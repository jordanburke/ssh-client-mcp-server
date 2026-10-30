# Fleet Self-Service Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user can add `ssh-fleet-mcp-server` to an MCP client with no config and be told, from inside the client, exactly what to do next. On first start the server writes a commented starter `fleet.toml` and runs with zero hosts. It creates a CA key when a configured `key_file` doesn't exist yet. A read-only `fleet_setup` tool reports setup state: the config path, each host's connection state and last error, and each CA's public key with the line to paste on hosts. A `check` subcommand gives the same picture from a terminal by connecting to every host.

**Architecture:** Creation happens only in `main()`, before `server.start`. No tool writes config or keys, because the agent is the governed party and a tool that edits `fleet.toml` could loosen its own policy. A new `packages/orchestrator/src/setup.ts` holds the first-start steps (`ensureConfig`, `ensureCaKeyFiles`) and the pure report builder (`setupReport`). `src/template.ts` holds the starter config as a string. `runners.ts` gains per-host last-connect-error tracking, so `packages/core` is untouched. `check` is a subcommand of the same binary that reuses parsing, the runner and the auditor.

**Tech Stack:** TypeScript (ESM), functype, Node `fs`, OpenSSH `ssh-keygen` (already required by CA mode), vitest. No new npm dependencies.

**Spec:** No spec section covers first-run setup; this plan is the design, agreed with Jordan on 2026-10-30. It builds on `docs/superpowers/specs/2026-10-17-fleet-governance-design.md`: *The enforcement property* (why tools stay read-only) and *Seamless operation* / *Phase 3* (CA key at boot). Builds on Phases 1–3 (merged as `7d2f49b`, `900005e`, `1ef3e6a`).

**Branch:** `feat/self-service-setup` off `main`.

**Verified against OpenSSH 9.6p1 on Linux** while writing this plan: `ssh-keygen -q -t ed25519 -N "" -C <c> -f <path> </dev/null` writes the private key `0600` and `<path>.pub` `0644`, even inside a `0755` dir; with `<path>` already present it prints `Overwrite (y/n)?`, exits 1 and leaves the file unchanged; with a missing parent dir it exits 1 (`Saving key … failed: No such file or directory`). An empty functype `Map.of()` has size 0, so `createPool([])` builds an empty pool. macOS was not verified.

## Decisions (Jordan, 2026-10-30)

- **Only the default config path is created.** When no `--config=` flag and no `SSH_FLEET_CONFIG` are given and `~/.config/ssh-fleet/fleet.toml` is missing, the server writes the template there. An explicit path that doesn't exist stays a fatal error (`Cannot read fleet config at <path>: …`), so a typo can't produce a healthy-looking server with zero hosts.
- **Zero hosts is a valid config.** The server starts, serves every tool, and `fleet_setup` tells the user to add a host. `parseFleet` no longer rejects an empty `[[hosts]]` list; `fleetWarnings` warns instead.
- **A CA key is created only for a missing `key_file`.** Exactly when `[[cas]].key_file` is configured and `lstat` fails with `ENOENT`. A symlink, wrong mode, wrong owner or `EACCES` stays a startup error through the existing `fromFile` checks. `key_cmd` and `key_env` never create anything.
- **Deviation from the governance spec:** the spec prefers the CA key off disk, with the canonical copy in a password manager. A created key lives in a `0600` file owned by the hub user, which `key_file` already allows. The template's example puts it at `~/.local/state/ssh-fleet/ca-<name>`, never under `~/.config` (dotfile managers sync that). Users who want the stricter posture keep using `key_cmd` / `key_env`.
- **A CA can come before its hosts.** CA mode (key creation, custody, self-test) starts when `[[cas]]` is non-empty, not only when a host uses `ca`. So a user can add `[[cas]]`, restart, copy the enrollment line from `fleet_setup`, and add hosts afterwards.
- **Don't list the hub as a fleet host when its CA is a `key_file`.** An agent with `exec` on the hub machine could read the key file or use the private agent socket and sign its own certificates. This predates the plan (stdio-as-same-user is ungoverned), but `fleet_setup` now prints those paths, so the README says it in one line.
- **One client per config in CA mode.** A second server on the same config fails on `hub.lock` before `fleet_setup` exists, and Claude Desktop hides stderr. The README's First Run section says so and points at `runtime_dir`.
- **Restart to apply edits.** No hot reload; out of scope.
- **One starter config.** `packages/orchestrator/fleet.example.toml` is deleted; `FLEET_TEMPLATE` replaces it, and README Quick Start points at first start.

## Global Constraints

- **No tool writes.** `fleet_setup` has no parameters and changes nothing. Config and key creation run in `main()` before `server.start` and never again.
- **Created files:** config `0600` in a `0700` dir, written with flag `"wx"` (never overwrites). CA keys via `ssh-keygen` into a parent dir created `0700` if missing. Each created item prints one stderr line: `created fleet config at <path>` / `created CA "<name>" key at <path>; add its line to each host (see fleet_setup)`.
- **Never surface a `key_cmd` string** in tool output, stderr or audit lines: it can embed a token. Report the key source by kind (`key_cmd` / `key_env` / `key_file`), plus the path for `key_file` only.
- **Audited like `hosts_list`:** `fleet_setup` writes a decision and result line with `ALLOW` and no host. `check` writes one per host with tool `check`, agent `operator` and `fields: { bypass: "policy" }`.
- **`check` bypasses policy, on purpose.** It runs `true` on each host as the operator, from a terminal, not as an agent. A `readonly` allowlist would otherwise deny it. The bypass is audited (above), and `check` is not reachable over MCP.
- **Style:** functype FP style, Prettier, `pnpm validate` lint-clean. Code that must throw for a host contract sits in `@interop`-tagged declarations.

## Review Focus

1. **No MCP tool can write config or keys.** The guarantee is structural: `ensureConfig` and `ensureCaKeyFiles` are imported only by `index.ts` and called only from `main()` / `startCa`, before `server.start`. Check that by reading `index.ts`. Task 6's `fleet_setup changes nothing on disk` test is a backstop, not the proof.
2. **No secret value reaches the report** → Task 6 tests `the report never contains a key_cmd string` and `the report never contains a password value`.
3. **A mistyped `key_file` is visible, not silent.** A typo creates a new CA that no host trusts; every connect then fails with a bare `Permission denied`. Mitigation: the stderr line, `created_this_start: true` on the CA, and a `next_steps` entry naming the CA and its line → Task 4 and Task 6 tests `a created CA is flagged with its enrollment line`.
4. **`check`'s policy bypass is audited and marked** → Task 7 test `check writes an audit line per host` (`fields.bypass = "policy"`).
5. **An explicit missing config is still fatal** → Task 3 test `an explicit path that doesn't exist is not created`.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/orchestrator/src/template.ts` | create | `FLEET_TEMPLATE`, the starter config text |
| `packages/orchestrator/src/setup.ts` | create | `resolveConfigPath`, `ensureConfig`, `ensureCaKeyFiles`, `setupReport`, `enrollLine` |
| `packages/orchestrator/src/fleet.ts` | modify | zero hosts allowed; `authKind` / `passwordEnv` on `HostEntry`; warnings |
| `packages/orchestrator/src/runners.ts` | modify | `lastError` per known host; empty `unknown host` list wording |
| `packages/orchestrator/src/index.ts` | modify | first-start wiring, CA mode gated on `[[cas]]`, `fleet_setup` tool, instructions, `check` dispatch |
| `packages/orchestrator/fleet.example.toml` | delete | replaced by `FLEET_TEMPLATE` |
| `packages/orchestrator/src/check.ts` | create | `runCheck`: connect to each host, print a table, exit code |
| `packages/orchestrator/test/{template,setup,check}.spec.ts` | create | unit tests |
| `packages/orchestrator/test/{fleet,runners,ops}.spec.ts` | modify | zero hosts, last error, `fleet_setup` handler |
| `packages/orchestrator/README.md`, `CLAUDE.md` | modify | First run, `fleet_setup`, `check` |

---

### Task 1: Zero-host config

**Files:** `src/fleet.ts`, `src/runners.ts`, `test/fleet.spec.ts`, `test/runners.spec.ts`

- [ ] **Step 1: Write the failing tests**
  - `fleet.spec.ts` › `a config with no hosts parses` — `parseFleet("")` → `Right` with `hosts: []` and default pool/audit.
  - `fleet.spec.ts` › `no hosts is a warning` — `fleetWarnings` of that fleet contains `no hosts configured; add a [[hosts]] entry and restart`.
  - `runners.spec.ts` › `an empty fleet builds a runner` — `buildFleetRunner` of the empty fleet → `Right`; `status()` is `[]`; `exec("x", …)` rejects.
  - `runners.spec.ts` › `unknown host with no hosts says so` — `tmuxRunnerFor("x", …)` → `Left('unknown host "x" — no hosts are configured')`.
  - `fleet.spec.ts` › `each host records its auth kind` — one host per mode → `authKind` is `password_env`, `key`, `key_env`, `agent`, `ca`.
  - `fleet.spec.ts` › `password_env keeps the variable name, not just the value` — `passwordEnv` is `Some("MINI_PW")` whether or not the variable is set.
  - `fleet.spec.ts` › `an unset password_env is a warning` — var unset → `fleetWarnings` contains `host "mini": password_env MINI_PW is not set`.
- [ ] **Step 2: Run to verify they fail** — `cd packages/orchestrator && pnpm test -- fleet runners`
- [ ] **Step 3: Implement.** Delete the `Fleet config has no [[hosts]] entries` check. Add `authKind: "password_env" | "key" | "key_env" | "agent" | "ca"` and `passwordEnv: Option<string>` to `HostEntry`. Today `resolveHostAuth` resolves the password at parse time and drops the variable name, so an unset variable leaves no trace of which mode was meant; keep the name. Add both warnings to `fleetWarnings`. In `tmuxRunnerFor`, use the "no hosts are configured" wording when `names` is empty. The `exec` path's unknown-host error comes from core `pool.ts`; leave its wording alone and don't touch core.
- [ ] **Step 4: Run the package suite** — `pnpm test`
- [ ] **Step 5: Commit** — `feat(orchestrator): a fleet config with no hosts is valid`

### Task 2: The starter template

**Files:** `src/template.ts`, `test/template.spec.ts`

The template is all comments, so it parses to zero hosts. Example blocks sit between `# --- example: <title> ---` and `# --- end ---`. Inside a block, TOML lines start with `# ` and prose lines start with `## `, so "remove the leading `# `" turns a block into valid TOML and leaves the prose as comments.

```toml
# ssh-fleet-mcp-server config.
#
# Add at least one [[hosts]] entry, then restart the server. In Claude Code, use /mcp and
# reconnect. The fleet_setup tool shows what is configured and what is still missing.
#
# To use an example block, remove the leading "# " from each of its lines.
#
# Secrets never go in this file. Each host names one place its secret comes from:
#   password_env = env var holding a password    key = path to a private key
#   key_env      = env var holding a key (PEM)   agent = true (uses SSH_AUTH_SOCK)
#   ca           = a [[cas]] entry: the server signs a 10-minute certificate per connection
#
# Reference: https://github.com/jordanburke/ssh-client-mcp-server/tree/main/packages/orchestrator#fleet-config-schema

# --- example: host with a password from the environment ---
# [[hosts]]
# name = "mini"
# host = "mini.local"
# user = "me"
# password_env = "MINI_SSH_PASSWORD"
# --- end ---

# --- example: host with a key file ---
# [[hosts]]
# name = "build"
# host = "build.example.com"
# key = "~/.ssh/id_ed25519"
# --- end ---

# --- example: read-only policy for every host ---
## Only commands matching an allow pattern run. See the README's Policy section.
# [defaults.policy]
# mode = "readonly"
# allow = ['uptime', 'df -h']
# --- end ---

# --- example: certificate authority ---
## If key_file doesn't exist, the server creates it on first start. fleet_setup then shows
## the line to add to a root-owned authorized-keys file on each host. To keep the key off
## disk, use key_cmd (a command that prints it, e.g. a keychain read) or key_env instead.
# [[cas]]
# name = "home"
# key_file = "~/.local/state/ssh-fleet/ca-home"
#
# [[hosts]]
# name = "nas"
# host = "nas.local"
# user = "fleet"
# ca = "home"
# --- end ---
```

The reference URL matches `git remote get-url origin` (`package.json` has no `repository` field).

- [ ] **Step 1: Write the failing tests** in `test/template.spec.ts`. A helper `uncomment(block)` strips a leading `# ` from each line and leaves every other line alone.
  - `the template parses to zero hosts` — `parseFleet(FLEET_TEMPLATE)` → `Right`, `hosts: []`.
  - `every example block parses on its own` — for each block between the markers, `parseFleet(uncomment(block))` → `Right`. Assert at least four blocks were found, so a marker typo can't make the test pass vacuously.
  - `all example blocks parse together` — the template with every block uncommented → `Right` with hosts `mini`, `build`, `nas`.
  - `the template holds no inline secret fields` — no line matches `^\s*#?\s*(password|private_key)\s*=`. (`key_cmd` is a reference, not a secret, and the prose mentions it.)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** `export const FLEET_TEMPLATE = \`…\`` exactly as above.
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `feat(orchestrator): starter fleet.toml template`

### Task 3: First-start config creation

**Files:** `src/setup.ts`, `src/index.ts`, `test/setup.spec.ts`

`findConfigPath` moves to `setup.ts` as `resolveConfigPath(argv, env, home): Readonly<{ path: string; explicit: boolean }>`, where `explicit` is true for a `--config=` flag or `SSH_FLEET_CONFIG`.

`ensureConfig(resolved): Either<string, Readonly<{ path: string; created: boolean }>>`. There is no separate existence check, so the race path is the only path:
- `explicit` → never write. File exists → `Right({ created: false })`; missing → `Left("Cannot read fleet config at <path>: no such file (only the default path, <default>, is created on first start)")`.
- default → `mkdirSync(dirname, { recursive: true, mode: 0o700 })`, then `writeFileSync(path, FLEET_TEMPLATE, { flag: "wx", mode: 0o600 })` → `Right({ created: true })`. `EEXIST` (the file was already there, or another client won the race) → `Right({ created: false })`. Any other error → `Left` naming the path.

- [ ] **Step 1: Write the failing tests** (temp `home` per test)
  - `resolveConfigPath prefers the flag, then the env var, then the default` — and `explicit` is true, true, false.
  - `the default path is created from the template` — content equals `FLEET_TEMPLATE`, file mode `0600`, dir mode `0700`, `created: true`.
  - `an existing config is left alone` — pre-written content survives, `created: false`.
  - `an explicit path that doesn't exist is not created` — `Left` containing the path; nothing written.
  - `an existing default config hits EEXIST, not an error` — pre-create the file; `ensureConfig` → `created: false`, content unchanged. This is the same branch a lost race takes.
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** `setup.ts`; in `main()`, call `ensureConfig` before reading, print `created fleet config at <path>` when created, and keep `created` for the report.
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `feat(orchestrator): write a starter config at the default path on first start`

### Task 4: Create a missing CA `key_file`

**Files:** `src/setup.ts`, `src/index.ts`, `test/setup.spec.ts`

`ensureCaKeyFiles(cas, proc): Promise<Either<string, ReadonlyArray<string>>>` returns the names of CAs it created. For each CA whose key is `{ kind: "file" }`:
- `Path.expand` the path; `lstat` it. Not `ENOENT` → skip (the existing `fromFile` checks run later in custody and report any problem).
- `ENOENT` → `mkdirSync(dirname, { recursive: true, mode: 0o700 })`, then `proc.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "ssh-fleet-ca-<name>", "-f", <path>], { env: childEnv(), input: "" })`.
- Exit 0 → created. Non-zero but the file now exists (another process created it) → not created, not an error. Otherwise → `Left('CA "<name>": creating key_file <path> failed: <stderr>')`.

`startCa` changes in two ways:
- **Gate:** it runs when `fleet.cas.length > 0`, not only when some host uses `ca` (see Decisions). `buildFleetRunner`'s `caHosts.length > 0 && ca.isNone()` check stays as it is.
- **Return:** `Promise<Readonly<{ wiring: Option<CaWiring>; created: ReadonlyArray<string> }>>`. `CaWiring` is unchanged, because existing tests build it as a literal (`runners.spec.ts`, `ca-integration.spec.ts`) and the created names are startup metadata, not runtime wiring.

It calls `ensureCaKeyFiles` before `startCaCustody` and prints `created CA "<name>" key at <path>; add its line to each host (see fleet_setup)` per created CA.

A half-written key read by a second client during a creation race fails `ssh-add` and stops that server; a restart fixes it. The README notes this in one sentence; no code.

- [ ] **Step 1: Write the failing tests** (`describe.skipIf(!hasOpenSsh)` for the real `ssh-keygen` ones). Use absolute temp paths for `key_file`: `Path.expand` resolves `~` against the real home, not a test's temp dir.
  - `a missing key_file is created 0600` — real `ssh-keygen`; private key `0600`, `.pub` exists, returns `["home"]`; then `caKeySource` reads it → `Right`.
  - `an existing key_file is not touched` — bytes and mtime unchanged, returns `[]`.
  - `a wrong-mode key_file is not replaced` — `0644` file stays `0644` and unchanged; the later `fromFile` still rejects it.
  - `a dangling symlink is not followed or replaced` — `lstat` succeeds, so no creation; the symlink is unchanged.
  - `key_cmd and key_env never create anything` — fake `proc` records no `ssh-keygen` call.
  - `a failed ssh-keygen stops startup naming the CA` — fake `proc` exits 1 with stderr `boom`, file absent → `Left` containing `CA "home"` and `boom`.
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `feat(orchestrator): create a missing CA key_file on first start`

### Task 5: Last connect error per host

**Files:** `src/runners.ts`, `test/runners.spec.ts`

`FleetRunner` gains `lastError: (host: string) => Option<Readonly<{ message: string; at: string }>>`. `runOn` records a rejection's message with an ISO timestamp, then rethrows; a later successful run on that host clears it. Only configured hosts are recorded (`names.has(host)`): `runOn` is also reached for unknown names, and they must not grow the map. A resolved `CommandResult` with a non-zero exit code is not a connect error and records nothing. For CA hosts, the key is the host name, not (agent, host).

- [ ] **Step 1: Write the failing tests** (fake `ConnectFactory`)
  - `a failed connect is recorded` — factory rejects `ECONNREFUSED`; `exec` rejects; `lastError("a")` → `Some` with that message.
  - `a later success clears it`.
  - `a non-zero exit is not a connect error` — factory resolves with code 1 → `lastError` is `None`.
  - `an unknown host is not recorded` — `exec("nope", …)` rejects; `lastError("nope")` is `None`.
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `feat(orchestrator): remember each host's last connect error`

### Task 6: The `fleet_setup` tool

**Files:** `src/setup.ts`, `src/index.ts`, `test/setup.spec.ts`, `test/ops.spec.ts`

`setupReport(ctx, runner): SetupReport` is pure. `ctx` is built once in `main()` after startup:

```ts
type SetupContext = Readonly<{
  configPath: string
  configCreated: boolean
  fleet: Fleet
  caPublicKeys: Map<string, string> // functype Map: CA name → the line from custody's ca-<name>.pub
  caCreated: ReadonlyArray<string>
  runtimeDir: Option<string> // resolved, CA mode only
  knownHosts: Option<string> // resolved, CA mode only
}>
```

The report, returned as JSON like `hosts_list`:

```json
{
  "config": { "path": "…/fleet.toml", "created_this_start": true },
  "next_steps": ["…"],
  "hosts": [
    {
      "name": "nas", "address": "fleet@nas.local:22", "auth": "ca", "ca": "home", "principal": "fleet",
      "connections": [{ "name": "nas (unknown)", "state": "idle", "inFlight": 0 }],
      "last_error": { "message": "…", "at": "…" },
      "enroll_line": "cert-authority,principals=\"fleet\" ssh-ed25519 AAAA… ssh-fleet-ca-home"
    }
  ],
  "cas": [
    { "name": "home", "key_source": "key_file", "key_file": "~/.local/state/ssh-fleet/ca-home",
      "created_this_start": true, "public_key": "ssh-ed25519 AAAA… ssh-fleet-ca-home",
      "enroll_line": "cert-authority,principals=\"fleet\" ssh-ed25519 AAAA… ssh-fleet-ca-home" }
  ],
  "audit_log": "~/.local/state/ssh-fleet/audit.jsonl",
  "runtime_dir": "/run/user/1000/ssh-fleet",
  "known_hosts": "~/.local/state/ssh-fleet/known_hosts"
}
```

- `auth` is `HostEntry.authKind` (Task 1). A `password_env` host also gets `password_env: "<VAR>"` and `env_set: true|false`; the value is never read into the report. `SetupContext.fleet` carries resolved passwords in `HostEntry.auth`, so `setupReport` must not serialize `auth` or any whole `HostEntry`.
- `connections` are the `runner.status()` rows whose name is the host's name or starts with `<name> (`.
- `enroll_line` is `cert-authority,principals="<principal>" <public key line>`. A host's line uses its own `principal` override if set; the CA's line uses the CA default.
- `last_error`, `ca`, `principal`, `enroll_line`, `key_file`, `runtime_dir`, `known_hosts` are omitted when they don't apply.
- `next_steps`, in this order: zero hosts → `Add a [[hosts]] entry to <path>, then restart the server.`; each `password_env` host with `env_set: false` → `<host>: set <VAR> in the MCP client's env for this server, then restart.`; each created CA → `Add CA "<name>"'s line to a root-owned authorized-keys file on each host that uses it: <enroll_line>`; each host with `last_error` → `<host>: <message>`. Empty when nothing is pending.

The handler: `fleetSetup: () => auditor.audited(call("fleet_setup", Option.none(), ALLOW), () => Promise.resolve(JSON.stringify(setupReport(ctx, runner))), noSummary)`. `makeHandlers` takes the context as a third argument. Register it as `fleet_setup`, description `Show setup state: config path, each host's connection state and last error, each CA's public key and the line to add on hosts, and what to do next. Read-only.`

The server `instructions` string gains: `Call fleet_setup first if hosts_list is empty or a host fails to connect; it says what to configure next.` With zero hosts, `hosts_list` returns `[]` and a model otherwise has no reason to call `fleet_setup`.

- [ ] **Step 1: Write the failing tests.** First update `ops.spec.ts`'s `withAudit` helper to pass a `SetupContext` as `makeHandlers`'s third argument, so the suite compiles throughout.
  - `setup.spec.ts` › `an empty fleet says to add a host` — `next_steps[0]` names the config path.
  - `setup.spec.ts` › `a created CA is flagged with its enrollment line` — `created_this_start: true`, `enroll_line` starts `cert-authority,principals="fleet" ssh-ed25519 `, and `next_steps` contains it.
  - `setup.spec.ts` › `a host principal override changes the host's line only`.
  - `setup.spec.ts` › `auth kinds are reported` — one host per kind.
  - `setup.spec.ts` › `the report never contains a key_cmd string` — CA with `key_cmd = "bws get --token SECRET123"`; `JSON.stringify(report)` lacks `SECRET123` and `bws`; `key_source` is `key_cmd`.
  - `setup.spec.ts` › `the report never contains a password value` — host with `password_env = "MINI_PW"`, `MINI_PW=SECRET-PW`; `JSON.stringify(report)` lacks `SECRET-PW`, has `env_set: true`.
  - `setup.spec.ts` › `an unset password_env is a next step` — `env_set: false` and a `next_steps` line naming the variable.
  - `setup.spec.ts` › `a CA with no hosts still shows its line` — one `[[cas]]`, zero hosts → the CA row has `public_key` and `enroll_line`.
  - `setup.spec.ts` › `a host's last error appears in the report and next_steps`.
  - `ops.spec.ts` › `fleet_setup is audited like hosts_list` — one decision line (`tool: "fleet_setup"`, `decision: "allow"`, no host) and one result line.
  - `ops.spec.ts` › `fleet_setup changes nothing on disk` — snapshot a temp config dir (names, sizes, mtimes) before and after the call; equal.
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** `setupReport`, `enrollLine`, the handler and registration. In `main()`, read each `custody.pubPath(name)` file once to fill `caPublicKeys`.
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `feat(orchestrator): fleet_setup tool reports setup state and next steps`

### Task 7: `check` subcommand

**Files:** `src/check.ts`, `src/index.ts`, `test/check.spec.ts`

`ssh-fleet-mcp-server check [--config=<path>]` runs in a terminal. It never creates config or keys.

1. Resolve the config path. Missing → print `No fleet config at <path>. Start the server once to create one at the default path, or pass --config=.` and exit 1.
2. Parse; print errors and exit 1. Print warnings.
3. Open the audit log (proves it's writable).
4. Before custody, `lstat` each CA's `key_file` (same `ENOENT` test as `ensureCaKeyFiles`). A missing one marks that CA's hosts `FAIL … key_file missing: the server creates it on first start`, and that CA is left out of custody. (Custody can't report per CA: a missing file fails `startCaCustody` as a whole.) If any CAs remain, start CA mode for them with runtime dir `<runtimeDir>-check`, so a running server's `hub.lock` doesn't block it. Custody shuts down at the end, removing that dir. Non-CA hosts are probed either way.
5. For every remaining host in parallel: `runner.exec(host, "true", "operator")`, audited with tool `check`, agent `operator`, `ALLOW`, `fields: { bypass: "policy" }`, so a grep separates operator probes from agent calls. Policy is not evaluated (see Global Constraints), so `mode = "deny"` hosts are probed too.
6. Print each host's line as it finishes (an unreachable host can take about 20 s, ssh2's ready timeout), then each CA's enroll line:
   ```
   ok    mini   me@mini.local:22         password_env   212 ms
   FAIL  nas    fleet@nas.local:22       ca             Permission denied (publickey).
   CA home: cert-authority,principals="fleet" ssh-ed25519 AAAA… ssh-fleet-ca-home
   ```
   A non-zero exit of `true` is a failure, shown with its stderr.
7. Shut the runner down; exit 0 if every host passed, else 1. With zero hosts, print `No hosts configured; add a [[hosts]] entry to <path>.` and exit 0.

`runCheck(deps)` takes the runner, auditor, fleet and an output writer, so it is testable without a process. `main()` dispatches when `process.argv[2] === "check"`.

- [ ] **Step 1: Write the failing tests** (fake runner)
  - `every host passing exits 0` and prints an `ok` line per host.
  - `a failing host exits 1` and prints its error.
  - `check writes an audit line per host` — tool `check`, agent `operator`, `fields.bypass = "policy"`.
  - `a missing key_file fails only its CA's hosts` — CA `a` with a missing `key_file`, CA `b` fine, plus a password host → `a`'s host `FAIL` with the first-start hint; the others are probed.
  - `zero hosts exits 0` and prints the add-a-host line.
  - `check ignores a readonly policy` — host with `mode = "readonly"`, no allow → still runs `true`.
  - `a missing config exits 1 without creating it`.
  - `the check runtime dir is separate` — derived path is `<runtimeDir>-check` and stays under the 86-byte socket check (a too-long one fails with the existing message).
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `feat(orchestrator): check subcommand connects to every host`

### Task 8: Docs

**Files:** `packages/orchestrator/README.md`, `CLAUDE.md`

- [ ] **README:** a **First Run** section before *Config Discovery*: add the server with no `--config`, call `fleet_setup`, edit the created file, restart. Note that only the default path is created. Add `fleet_setup` under *Tools* with the report shape. Add `check` under a **Command Line** heading. In *CA Mode › The CA key at boot*, add the created-`key_file` behavior and its trade-off against `key_cmd`. In *`[[hosts]]`*, change "required, one or more" to "zero or more; with none, the server starts and `fleet_setup` says what to add". In *Client Setup*, show the no-`--config` form first. Quick Start points at first start instead of `fleet.example.toml`; delete that file. First Run also says: one client per config in CA mode (see `runtime_dir`); don't list the hub machine as a fleet host when its CA is a `key_file`; a creation race between two clients can fail one start, and a restart fixes it. Under *Command Line*, say `check` runs `true` on each host, so a `ForceCommand` account fails it.
- [ ] **CLAUDE.md:** list `setup.ts`, `template.ts`, `check.ts` under the orchestrator; add `fleet_setup` to its tools; config discovery notes first-start creation at the default path.
- [ ] **Validate:** `pnpm -r validate` from the repo root.
- [ ] **Commit** — `docs: first run, fleet_setup and check`
