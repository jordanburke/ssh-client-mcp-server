import { describe, expect, it } from "vitest"

import { channelResult, execOutput, exitLabel } from "../src/ssh.js"

const failure = (e: ReturnType<typeof execOutput>): string =>
  e.fold(
    (m) => m,
    () => "",
  )
const success = (e: ReturnType<typeof execOutput>): string =>
  e.fold(
    () => "",
    (v) => v,
  )

describe("channelResult", () => {
  it("keeps a numeric exit code", () => {
    expect(channelResult("o", "e", 3, undefined)).toEqual({ stdout: "o", stderr: "e", code: 3 })
  })

  it("reports a signal as 128 + its number, never as exit 0", () => {
    expect(channelResult("", "", null, "KILL")).toEqual({ stdout: "", stderr: "", code: 137, signal: "KILL" })
    expect(channelResult("", "", null, "TERM").code).toBe(143)
  })

  it("accepts the SIG-prefixed name ssh2 gives", () => {
    expect(channelResult("", "", null, "SIGKILL")).toEqual({ stdout: "", stderr: "", code: 137, signal: "KILL" })
  })

  it("still fails when ssh2 gives neither code nor signal", () => {
    expect(channelResult("", "", undefined, undefined)).toEqual({
      stdout: "",
      stderr: "",
      code: 255,
      signal: "unknown",
    })
  })
})

describe("exitLabel", () => {
  it("names the signal when there is one", () => {
    expect(exitLabel({ stdout: "", stderr: "", code: 1 })).toBe("exit 1")
    expect(exitLabel({ stdout: "", stderr: "", code: 137, signal: "KILL" })).toBe("exit 137 (signal KILL)")
  })
})

describe("execOutput", () => {
  it("succeeds on exit 0 even with stderr, keeping stderr under a marker", () => {
    expect(success(execOutput({ stdout: "out", stderr: "", code: 0 }))).toBe("out")
    expect(success(execOutput({ stdout: "out", stderr: "warn", code: 0 }))).toBe("out\n[stderr]\nwarn")
  })

  it("fails on a non-zero exit, stderr first, then stdout", () => {
    expect(failure(execOutput({ stdout: "ctx", stderr: "why", code: 2 }))).toBe("exit 2:\nwhy\n[stdout]\nctx")
    expect(failure(execOutput({ stdout: "only", stderr: "", code: 2 }))).toBe("exit 2:\nonly")
  })

  it("fails a signal-killed command with empty output", () => {
    expect(failure(execOutput({ stdout: "", stderr: "", code: 137, signal: "KILL" }))).toBe("exit 137 (signal KILL):\n")
  })
})
