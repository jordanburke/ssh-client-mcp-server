import { describe, expect, it } from "vitest"

import {
  buildKeys,
  buildList,
  buildRead,
  buildSend,
  clampLines,
  interpretAck,
  interpretKeys,
  interpretList,
  interpretRead,
  isTmuxMissing,
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
