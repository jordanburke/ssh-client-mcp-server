import { describe, expect, it } from "vitest"

import { channelResult, execOutput } from "../src/ssh.js"
import { exitLabel, interpretAck, interpretList, isTimedOutMessage } from "../src/tmux.js"

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

  it("fails, without claiming a signal, when the channel closes with no exit status", () => {
    const r = channelResult("half", "", undefined, undefined)
    expect(r).toEqual({ stdout: "half", stderr: "", code: 255, noExitStatus: true })
    expect(exitLabel(r)).toBe("exit 255 (no exit status: channel closed)")
  })
})

describe("exitLabel", () => {
  it("names the signal when there is one", () => {
    expect(exitLabel({ stdout: "", stderr: "", code: 1 })).toBe("exit 1")
    expect(exitLabel({ stdout: "", stderr: "", code: 137, signal: "KILL" })).toBe("exit 137 (signal KILL)")
  })
})

describe("timeouts", () => {
  const timedOut = { stdout: "", stderr: "", code: 124, timedOutMs: 5000 }

  it("a tmux command that timed out says so, and the message is recognized", () => {
    const msg = interpretAck("tmux send-keys")(timedOut).fold(
      (m) => m,
      () => "",
    )
    expect(msg).toBe("tmux send-keys timed out after 5000 ms")
    expect(isTimedOutMessage(msg)).toBe(true)
  })

  it("a failure whose output mentions a timeout is not a timeout", () => {
    expect(isTimedOutMessage("tmux send-keys failed: exit 1")).toBe(false)
    expect(isTimedOutMessage("tmux_send failed: request timed out after 5000 ms")).toBe(false)
    expect(isTimedOutMessage("[box-a] exit 1:\nrequest to api timed out after 5000 ms")).toBe(false)
  })

  it("a timeout wins over partial stderr that looks like no server", () => {
    const r = { stdout: "", stderr: "no server running on /tmp/tmux-1/default", code: 124, timedOutMs: 5000 }
    const msg = interpretList(r).fold(
      (m) => m,
      () => "listed",
    )
    expect(msg).toBe("tmux list-sessions timed out after 5000 ms")
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
