# tmux Session Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tmux-backed persistent-session tools (`tmux_list`, `tmux_send`, `tmux_read`, `tmux_keys`) so an orchestrating Claude can drive long-lived remote processes across independent MCP calls.

**Architecture:** A new `src/tmux.ts` holds pure command builders + result interpreters + thin async operations parameterized over a `TmuxRunner` (so they test without SSH). `src/index.ts` gains a stderr-tolerant `execSshResult` runner, wires it as the production `TmuxRunner`, and registers the four tools. tmux on the remote is the state-holder; the existing one-shot-SSH-per-call transport is unchanged.

**Tech Stack:** TypeScript (ESM), functype (`Either`/`Option`/`List`), somamcp (`createServer`, `UserError`), ssh2, zod, vitest.

**Branch:** `feat/tmux-session-attach` (already exists with the committed spec).

**Spec:** `docs/superpowers/specs/2026-06-07-tmux-session-attach-design.md`

---

## File Structure

- **Create `src/tmux.ts`** — all tmux logic: types (`CommandResult`, `TmuxRunner`), pure helpers (`shellQuote`, `clampLines`, `trimTrailingBlankLines`, `validateSession`, `validateKey`), command builders (`buildList`, `buildSend`, `buildRead`, `buildKeys`), result interpreters (`isTmuxMissing`, `interpretList`, `interpretAck`, `interpretRead`, `interpretKeys`), and async operations (`tmuxList`, `tmuxSend`, `tmuxRead`, `tmuxKeys`).
- **Create `test/tmux.spec.ts`** — unit tests for every pure function + operations (via a stub runner), including the injection-safety suite.
- **Create `test/tmux.integration.spec.ts`** — one gated round-trip against real local tmux via a `child_process` runner.
- **Modify `src/index.ts`** — add `execSshResult`, the `--tmux-session` default, and register the four tools.
- **Modify `README.md`** and **`CLAUDE.md`** — document the new tools.

Design rule: `src/tmux.ts` never imports `ssh2` or `somamcp`. It returns `Either<string, T>`; `index.ts` maps `Left` → `UserError`. This keeps the whole module unit-testable.

---

## Task 1: Module scaffold — types and `validateSession`

**Files:**
- Create: `src/tmux.ts`
- Test: `test/tmux.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/tmux.spec.ts
import { describe, expect, it } from "vitest"

import { validateSession } from "../src/tmux.js"

describe("validateSession", () => {
  it("accepts safe names", () => {
    for (const name of ["agent", "box-1", "claude_2", "ABC"]) {
      const r = validateSession(name)
      expect(r.isRight()).toBe(true)
      if (r.isRight()) expect(r.value).toBe(name)
    }
  })

  it("rejects names with shell metacharacters", () => {
    for (const name of ["a; b", "../x", "a b", "$(x)", "a`b`", ""]) {
      const r = validateSession(name)
      expect(r.isLeft()).toBe(true)
      if (r.isLeft()) expect(r.value).toContain("Invalid session name")
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: FAIL — cannot resolve `../src/tmux.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tmux.ts
import { type Either, Left, Right } from "functype"

export type CommandResult = Readonly<{ stdout: string; stderr: string; code: number }>

export type TmuxRunner = (command: string) => Promise<CommandResult>

const SESSION_RE = /^[A-Za-z0-9_-]+$/

export const validateSession = (name: string): Either<string, string> =>
  SESSION_RE.test(name)
    ? Right<string, string>(name)
    : Left<string, string>(`Invalid session name "${name}": only letters, digits, hyphen, and underscore are allowed`)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.spec.ts
git commit -m "feat(tmux): add module scaffold and session-name validation"
```

---

## Task 2: Pure helpers — `shellQuote`, `clampLines`, `trimTrailingBlankLines`, `validateKey`

**Files:**
- Modify: `src/tmux.ts`
- Test: `test/tmux.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/tmux.spec.ts
import { clampLines, shellQuote, trimTrailingBlankLines, validateKey } from "../src/tmux.js"

describe("shellQuote", () => {
  it("wraps plain text in single quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'")
  })

  it("neutralizes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it("renders shell metacharacters inert", () => {
    expect(shellQuote("; rm -rf ~")).toBe("'; rm -rf ~'")
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'")
    expect(shellQuote("`id`")).toBe("'`id`'")
  })
})

describe("clampLines", () => {
  it("clamps to [1, 2000] and floors", () => {
    expect(clampLines(0)).toBe(1)
    expect(clampLines(-5)).toBe(1)
    expect(clampLines(50.9)).toBe(50)
    expect(clampLines(99999)).toBe(2000)
  })
})

describe("trimTrailingBlankLines", () => {
  it("strips trailing whitespace and blank lines", () => {
    expect(trimTrailingBlankLines("a\nb\n\n  \n")).toBe("a\nb")
  })

  it("returns empty string for all-blank input", () => {
    expect(trimTrailingBlankLines("\n  \n\t\n")).toBe("")
  })
})

describe("validateKey", () => {
  it("accepts allowlisted keys", () => {
    for (const k of ["Enter", "Escape", "C-c", "Up"]) {
      expect(validateKey(k).isRight()).toBe(true)
    }
  })

  it("rejects unknown / injection keys", () => {
    for (const k of ["rm", "C-c; rm", "Enter Enter", ""]) {
      expect(validateKey(k).isLeft()).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: FAIL — `shellQuote`/`clampLines`/`trimTrailingBlankLines`/`validateKey` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/tmux.ts
export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

export const clampLines = (n: number): number => Math.max(1, Math.min(2000, Math.floor(n)))

export const trimTrailingBlankLines = (s: string): string => s.replace(/\s+$/, "")

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "Enter", "Escape", "Tab", "Space", "BSpace",
  "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "C-c", "C-d", "C-z", "C-l", "C-u", "C-a", "C-e", "C-r",
])

export const validateKey = (key: string): Either<string, string> =>
  ALLOWED_KEYS.has(key)
    ? Right<string, string>(key)
    : Left<string, string>(`Unsupported key "${key}": allowed keys are ${[...ALLOWED_KEYS].join(", ")}`)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.spec.ts
git commit -m "feat(tmux): add shell-quoting, line clamping, trim, and key validation helpers"
```

---

## Task 3: Command builders + injection-safety suite

**Files:**
- Modify: `src/tmux.ts`
- Test: `test/tmux.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/tmux.spec.ts
import { buildKeys, buildList, buildRead, buildSend } from "../src/tmux.js"

describe("buildList", () => {
  it("requests one session name per line", () => {
    expect(buildList()).toBe("tmux list-sessions -F '#{session_name}'")
  })
})

describe("buildSend", () => {
  it("creates (idempotent) then sends literal text with Enter", () => {
    const r = buildSend("agent", "ls -la", true)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value).toBe(
        "tmux new-session -A -d -s agent && tmux send-keys -t agent -l -- 'ls -la' && tmux send-keys -t agent Enter",
      )
    }
  })

  it("omits Enter when submit is false", () => {
    const r = buildSend("agent", "partial", false)
    if (r.isRight()) {
      expect(r.value).toBe("tmux new-session -A -d -s agent && tmux send-keys -t agent -l -- 'partial'")
    }
  })

  it("propagates session validation failure", () => {
    expect(buildSend("a; b", "x", true).isLeft()).toBe(true)
  })

  describe("injection safety", () => {
    it("renders dangerous input inert via single-quoting", () => {
      for (const payload of ["; rm -rf ~", "$(whoami)", "`id`", "a'b", "x && y", "$HOME"]) {
        const r = buildSend("agent", payload, true)
        expect(r.isRight()).toBe(true)
        if (r.isRight()) {
          // The payload appears only inside the single-quoted send-keys argument.
          expect(r.value).toContain(`-l -- ${shellQuote(payload)}`)
        }
      }
    })
  })
})

describe("buildRead", () => {
  it("captures the pane as plain text with clamped scrollback", () => {
    const r = buildRead("agent", 200)
    if (r.isRight()) expect(r.value).toBe("tmux capture-pane -t agent -p -J -S -200")
  })

  it("clamps the line count", () => {
    const r = buildRead("agent", 99999)
    if (r.isRight()) expect(r.value).toBe("tmux capture-pane -t agent -p -J -S -2000")
  })

  it("propagates session validation failure", () => {
    expect(buildRead("../x", 10).isLeft()).toBe(true)
  })
})

describe("buildKeys", () => {
  it("sends allowlisted keys to the session", () => {
    const r = buildKeys("agent", ["C-c"])
    if (r.isRight()) expect(r.value).toBe("tmux send-keys -t agent C-c")
  })

  it("rejects an empty key list", () => {
    expect(buildKeys("agent", []).isLeft()).toBe(true)
  })

  it("rejects a non-allowlisted key", () => {
    expect(buildKeys("agent", ["Enter", "rm -rf"]).isLeft()).toBe(true)
  })

  it("propagates session validation failure", () => {
    expect(buildKeys("a b", ["Enter"]).isLeft()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: FAIL — builders not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/tmux.ts
export const buildList = (): string => "tmux list-sessions -F '#{session_name}'"

export const buildSend = (session: string, input: string, submit: boolean): Either<string, string> =>
  validateSession(session).map((s) => {
    const create = `tmux new-session -A -d -s ${s}`
    const send = `tmux send-keys -t ${s} -l -- ${shellQuote(input)}`
    const enter = submit ? ` && tmux send-keys -t ${s} Enter` : ""
    return `${create} && ${send}${enter}`
  })

export const buildRead = (session: string, lines: number): Either<string, string> =>
  validateSession(session).map((s) => `tmux capture-pane -t ${s} -p -J -S -${clampLines(lines)}`)

export const buildKeys = (session: string, keys: ReadonlyArray<string>): Either<string, string> =>
  validateSession(session).flatMap((s) => {
    if (keys.length === 0) return Left<string, string>("No keys provided")
    const bad = keys.find((k) => validateKey(k).isLeft())
    return bad === undefined
      ? Right<string, string>(`tmux send-keys -t ${s} ${keys.join(" ")}`)
      : Left<string, string>(`Unsupported key "${bad}"`)
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: PASS.

> Note: the exact `send-keys -l -- ...` form (whether `--` is honored alongside `-l`) is verified by the integration test in Task 7. If it proves wrong there, fix `buildSend` and this test together.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.spec.ts
git commit -m "feat(tmux): add command builders with injection-safety tests"
```

---

## Task 4: Result interpreters

**Files:**
- Modify: `src/tmux.ts`
- Test: `test/tmux.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/tmux.spec.ts
import { interpretAck, interpretKeys, interpretList, interpretRead, isTmuxMissing } from "../src/tmux.js"

const res = (over: Partial<{ stdout: string; stderr: string; code: number }> = {}) => ({
  stdout: "",
  stderr: "",
  code: 0,
  ...over,
})

describe("isTmuxMissing", () => {
  it("detects exit 127 and not-found stderr", () => {
    expect(isTmuxMissing(res({ code: 127, stderr: "bash: tmux: command not found" }))).toBe(true)
    expect(isTmuxMissing(res({ stderr: "tmux: not found", code: 1 }))).toBe(true)
  })

  it("is false for normal results", () => {
    expect(isTmuxMissing(res({ stdout: "agent\n" }))).toBe(false)
    expect(isTmuxMissing(res({ code: 1, stderr: "no server running on /tmp/tmux-1000/default" }))).toBe(false)
  })
})

describe("interpretList", () => {
  it("parses session names on success", () => {
    const r = interpretList(res({ stdout: "agent\nbox-1\n" }))
    if (r.isRight()) expect(r.value).toEqual(["agent", "box-1"])
  })

  it("returns an empty list when no server is running", () => {
    const r = interpretList(res({ code: 1, stderr: "no server running on /tmp/tmux-1000/default" }))
    expect(r.isRight()).toBe(true)
    if (r.isRight()) expect(r.value).toEqual([])
  })

  it("surfaces a tmux-missing error", () => {
    const r = interpretList(res({ code: 127, stderr: "tmux: command not found" }))
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain("tmux not found")
  })
})

describe("interpretAck", () => {
  it("returns Right on exit 0", () => {
    expect(interpretAck("tmux_send")(res()).isRight()).toBe(true)
  })

  it("returns Left with the label on failure", () => {
    const r = interpretAck("tmux_send")(res({ code: 1, stderr: "boom" }))
    if (r.isLeft()) expect(r.value).toContain("tmux_send")
  })
})

describe("interpretRead", () => {
  it("trims the captured pane on success", () => {
    const r = interpretRead("agent")(res({ stdout: "line1\nline2\n\n" }))
    if (r.isRight()) expect(r.value).toBe("line1\nline2")
  })

  it("gives a clear error for a missing session", () => {
    const r = interpretRead("ghost")(res({ code: 1, stderr: "can't find session: ghost" }))
    if (r.isLeft()) expect(r.value).toContain('No tmux session "ghost"')
  })
})

describe("interpretKeys", () => {
  it("gives a clear error for a missing session", () => {
    const r = interpretKeys("ghost")(res({ code: 1, stderr: "can't find session: ghost" }))
    if (r.isLeft()) expect(r.value).toContain('No tmux session "ghost"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: FAIL — interpreters not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/tmux.ts
const TMUX_MISSING_MSG =
  "tmux not found on the remote host — install tmux (e.g. apt/brew install tmux) or use the exec tool instead"

const SESSION_MISSING_RE = /can't find session|session not found/i

export const isTmuxMissing = (r: CommandResult): boolean =>
  r.code === 127 || /tmux: (command )?not found/i.test(r.stderr)

const failure = (label: string, r: CommandResult): string =>
  `${label} failed: ${r.stderr.trim() || `exit ${r.code}`}`

export const interpretList = (r: CommandResult): Either<string, ReadonlyArray<string>> => {
  if (isTmuxMissing(r)) return Left<string, ReadonlyArray<string>>(TMUX_MISSING_MSG)
  if (r.code === 0) {
    return Right<string, ReadonlyArray<string>>(
      r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    )
  }
  if (/no server running/i.test(r.stderr)) return Right<string, ReadonlyArray<string>>([])
  return Left<string, ReadonlyArray<string>>(failure("tmux list-sessions", r))
}

export const interpretAck =
  (label: string) =>
  (r: CommandResult): Either<string, void> => {
    if (isTmuxMissing(r)) return Left<string, void>(TMUX_MISSING_MSG)
    if (r.code === 0) return Right<string, void>(undefined)
    return Left<string, void>(failure(label, r))
  }

export const interpretRead =
  (session: string) =>
  (r: CommandResult): Either<string, string> => {
    if (isTmuxMissing(r)) return Left<string, string>(TMUX_MISSING_MSG)
    if (r.code === 0) return Right<string, string>(trimTrailingBlankLines(r.stdout))
    if (SESSION_MISSING_RE.test(r.stderr)) {
      return Left<string, string>(`No tmux session "${session}" — list with tmux_list, or tmux_send creates one`)
    }
    return Left<string, string>(failure("tmux capture-pane", r))
  }

export const interpretKeys =
  (session: string) =>
  (r: CommandResult): Either<string, void> => {
    if (isTmuxMissing(r)) return Left<string, void>(TMUX_MISSING_MSG)
    if (r.code === 0) return Right<string, void>(undefined)
    if (SESSION_MISSING_RE.test(r.stderr)) {
      return Left<string, void>(`No tmux session "${session}" — list with tmux_list, or tmux_send creates one`)
    }
    return Left<string, void>(failure("tmux send-keys", r))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.spec.ts
git commit -m "feat(tmux): add result interpreters for list/send/read/keys"
```

---

## Task 5: Async operations over a `TmuxRunner`

**Files:**
- Modify: `src/tmux.ts`
- Test: `test/tmux.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/tmux.spec.ts
import { tmuxKeys, tmuxList, tmuxRead, tmuxSend } from "../src/tmux.js"
import type { TmuxRunner } from "../src/tmux.js"

// A stub runner that records the command it was given and returns a canned result.
const stubRunner = (result: { stdout?: string; stderr?: string; code?: number }) => {
  const calls: string[] = []
  const runner: TmuxRunner = async (command) => {
    calls.push(command)
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 }
  }
  return { runner, calls }
}

describe("tmuxList (operation)", () => {
  it("runs list-sessions and parses names", async () => {
    const { runner, calls } = stubRunner({ stdout: "agent\n" })
    const r = await tmuxList(runner)
    expect(calls).toEqual(["tmux list-sessions -F '#{session_name}'"])
    if (r.isRight()) expect(r.value).toEqual(["agent"])
  })
})

describe("tmuxSend (operation)", () => {
  it("builds the create+send command and acks", async () => {
    const { runner, calls } = stubRunner({ code: 0 })
    const r = await tmuxSend(runner, { session: "agent", input: "echo hi", submit: true })
    expect(r.isRight()).toBe(true)
    expect(calls[0]).toContain("tmux new-session -A -d -s agent")
    expect(calls[0]).toContain("send-keys -t agent -l -- 'echo hi'")
  })

  it("short-circuits on an invalid session without calling the runner", async () => {
    const { runner, calls } = stubRunner({ code: 0 })
    const r = await tmuxSend(runner, { session: "a; b", input: "x", submit: true })
    expect(r.isLeft()).toBe(true)
    expect(calls).toEqual([])
  })
})

describe("tmuxRead (operation)", () => {
  it("returns the trimmed pane", async () => {
    const { runner } = stubRunner({ stdout: "out\n\n" })
    const r = await tmuxRead(runner, { session: "agent", lines: 100 })
    if (r.isRight()) expect(r.value).toBe("out")
  })
})

describe("tmuxKeys (operation)", () => {
  it("sends validated keys", async () => {
    const { runner, calls } = stubRunner({ code: 0 })
    const r = await tmuxKeys(runner, { session: "agent", keys: ["C-c"] })
    expect(r.isRight()).toBe(true)
    expect(calls).toEqual(["tmux send-keys -t agent C-c"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: FAIL — operations not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/tmux.ts
export const tmuxList = async (runner: TmuxRunner): Promise<Either<string, ReadonlyArray<string>>> =>
  interpretList(await runner(buildList()))

export const tmuxSend = async (
  runner: TmuxRunner,
  p: Readonly<{ session: string; input: string; submit: boolean }>,
): Promise<Either<string, void>> => {
  const cmd = buildSend(p.session, p.input, p.submit)
  if (cmd.isLeft()) return Left<string, void>(cmd.value)
  return interpretAck("tmux_send")(await runner(cmd.value))
}

export const tmuxRead = async (
  runner: TmuxRunner,
  p: Readonly<{ session: string; lines: number }>,
): Promise<Either<string, string>> => {
  const cmd = buildRead(p.session, p.lines)
  if (cmd.isLeft()) return Left<string, string>(cmd.value)
  return interpretRead(p.session)(await runner(cmd.value))
}

export const tmuxKeys = async (
  runner: TmuxRunner,
  p: Readonly<{ session: string; keys: ReadonlyArray<string> }>,
): Promise<Either<string, void>> => {
  const cmd = buildKeys(p.session, p.keys)
  if (cmd.isLeft()) return Left<string, void>(cmd.value)
  return interpretKeys(p.session)(await runner(cmd.value))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/tmux.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.spec.ts
git commit -m "feat(tmux): add async operations over a TmuxRunner"
```

---

## Task 6: SSH runner + tool wiring in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the stderr-tolerant runner**

Add this function in `src/index.ts` just below the existing `execSshCommand` (after line 46). It mirrors `execSshCommand` but resolves a structured result instead of rejecting on stderr:

```ts
const execSshResult = (sshConfig: ConnectConfig, command: string): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const conn = new SSHClient()
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new UserError(`SSH exec error: ${err.message}`))
          conn.end()
          return
        }
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        stream.on("close", (code: number) => {
          conn.end()
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString(),
            stderr: Buffer.concat(stderrChunks).toString(),
            code: code ?? 0,
          })
        })
        stream.on("data", (data: Buffer) => stdoutChunks.push(data))
        stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data))
      })
    })
    conn.on("error", (err) => {
      reject(new UserError(`SSH connection error: ${err.message}`))
    })
    conn.connect(sshConfig)
  })
```

- [ ] **Step 2: Update imports**

At the top of `src/index.ts`, extend the functype import and add the tmux import:

```ts
import { type Either, Option } from "functype"
```

and after the `./config.js` import line, add:

```ts
import {
  type CommandResult,
  type TmuxRunner,
  tmuxKeys,
  tmuxList,
  tmuxRead,
  tmuxSend,
} from "./tmux.js"
```

- [ ] **Step 3: Wire the runner, default session, and tools**

Inside `main()`, immediately after the `server.addTool({ name: "exec", … })` block (after line 93), add:

```ts
  const defaultSession = Option(argv["tmux-session"]).orElse("agent")
  const tmuxRunner: TmuxRunner = (command) => execSshResult(sshConfig, command)
  const unwrap = <T>(result: Either<string, T>): T =>
    result.fold(
      (msg) => {
        throw new UserError(msg)
      },
      (value) => value,
    )

  server.addTool({
    name: "tmux_list",
    description: "List live tmux sessions on the remote host.",
    parameters: z.object({}),
    execute: async () => JSON.stringify(unwrap(await tmuxList(tmuxRunner))),
  })

  server.addTool({
    name: "tmux_send",
    description:
      "Type text into a persistent tmux session on the remote host (creates the session if it does not exist). Use to dispatch work to a long-running interactive process such as a coding agent.",
    parameters: z.object({
      session: z.string().optional().describe("tmux session name (defaults to --tmux-session)"),
      input: z.string().describe("Text to type into the session"),
      submit: z.boolean().optional().describe("Press Enter after the text (default true)"),
    }),
    execute: async ({ session, input, submit }) => {
      const target = session ?? defaultSession
      unwrap(await tmuxSend(tmuxRunner, { session: target, input, submit: submit ?? true }))
      return `Sent to tmux session "${target}".`
    },
  })

  server.addTool({
    name: "tmux_read",
    description: "Capture the recent output (pane transcript) of a tmux session on the remote host.",
    parameters: z.object({
      session: z.string().optional().describe("tmux session name (defaults to --tmux-session)"),
      lines: z.number().optional().describe("Lines of scrollback to capture (default 200, max 2000)"),
    }),
    execute: async ({ session, lines }) =>
      unwrap(await tmuxRead(tmuxRunner, { session: session ?? defaultSession, lines: lines ?? 200 })),
  })

  server.addTool({
    name: "tmux_keys",
    description:
      "Send control/special keys to a tmux session (e.g. C-c to interrupt, Escape, Up). Use tmux_send for ordinary text.",
    parameters: z.object({
      session: z.string().optional().describe("tmux session name (defaults to --tmux-session)"),
      keys: z.array(z.string()).min(1).describe("tmux key names, e.g. ['C-c'] or ['Escape']"),
    }),
    execute: async ({ session, keys }) => {
      const target = session ?? defaultSession
      unwrap(await tmuxKeys(tmuxRunner, { session: target, keys }))
      return `Sent keys [${keys.join(", ")}] to tmux session "${target}".`
    },
  })
```

- [ ] **Step 4: Verify typecheck, lint, and existing tests pass**

Run: `pnpm typecheck && pnpm lint:check && pnpm vitest run`
Expected: PASS (existing config tests + new tmux unit tests; typecheck clean).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(tmux): add execSshResult runner and register tmux_list/send/read/keys tools"
```

---

## Task 7: Gated local-tmux integration test

**Files:**
- Create: `test/tmux.integration.spec.ts`

This is the only test that exercises real tmux. It uses a local `child_process` runner (no SSH) and is skipped when tmux is not installed, so CI without tmux stays green. It also verifies the real `send-keys -l --` round-trip from Task 3's note.

- [ ] **Step 1: Write the integration test**

```ts
// test/tmux.integration.spec.ts
import { execFile, execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

import { tmuxList, tmuxRead, tmuxSend, type TmuxRunner } from "../src/tmux.js"

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

// Runs the assembled tmux command through a local shell, mirroring what
// execSshResult does over SSH but without a network hop.
const localRunner: TmuxRunner = (command) =>
  new Promise((resolve) => {
    execFile("bash", ["-c", command], (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0
      resolve({ stdout, stderr, code })
    })
  })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasTmux)("tmux integration (local)", () => {
  const session = `ssh-mcp-it-${randomBytes(4).toString("hex")}`

  afterAll(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    } catch {
      // session may already be gone; ignore
    }
  })

  it("creates a session, sends a command, and reads its output back", async () => {
    const sent = await tmuxSend(localRunner, { session, input: "echo hello-from-tmux-test", submit: true })
    expect(sent.isRight()).toBe(true)

    await wait(400) // let the pane shell run the command and render

    const read = await tmuxRead(localRunner, { session, lines: 100 })
    expect(read.isRight()).toBe(true)
    if (read.isRight()) expect(read.value).toContain("hello-from-tmux-test")
  })

  it("lists the created session", async () => {
    const r = await tmuxList(localRunner)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) expect(r.value).toContain(session)
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run test/tmux.integration.spec.ts`
Expected (tmux installed): PASS (2 tests). Expected (no tmux): SKIPPED.

> If the round-trip fails specifically because `send-keys -l --` typed a literal `--` into the pane, remove `-- ` from `buildSend` (`src/tmux.ts`) and update the Task 3 `buildSend` assertions to match, then re-run Tasks 3 and 7.

- [ ] **Step 3: Run the full suite**

Run: `pnpm vitest run`
Expected: PASS (unit + integration).

- [ ] **Step 4: Commit**

```bash
git add test/tmux.integration.spec.ts
git commit -m "test(tmux): add gated local-tmux round-trip integration test"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md tool description**

In `CLAUDE.md`, find the "MCP Tool" bullet under Core Components that currently reads:

```
- **MCP Tool**: `exec` — runs a shell command on the remote host, returns stdout as a string. stderr becomes a `UserError`
```

Replace it with:

```
- **MCP Tools**:
  - `exec` — runs a one-shot shell command on the remote host, returns stdout as a string. stderr becomes a `UserError`
  - `tmux_list` / `tmux_send` / `tmux_read` / `tmux_keys` — persistent interactive sessions backed by remote tmux (see `src/tmux.ts`). tmux is the state-holder; each tool is one tmux subcommand over the same one-shot SSH transport. Pure command builders + interpreters live in `src/tmux.ts`; `execSshResult` in `src/index.ts` is the stderr-tolerant runner they use.
```

Also add to the Configuration section's CLI argument list:

```
- `--tmux-session` (optional): default tmux session name for the tmux_* tools (default: `agent`)
```

- [ ] **Step 2: Update README.md**

Add a "tmux sessions" subsection to the README's tools/usage area documenting the four tools, their parameters, and the `--tmux-session` flag. Use this content:

```markdown
### Persistent sessions (tmux)

For driving long-running interactive processes (e.g. a remote coding agent) across calls, the server exposes tmux-backed tools. tmux must be installed on the remote host.

- `tmux_list` — list live tmux sessions.
- `tmux_send({ session?, input, submit? })` — type `input` into `session` (created if absent); presses Enter unless `submit: false`.
- `tmux_read({ session?, lines? })` — return the recent pane transcript (`lines` default 200, max 2000).
- `tmux_keys({ session?, keys })` — send control/special keys, e.g. `{ keys: ["C-c"] }`.

`session` defaults to `--tmux-session` (default `agent`). Tip: run agents in a line-oriented mode (not a full-screen TUI) so `tmux_read` returns a clean transcript.
```

- [ ] **Step 3: Validate the whole project**

Run: `pnpm validate`
Expected: format → lint → typecheck → test → build all PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(tmux): document tmux session tools and --tmux-session flag"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full validation chain**

Run: `pnpm validate`
Expected: all stages PASS.

- [ ] **Step 2: Confirm tool surface via the inspector (optional, manual)**

Run: `pnpm inspect`
Expected: the inspector lists `exec`, `tmux_list`, `tmux_send`, `tmux_read`, `tmux_keys`, plus the `soma_*` introspection tools.

- [ ] **Step 3: Push the branch and open a PR**

```bash
git push -u origin feat/tmux-session-attach
gh pr create --base main --title "Add tmux persistent-session tools" --body "Implements docs/superpowers/specs/2026-06-07-tmux-session-attach-design.md"
```

> Version bump and publish are handled separately via the `vbctp`/`bctpp` release flow — not part of this plan.

---

## Self-Review

**Spec coverage:**
- tmux-as-state-holder over one-shot SSH → Task 6 (`execSshResult` + `tmuxRunner`). ✓
- One server per host / topology → no code; honored by not adding multi-host routing. ✓
- Line-oriented operational recommendation → documented in Task 8 README. ✓
- Module layout (pure builders/interpreters + runner interface) → Tasks 1–5. ✓
- `execSshResult` stderr-tolerant runner, `exec` untouched → Task 6 Step 1 (added below existing `execSshCommand`, not modifying it). ✓
- Tool surface `tmux_list/send/read/keys`, `tmux_kill` omitted → Task 6 Step 3. ✓
- Params + `--tmux-session` default `agent` → Task 6 Step 3. ✓
- Error table (tmux-missing, no-server→empty, missing-session, `-A` idempotent create, blank-pane trim, connection errors) → Tasks 3–4 + Task 6. ✓
- Security: shell-quoting input, session-name validation, key allowlist → Tasks 1–3 (+ injection suite in Task 3). ✓
- Payload cap (lines ≤ 2000) → Task 2 `clampLines` + Task 3 `buildRead`. ✓
- Testing: pure unit + injection suite + one gated integration test + manual e2e → Tasks 1–5, 7, 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the two "if it fails, adjust" notes (Tasks 3 & 7) are explicit verification fallbacks tied to the integration test, not vague instructions.

**Type consistency:** `CommandResult` and `TmuxRunner` defined in Task 1 and reused verbatim in Tasks 5–7. Operation signatures (`tmuxList/Send/Read/Keys`) match between Task 5 definitions and Task 6 call sites (`{ session, input, submit }`, `{ session, lines }`, `{ session, keys }`). Interpreter names (`interpretList/Ack/Read/Keys`, `isTmuxMissing`) consistent across Tasks 4–5. `unwrap`/`Either` usage in Task 6 matches the `Either<string, T>` returns from Task 5.
