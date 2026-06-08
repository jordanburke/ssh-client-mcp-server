import { describe, expect, it } from "vitest"

import {
  buildKeys,
  buildList,
  buildRead,
  buildSend,
  clampLines,
  shellQuote,
  trimTrailingBlankLines,
  validateKey,
  validateSession,
} from "../src/tmux.js"

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
