import { describe, expect, it } from "vitest"

import { clampLines, shellQuote, trimTrailingBlankLines, validateKey, validateSession } from "../src/tmux.js"

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
