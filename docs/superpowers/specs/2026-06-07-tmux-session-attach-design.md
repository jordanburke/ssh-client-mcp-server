# Design: tmux persistent-session attach for ssh-client-mcp-server

**Date:** 2026-06-07
**Status:** Approved (design); pending spec review
**Author:** Jordan Burke (with Claude)

## Summary

Add a persistent-interactive-session capability to `ssh-client-mcp-server` built on
remote **tmux**. Today the only tool, `exec`, runs a one-shot command over a
fresh SSH connection and returns stdout — stateless, no interactivity. This
feature adds tools to **send input to** and **read output from** a long-lived
tmux session on the remote host, so an orchestrating Claude can drive a
long-running interactive process (primarily a remote coding agent such as
`claude`) across many independent MCP calls.

The `exec` tool is unchanged. This is purely additive.

## Motivation

The driving use case: running multiple coding agents across different machines
and keeping them busy. Each remote agent is a long-lived interactive process;
the orchestrator needs to dispatch a task, come back later, read what happened,
and dispatch the next task — without the agent dying between calls.

tmux is chosen as the substrate because:

- **It is the state-holder, not the shell.** The session lives in a tmux server
  on the remote, fully decoupled from SSH connections. This means the existing
  stateless one-shot-SSH-per-call transport remains correct — each tool call is
  just one `tmux` subcommand over a fresh connection.
- **Human observability.** You can `tmux attach` to any session yourself to
  watch an agent work or take over — genuinely valuable when running a fleet
  unattended.
- **Zero custom remote daemon.** tmux is ubiquitous; nothing to write or deploy
  on the remote beyond tmux itself.

### Scope decomposition

This is **Layer 1** of two:

- **Layer 1 (this spec):** the dumb, reliable session primitive — attach/create,
  send input, read pane, on a single host.
- **Layer 2 (future, separate spec):** a higher-order orchestrator MCP that knows
  about N hosts, dispatches work, detects when an agent is _done and ready_, and
  keeps the fleet busy. All readiness/completion-detection intelligence lives
  here, not in Layer 1.

### Topology

**One server instance per host** (unchanged from today's model). The orchestrating
Claude configures N instances, each with its own `--host`/auth. No multi-host
routing in this server.

### Operational recommendation: line-oriented agents

The `claude` interactive TUI is a full-screen, repainting application; `capture-pane`
of a TUI returns the current rendered frame, which is awkward to parse. The
recommended operational pattern is to run agents **line-oriented** inside tmux
(e.g. `claude -p`/stream output rather than the full TUI), so the pane holds a
clean scrolling transcript. This keeps tmux's persistence + attach-to-watch
benefits while yielding scrapeable text. This is an operational convention, not
something the tools enforce — the tools simply `capture-pane`.

## Architecture

```
orchestrator Claude
  → tmux_send(session, "<dispatch a task>")        # one MCP call
  → … work on other hosts …
  → tmux_read(session, lines: 200)                 # one MCP call — read transcript
  → (orchestrator judges done/working/waiting)     # Layer 2 concern
  → tmux_send(session, "<next task>")              # keep it busy
```

Each arrow is one independent MCP call → one fresh SSH exec of one `tmux`
command. tmux on the remote holds the live session between calls.

### Module layout

A new `src/tmux.ts` module, structured for testability and matching the existing
functional style in `config.ts`:

- **Pure command builders** — construct the exact remote command string from
  validated params. All escaping/quoting lives here.
- **Pure result interpreters** — map `{ stdout, stderr, code }` to tool results
  or `UserError`s.
- **A runner interface** — `type TmuxRunner = (command: string) => Promise<CommandResult>`.
  Production wires it to `execSshResult` (see below); tests inject a stub or a
  local-`child_process` runner.

Each tool's `execute` is therefore: `build (pure) → run (I/O) → interpret (pure)`.

### The SSH runner change (blocking prerequisite)

The current `execSshCommand` rejects with `UserError` on **any** stderr
(`src/index.ts:28-32`). tmux legitimately writes to stderr (`no server running`,
`can't find session`), so that runner cannot be reused as-is.

Add a second runner:

```ts
type CommandResult = { stdout: string; stderr: string; code: number }
execSshResult(sshConfig, command): Promise<CommandResult>
```

It captures all three and **never rejects on stderr** — it rejects only on
connection/auth failure (same as today). Each tmux tool interprets the exit code.
The existing `exec` tool and its stderr-is-error semantics are **untouched**;
only tmux tools use `execSshResult`.

## Tool surface (additive)

| Tool        | Purpose                                                     | Underlying tmux command                                                                                         |
| ----------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tmux_list` | List live sessions on the host                              | `tmux list-sessions`                                                                                            |
| `tmux_send` | Ensure session exists, send literal text (+ optional Enter) | `tmux new-session -A -d -s <s>` then `tmux send-keys -t <s> -l <text>` (+ `send-keys -t <s> Enter` if `submit`) |
| `tmux_read` | Capture the pane transcript                                 | `tmux capture-pane -t <s> -p -J -S -<lines>`                                                                    |
| `tmux_keys` | Send control/special keys (escape hatch)                    | `tmux send-keys -t <s> <key…>`                                                                                  |

`tmux_kill` (session teardown) is intentionally **omitted** (YAGNI); trivial to
add later if fleet hygiene requires it.

### Parameters

- `tmux_send`: `session?` (default from config), `input: string`, `submit?: boolean` (default `true`)
- `tmux_read`: `session?`, `lines?: number` (default 200, clamped to max 2000)
- `tmux_keys`: `session?`, `keys: string[]` (each validated against an allowlist)
- `tmux_list`: (none)

`tmux_send` and `tmux_keys` are separate because literal text (`send-keys -l`)
and key-names (`send-keys C-c`) have different escaping and intent; folding them
into one tool would require a mode flag and ambiguous input.

### Config

One new optional CLI arg: `--tmux-session=<name>` (default `"agent"`). Lets the
`session` param be omitted for the common single-agent-per-host case, and
specified when running several agents on one box.

## Error handling

| Condition                         | Detection                                                  | Behavior                                                                                 |
| --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| tmux not installed                | nonzero from a `command -v tmux` guard / command-not-found | Actionable `UserError`: _"tmux not found on `<host>` — install it or use `exec`."_       |
| No tmux server yet                | `list-sessions` exits 1 with `no server running`           | `tmux_list` returns **empty list**, not an error                                         |
| Session missing (read/keys)       | `can't find session`                                       | Clear error naming the session, suggesting `tmux_list`                                   |
| Auto-create race / already exists | —                                                          | Avoided by `new-session -A -d -s` (`-A` = attach-or-create, idempotent, `-d` = detached) |
| Empty/blank pane                  | —                                                          | `tmux_read` trims trailing blank lines; returns `""`                                     |
| Connection / auth failure         | ssh2 error                                                 | Same `UserError` path as today (shared connect logic)                                    |

### Security — input & session-name handling

The tmux command is assembled into a string parsed by the **remote login shell**
before tmux sees it. Therefore:

- **`input` is shell-quoted** before interpolation (wrap in single quotes; escape
  embedded `'` as `'\''`). The `-l` flag keeps input literal _to tmux_; the
  quoting keeps it literal _to the shell_. **Both are required.** e.g.
  `tmux_send(input: "; rm -rf ~")` must reach the pane as literal characters and
  never execute in the outer shell.
- **`session` names are validated** against `^[A-Za-z0-9_-]+$` and **rejected**
  (not quoted-and-run) otherwise — they appear in `-t <session>`.
- **`tmux_keys` values are validated** against an allowlist of tmux key-names
  (`C-c`, `Enter`, `Escape`, `Up`, `Down`, …) rather than passed through raw.

### Payload caps

`tmux_read` `lines` is clamped to a max (2000) so a runaway pane cannot return a
giant blob.

## Testing strategy

Follows the existing pattern (`test/config.spec.ts`, vitest) and the
"tests-first for complex/security-critical logic" rule.

### Unit tests (bulk; TDD-first)

- **Command builders** — exact-string assertions for `buildSend`, `buildRead`
  (incl. `lines` clamping), `buildKeys` (allowlist), `buildList`.
- **Security suite** (dedicated `describe`) — feed `buildSend` injection payloads
  (`; rm -rf ~`, `$(whoami)`, embedded `'`, backticks, newlines) and assert each
  is inert (shell-quoted, reaches the pane literally). Assert bad session names
  (`a; b`, `../x`) are **rejected**.
- **Result interpreters** — `list-sessions` → session list; `no server running` →
  empty list; tmux-not-found → actionable error; `can't find session` → clear
  error; capture-pane → trailing blanks trimmed, empty pane → `""`.

### Integration test (one, gated)

A round-trip against **real tmux on localhost** (no SSH) via the injected
`TmuxRunner` using `child_process`: send text → capture pane → assert it appears.
**Gated on `command -v tmux`** and skipped when tmux is absent, so CI stays green
without adding a tmux dependency to the pipeline. Catches the real send→capture
timing/round-trip that pure tests cannot.

### End-to-end (manual)

SSH + remote tmux validated manually via `pnpm inspect` against a real host;
documented, not automated (real-SSH-in-CI isn't worth the flakiness for a
single-maintainer lib).

## Out of scope (explicitly)

- Readiness / completion detection ("is the agent done?") — Layer 2.
- Multi-host routing in a single server — one instance per host.
- `tmux_kill` / session lifecycle management — YAGNI for now.
- Forcing line-oriented agent mode — operational convention, not enforced.
- Parsing/structuring TUI frames — recommend line-oriented agents instead.

## Open questions

None blocking. Exact `send-keys` flag combination (`-l` interaction with `--`
and trailing `Enter`) to be confirmed against the installed tmux during
implementation.
