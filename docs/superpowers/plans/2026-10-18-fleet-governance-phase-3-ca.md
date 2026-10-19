# Fleet Governance Phase 3 (CA Certificates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ca` auth mode. The hub holds an SSH certificate authority in a private `ssh-agent`, mints a 10-minute certificate per connection, and reaches the host through the system `ssh` binary, so hosts trust one CA line instead of per-host keys.

**Architecture:** Two new core modules behind an injected process seam. `packages/core/src/ca.ts` owns custody: it recovers or creates the runtime dir, starts a private `ssh-agent`, loads each CA key without writing it to disk, and mints ephemeral certificates with `ssh-keygen -U -s`. `packages/core/src/openssh.ts` is a second `ConnectFactory`: one `ssh` ControlMaster child per connection, `exec` over its socket with no fallback path, and retirement when the certificate expires. The orchestrator parses `[[cas]]` and a per-host `ca = "<name>"` auth mode, and gives each (agent, CA host) pair its own pool, so one agent never rides another's session. Existing auth modes keep the ssh2 path unchanged.

**Tech Stack:** TypeScript (ESM), functype, Node `child_process` / `fs` / `crypto`, OpenSSH (`ssh`, `ssh-keygen`, `ssh-agent`, `ssh-add`; `sshd` for the integration fixture), vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-fleet-governance-design.md` — *The enforcement property*, *Seamless operation* (CA key at boot), *Phase 3 — CA custody and certificate minting*, and the CA rows of *Error handling* and *Testing strategy*. Builds on Phases 1–2 (merged as `7d2f49b`, `900005e`).

**Branch:** `feat/governance-ca` off `main`.

**Verified against OpenSSH 9.6p1 on Linux** during plan review: `ssh-add -` and `ssh-keygen -y -f /dev/stdin` read a key from stdin; `-z` accepts serials up to 2^64−1; `-O check|stop|exit` exit 255 with no master; `-O stop` unlinks the socket at once and the master exits when its last session closes; a stale control socket silently disables multiplexing; `ssh-agent -a` refuses an existing socket path; ControlPath fails above 90 bytes on Linux (OpenSSH binds `<path>.<16 chars>` first). macOS was not verified.

## Global Constraints

- **Certificate:** `ssh-keygen -U -s <ca.pub> -I <agent> -n <principal> -V -5m:+10m -z <serial> -O no-port-forwarding -O no-agent-forwarding -O no-x11-forwarding -O no-user-rc [-O source-address=<cidr>] <ephemeral.pub>`. Ephemeral keys are ed25519, created in the runtime dir with mode `0600`.
- **The CA private key never touches disk.** It reaches `ssh-keygen -y -f /dev/stdin` and `ssh-add -` on stdin only. Inline keys in config are rejected, like every other secret.
- **No prompt can hang startup:** `ssh-keygen -y` and `ssh-add` run with `SSH_ASKPASS=/bin/false` and `SSH_ASKPASS_REQUIRE=force`, so a passphrase-protected key fails at once, with or without a terminal.
- **Child environment is an allowlist.** Every OpenSSH child gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` from the hub's environment, plus what the step needs. `SSH_AUTH_SOCK` (the **private** agent) is passed only to `ssh-add` and `ssh-keygen -U`. No `ssh` child ever sees an agent socket or `DISPLAY`.
- **CA key references,** exactly one per CA: `key_cmd` (run with `sh -c`; stdout is the key; a keychain or password-manager read goes here), `key_env` (env var name; the variable is deleted from `process.env` after it is read), or `key_file` (refused unless it is a regular file, not a symlink, mode `0600` or stricter, owned by the hub user). Loading needs no interactive unlock.
- **Masters:** `ssh -F /dev/null -M -N -S <sock> -o ControlPersist=no -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=<key> -o CertificateFile=<cert> -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=<known_hosts> -o ConnectTimeout=10 -p <port> <user>@<host>`, spawned as a child the factory owns. `-F /dev/null` and `IdentityAgent=none` keep the hub user's own `~/.ssh/config` identities and agent out of the master, so it can only offer the minted certificate. (Cost: no `ProxyJump` / `~/.ssh/config` support in Phase 3. Decision, Jordan 2026-10-19: revisit when a host needs a jump host, as an explicit per-host `proxy_jump` or a hub-owned `ssh_config` passed with `-F` — never the user's `~/.ssh/config` — with the jump hop also authenticating by certificate.)
- **Exec:** `ssh -F /dev/null -S <sock> -o ControlMaster=no -o ProxyCommand=false -o BatchMode=yes -p <port> <user>@<host> -- <command>`, spawned without a shell. `ProxyCommand=false` means a missing socket fails the call instead of opening a direct connection.
- **`known_hosts`:** hub-owned, `known_hosts` from config, default `~/.local/state/ssh-fleet/known_hosts`. Trust on first use (`accept-new`).
- **Lifetime:** a master retires at its certificate's end (10 minutes after minting): mark retired and fire `onClose` (the pool drops it) → `-O stop` (no new sessions; the master exits when in-flight sessions end) → wait for the child to exit, up to 60 s → kill it if still alive → dispose the key and certificate. `onClose` and `dispose` are idempotent: child exit, retirement and `close` can each trigger them. A non-zero master exit code is not an error signal. An `exec` on a master that has exited or retired rejects before spawning (so the pool's reconnect-once path opens a new one).
- **Pools:** one pool per (agent, CA host), built lazily; non-CA hosts keep one shared ssh2 pool and ignore the agent. Every agent is `"unknown"` until Phase 4.
- **Serial:** strictly increasing: `max(previous + 1, Date.now() * 1000)` as a `bigint`, carried as a decimal string outside `ca.ts`. No stored state.
- **Runtime dir:** `runtime_dir` from config, else `$XDG_RUNTIME_DIR/ssh-fleet`, else `~/.local/state/ssh-fleet/run`; mode `0700`. Control sockets are `m-<12 hex of sha256(agent + "\0" + host name)>.sock`; startup fails if that path exceeds **86 bytes** (90 on Linux, minus macOS's smaller limit).
- **Crash recovery:** at startup, if `agent.pid` names a live `ssh-agent`, kill it; unlink `agent.sock`, `agent.pid`, `m-*.sock`, `k-*`, `ca-*.pub`. Before each master spawn, unlink its socket path.
- **Fatal at startup** (when any host uses `ca`): a missing `ssh`, `ssh-keygen`, `ssh-agent` or `ssh-add`; a CA reference that fails to resolve; a key that fails to load; a socket path over 86 bytes; a host naming an undefined CA. A failure after custody starts shuts custody down before exiting, so no agent is left holding the key.
- **Minting failure:** a connect error naming the CA: `CA "<name>": <step> failed: <stderr>`.
- **Shutdown order:** every OpenSSH factory's masters exit (awaited), then custody (agent killed, runtime dir removed).
- **Out of scope:** KRL, `ProxyJump` (see the Masters decision), per-host `max_timeout_ms`, real agent identity (Phase 4), approval (Phase 5).
- **Style:** functype FP style, Prettier, `pnpm validate` lint-clean. Code that must throw for a host contract sits in `@interop`-tagged declarations.

## Review Focus

1. **A dead control socket must never become a direct login** → Task 4 test `exec cannot fall back to a direct connection` (args) and Task 7 test `a stopped master's socket does not fall back` (real sshd).
2. **A master that dies on its own** (host reboot, network drop) must fire `onClose` so the pool reconnects → Task 4 test `a master that exits fires onClose once`.
3. **A call in flight when the master retires** must finish; a call after it must get a new master → Task 5 tests `retiring lets in-flight execs finish` and `a call after retirement mints a new master`.
4. **A passphrase-protected CA key** must fail startup naming the CA, never hang → Task 2 tests `a key that won't load fails startup naming the CA` and `ssh-add and ssh-keygen -y can't prompt`.
5. **A hub that crashed** must restart cleanly over its stale runtime dir → Task 2 test `startup recovers from a stale runtime dir`.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/core/src/proc.ts` | create | `ProcessRunner` seam; `childEnv` allowlist |
| `packages/core/src/ca.ts` | create | `checkOpenSsh`, `startCaCustody`, `mint`, `nextSerial`, `socketPathFor` |
| `packages/core/src/openssh.ts` | create | `opensshConnect`: master, exec, close, retirement, shutdown |
| `packages/core/src/index.ts` | modify | export the above |
| `packages/core/test/{ca,openssh}.spec.ts` | create | unit + OpenSSH-gated tests |
| `packages/orchestrator/src/fleet.ts` | modify | `[[cas]]`, `runtime_dir`, `known_hosts`, host `ca` / `principal` |
| `packages/orchestrator/src/runners.ts` | modify | CA hosts → per-(agent, host) pools; `exec` / `tmuxRunnerFor` take an agent |
| `packages/orchestrator/src/index.ts` | modify | pass the agent; start and stop custody |
| `packages/orchestrator/test/{fleet,runners,ops}.spec.ts` | modify | config, routing |
| `packages/orchestrator/test/ca-integration.spec.ts` | create | self-hosted `sshd` end-to-end, gated on OpenSSH |
| `packages/orchestrator/README.md`, `fleet.example.toml`, `CLAUDE.md` | modify | CA mode docs |

---

### Task 1: Fleet config — `[[cas]]` and the `ca` auth mode

**Files:**
- Modify: `packages/orchestrator/src/fleet.ts`
- Test: `packages/orchestrator/test/fleet.spec.ts`

**Interfaces:**
- Produces:
  - `type CaKeyRef = Readonly<{ kind: "cmd"; cmd: string }> | Readonly<{ kind: "env"; name: string }> | Readonly<{ kind: "file"; path: string }>`
  - `type CaEntry = Readonly<{ name: string; key: CaKeyRef; principal: string; sourceAddress: Option<string> }>` — `principal` defaults to `"fleet"`.
  - `Fleet` gains `cas: ReadonlyArray<CaEntry>`, `runtimeDir: Option<string>`, `knownHosts: Option<string>` (both raw, unexpanded).
  - `HostEntry` gains `ca: Option<string>` and `principal: Option<string>` (overrides the CA's).

`ca = "<name>"` is a fifth auth field, counted by the existing exactly-one-auth rule; a CA host's `auth` is the empty `ResolveAuthOptions`. Existing messages gain `ca`: `no auth mode (need exactly one of key/key_env/agent/password_env/ca)` and `secrets must not be inline; use key/key_env/agent/password_env/ca`. New error strings (exact):
- `ca "<name>": exactly one of key_cmd, key_env, key_file is required`
- `ca "<name>": keys must not be inline; use key_cmd, key_env or key_file` (for `key` / `private_key`)
- `ca "<name>": duplicate name` / `[[cas]] entry has no name`
- `ca "<name>": principal must be non-empty with no commas` (also for a host's `principal`, prefixed `host "<name>":`)
- `ca "<name>": source_address must be an IPv4 or IPv6 CIDR` (`a.b.c.d/n` or IPv6 `…/n`; check shape and prefix range)
- `host "<name>": ca "<ca>" is not defined in [[cas]]`
- `host "<name>": principal applies only to ca auth`

- [ ] **Step 1: Write the failing tests** in `fleet.spec.ts`:
  - `reads [[cas]] with a default principal` — `name = "home"`, `key_cmd = "op read x"` → `{ name: "home", key: { kind: "cmd", cmd: "op read x" }, principal: "fleet" }`, `sourceAddress` `None`.
  - `a host can use ca auth` — `ca = "home"` → `hosts[0].ca` is `Some("home")`.
  - `ca counts as an auth mode` — `ca = "home"` and `agent = true` → `exactly one auth mode allowed, found 2`.
  - `the no-auth message lists ca` — a host with no auth → contains `key/key_env/agent/password_env/ca`.
  - `rejects a ca with no key reference` / `rejects an inline ca key` / `rejects two key references` — exact strings.
  - `rejects a principal with a comma` and `rejects a malformed source_address` (`"10.0.0.1"`, `"10.0.0.1/33"`) — exact strings.
  - `rejects a host naming an undefined ca` / `rejects principal on a non-ca host` — exact strings.
  - `reads runtime_dir and known_hosts` — present → `Some`; absent → `None`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/orchestrator && npx vitest run test/fleet.spec.ts`
Expected: FAIL on the 12 new tests.

- [ ] **Step 3: Implement** `parseCas(raw)` and the host changes. Errors join the existing `Fleet config errors:` list.

- [ ] **Step 4: Run the package suite**

Run: `pnpm validate`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/fleet.ts packages/orchestrator/test/fleet.spec.ts
git commit -m "feat(orchestrator): [[cas]] config and the ca auth mode"
```

---

### Task 2: Process seam and CA custody

**Files:**
- Create: `packages/core/src/proc.ts`, `packages/core/src/ca.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/ca.spec.ts`

**Interfaces:**
- Produces (`proc.ts`):
  - `type ProcResult = Readonly<{ code: number; stdout: string; stderr: string }>`
  - `type Env = Readonly<Record<string, string>>`
  - `type Child = Readonly<{ onExit: (cb: (code: number | null) => void) => void; kill: () => void; stderr: () => string; exited: () => boolean }>` — `stderr()` returns the last 4 KB.
  - `type ProcessRunner = Readonly<{ run: (cmd: string, args: ReadonlyArray<string>, opts: Readonly<{ env: Env; input?: string }>) => Promise<ProcResult>; spawn: (cmd: string, args: ReadonlyArray<string>, opts: Readonly<{ env: Env }>) => Child }>` — `env` is the **whole** child environment, never merged with `process.env`.
  - `childEnv(extra?: Env): Env` — `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` from `process.env` (where set), plus `extra`.
  - `nodeProcessRunner: ProcessRunner` — `execFile` / `spawn` without a shell; `run` resolves with `code` on a non-zero exit and rejects only on a spawn failure (`ENOENT`).
- Produces (`ca.ts`):
  - `type CaKeySource = Readonly<{ name: string; key: () => Promise<Either<string, string>> }>`
  - `type Custody = Readonly<{ runtimeDir: string; agentSock: string; pubPath: (ca: string) => Option<string>; shutdown: () => Promise<void> }>`
  - `checkOpenSsh(proc: ProcessRunner): Promise<Either<string, void>>` — probes `ssh -V`, `ssh-keygen -?`, `ssh-agent -?`, `ssh-add -?` (never a bare `ssh-agent`, which would start an agent); resolving with any code = present, rejecting = missing; `Left("OpenSSH binaries missing: <comma-separated list>")`.
  - `startCaCustody(runtimeDir: string, cas: ReadonlyArray<CaKeySource>, proc: ProcessRunner): Promise<Either<string, Custody>>`

`startCaCustody`: create `runtimeDir` (`0700`) and run crash recovery (Global Constraints); spawn `ssh-agent -D -a <dir>/agent.sock` with `childEnv()`, write its PID to `agent.pid`, wait ≤ 5 s for the socket. For each CA: fetch the key; `ssh-keygen -y -f /dev/stdin` with the key as input → write `<dir>/ca-<name>.pub`; `ssh-add -` with the key as input. Both get `childEnv({ SSH_ASKPASS: "/bin/false", SSH_ASKPASS_REQUIRE: "force" })`, and `ssh-add` also `SSH_AUTH_SOCK=<dir>/agent.sock`. Any failure → kill the agent, remove its files, `Left('CA "<name>": <step> failed: <stderr>')`. `shutdown` kills the agent and removes the runtime dir.

- [ ] **Step 1: Write the failing tests** in `packages/core/test/ca.spec.ts`. Gate OpenSSH-backed tests with `describe.skipIf(!hasOpenSsh)` (synchronous probe of the four binaries). Throwaway CAs come from `ssh-keygen -t ed25519 -N "" -f <tmp>/ca` in `beforeAll`.
  - `childEnv keeps only the allowlist` — with `SSH_AUTH_SOCK` and `DISPLAY` set in `process.env`, `childEnv({ X: "1" })` has neither, keeps `PATH`, and has `X`.
  - `checkOpenSsh finds the binaries` — `Right`.
  - `checkOpenSsh names a missing binary` — fake `ProcessRunner` rejecting with `ENOENT` for `ssh-add` → `Left` containing `ssh-add`.
  - `ssh-add and ssh-keygen -y can't prompt` — with a recording fake `ProcessRunner`, the `env` of both calls has `SSH_ASKPASS: "/bin/false"`, `SSH_ASKPASS_REQUIRE: "force"`, and no `DISPLAY`; only `ssh-add` has `SSH_AUTH_SOCK`.
  - `custody loads a CA without writing its private key` — `Right`; `pubPath("home")` contents equal `<tmp>/ca.pub`'s; no file under `runtimeDir` contains `PRIVATE KEY`; `ssh-add -l` against `custody.agentSock` lists one key.
  - `a key that won't load fails startup naming the CA` — a CA made with `-N secret` → `Left` starting `CA "home":` within 10 s.
  - `a failing key source fails naming the CA` — source `Left("no such secret")` → `Left` containing `CA "home"` and `no such secret`.
  - `startup recovers from a stale runtime dir` — start custody, then simulate a crash (leave the dir and agent; touch `m-0123456789ab.sock`); start custody again on the same dir → `Right`; the first agent's PID is gone; no `m-*.sock` remains.
  - `shutdown removes the runtime dir and stops the agent` — the dir is gone and `ssh-add -l` on the old socket fails.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/core && npx vitest run test/ca.spec.ts`
Expected: FAIL — `../src/ca.js` / `../src/proc.js` can't be resolved.

- [ ] **Step 3: Implement** `proc.ts` and the custody half of `ca.ts`; export both.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/ca.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proc.ts packages/core/src/ca.ts packages/core/src/index.ts packages/core/test/ca.spec.ts
git commit -m "feat(core): CA custody in a private ssh-agent, with crash recovery"
```

---

### Task 3: Minting certificates

**Files:**
- Modify: `packages/core/src/ca.ts`
- Test: `packages/core/test/ca.spec.ts`

**Interfaces:**
- Consumes: `Custody`, `ProcessRunner`, `childEnv` (Task 2).
- Produces:
  - `type MintRequest = Readonly<{ ca: string; agent: string; principal: string; sourceAddress: Option<string> }>`
  - `type Minted = Readonly<{ keyPath: string; certPath: string; validUntil: Date; serial: string; dispose: () => Promise<void> }>` — `serial` is decimal; `dispose` deletes key, `.pub` and cert and is idempotent.
  - `mint(custody: Custody, req: MintRequest, proc: ProcessRunner, now?: () => Date): Promise<Either<string, Minted>>`
  - `nextSerial(nowMs: number): bigint` — `max(previous + 1, BigInt(nowMs) * 1000n)`.
  - `socketPathFor(runtimeDir: string, agent: string, host: string): Either<string, string>` — `<runtimeDir>/m-<first 12 hex of sha256(agent + "\0" + host)>.sock`; `Left("runtime_dir <dir> is too long for control sockets (socket paths must be at most 86 bytes)")`.

`mint`: `ssh-keygen -t ed25519 -N "" -C "" -f <runtimeDir>/k-<16 random hex>` with `childEnv()`, then the Global Constraints signing command with `childEnv({ SSH_AUTH_SOCK: custody.agentSock })`. `validUntil` = `now() + 10 min`. Errors: `CA "<ca>": key generation failed: …` / `CA "<ca>": signing failed: …`, deleting any files created.

- [ ] **Step 1: Write the failing tests** (gated as Task 2, reusing a custody):
  - `mints a certificate with the agent, principal, validity and options` — `ssh-keygen -L -f <certPath>` contains `Key ID: "unknown"`, `Serial: <serial>`, a `Valid: from … to …` line about 15 minutes wide, `Principals:` followed by an indented `fleet`, `Critical Options: (none)`, and under `Extensions:` exactly `permit-pty` (no `permit-port-forwarding`, `permit-agent-forwarding`, `permit-X11-forwarding`, `permit-user-rc`).
  - `source_address becomes a critical option` — `Some("100.64.0.1/32")` → `-L` shows `source-address 100.64.0.1/32`.
  - `serials strictly increase` — 2000 calls with the same `nowMs` are strictly increasing, and a call with `nowMs + 1` afterwards is larger than all of them.
  - `dispose deletes the key and certificate, twice safely` — no `k-*` files remain; a second `dispose()` resolves.
  - `signing with an unknown CA fails naming it` — `ca: "nope"` → `Left` starting `CA "nope":`.
  - `rejects a runtime dir whose socket paths are too long` — `socketPathFor("/" + "x".repeat(70), "unknown", "box-a")` is `Left`; `socketPathFor("/run/fleet", "unknown", "box-a")` is `Right` and ends `.sock`; different agents give different paths.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/ca.spec.ts`
Expected: FAIL — `mint` is not exported.

- [ ] **Step 3: Implement** `mint`, `nextSerial`, `socketPathFor`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/ca.spec.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ca.ts packages/core/test/ca.spec.ts
git commit -m "feat(core): mint ten-minute certificates from the private CA"
```

---

### Task 4: OpenSSH connect factory

**Files:**
- Create: `packages/core/src/openssh.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/openssh.spec.ts`

**Interfaces:**
- Consumes: `ProcessRunner`, `Child`, `childEnv` (Task 2); `Minted` (Task 3); `ConnectFactory`, `PooledConnection` (`pool.ts`).
- Produces:
  - `type OpensshDeps = Readonly<{ proc: ProcessRunner; mintFor: () => Promise<Either<string, Minted>>; socketPath: string; knownHosts: string; readyTimeoutMs?: number; retireAfterMs?: number; drainTimeoutMs?: number; setTimer?: (cb: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void }>` — one factory serves one (agent, host); defaults 15 000 / 600 000 / 60 000.
  - `type Openssh = Readonly<{ connect: ConnectFactory; shutdown: () => Promise<void> }>`
  - `opensshConnect(deps: OpensshDeps): Openssh`

Connect: mint (a `Left` rejects with that message, nothing spawned); unlink `socketPath`; spawn the master (Global Constraints) with `childEnv()`; poll `ssh -F /dev/null -S <sock> -O check <user>@<host>` every 100 ms until it exits 0. If the child exits first, reject at once with `master for <host> exited: <child.stderr()>`; after `readyTimeoutMs`, kill it and reject `master for <host> did not come up: <child.stderr()>`. Both dispose the minted files. `exec`: reject `master for <host> is gone` without spawning if the child has exited or the connection is retired; otherwise run the exec command (Global Constraints) and map `{ code, stdout, stderr }` to `CommandResult`. The child's exit fires every `onClose` callback once and disposes. `close` (sync, as `PooledConnection` requires) starts the exit: `-O exit` (an exit code of 255 counts as done), then waits for the child, kills it after `drainTimeoutMs`, disposes. `shutdown()` closes every live master and resolves when all children have exited.

- [ ] **Step 1: Write the failing tests** with a fake `ProcessRunner` that records every call's args and env, lets the test settle `-O check`, and fires child exit:
  - `starts a master that can only offer the certificate` — spawned args contain `-F`, `/dev/null`, `-M`, `-N`, `-S`, `<sock>`, `IdentitiesOnly=yes`, `IdentityAgent=none`, `IdentityFile=<keyPath>`, `CertificateFile=<certPath>`, `BatchMode=yes`, `StrictHostKeyChecking=accept-new`, `UserKnownHostsFile=<knownHosts>`, `ControlPersist=no`, `-p`, `2222`, `deploy@box-a`; its env has no `SSH_AUTH_SOCK`.
  - `exec cannot fall back to a direct connection` — `exec("uptime")` runs `ssh` with `-F /dev/null -S <sock> -o ControlMaster=no -o ProxyCommand=false -o BatchMode=yes -p 2222 deploy@box-a -- uptime`, env without `SSH_AUTH_SOCK`, and returns `{ stdout, stderr, code }`.
  - `exec on a dead master rejects without spawning` — fire child exit, then `exec` rejects matching `/is gone/` and no new `run` call is recorded.
  - `a master that exits fires onClose once` — fire exit twice; the callback ran once; `dispose` called once.
  - `close exits the master and disposes` — `close()` runs `-O exit` (fake returns 255) and, after child exit, `dispose` was called.
  - `a mint failure rejects the connect` — nothing spawned; rejection is the mint message.
  - `a master that exits before it is ready rejects at once` — fire child exit with stderr `"Permission denied"` before `-O check` succeeds → rejects matching `/exited: Permission denied/` immediately (no wait for the timeout).
  - `a master that never comes up is killed` — `-O check` always 255; `readyTimeoutMs: 300` → rejects `/did not come up/`; `kill` called.
  - `shutdown waits for every master to exit` — two connections; `shutdown()` pending until both children exit.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/openssh.spec.ts`
Expected: FAIL — `../src/openssh.js` can't be resolved.

- [ ] **Step 3: Implement** `opensshConnect` and export it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/openssh.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/openssh.ts packages/core/src/index.ts packages/core/test/openssh.spec.ts
git commit -m "feat(core): OpenSSH ControlMaster connect factory with no fallback path"
```

---

### Task 5: Retire masters at certificate expiry

**Files:**
- Modify: `packages/core/src/openssh.ts`
- Test: `packages/core/test/openssh.spec.ts`

**Interfaces:**
- Consumes: Task 4's factory and fakes.

At connect, schedule retirement after `retireAfterMs` (`setTimer`). Retirement, per Global Constraints: mark retired and fire `onClose` → `-O stop` → wait for the child's exit up to `drainTimeoutMs` → kill if alive → dispose. `close` cancels a pending retirement; retirement after `close` is a no-op.

- [ ] **Step 1: Write the failing tests** with injected timers (`vi.useFakeTimers()`):
  - `a master is retired when its certificate expires` — advance `retireAfterMs` → `onClose` fired, `-O stop` run; fire child exit → `dispose` called; `-O exit` never run.
  - `retiring lets in-flight execs finish` — an `exec` whose `run` is held open; advance → `-O stop` run, child still alive; release the exec → it resolves with its result; then child exit → `dispose`.
  - `a master that ignores stop is killed after the drain timeout` — advance `retireAfterMs`, then `drainTimeoutMs` → `kill` called, `dispose` called.
  - `a call after retirement mints a new master` — through `createPool` with this factory's `connect`: run a command, advance `retireAfterMs`, fire the first child's exit, run another → `mintFor` called twice, two masters spawned.
  - `close cancels retirement` — `close()`, then advance → no `-O stop`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/openssh.spec.ts`
Expected: FAIL on the 5 new tests.

- [ ] **Step 3: Implement** retirement.

- [ ] **Step 4: Run the core suite**

Run: `cd packages/core && pnpm validate`
Expected: all pass; `pool.spec.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/openssh.ts packages/core/test/openssh.spec.ts
git commit -m "feat(core): retire OpenSSH masters when their certificate expires"
```

---

### Task 6: Route CA hosts through per-(agent, host) pools

**Files:**
- Modify: `packages/orchestrator/src/runners.ts`, `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/test/runners.spec.ts`, `packages/orchestrator/test/ops.spec.ts`

**Interfaces:**
- Consumes: `CaEntry`, `HostEntry.ca`, `HostEntry.principal`, `Fleet.cas`, `Fleet.runtimeDir`, `Fleet.knownHosts` (Task 1); `checkOpenSsh`, `startCaCustody`, `Custody`, `CaKeySource`, `mint`, `socketPathFor`, `nodeProcessRunner` (Tasks 2–3); `opensshConnect`, `Openssh` (Task 4).
- Produces:
  - `FleetRunner.exec` becomes `(host: string, command: string, agent: string) => Promise<CommandResult>`; `tmuxRunnerFor` becomes `(host: string, agent: string) => Either<string, TmuxRunner>`. Handlers pass `AGENT_UNKNOWN`.
  - `type CaWiring = Readonly<{ custody: Custody; proc: ProcessRunner; knownHosts: string; openFor?: (agent: string, host: HostEntry) => Openssh }>` — `openFor` replaces the real factory in tests.
  - `buildFleetRunner(fleet: Fleet, connect?: ConnectFactory, ca?: Option<CaWiring>)` — a CA host without wiring → `Left('host "<name>" uses ca auth but CA custody is not running')`.
  - `caKeySource(entry: CaEntry): CaKeySource` — `cmd` via `nodeProcessRunner.run("sh", ["-c", cmd], { env: childEnv() })`, stdout trimmed; `env` reads then deletes the variable; `file` checks regular file / not a symlink / mode / owner, then reads.
  - `defaultRuntimeDir(): string`, `defaultKnownHosts(): string`.

Partition `fleet.hosts` by `ca.isSome()`; only non-CA hosts enter the ssh2 pool. For CA hosts, a functype `Map` from `${agent}\0${host}` to `{ pool, openssh }`, built on first use: `openssh = opensshConnect({ proc, knownHosts, socketPath: socketPathFor(custody.runtimeDir, agent, host.name), mintFor: () => mint(custody, { ca, agent, principal: host.principal.orElse(caEntry.principal), sourceAddress: caEntry.sourceAddress }, proc) })` and `pool = createPool([{ name: host.name, sshConfig }], fleet.pool, openssh.connect)`. `hostNames` and `tmuxRunnerFor` cover all hosts. `status()` lists every ssh2 host, every CA host with no pool as `disconnected`, and each CA pool as `<host> (<agent>)`. `shutdown()`: every pool, then every `openssh.shutdown()` (awaited), then `custody.shutdown()`.

In `main`, when any host uses `ca`: `checkOpenSsh`; resolve `runtimeDir` / `knownHosts` (expanded, or the defaults); `socketPathFor` once with the longest host name as a startup check; `startCaCustody` with `caKeySource` per CA. Any `Left` → print, `process.exit(1)`; a `Left` from `buildFleetRunner` after custody started → `await custody.shutdown()` first.

- [ ] **Step 1: Write the failing tests**
  - `runners.spec.ts` `a ca host without custody fails to build` — exact message.
  - `two agents get separate pools and sockets on a CA host` — `openFor` records `(agent, host.name)` and returns a fake `Openssh` whose `connect` counts connections and records the `socketPath` it would use (call `socketPathFor` in the test's fake): `exec("box-a", "x", "claude")` and `exec("box-a", "x", "codex")` → two connections with different socket paths; a second `exec` by `"claude"` reuses its connection.
  - `non-ca hosts ignore the agent` — two agents on an ssh2 host share one connection.
  - `ca hosts appear in hosts_list before first use` — `status()` includes `box-a` as `disconnected`; `hostNames` includes it.
  - `shutdown stops pools, then masters, then custody` — record call order across fakes → pools, then every `openssh.shutdown`, then `custody.shutdown`.
  - `caKeySource reads and clears env, and refuses a world-readable file` — `env` → `Right(value)` and the variable is gone; a `0644` file → `Left` containing `0600`; a symlink → `Left` containing `symlink`.
  - `ops.spec.ts`: update the fake runner's signatures; `exec passes the agent to the runner` — the recorded agent is `"unknown"`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/orchestrator && npx vitest run test/runners.spec.ts test/ops.spec.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** in `runners.ts` and `index.ts`.

- [ ] **Step 4: Run the full suite**

Run: `cd ../.. && pnpm -r validate`
Expected: all three packages pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/runners.ts packages/orchestrator/src/index.ts packages/orchestrator/test/runners.spec.ts packages/orchestrator/test/ops.spec.ts
git commit -m "feat(orchestrator): route ca hosts through per-agent OpenSSH pools"
```

---

### Task 7: End-to-end against a self-hosted sshd, and documentation

**Files:**
- Create: `packages/orchestrator/test/ca-integration.spec.ts`
- Modify: `packages/orchestrator/README.md`, `packages/orchestrator/fleet.example.toml`, `CLAUDE.md`

The fixture runs `sshd` as the current user — no root, no edits to any real SSH config. Skip the file unless `ssh`, `ssh-keygen`, `ssh-agent`, `ssh-add` and `sshd` (`/usr/sbin/sshd` or on `PATH`) all exist. In `beforeAll`, in a temp dir: generate a host key and a CA; write `authorized_principals` containing `fleet`; write `sshd_config` with `Port <random 20000–40000>`, `ListenAddress 127.0.0.1`, `HostKey <tmp>/host`, `PidFile none`, `UsePAM no`, `StrictModes no`, `AuthorizedKeysFile none`, `TrustedUserCAKeys <tmp>/ca.pub`, `AuthorizedPrincipalsFile <tmp>/authorized_principals`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `LogLevel VERBOSE`; spawn `sshd -D -e -f <cfg>` capturing stderr; wait until the port accepts. Build a fleet: `[[cas]] name = "it"`, `key_file` = the CA (`0600`), one host `127.0.0.1` on that port with `user` = the current user and `ca = "it"`, `runtime_dir` and `known_hosts` under the temp dir; start custody; build the runner. `afterAll`: runner shutdown, kill `sshd`, remove the temp dir.

- [ ] **Step 1: Write the tests** in `ca-integration.spec.ts`:
  - `exec runs over a certificate` — `exec(host, "whoami", "unknown")` → `stdout` is the current user, `code` 0; `sshd`'s stderr contains `Accepted certificate ID "unknown"`.
  - `exit codes come through` — `exec(host, "exit 7", "unknown")` → `code` 7.
  - `a second agent gets its own certificate` — `exec(host, "true", "claude")` → `sshd` stderr also contains `Accepted certificate ID "claude"`.
  - `a stopped master's socket does not fall back` — run `ssh -F /dev/null -S <that agent's socket> -O stop …` on a live master, wait for it to exit, then run the exec command directly with the same args → non-zero exit, and `sshd` logs no new `Accepted` or `Failed publickey` line.
  - `shutdown leaves nothing behind` — after the runner's shutdown, the runtime dir is gone and no `ssh-agent` from this test is alive.

- [ ] **Step 2: Run them**

Run: `cd packages/orchestrator && npx vitest run test/ca-integration.spec.ts`
Expected: PASS (5 tests) where OpenSSH and `sshd` are installed; skipped otherwise.

- [ ] **Step 3: Document.** In `README.md`, add `## CA Mode`:
  - The `[[cas]]` table (`name`, `key_cmd` / `key_env` / `key_file`, `principal`, `source_address`), host `ca` / `principal`, top-level `runtime_dir` and `known_hosts`.
  - **Host enrollment:** `cert-authority,principals="fleet" ssh-ed25519 AAAA… ssh-fleet-ca` in a **root-owned** authorized-keys file (`AuthorizedKeysFile /etc/ssh/authorized_keys/%u`, or `TrustedUserCAKeys` plus `AuthorizedPrincipalsFile`); why a user-writable `~/.ssh/authorized_keys` is a bypass; principal vs account.
  - **CA key at boot:** `key_cmd` for a keychain or password manager (`security find-generic-password -s ssh-fleet-ca -w`, `op read …`), a `0600` `key_file` owned by the hub user, or `key_env`; on stdin only, never on disk; no interactive unlock; canonical copy in the password manager.
  - **What a certificate allows:** 10 minutes, key ID = agent, no port / agent / X11 forwarding or `~/.ssh/rc`, optional `source_address`; masters retire at expiry; host keys trusted on first use in the hub's own `known_hosts`; `~/.ssh/config` is ignored (no `ProxyJump` yet).
  - **Revocation:** stop the hub (no new certificates; existing ones expire within 10 minutes); remove the CA line to cut access now; separate `[[cas]]` for separate trust domains.
  - **Enforcement:** run the hub as its own OS user (launchd / systemd) with no unrestricted `sudo` for the interactive user; stdio mode is ungoverned.
  - Add `ca` to the `[[hosts]]` auth table, a commented `[[cas]]` block and a `ca = "home"` host to `fleet.example.toml`, and `ca.ts` / `openssh.ts` / `proc.ts` to the core module list in `CLAUDE.md`.

- [ ] **Step 4: Run the full suite**

Run: `cd ../.. && pnpm -r validate`
Expected: all three packages pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/test/ca-integration.spec.ts packages/orchestrator/README.md packages/orchestrator/fleet.example.toml CLAUDE.md
git commit -m "test+docs(orchestrator): CA mode end to end against a self-hosted sshd"
```
