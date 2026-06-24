import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type ConnectFactory, type PooledConnection } from "@ssh-mcp/core"

import { parseFleet } from "../src/fleet.js"
import { buildFleetRunner } from "../src/runners.js"

const fakeConn: PooledConnection = {
  exec: async (command) => ({ stdout: `out:${command}`, stderr: "", code: 0 }),
  close: () => {},
  onClose: () => {},
}
const connect: ConnectFactory = async () => fakeConn

const fleet = parseFleet(`
[[hosts]]
name = "box-a"
host = "10.0.0.11"
agent = true
tmux_session = "sess-a"
`)

// resolveAuth checks SSH_AUTH_SOCK when agent = true; provide a fake value so
// the test does not depend on a live ssh-agent (connect is injected anyway).
let savedSshAuthSock: string | undefined

describe("buildFleetRunner", () => {
  beforeAll(() => {
    savedSshAuthSock = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock"
  })

  afterAll(() => {
    if (savedSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK
    } else {
      process.env.SSH_AUTH_SOCK = savedSshAuthSock
    }
  })
  it("exposes host names and a per-host tmux runner", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value.hostNames).toEqual(["box-a"])
      expect(r.value.sessionFor("box-a")).toBe("sess-a")
      const tr = r.value.tmuxRunnerFor("box-a")
      expect(tr.isRight()).toBe(true)
      if (tr.isRight())
        expect(await tr.value("tmux list-sessions")).toEqual({ stdout: "out:tmux list-sessions", stderr: "", code: 0 })
      await r.value.shutdown()
    }
  })

  it("errors the tmux runner for an unknown host", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    if (r.isRight()) {
      expect(r.value.tmuxRunnerFor("ghost").isLeft()).toBe(true)
      await r.value.shutdown()
    }
  })

  it("fails when a host's auth cannot resolve (missing key-env)", async () => {
    delete process.env.NOPE_KEY
    const f = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
key_env = "NOPE_KEY"
`)
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    expect(r.isLeft()).toBe(true)
  })
})
