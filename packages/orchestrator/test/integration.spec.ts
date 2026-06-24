// packages/orchestrator/test/integration.spec.ts
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"
import { tmuxRead, tmuxSend } from "@ssh-mcp/core"

import { parseFleet } from "../src/fleet.js"
import { buildFleetRunner } from "../src/runners.js"

// Requires: tmux, an SSH server reachable at localhost, and agent auth that can log in.
const canSsh = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "localhost", "true"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!canSsh)("orchestrator integration (localhost SSH)", () => {
  const session = `ssh-fleet-it-${randomBytes(4).toString("hex")}`
  const fleet = parseFleet(`
[[hosts]]
name = "local"
host = "localhost"
agent = true
tmux_session = "${session}"
`)

  afterAll(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    } catch {
      // ignore
    }
  })

  it("creates a session on the host and reads it back over a pooled connection", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value)
    expect(r.isRight()).toBe(true)
    if (!r.isRight()) return
    const tr = r.value.tmuxRunnerFor("local")
    if (!tr.isRight()) throw new Error(tr.value)

    const sent = await tmuxSend(tr.value, { session, input: "echo fleet-roundtrip-ok", submit: true })
    expect(sent.isRight()).toBe(true)
    await wait(500)
    const read = await tmuxRead(tr.value, { session, lines: 50 })
    expect(read.isRight()).toBe(true)
    if (read.isRight()) expect(read.value).toContain("fleet-roundtrip-ok")

    // second send reuses the pooled connection (no reconnect, no TTY)
    const again = await tmuxSend(tr.value, { session, input: "echo second-pooled-send", submit: true })
    expect(again.isRight()).toBe(true)

    await r.value.shutdown()
  })
})
