# Fleet Governance Phase 1 (Audit Log) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `ssh-fleet-mcp-server` tool call writes a `decision` line before it runs and a `result` line after, to an append-only JSONL file the hub owns.

**Architecture:** A new `packages/orchestrator/src/audit.ts` holds a pure `Auditor` (injected sink, clock and id generator) plus `openAuditLog`, the file-backed sink. `makeHandlers` takes the auditor and wraps each tool's work in `auditor.audited(...)`, following the existing injected-seam pattern (`FleetRunner`, `ConnectFactory`). `parseFleet` gains an `[audit]` table and a per-host `log_output` flag; `main` opens the log before building the runner and exits if it can't.

**Tech Stack:** TypeScript (ESM), functype (`Either`, `Option`, `Map`, `Try`, `Wire`), functype-os (`Path.expand`), somamcp (`UserError`), node `fs` / `crypto`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-fleet-governance-design.md` — section *Phase 1 — Audit log*, plus the audit rows of *Error handling* and *Testing strategy*.

**Branch:** `feat/governance-audit` off `main`.

## Global Constraints

- **Default path:** `~/.local/state/ssh-fleet/audit.jsonl` under the hub user, file mode `0600`.
- **Two lines per call,** sharing `id`: `event: "decision"` written **before** execution, `event: "result"` after.
- **Sizes, not contents.** `exec` records the command and output byte sizes. Opt-in `log_output = true` per host adds a truncated excerpt (`exec` only).
- **tmux:** `tmux_send` logs the input text; `tmux_read` logs only the line count.
- **Agent:** always `"unknown"` in Phase 1 (identity arrives in Phase 4).
- **No policy yet:** `decision` is always `"allow"`; there is no `rule` field until Phase 2.
- **Fatal at startup:** an audit path that isn't writable. **Fatal per call:** any audit write failure — no unaudited execution.
- **Out of scope:** rotation, an off switch, remote sinks. Append-only flags (`chattr +a`, `chflags uappend`) are documented, not set by code.
- **Style:** functype FP style, Prettier (no semicolons, 120 cols), `pnpm validate` lint-clean. Throws of `UserError` carry `/** @interop somamcp reports a tool failure to the client only when the handler throws UserError. */`. The on-disk line shape is a `Wire<…>` type.

## Review Focus

1. **A command containing a newline or quotes** must still produce exactly one parseable JSON line → Task 1 test `a command with a newline stays one line`.
2. **An existing audit file with wider permissions (`0644`)** must be tightened to `0600` at startup → Task 2 test `tightens an existing 0644 file to 0600`.
3. **Two calls in flight at once** must each yield a complete decision/result pair with distinct ids, decision first → Task 4 test `concurrent calls each get a complete pair`.
4. **Multi-byte output** must count UTF-8 bytes, and an excerpt must not split a character → Task 1 test `excerpt keeps whole code points`, Task 4 test `stdout_bytes counts UTF-8 bytes`.
5. **A call rejected before it reaches a host** (unknown host) must still be audited, with `status: "error"` → Task 4 test `an unknown host is still audited`.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/orchestrator/src/audit.ts` | create | line types, `createAuditor`, `openAuditLog`, `excerpt` |
| `packages/orchestrator/test/audit.spec.ts` | create | auditor + file sink tests |
| `packages/orchestrator/src/fleet.ts` | modify | `Fleet.audit`, `HostEntry.logOutput`, validation |
| `packages/orchestrator/src/runners.ts` | modify | `FleetRunner.logOutputFor` |
| `packages/orchestrator/src/index.ts` | modify | `makeHandlers(runner, auditor)`, `main` wiring |
| `packages/orchestrator/test/{fleet,ops,runners}.spec.ts` | modify | config + handler audit tests |
| `packages/orchestrator/README.md`, `fleet.example.toml`, `CLAUDE.md` | modify | docs |

---

### Task 1: The auditor

**Files:**
- Create: `packages/orchestrator/src/audit.ts`
- Test: `packages/orchestrator/test/audit.spec.ts`

**Interfaces:**
- Produces (all exported from `audit.ts`):
  - `type AuditFields = Wire<Readonly<Record<string, string | number | boolean | ReadonlyArray<string> | undefined>>>`
  - `type AuditCall = Readonly<{ agent: string; tool: string; host: Option<string>; fields: AuditFields }>`
  - `type AuditSink = (line: string) => void` — appends one line; throws on failure.
  - `type Auditor = Readonly<{ audited: <A>(call: AuditCall, run: () => Promise<A>, summarize: (a: A) => AuditFields) => Promise<A> }>`
  - `createAuditor(deps: Readonly<{ sink: AuditSink; now: () => Date; newId: () => string }>): Auditor`
  - `EXCERPT_CHARS = 1024`; `excerpt(s: string): string` — the first 1024 **code points** of `s`.
  - `AGENT_UNKNOWN = "unknown"`

Line shapes (keys in this order; `host` omitted when `None`; `undefined` field values omitted by `JSON.stringify`):
- decision: `{ ts, id, event: "decision", agent, tool, host, ...fields, decision: "allow" }`
- result: `{ ts, id, event: "result", agent, tool, host, status: "ok" | "error", ms, ...summary, error? }`

`ts` is `now().toISOString()`. `ms` is the difference between the two `now()` readings. On `status: "error"`, `error` is the thrown value's message and `summary` is not called.

- [ ] **Step 1: Write the failing tests** in `test/audit.spec.ts`. Use a memory sink (`lines: string[]`), `newId: () => "id-1"`, and a clock that returns `2026-10-17T14:02:11.000Z`, then `+412 ms`:
  - `writes a decision line before running the call` — inside `run`, `lines` has length 1 and `JSON.parse(lines[0])` matches `{ id: "id-1", event: "decision", agent: "unknown", tool: "exec", host: "box-a", command: "uptime", decision: "allow" }`.
  - `writes a result line with status, ms and the summary` — `run` resolves `{ code: 0 }`, `summarize` returns `{ code: 0, stdout_bytes: 6 }`; `lines[1]` matches `{ id: "id-1", event: "result", status: "ok", ms: 412, code: 0, stdout_bytes: 6 }`; `audited` resolves `{ code: 0 }`.
  - `a run that throws still yields both lines and rethrows` — `run` rejects `new Error("boom")`; `audited` rejects with that error; `lines[1]` matches `{ status: "error", error: "boom" }`.
  - `a decision write failure stops the call` — the sink throws on its first call; `run` is never called; `audited` rejects with a `UserError` whose message contains `"call not executed"`.
  - `a result write failure fails the call` — the sink throws on its second call; rejects with a `UserError` containing `"after execution"`.
  - `a command with a newline stays one line` — `fields: { command: 'echo "a"\nrm x' }`; every entry in `lines` contains no `"\n"` and `JSON.parse(lines[0]).command === 'echo "a"\nrm x'`.
  - `omits host for host-less tools` — `host: Option.none()`; `"host" in JSON.parse(lines[0])` is `false`.
  - `excerpt keeps whole code points` — `excerpt("x".repeat(2000)).length === 1024`; `Array.from(excerpt("😀".repeat(2000))).length === 1024`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/orchestrator && npx vitest run test/audit.spec.ts`
Expected: FAIL — `Cannot find module '../src/audit.js'`.

- [ ] **Step 3: Implement `createAuditor`, `excerpt` and the types in `src/audit.ts`.** Wrap each sink write so a throw becomes `UserError("audit log write failed — call not executed: <msg>")` (decision) or `UserError("audit log write failed after execution: <msg>")` (result). If both `run` and the result write fail, the audit `UserError` wins. Tag the function holding the throws `@interop`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/audit.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/audit.ts packages/orchestrator/test/audit.spec.ts
git commit -m "feat(orchestrator): auditor writes decision and result lines per call"
```

---

### Task 2: The file sink

**Files:**
- Modify: `packages/orchestrator/src/audit.ts`
- Test: `packages/orchestrator/test/audit.spec.ts`

**Interfaces:**
- Consumes: `AuditSink` (Task 1).
- Produces: `DEFAULT_AUDIT_PATH = "~/.local/state/ssh-fleet/audit.jsonl"`; `openAuditLog(path: string): Either<string, AuditSink>`.

Behavior: expand `path` with functype-os `Path.expand`; `mkdirSync(dirname, { recursive: true, mode: 0o700 })`; create the file if absent with mode `0o600`; `chmodSync(file, 0o600)` so an existing wider file is tightened; return a sink that calls `appendFileSync(file, line + "\n")`. Any failure is `Left("audit log <expanded path> is not writable: <msg>")`. An invalid expansion is `Left("invalid audit path <path>: <msg>")`.

- [ ] **Step 1: Write the failing tests** (each in a fresh `mkdtempSync(join(tmpdir(), "audit-"))`):
  - `creates missing directories and a 0600 file` — `openAuditLog(join(dir, "a/b/audit.jsonl"))` is `Right`; `statSync(file).mode & 0o777` is `0o600`.
  - `tightens an existing 0644 file to 0600` — write the file with mode `0o644` first; after `openAuditLog`, mode is `0o600`.
  - `appends lines after existing content` — file starts as `"old\n"`; after `sink("a")`, `sink("b")` it reads `"old\na\nb\n"`.
  - `fails when the path is a directory` — `openAuditLog(dir)` is `Left` and the message contains `dir`.
  - `expands ~` — with `process.env.HOME = dir` (restored after), `openAuditLog("~/x/audit.jsonl")` creates `join(dir, "x/audit.jsonl")`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/audit.spec.ts`
Expected: FAIL — `openAuditLog is not a function`.

- [ ] **Step 3: Implement `openAuditLog` and `DEFAULT_AUDIT_PATH` in `src/audit.ts`,** using `Try(...)` for the filesystem calls.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/audit.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/audit.ts packages/orchestrator/test/audit.spec.ts
git commit -m "feat(orchestrator): file-backed audit sink with 0600 mode and startup check"
```

---

### Task 3: Fleet config — `[audit]` and `log_output`

**Files:**
- Modify: `packages/orchestrator/src/fleet.ts`, `packages/orchestrator/src/runners.ts`
- Modify: `packages/orchestrator/README.md`, `packages/orchestrator/fleet.example.toml`
- Test: `packages/orchestrator/test/fleet.spec.ts`, `packages/orchestrator/test/runners.spec.ts`

**Interfaces:**
- Consumes: `DEFAULT_AUDIT_PATH` (Task 2).
- Produces:
  - `type AuditSettings = Readonly<{ path: string }>`; `Fleet` becomes `Readonly<{ hosts: HostEntry[]; pool: PoolSettings; audit: AuditSettings }>`.
  - `HostEntry` gains `logOutput: boolean`.
  - `FleetRunner` gains `logOutputFor: (host: string) => boolean` (`false` for an unknown host), built in `makeRunner` from a functype `Map` like `sessions`.

`parseFleet` keeps the path unexpanded; `openAuditLog` expands it.

- [ ] **Step 1: Write the failing tests**
  - `fleet.spec.ts` `defaults the audit path` — a config with no `[audit]` gives `fleet.audit.path === "~/.local/state/ssh-fleet/audit.jsonl"`.
  - `reads [audit].path` — `[audit]\npath = "/var/log/fleet/audit.jsonl"` gives that path.
  - `rejects an empty [audit].path` — `path = ""` is `Left` containing `"audit.path must be a non-empty string"`.
  - `reads log_output per host, default false` — one host with `log_output = true`, one without: `logOutput` is `true` / `false`.
  - `rejects a non-boolean log_output` — `log_output = "yes"` is `Left` containing `host "box-a": log_output must be true or false`.
  - `runners.spec.ts` `logOutputFor reflects the host entry` — `true` for the flagged host, `false` for the other and for `"nope"`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/fleet.spec.ts test/runners.spec.ts`
Expected: FAIL on the 6 new tests.

- [ ] **Step 3: Implement** `AuditSettings` / `parseAudit(raw)` and the `log_output` check inside `parseHost` in `fleet.ts`, and `logOutputFor` in `runners.ts`. Update the fake runner in `test/ops.spec.ts` (`recording()`) to include `logOutputFor: () => false` so it still compiles.

- [ ] **Step 4: Document the config.** In `README.md` add an `### [audit] (optional)` table (`path`, string, default `~/.local/state/ssh-fleet/audit.jsonl`) under *Fleet Config Schema*, and a `log_output` row (bool, no, "Add a 1024-character excerpt of `exec` output to the audit log. Off by default because output can contain secrets.") to the `[[hosts]]` table. Add a commented `[audit]` block and one `log_output = true` example to `fleet.example.toml`.

- [ ] **Step 5: Run the package suite**

Run: `pnpm validate`
Expected: format, lint, typecheck, test and build all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): [audit] path and per-host log_output in fleet config"
```

---

### Task 4: Audit every tool call

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/README.md`, `CLAUDE.md`
- Test: `packages/orchestrator/test/ops.spec.ts`

**Interfaces:**
- Consumes: `createAuditor`, `Auditor`, `AuditFields`, `AGENT_UNKNOWN`, `excerpt`, `openAuditLog` (Tasks 1–2); `Fleet.audit`, `FleetRunner.logOutputFor` (Task 3).
- Produces: `makeHandlers(runner: FleetRunner, auditor: Auditor)`.

Each handler calls `auditor.audited({ agent: AGENT_UNKNOWN, tool, host, fields }, run, summarize)`:

| tool | `host` | decision `fields` | result `summary` |
| --- | --- | --- | --- |
| `hosts_list` | `None` | `{}` | `{}` |
| `exec` | `Some(host)` | `{ command }` | `{ code, stdout_bytes, stderr_bytes }`, plus `stdout_excerpt` / `stderr_excerpt` when `runner.logOutputFor(host)` |
| `tmux_list` | `Some(host)` | `{}` | `{}` |
| `tmux_send` | `Some(host)` | `{ session, input, submit }` | `{}` |
| `tmux_read` | `Some(host)` | `{ session, lines }` (resolved: default 200) | `{ stdout_bytes }` |
| `tmux_keys` | `Some(host)` | `{ session, keys }` | `{}` |

`session` is the resolved target session. Byte sizes use `Buffer.byteLength(s, "utf8")`. For `exec`, `run` is `runner.exec(host, command)`, so the result line records the real `code` and sizes; the existing "non-empty stderr → `UserError`" mapping stays in the handler, **after** `audited` returns. For the tmux tools, `run` is the handler's whole current body, so an unknown host (`tmuxRunnerFor` → `Left`) is audited as `status: "error"`.

- [ ] **Step 1: Write the failing tests** in `ops.spec.ts`. Add a helper `withAudit(runner, newId = () => "id-1")` returning `{ h: makeHandlers(runner, auditor), lines }` over a memory sink, and switch the existing tests to it. New tests (parse `lines` with `JSON.parse`):
  - `exec writes a decision and a result` — decision matches `{ event: "decision", agent: "unknown", tool: "exec", host: "box-b", command: "whoami", decision: "allow" }`; result matches `{ event: "result", status: "ok", code: 0, stdout_bytes: 6, stderr_bytes: 0 }` with no `stdout_excerpt` key.
  - `exec adds excerpts for a log_output host` — runner with `logOutputFor: (h) => h === "box-b"`; result has `stdout_excerpt: "agent\n"`.
  - `exec with stderr is audited as ok, then the handler throws` — runner returns `{ stdout: "", stderr: "denied\n", code: 1 }`; `h.exec` rejects; result line matches `{ status: "ok", code: 1, stderr_bytes: 7 }`.
  - `stdout_bytes counts UTF-8 bytes` — stdout `"é\n"`; `stdout_bytes: 3`.
  - `tmux_send logs the input text` — decision matches `{ tool: "tmux_send", session: "agent", input: "ls -la", submit: true }`.
  - `tmux_read logs the line count, not the transcript` — the fake runner returns stdout `"SECRET-OUTPUT\n"`; decision matches `{ tool: "tmux_read", lines: 200 }`, result matches `{ stdout_bytes: 14 }`, and `lines.join("")` does not contain `"SECRET-OUTPUT"`.
  - `an unknown host is still audited` — `tmuxRunnerFor` returns `Left('unknown host "z"')`; `h.tmuxList({ host: "z" })` rejects; lines are a decision and a result with `status: "error"`.
  - `concurrent calls each get a complete pair` — `newId` counts up; `await Promise.all([h.exec(a), h.exec(b)])`; 4 lines, 2 distinct ids, and for each id the decision index is below the result index.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/ops.spec.ts`
Expected: FAIL — `makeHandlers` ignores its second argument, so no lines are written.

- [ ] **Step 3: Implement the handler changes** in `makeHandlers`, per the table above.

- [ ] **Step 4: Wire `main`.** After `parseFleet` and before `buildFleetRunner`: `openAuditLog(fleet.audit.path)`, and on `Left` print the message to stderr and `process.exit(1)` (same shape as the existing config errors). Build `createAuditor({ sink, now: () => new Date(), newId: randomUUID })` (`node:crypto`) and pass it to `makeHandlers`. Add `audit: <path>` to the startup banner on stderr.

- [ ] **Step 5: Document.** In `README.md` add an `## Audit Log` section: the two line shapes with one example pair, what is and isn't recorded (per the table), `log_output`, that a write failure fails the call, that rotation is out of scope, and the append-only tip (`sudo chattr +a <file>` on Linux, `sudo chflags uappend <file>` on macOS, from an administrator account). In `CLAUDE.md`, add `audit.ts` to the orchestrator module list.

- [ ] **Step 6: Run the full suite**

Run: `cd ../.. && pnpm -r validate`
Expected: all three packages pass; the connector and core suites are unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator CLAUDE.md
git commit -m "feat(orchestrator): audit every tool call to the JSONL log"
```
