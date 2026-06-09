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

  // Regression: a second send targets an ALREADY-EXISTING session. The old
  // `new-session -A -d` form attached here (needs a TTY) and failed over a
  // non-TTY runner with "open terminal failed: not a terminal".
  it("sends again to an existing session without needing a TTY", async () => {
    const again = await tmuxSend(localRunner, { session, input: "echo second-send-ok", submit: true })
    expect(again.isRight()).toBe(true)

    await wait(400)

    const read = await tmuxRead(localRunner, { session, lines: 100 })
    expect(read.isRight()).toBe(true)
    if (read.isRight()) expect(read.value).toContain("second-send-ok")
  })
})
