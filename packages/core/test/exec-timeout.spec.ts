import { type AddressInfo } from "node:net"

import { Server, utils } from "ssh2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createPool, defaultConnect } from "../src/pool.js"
import { nodeProcessRunner } from "../src/proc.js"

// A local ssh2 server whose exec writes "partial" and never exits, so only a timeout ends the call.
// It records every command it receives and every signal the client sends.
const seen = { commands: [] as string[], signals: [] as string[], connects: 0 }
const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (client) => {
  seen.connects++
  client.on("authentication", (ctx) => ctx.accept())
  client.on("session", (accept) => {
    accept()
      .on("exec", (acceptExec, _reject, info) => {
        seen.commands.push(info.command)
        const stream = acceptExec()
        if (info.command === "quick") {
          stream.write("done")
          stream.exit(0)
          stream.end()
          return
        }
        stream.write("partial")
        stream.stderr.write("warn")
      })
      // ssh2 types the session's "signal" event loosely; the name is all this test needs.
      .on("signal", (_accept: unknown, _reject: unknown, info: { name: string }) => {
        seen.signals.push(info.name)
      })
  })
  client.on("error", () => undefined)
})

const port = { value: 0 }
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port.value = (server.address() as AddressInfo).port
        resolve()
      })
    }),
)
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const opts = { maxPerHost: 1, idleTimeoutMs: 60_000, acquireTimeoutMs: 1_000 }

describe("exec timeout over ssh2", () => {
  it("returns the output so far, sends KILL, and never re-runs the command", async () => {
    const pool = createPool([{ name: "h", sshConfig: { host: "127.0.0.1", port: port.value, username: "t" } }], opts)
    const before = { commands: seen.commands.length, connects: seen.connects }
    const r = await pool.run("h", "forever", { timeoutMs: 300 })
    expect(r).toEqual({ stdout: "partial", stderr: "warn", code: 124, timedOutMs: 300 })
    // The KILL request arrives just after the result; wait for it, up to 2 s.
    const deadline = Date.now() + 2_000
    while (!seen.signals.includes("KILL") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(seen.signals).toContain("KILL")
    expect(seen.commands.length - before.commands).toBe(1)
    expect(seen.connects - before.connects).toBe(1)
    // The connection stays usable after a timeout.
    expect((await pool.run("h", "quick", { timeoutMs: 5_000 })).stdout).toBe("done")
    await pool.shutdown()
  })

  it("waits without a timeout when none is given", async () => {
    const conn = await defaultConnect({ host: "127.0.0.1", port: port.value, username: "t" })
    expect(await conn.exec("quick")).toEqual({ stdout: "done", stderr: "", code: 0 })
    conn.close()
  })
})

describe("proc.run timeout", () => {
  it("keeps what the child wrote before it was killed", async () => {
    const r = await nodeProcessRunner.run("sh", ["-c", "echo out; echo err >&2; sleep 5"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 500,
    })
    expect(r).toEqual({ code: -1, stdout: "out\n", stderr: "err\n", timedOut: true })
  })
})
