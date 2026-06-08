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
