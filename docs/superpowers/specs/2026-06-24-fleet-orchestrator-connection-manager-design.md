# Design: fleet-orchestrator MCP — connection-manager layer

**Date:** 2026-06-24
**Status:** Approved (design); pending spec review
**Author:** Jordan Burke (with Claude)

## Summary

Add a new MCP server that manages a **fleet of SSH hosts** from one endpoint:
a declarative host registry, **pooled persistent SSH connections** per host, and
host-routed `exec`/`tmux_*` tools. It reuses the existing connector's pure tmux
logic (`tmux.ts`) verbatim by feeding it a pooled, multi-host runner.

This is **subsystem A (the connection manager)** of a larger goal. The
**scheduler / orchestration intelligence (subsystem B)** — dispatching work
across the fleet and detecting when an agent is done/free to keep N agents busy —
is explicitly **out of scope here** and gets its own brainstorm → spec → plan
cycle, built on top of this layer.

The existing single-host connector (`ssh-client-mcp-server`, v1.5.1) keeps its
published identity and behavior; the only change to it is sharing code via a new
private `core` package.

## Motivation

Driving multiple remote coding agents across machines needs a single place that
knows the whole fleet and can reach any host efficiently. Three concerns,
collapsing into two subsystems:

1. **Multi-host registry** — declare N hosts + per-host auth.
2. **Connection pooling** — reuse persistent SSH connections instead of the
   one-shot-per-call handshake the single-host connector pays.

(The third concern, scheduling, is subsystem B — deferred.)

The connector's `tmux.ts` is already pure (no `ssh2`/`somamcp`) with an
injectable `TmuxRunner`, so the orchestrator reuses all the command-building,
escaping, and validation logic by supplying a pooled multi-host runner — no
reimplementation.

## Architecture

### Monorepo layout

Convert the repo into a pnpm-workspace monorepo with three packages:

```
ssh-client-mcp-server/                 (repo root — workspace manager)
├── pnpm-workspace.yaml                (packages: ["packages/*"])
├── packages/
│   ├── core/         @ssh-mcp/core   — PRIVATE, never published
│   │                                   pure tmux.ts (builders/interpreters/types)
│   │                                   + SSH runners: execSshResult (one-shot)
│   │                                     and createPool (pooled multi-host)
│   ├── connector/    ssh-client-mcp-server  — the EXISTING published package,
│   │                                   relocated; keeps name/bin/version/
│   │                                   server.json/publish.yml. Imports core.
│   └── orchestrator/ ssh-fleet-mcp-server (name TBD) — NEW published package:
│                                       registry + pool + host-routed tools.
│                                       Scheduler added later (subsystem B).
```

**`core` is private and bundled, not published.** tsdown bundles imports into
each server's `dist/index.js`, so both servers inline `core` at build time — no
third package to publish, no version coupling. `core` is `tmux.ts` (already pure)
plus the SSH runners extracted from the connector's `index.ts`.

**The connector keeps its published identity** — same package name, bin,
`server.json`, `publish.yml`. The only change: `tmux.ts` + runners move to
`core`; the connector imports them. Behavior identical; its full test suite must
pass unchanged (the migration's correctness proof).

**The orchestrator embeds a pooled multi-host `TmuxRunner`** from `core` and
feeds it the same pure tmux builders — injection-safety/validation reused
verbatim.

### How the orchestrator reaches hosts

It **embeds a pooled, multi-host SSH runner** (does NOT act as an MCP client of N
connector processes). Real SSH pooling requires owning the sockets, which the
MCP-client approach cannot do; it would also leave SSH one-shot inside each
connector and add process-management complexity. Embedding is the only approach
that satisfies the pooling requirement.

### Migration-first sequencing

The implementation plan does the **`core` extraction first** as a contained,
low-risk step — extract `core`, repoint the connector at it, prove the connector
builds/tests/publishes identically — **before** any orchestrator code.

## Fleet config & auth

A declarative **TOML** fleet file (parser dep: `smol-toml`), parsed and fully
validated at startup with fail-fast `Either`-accumulation (the connector's
`validateConfig` pattern).

```toml
[defaults]                 # applied to every host unless overridden
port = 22
user = "agent"             # falls back to OS user if omitted
tmux_session = "agent"

[pool]                     # connection-pool tuning
max_per_host = 2
idle_timeout_ms = 60000

[[hosts]]
name = "box-a"             # the id passed as host="box-a" in tool calls
host = "10.0.0.11"
user = "jordan"
key = "~/.ssh/id_ed25519"  # path; ~ and $VAR expanded via functype-os Path.expand

[[hosts]]
name = "box-b"
host = "build.example.com"
agent = true               # SSH_AUTH_SOCK

[[hosts]]
name = "box-c"
host = "192.168.1.50"
password_env = "BOXC_SSH_PASSWORD"   # secret read from env, never inline
```

### Auth modes (exactly one per host)

Reuse the connector's `resolveAuth` precedence/mechanics:

- `key` — path to a private key (`~`/`$VAR` expanded).
- `key_env` — name of an env var holding the key PEM.
- `agent` — use `SSH_AUTH_SOCK`.
- `password_env` — name of an env var holding the password.

This `password_env` is the symmetric `--password-env` capability previously
discussed for the connector — passwords need never touch a file.

### Secrets hygiene enforced by the schema

Inline `password` / `private_key` **literal** fields are **rejected** by
validation — secrets only ever arrive by reference (path / env var / agent).
envpkt fits naturally: it populates the referenced env vars; no special field.

### Discovery

`--config=<path>` explicit, else default `./fleet.toml` →
`~/.config/ssh-fleet/fleet.toml`.

## Connection pool

The only stateful component; ssh2 multiplexes multiple `exec` channels over one
connection, so the "pool" is **connection reuse + a concurrency cap**, not a bank
of sockets.

- **One persistent `ssh2.Client` per host**, established **lazily** on first call
  and reused — the win is skipping the TCP+SSH handshake every subsequent
  `tmux` subcommand.
- **Each tool call runs on its own short-lived exec channel**
  (`client.exec(cmd)` → collect `{stdout, stderr, code}` → close the channel,
  keep the Client). Pool the connection, not channels.
- **`max_per_host`** is a per-host concurrency cap (semaphore on in-flight
  channels) so we never exceed the SSH server's `MaxSessions`; excess calls queue
  with a bounded wait (timeout → clear `host busy` error, never an indefinite
  hang).
- **Health & lifecycle:** ssh2 keepalive detects dead links; on `error`/`close`
  the Client is evicted and the next call lazily reconnects (an exec that fails
  mid-flight retries once on a fresh Client). **Idle eviction** closes a Client
  after `idle_timeout_ms`, re-establishing on demand. **Graceful shutdown**
  (SIGINT/SIGTERM) closes all Clients.

**Semantically identical to one-shot.** Each call is its own channel/shell and
tmux holds all session state, so pooling changes no behavior — pure latency
reduction. The pooled runner and the connector's `execSshResult` are
interchangeable behind the same `CommandResult` contract.

**`core` API:** `createPool(hosts, poolOpts) → { run(hostName, command):
Promise<CommandResult>, status(), shutdown() }`. The orchestrator binds a
per-host `TmuxRunner = (command) => pool.run(hostName, command)`.

**Testability seam:** `createPool` takes an injected
`connect: (sshConfig) => Promise<PooledConnection>` factory (ssh2 at the edge);
`PooledConnection` exposes `exec(cmd): Promise<CommandResult>`, `close()`, and
connection events. Tests inject a fake.

## Tool surface

Connector tools made host-aware (required `host` naming a configured member),
plus one fleet-introspection tool. Same tool *names* as the connector (separate
server → no collision; identical mental model).

| Tool | Params | Purpose |
|------|--------|---------|
| `hosts_list` | — | List configured hosts + live pool status (connected/idle/disconnected, in-flight channels). |
| `exec` | `host`, `command` | One-shot command on a host (via pool). |
| `tmux_list` | `host` | List tmux sessions on a host. |
| `tmux_send` | `host`, `session?`, `input`, `submit?` | Send text to a session on a host. |
| `tmux_read` | `host`, `session?`, `lines?` | Read a session's pane on a host. |
| `tmux_keys` | `host`, `session?`, `keys` | Send control keys to a session on a host. |

- The only delta from the connector tools is the `host` param; all other params
  and semantics are identical and run through the **same `core` tmux
  builders/interpreters** behind the per-host pooled runner.
- `host` is **required** and validated against the registry; unknown host →
  clear error listing configured names.
- `session` defaults to the host's configured `tmux_session`, else the global
  default.

### Deferred (not in this layer)

- **Fan-out tools** (`exec_all`, run-on-subset) — selecting/targeting groups is
  orchestration intent → subsystem B.
- **`tmux_kill`** — YAGNI (as in the connector).
- **Runtime `add_host`** — registry is static config by design.

## Error handling

Defining property: **per-host fault isolation** — one dead/misconfigured box must
never break calls to others. Each host has its own pool/Client; `hosts_list`
surfaces per-host status so callers route around a down host.

### Fatal vs. tolerated

- **Fatal at startup (authoring errors):** malformed TOML; duplicate/unsafe host
  names; a host with zero or multiple auth modes; a referenced key file
  unreadable or a `*_env` var unset. Accumulate all, exit non-zero.
- **NOT checked at startup (runtime availability):** host reachability. Connect
  lazily — an unreachable box doesn't block boot; it errors when called and shows
  `disconnected` in `hosts_list`.

### Per-call errors

- **Unknown `host`** → clear error listing configured host names.
- **Connect/auth failure** → `Cannot connect to host "box-a" (10.0.0.11):
  <ssh2 message>`; a mid-flight dropped connection retries once on a fresh
  Client, then errors.
- **tmux-level errors** → reuse the same `core` interpreters (`isTmuxMissing`,
  missing-session, etc.); the orchestrator prefixes the host name
  (`[box-a] No tmux session "agent" …`).
- **exec stderr** → mirrors the connector exactly (one-shot `exec` treats stderr
  as fatal `UserError`; `tmux_*` use the stderr-tolerant interpreters).
- **Pool saturation** → calls past `max_per_host` queue with a bounded wait;
  timeout → clear `host busy` error.

## Testing strategy

Behind injectable seams so risky parts test without real SSH; per package;
`pnpm -r test` runs all.

### `packages/core`

- **tmux.ts** — existing pure tests migrate here unchanged.
- **Pool** — drive every lifecycle path via the injected fake `connect` factory:
  lazy connect + reuse (factory called once), concurrency cap + queueing, idle
  eviction (`vi.useFakeTimers()`), reconnect-on-error, `shutdown()` closes all.
- **Config parse/validate** — pure; a table of sample configs covering each error
  case, **including security**: inline `password`/`private_key` rejected;
  zero/multiple auth rejected; missing `*_env` rejected.

### `packages/orchestrator`

- Host-aware operations against a **stub pool** (the connector's `stubRunner`
  pattern): assert host routing, `session` defaulting, unknown-host error, and
  that the same `core` builders are invoked.
- **Isolation test** — an error bound to host A leaves host B's calls working.

### Integration (gated)

Pooled runner + tmux builders against **localhost over real SSH**, gated on
`command -v sshd` + a reachable localhost login; **skipped** when unavailable so
CI stays green. Verifies real connect-reuse + a tmux round-trip end-to-end.

### Regression

After the `core` extraction, the connector's full suite must pass **unchanged** —
the proof the migration was behavior-preserving.

### Manual e2e

`pnpm inspect` the orchestrator against a real `fleet.toml` (e.g. mini65).

## Out of scope (explicitly)

- **Scheduler / orchestration intelligence** (dispatch, readiness detection,
  keep-N-busy, fan-out) — subsystem B, its own spec.
- **`tmux_kill`**, **runtime host registration**, **a default host** (host is
  required in this layer).
- **Changes to the connector's behavior** — only its source location and a
  `core` dependency change.

## Open questions

- **Orchestrator package name** (`ssh-fleet-mcp-server`?) — finalize at
  implementation.
- **Default-host convenience** (making `host` optional when one is configured) —
  deferred unless it proves needed.
