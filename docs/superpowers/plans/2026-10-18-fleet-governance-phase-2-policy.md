# Fleet Governance Phase 2 (Policy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-host `readonly` / `readwrite` / `deny` rules in `fleet.toml`, checked before every tool call, with each decision and the rule behind it written to the audit log.

**Architecture:** A new pure module `packages/orchestrator/src/policy.ts` parses and validates policy tables and evaluates a request to a `Verdict`. `parseFleet` resolves one `HostPolicy` per host (host keys override `[defaults.policy]` keys). Each handler evaluates its request and hands the `Verdict` to the Phase 1 auditor, which writes `decision` and `rule` and, on a denial, throws without running the call. With no policy configured anywhere, behavior is identical to Phase 1.

**Tech Stack:** TypeScript (ESM), functype (`Either`, `Option`), somamcp (`UserError`), smol-toml, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-fleet-governance-design.md` — section *Phase 2 — Policy*, plus the policy rows of *Error handling* and *Testing strategy*. Builds on Phase 1 (`docs/superpowers/plans/2026-10-17-fleet-governance-phase-1-audit.md`, merged as `7d2f49b`).

**Branch:** `feat/governance-policy` off `main`.

## Global Constraints

- **Modes:** `"readonly" | "readwrite" | "deny"`. **tmux gate:** `"approve" | "open"` (applies to `tmux_send` / `tmux_keys`).
- **Built-in defaults** (no `[defaults.policy]`, no `[hosts.policy]`): `mode = "readwrite"`, `tmux = "open"`, no `allow`, no `needs_approval`, no `agents` — so an existing config behaves exactly as in Phase 1. (The spec's example `tmux = "approve"` is a configured default, not the built-in one.)
- **Merging:** each key in `[hosts.policy]` replaces the same key from `[defaults.policy]`; lists are replaced, never concatenated. Cross-key rules are checked on the **merged** policy.
- **An empty list means "not set":** `allow = []`, `needs_approval = []` and `agents = []` behave as if absent. `allow = []` is the documented way for a host to drop an inherited `allow` when it overrides `mode`.
- **Unknown keys are fatal:** a policy table may contain only `mode`, `tmux`, `allow`, `needs_approval`, `agents`, so a typo like `needs_aproval` can't silently delete a tripwire.
- **Readonly:** reject a command containing `\n`, `\r`, `\0`, or any of `` ; & | $ ` ( ) < > { } \ ' " * ? [ ~ ``; otherwise require a full match of some `allow` pattern, wrapped as `^(?:…)$`, compiled with **no regex flags**.
  - **Decision (Jordan, 2026-10-18; the spec is amended to match):** the spec's original list omitted `` \ ' " * ? [ ~ ``. Commands run under the remote `$SHELL -c`, where all of these carry meaning (escapes, quoting, globbing, home expansion), so an operator's loose pattern such as `.*` would let them through. The cost: a readonly command can't contain quotes or globs (e.g. `journalctl --since "1 hour ago"`).
  - The README states: never use `.`, `.*` or `\S` in an `allow` pattern; spell out the characters allowed, as the spec's examples do (`[\w@.-]+`).
- **Readwrite:** a `needs_approval` pattern matching **anywhere** (unanchored) requires approval.
- **No approval channel until Phase 5:** anything that requires approval is **denied** (fail closed), naming the rule.
- **tmux:** `allow` / `needs_approval` apply to `exec` only. `tmux_send` / `tmux_keys` are denied under `readonly`; under `readwrite`, `tmux = "approve"` denies (no approval yet) and `"open"` allows. `tmux_list` / `tmux_read` are allowed unless the host is `deny` or the agent is excluded. `hosts_list` is never gated.
- **Agents:** a non-empty `agents = [...]` is enforced now. The Phase 1 agent is `"unknown"`, so such a host denies every call until Phase 4, and **startup prints a warning to stderr naming each such host**. An entry matches an agent equal to it or starting with `<entry>@`.
- **Denial message:** `UserError("[<host>] denied by rule <rule>: <reason>")`. **Audit:** the decision line carries `decision: "allow" | "deny"` and `rule: "<host>:<rule>"`; a denied call writes **only** the decision line (with `reason`) — nothing ran, so there is no result line.
- **Startup validation is fatal** and joins the existing `Fleet config errors:` list: invalid regex, unknown `mode` / `tmux`, unknown policy key, a non-empty `allow` without `readonly`, a non-empty `needs_approval` without `readwrite`, non-string-array lists.
- **Out of scope:** approval (Phase 5), real agent identity (Phase 4), per-host `max_timeout_ms`.
- **Style:** functype FP style, Prettier, `pnpm validate` lint-clean; throws of `UserError` sit in `@interop`-tagged declarations.

## Review Focus

1. **A config with no policy at all** must behave exactly as Phase 1, including `tmux_send` → Task 5 test `no policy configured: every tool still runs`.
2. **Whitespace a person might not notice** (`"uptime "`, a tab, `\r`) under `readonly` → Task 2 tests `trailing space is not trimmed` and `carriage return is a newline`.
3. **An allow pattern with a bare alternation** (`"df -h|uptime"`) must still be anchored as a whole → Task 2 test `alternation is anchored as a whole` (its deny rows, `"xuptime"` and `"df -hx"`, both pass an unwrapped `^df -h|uptime$`, so they catch a missing wrap).
4. **Agent name matching** must not be a plain prefix (`claude` matches `claude@laptop`, not `claudex`) → Task 2 test `agents match by name or name@instance`.
5. **An unknown host** must keep its Phase 1 error path rather than a policy denial → Task 5 test `an unknown host is not a policy denial`.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/orchestrator/src/policy.ts` | create | types, `parsePolicyTable`, `resolvePolicy`, `evaluate` |
| `packages/orchestrator/test/policy.spec.ts` | create | table-driven parse and evaluation tests |
| `packages/orchestrator/src/fleet.ts` | modify | `HostEntry.policy`, `[defaults.policy]` / `[hosts.policy]` |
| `packages/orchestrator/src/runners.ts` | modify | `FleetRunner.policyFor` |
| `packages/orchestrator/src/audit.ts` | modify | `AuditCall.verdict`; deny path |
| `packages/orchestrator/src/index.ts` | modify | each handler evaluates and passes its verdict |
| `packages/orchestrator/test/{fleet,runners,audit,ops}.spec.ts` | modify | integration tests |
| `packages/orchestrator/README.md`, `fleet.example.toml`, `CLAUDE.md` | modify | docs, incl. a sample restricted account |

---

### Task 1: Policy tables — parse and validate

**Files:**
- Create: `packages/orchestrator/src/policy.ts`
- Test: `packages/orchestrator/test/policy.spec.ts`

**Interfaces:**
- Produces:
  - `type PolicyMode = "readonly" | "readwrite" | "deny"`; `type TmuxGate = "approve" | "open"`
  - `type PolicyTable = Readonly<{ mode: Option<PolicyMode>; tmux: Option<TmuxGate>; allow: Option<ReadonlyArray<string>>; needsApproval: Option<ReadonlyArray<string>>; agents: Option<ReadonlyArray<string>> }>` — one parsed TOML table, every key optional.
  - `type HostPolicy = Readonly<{ mode: PolicyMode; tmux: TmuxGate; allow: ReadonlyArray<RegExp>; needsApproval: ReadonlyArray<RegExp>; agents: Option<ReadonlyArray<string>> }>` — `allow` regexes are already wrapped `^(?:…)$`; `needsApproval` regexes are unanchored.
  - `EMPTY_TABLE: PolicyTable` (all `None`).
  - `parsePolicyTable(raw: unknown, where: string): Either<ReadonlyArray<string>, PolicyTable>` — `where` prefixes each error (`"defaults.policy"` or `host "box-a": policy`). `undefined` → `Right(EMPTY_TABLE)`.
  - `resolvePolicy(where: string, defaults: PolicyTable, host: PolicyTable): Either<ReadonlyArray<string>, HostPolicy>` — host keys override, built-in defaults fill the rest, empty lists become "not set" (`agents` → `None`), regexes are compiled with no flags, cross-key rules are checked on the merged result.

Error strings (exact; `<where>` as passed):
- `<where>.mode must be one of readonly, readwrite, deny`
- `<where>.tmux must be approve or open`
- `<where>.<key> must be an array of strings` (`<key>` is the TOML name: `allow`, `needs_approval`, `agents`)
- `<where>: invalid regex in <key>: "<pattern>" (<message>)`
- `<where>: allow applies only to mode = "readonly"`
- `<where>: needs_approval applies only to mode = "readwrite"`
- `<where> must be a table` (raw is present but not a plain object)
- `<where>: unknown key "<key>"`

- [ ] **Step 1: Write the failing tests** in `test/policy.spec.ts` (`describe("parsePolicyTable / resolvePolicy")`). Tests build tables by passing raw TOML-shaped objects through `parsePolicyTable` (its fields are `Option`s):
  - `no tables resolve to the built-in default` — `resolvePolicy("host \"a\": policy", EMPTY_TABLE, EMPTY_TABLE)` is `Right` with `mode: "readwrite"`, `tmux: "open"`, empty `allow` and `needsApproval`, `agents` `None`.
  - `host keys override defaults; lists replace` — defaults `{ mode: "readonly", allow: ["uptime"] }`, host `{ allow: ["df -h"] }` → `mode: "readonly"`, `allow.map(r => r.source)` is `["^(?:df -h)$"]`.
  - `rejects an unknown mode` / `rejects an unknown tmux value` — error lists contain the exact strings above.
  - `rejects a non-array allow` — `{ allow: "uptime" }` → `host "a": policy.allow must be an array of strings`.
  - `rejects an invalid regex` — `{ mode: "readonly", allow: ["("] }` → an error starting `host "a": policy: invalid regex in allow: "("`.
  - `rejects allow without readonly` and `rejects needs_approval without readwrite` — exact strings.
  - `rejects a non-table` — `parsePolicyTable("x", "defaults.policy")` → `defaults.policy must be a table`.
  - `rejects an unknown key` — `{ needs_aproval: ["rm"] }` → `host "a": policy: unknown key "needs_aproval"`.
  - `allow = [] drops an inherited allow` — defaults `{ mode: "readonly", allow: ["uptime"] }`, host `{ mode: "readwrite", allow: [] }` → `Right`, `mode: "readwrite"`, empty `allow`.
  - `an inherited allow under a readwrite override is an error` — same defaults, host `{ mode: "readwrite" }` → `Left` containing `host "a": policy: allow applies only to mode = "readonly"`.
  - `agents = [] is not set` — `{ agents: [] }` → `agents` is `None`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/orchestrator && npx vitest run test/policy.spec.ts`
Expected: FAIL — the module `../src/policy.js` can't be resolved.

- [ ] **Step 3: Implement the types, `EMPTY_TABLE`, `parsePolicyTable` and `resolvePolicy` in `src/policy.ts`.** Collect every error rather than stopping at the first, the way `parseFleet` does.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/policy.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/policy.ts packages/orchestrator/test/policy.spec.ts
git commit -m "feat(orchestrator): parse and validate per-host policy tables"
```

---

### Task 2: Policy evaluation

**Files:**
- Modify: `packages/orchestrator/src/policy.ts`
- Test: `packages/orchestrator/test/policy.spec.ts`

**Interfaces:**
- Consumes: `HostPolicy` (Task 1).
- Produces:
  - `type PolicyTool = "exec" | "tmux_list" | "tmux_send" | "tmux_read" | "tmux_keys"`
  - `type PolicyRequest = Readonly<{ tool: "exec"; agent: string; command: string }> | Readonly<{ tool: Exclude<PolicyTool, "exec">; agent: string }>` — only `exec` carries a command, so there is no "exec without a command" case.
  - `type Verdict = Readonly<{ decision: "allow"; rule: Option<string> }> | Readonly<{ decision: "deny"; rule: string; reason: string }>`
  - `ALLOW: Verdict` — `{ decision: "allow", rule: None }`, for host-less tools and unknown hosts.
  - `evaluate(policy: HostPolicy, req: PolicyRequest): Verdict`

`rule` is the short name; the host prefix is added by the auditor. Evaluation order, first match wins:

| # | Condition | Verdict |
| --- | --- | --- |
| 1 | `mode = "deny"` | deny, rule `deny`, reason `host is closed by policy` |
| 2 | `agents` is `Some` and no entry `e` has `agent === e` or `agent.startsWith(e + "@")` | deny, rule `agents`, reason `agent "<agent>" is not in agents` |
| 3 | `tmux_list` or `tmux_read` | allow, rule `<mode>` |
| 4 | `tmux_send` / `tmux_keys` under `readonly` | deny, rule `readonly`, reason `tmux input is not allowed on a readonly host` |
| 5 | `tmux_send` / `tmux_keys` under `readwrite`, `tmux = "approve"` | deny, rule `tmux`, reason `tmux input requires approval, which is not available yet` |
| 6 | `tmux_send` / `tmux_keys` under `readwrite`, `tmux = "open"` | allow, rule `readwrite` |
| 7 | `exec` under `readonly`, command has a character from the readonly reject list (Global Constraints) | deny, rule `readonly`, reason `command contains a newline or shell metacharacter` |
| 8 | `exec` under `readonly`, some `allow` regex tests true | allow, rule `readonly` |
| 9 | `exec` under `readonly`, otherwise | deny, rule `readonly`, reason `command not in allow list` |
| 10 | `exec` under `readwrite`, some `needsApproval` regex tests true | deny, rule `needs_approval`, reason `matches "<source>" and needs approval, which is not available yet` |
| 11 | `exec` under `readwrite`, otherwise | allow, rule `readwrite` |

- [ ] **Step 1: Write the failing tests** as one `it.each` table in `test/policy.spec.ts` (`describe("evaluate")`), building policies with `resolvePolicy` from Task 1. Agent is `"unknown"` unless stated. Rows (name → expected `decision` / `rule`):
  - `deny mode denies exec` → deny/`deny`; `deny mode denies tmux_read` → deny/`deny`
  - `deny is checked before agents` (`mode = "deny"`, `agents = ["unknown"]`) → deny/`deny`
  - `agents is checked before the allow list` (`readonly`, `allow = ["uptime"]`, `agents = ["claude"]`, `"uptime"`) → deny/`agents`
  - `agents excludes unknown` (`agents = ["claude"]`) → deny/`agents`
  - `agents match by name or name@instance` — `agents = ["claude"]`: agent `"claude"` allow, `"claude@laptop"` allow, `"claudex"` deny/`agents`, `"x@claude"` deny/`agents`
  - `readonly allows an allowlisted command` (`allow = ["uptime"]`, `"uptime"`) → allow/`readonly`
  - `readonly is a full match` (`allow = ["uptime"]`, `"uptime --help"`) → deny/`readonly`, reason `command not in allow list`
  - `trailing space is not trimmed` (`"uptime "`) → deny/`readonly`
  - `alternation is anchored as a whole` (`allow = ["df -h|uptime"]`): `"df -h"` allow, `"uptime"` allow, `"xuptime"` deny, `"df -hx"` deny
  - metacharacters, one row each, all with `allow = [".*"]` → deny/`readonly`, reason `command contains a newline or shell metacharacter`: `"cmd; rm"`, `"cmd && x"`, `"cmd | x"`, `"cmd $(x)"`, `` "cmd `x`" ``, `"cmd > f"`, `"cmd < f"`, `"cmd {a,b}"`, `"cmd\nx"`, `"cmd\0x"`, `"cmd \\x"`, `"cmd 'x'"`, `'cmd "x"'`, `"ls *"`, `"ls ?"`, `"ls [ab]"`, `"cat ~/x"`
  - `carriage return is a newline` (`"cmd\rx"`, `allow = [".*"]`) → deny/`readonly`
  - `a tab is not a metacharacter` (`allow = ["echo\\ta"]`, `"echo\ta"`) → allow
  - `readonly denies tmux_send` / `readonly allows tmux_read` → deny/`readonly`, allow/`readonly`
  - `readwrite needs_approval matches anywhere` (`needs_approval = ["rm"]`, `"sudo rm -rf x"`) → deny/`needs_approval`
  - `readwrite allows anything else` (`"ls"`) → allow/`readwrite`
  - `tmux approve denies tmux_keys` / `tmux open allows tmux_send` → deny/`tmux`, allow/`readwrite`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/policy.spec.ts`
Expected: FAIL — `evaluate` is not exported yet.

- [ ] **Step 3: Implement `evaluate`, `ALLOW` and the request/verdict types in `src/policy.ts`.** The reject check is one character class over the command: ``/[\n\r\0;&|$`()<>{}\\'"*?[~]/``.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/policy.spec.ts`
Expected: PASS (all rows).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/policy.ts packages/orchestrator/test/policy.spec.ts
git commit -m "feat(orchestrator): evaluate exec and tmux requests against host policy"
```

---

### Task 3: Fleet config — `[defaults.policy]` and `[hosts.policy]`

**Files:**
- Modify: `packages/orchestrator/src/fleet.ts`, `packages/orchestrator/src/runners.ts`
- Test: `packages/orchestrator/test/fleet.spec.ts`, `packages/orchestrator/test/runners.spec.ts`

**Interfaces:**
- Consumes: `PolicyTable`, `HostPolicy`, `parsePolicyTable`, `resolvePolicy` (Task 1).
- Produces: `HostEntry` gains `policy: HostPolicy`; `FleetRunner` gains `policyFor: (host: string) => Option<HostPolicy>` (`None` for an unknown host), built in `makeRunner` from a functype `Map` like `logOutput`; `fleetWarnings(fleet: Fleet): ReadonlyArray<string>` in `fleet.ts` returns `host "<name>": policy.agents is set, so every call is denied until agent identity is available` for each host whose `policy.agents` is `Some`.

In `parseFleet`: parse `defaults.policy` once with `where = "defaults.policy"`; in `parseHost`, parse `h.policy` with `where = host "<name>": policy` and `resolvePolicy` against the defaults table — or against `EMPTY_TABLE` when the defaults table itself failed, so its errors are reported once, not once per host. All errors join the existing `Fleet config errors:` list.

- [ ] **Step 1: Write the failing tests**
  - `fleet.spec.ts` `hosts get the built-in policy by default` — `base` → `hosts[0].policy.mode === "readwrite"`, `tmux === "open"`.
  - `reads [defaults.policy] and [hosts.policy]` — defaults `mode = "readwrite"`, `tmux = "approve"`; `box-a` has `[hosts.policy] mode = "readonly"`, `allow = ["uptime"]` → `box-a` policy `readonly` with one `allow`, `tmux` `"approve"` inherited.
  - `reports policy errors with the host name` — `[hosts.policy] mode = "nope"` → `Left` containing `host "box-a": policy.mode must be one of readonly, readwrite, deny`.
  - `reports a defaults.policy error once` — two hosts and `[defaults.policy] tmux = "x"` → the `Left` contains `defaults.policy.tmux must be approve or open` exactly once.
  - `warns for each host with agents set` — `box-a` with `agents = ["claude"]`, `box-b` without → `fleetWarnings` returns exactly the `box-a` message.
  - `runners.spec.ts` `policyFor returns the host policy` — `Some` with the configured mode for a known host, `None` for `"nope"`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/fleet.spec.ts test/runners.spec.ts`
Expected: FAIL on the 6 new tests.

- [ ] **Step 3: Implement** in `fleet.ts` and `runners.ts`. Add `policyFor: () => Option.none()` to the fake runner in `test/ops.spec.ts` (`recording()`) so it compiles.

- [ ] **Step 4: Run the package suite**

Run: `pnpm validate`
Expected: format, lint, typecheck, test and build all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/fleet.ts packages/orchestrator/src/runners.ts packages/orchestrator/test/fleet.spec.ts packages/orchestrator/test/runners.spec.ts packages/orchestrator/test/ops.spec.ts
git commit -m "feat(orchestrator): per-host policy in fleet config"
```

---

### Task 4: Audit decisions and denials

**Files:**
- Modify: `packages/orchestrator/src/audit.ts`, `packages/orchestrator/src/index.ts` (only `call()`: add `verdict: ALLOW`, so the tree stays green until Task 5)
- Test: `packages/orchestrator/test/audit.spec.ts`

**Interfaces:**
- Consumes: `Verdict`, `ALLOW` (Task 2).
- Produces: `AuditCall` gains `verdict: Verdict`. Phase 1 callers and tests pass `verdict: ALLOW`.

Decision line: `decision` is `verdict.decision`; `rule` is `"<host>:<rule>"` when the verdict has a rule (`"<rule>"` alone when the call has no host); a deny line also carries `reason`. On deny, `audited` writes the decision line, does **not** call `run` or `summarize`, writes no result line, and rejects with `UserError("[<host>] denied by rule <rule>: <reason>")` (no `[<host>] ` prefix when there is no host). A failed write of a deny line is still the Phase 1 `call not executed` error.

- [ ] **Step 1: Write the failing tests** in `audit.spec.ts` (update the existing `execCall` fixture to carry `verdict: ALLOW`):
  - `an allow verdict with a rule records it` — `verdict: { decision: "allow", rule: Option("readonly") }` → decision line has `decision: "allow"`, `rule: "box-a:readonly"`.
  - `an allow verdict without a rule omits rule` — `ALLOW` → `"rule" in decision` is `false`.
  - `a deny verdict writes one line and never runs` — `{ decision: "deny", rule: "readonly", reason: "command not in allow list" }` → `lines` has length 1 with `decision: "deny"`, `rule: "box-a:readonly"`, `reason: "command not in allow list"`; `run` not called; rejects with a `UserError` whose message is `[box-a] denied by rule readonly: command not in allow list`.
  - `a failed deny-line write is still "call not executed"` — same deny verdict, sink throws on its first write → rejects with a `UserError` containing `call not executed`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/audit.spec.ts`
Expected: FAIL — the allow-with-rule and deny tests (no `rule` / `decision: "allow"` still written).

- [ ] **Step 3: Implement the verdict handling in `createAuditor`,** and add `verdict: ALLOW` to `call()` in `src/index.ts`.

- [ ] **Step 4: Run the package suite**

Run: `pnpm validate`
Expected: format, lint, typecheck, test and build all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/audit.ts packages/orchestrator/src/index.ts packages/orchestrator/test/audit.spec.ts
git commit -m "feat(orchestrator): audit lines carry the policy decision and rule; denials never run"
```

---

### Task 5: Gate every tool, and document

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/README.md`, `packages/orchestrator/fleet.example.toml`, `CLAUDE.md`
- Test: `packages/orchestrator/test/ops.spec.ts`

**Interfaces:**
- Consumes: `evaluate`, `ALLOW`, `PolicyRequest` (Task 2); `FleetRunner.policyFor`, `fleetWarnings` (Task 3); `AuditCall.verdict` (Task 4).

Each host-routed handler builds its `PolicyRequest` (`agent: AGENT_UNKNOWN`; `exec` includes its `command`) and sets `verdict = runner.policyFor(host).fold(() => ALLOW, (p) => evaluate(p, req))`, replacing the `ALLOW` that Task 4 put in `call()`. `hosts_list` uses `ALLOW`. An unknown host therefore reaches the runner and fails as in Phase 1. In `main`, after `parseFleet`, print each `fleetWarnings(fleet)` line to stderr prefixed `warning: `.

- [ ] **Step 1: Write the failing tests** in `ops.spec.ts`, with a helper giving the fake runner a policy via `resolvePolicy` (Task 1):
  - `no policy configured: every tool still runs` — `policyFor` returns the built-in default for every host; `exec`, `tmux_send`, `tmux_keys`, `tmux_read`, `tmux_list` all resolve, and every decision line has `decision: "allow"`.
  - `readonly host denies exec outside the allow list without running it` — `allow = ["uptime"]`; `h.exec({ command: "rm x" })` rejects with `[box-a] denied by rule readonly: command not in allow list`; the runner's `calls` is empty; one audit line with `decision: "deny"`.
  - `readonly host allows an allowlisted exec` — `"uptime"` resolves; decision line `rule: "box-a:readonly"`.
  - `readonly host denies tmux_send` — rejects naming rule `readonly`; `calls` is empty.
  - `needs_approval denies a matching exec` — `readwrite`, `needs_approval = ["sudo"]`; `"sudo ls"` rejects naming rule `needs_approval`.
  - `an unknown host is not a policy denial` — `policyFor` returns `None` and `exec` throws `unknown host "z"`; the rejection matches `/unknown host/`, and the decision line has `decision: "allow"` with no `rule`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/ops.spec.ts`
Expected: FAIL — the four denial/rule tests (handlers don't consult policy yet).

- [ ] **Step 3: Implement the handler changes** in `makeHandlers`.

- [ ] **Step 4: Document.** In `README.md`:
  - Add a `### [defaults.policy] / [hosts.policy] (optional)` table (`mode`, `tmux`, `allow`, `needs_approval`, `agents`) under *Fleet Config Schema*, with the built-in defaults.
  - Add a `## Policy` section: the evaluation order, the tmux rules, that `readonly` is an allowlist (no deny-list mode, and why), the readonly reject list and the rule never to use `.`, `.*` or `\S` in `allow`, that `needs_approval` is a tripwire, that anything needing approval is denied until approval ships, that `agents` denies every call until agent identity ships (and startup warns), that an empty list means "not set" and `allow = []` drops an inherited list, that the spec's `tmux = "approve"` is a recommended setting while the built-in default is `"open"`, and the denial message and audit `rule` / `reason` fields.
  - State plainly that running the server over stdio as the same OS user as the agent is **not governed**: the agent can bypass it with its own shell and credentials (see the spec's enforcement property).
  - In that section, show a **sample restricted account**: a dedicated remote user (e.g. `fleet-ro`) with no `sudo` except a `sudoers.d` entry naming exact read-only commands (e.g. `fleet-ro ALL=(root) NOPASSWD: /usr/bin/systemctl status *, /usr/bin/journalctl -u *`), a note that sudoers `*` matches any trailing arguments, a note that `allow` patterns must then include the `sudo ` prefix (`sudo systemctl status [\w@.-]+`), and a note that the remote account is the real boundary.
  - Update the *Audit Log* section: `decision` can be `"deny"`, `rule` / `reason` fields, and "two lines per call" becomes "two lines per call that runs; a denied call writes only its decision line".
  - Add a commented `[defaults.policy]` block and a readonly `[hosts.policy]` example to `fleet.example.toml`. Add `policy.ts` to the orchestrator module list in `CLAUDE.md`.

- [ ] **Step 5: Run the full suite**

Run: `cd ../.. && pnpm -r validate`
Expected: all three packages pass; core and connector unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/index.ts packages/orchestrator/test/ops.spec.ts packages/orchestrator/README.md packages/orchestrator/fleet.example.toml CLAUDE.md
git commit -m "feat(orchestrator): gate every tool call on host policy"
```
