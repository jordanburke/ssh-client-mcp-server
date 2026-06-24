import { Right } from "functype"
import { describe, expect, it } from "vitest"
import { type CommandResult } from "@ssh-mcp/core"

import { makeHandlers } from "../src/index.js"
import { type FleetRunner } from "../src/runners.js"

const recording = () => {
  const calls: Array<{ host: string; command: string }> = []
  const runner: FleetRunner = {
    hostNames: ["box-a", "box-b"],
    sessionFor: () => "agent",
    tmuxRunnerFor: (host) => Right((command: string) => run(host, command)),
    exec: (host, command) => run(host, command),
    status: () => [
      { name: "box-a", state: "idle", inFlight: 0 },
      { name: "box-b", state: "disconnected", inFlight: 0 },
    ],
    shutdown: async () => {},
  }
  const run = async (host: string, command: string): Promise<CommandResult> => {
    calls.push({ host, command })
    return { stdout: "agent\n", stderr: "", code: 0 }
  }
  return { runner, calls }
}

describe("orchestrator handlers", () => {
  it("hosts_list returns status JSON", async () => {
    const { runner } = recording()
    const h = makeHandlers(runner)
    const out = JSON.parse(await h.hostsList())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ name: "box-a", state: "idle" })
  })

  it("exec routes the command to the named host", async () => {
    const { runner, calls } = recording()
    const h = makeHandlers(runner)
    await h.exec({ host: "box-b", command: "whoami" })
    expect(calls).toContainEqual({ host: "box-b", command: "whoami" })
  })

  it("tmux_list runs list-sessions on the host", async () => {
    const { runner, calls } = recording()
    const h = makeHandlers(runner)
    const out = await h.tmuxList({ host: "box-a" })
    expect(calls[0]).toMatchObject({ host: "box-a" })
    expect(calls[0].command).toContain("list-sessions")
    expect(out).toContain("agent")
  })

  it("rejects an unknown host on exec", async () => {
    const { runner } = recording()
    const failing: FleetRunner = {
      ...runner,
      exec: async () => {
        throw new Error('unknown host "z"')
      },
    }
    const h = makeHandlers(failing)
    await expect(h.exec({ host: "z", command: "x" })).rejects.toThrow(/unknown host/)
  })
})
