import { Left, Right } from "functype"
import { describe, expect, it } from "vitest"
import { type CommandResult } from "@ssh-mcp/core"

import { createAuditor } from "../src/audit.js"
import { makeHandlers } from "../src/index.js"
import { type FleetRunner } from "../src/runners.js"

const recording = (result: CommandResult = { stdout: "agent\n", stderr: "", code: 0 }) => {
  const calls: Array<{ host: string; command: string }> = []
  const runner: FleetRunner = {
    hostNames: ["box-a", "box-b"],
    sessionFor: () => "agent",
    logOutputFor: () => false,
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
    return result
  }
  return { runner, calls }
}

const withAudit = (runner: FleetRunner, newId: () => string = () => "id-1") => {
  const lines: string[] = []
  const auditor = createAuditor({ sink: (line) => lines.push(line), now: () => new Date(), newId })
  return { h: makeHandlers(runner, auditor), lines, parsed: () => lines.map((l) => JSON.parse(l)) }
}

describe("orchestrator handlers", () => {
  it("hosts_list returns status JSON", async () => {
    const { runner } = recording()
    const { h } = withAudit(runner)
    const out = JSON.parse(await h.hostsList())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ name: "box-a", state: "idle" })
  })

  it("exec routes the command to the named host", async () => {
    const { runner, calls } = recording()
    const { h } = withAudit(runner)
    await h.exec({ host: "box-b", command: "whoami" })
    expect(calls).toContainEqual({ host: "box-b", command: "whoami" })
  })

  it("tmux_list runs list-sessions on the host", async () => {
    const { runner, calls } = recording()
    const { h } = withAudit(runner)
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
    const { h } = withAudit(failing)
    await expect(h.exec({ host: "z", command: "x" })).rejects.toThrow(/unknown host/)
  })
})

describe("audit", () => {
  it("exec writes a decision and a result", async () => {
    const { runner } = recording()
    const { h, parsed } = withAudit(runner)
    await h.exec({ host: "box-b", command: "whoami" })
    const [decision, result] = parsed()
    expect(decision).toMatchObject({
      event: "decision",
      agent: "unknown",
      tool: "exec",
      host: "box-b",
      command: "whoami",
      decision: "allow",
    })
    expect(result).toMatchObject({ event: "result", status: "ok", code: 0, stdout_bytes: 6, stderr_bytes: 0 })
    expect("stdout_excerpt" in result).toBe(false)
  })

  it("exec adds excerpts for a log_output host", async () => {
    const { runner } = recording()
    const { h, parsed } = withAudit({ ...runner, logOutputFor: (host) => host === "box-b" })
    await h.exec({ host: "box-b", command: "whoami" })
    expect(parsed()[1]).toMatchObject({ stdout_excerpt: "agent\n", stderr_excerpt: "" })
  })

  it("exec with stderr is audited as ok, then the handler throws", async () => {
    const { runner } = recording({ stdout: "", stderr: "denied\n", code: 1 })
    const { h, parsed } = withAudit(runner)
    await expect(h.exec({ host: "box-a", command: "cat /root/x" })).rejects.toThrow(/denied/)
    expect(parsed()[1]).toMatchObject({ status: "ok", code: 1, stderr_bytes: 7 })
  })

  it("stdout_bytes counts UTF-8 bytes", async () => {
    const { runner } = recording({ stdout: "é\n", stderr: "", code: 0 })
    const { h, parsed } = withAudit(runner)
    await h.exec({ host: "box-a", command: "echo é" })
    expect(parsed()[1]).toMatchObject({ stdout_bytes: 3 })
  })

  it("tmux_send logs the input text", async () => {
    const { runner } = recording({ stdout: "", stderr: "", code: 0 })
    const { h, parsed } = withAudit(runner)
    await h.tmuxSend({ host: "box-a", input: "ls -la" })
    expect(parsed()[0]).toMatchObject({ tool: "tmux_send", session: "agent", input: "ls -la", submit: true })
  })

  it("tmux_read logs the line count, not the transcript", async () => {
    const { runner } = recording({ stdout: "SECRET-OUTPUT\n", stderr: "", code: 0 })
    const { h, lines, parsed } = withAudit(runner)
    await h.tmuxRead({ host: "box-a" })
    const [decision, result] = parsed()
    expect(decision).toMatchObject({ tool: "tmux_read", lines: 200 })
    // core trims trailing whitespace, so the transcript returned is 13 bytes
    expect(result).toMatchObject({ status: "ok", stdout_bytes: 13 })
    expect(lines.join("")).not.toContain("SECRET-OUTPUT")
  })

  it("an unknown host is still audited", async () => {
    const { runner } = recording()
    const { h, parsed } = withAudit({ ...runner, tmuxRunnerFor: () => Left('unknown host "z"') })
    await expect(h.tmuxList({ host: "z" })).rejects.toThrow(/unknown host/)
    const [decision, result] = parsed()
    expect(decision).toMatchObject({ event: "decision", tool: "tmux_list", host: "z" })
    expect(result).toMatchObject({ event: "result", status: "error" })
  })

  it("concurrent calls each get a complete pair", async () => {
    const { runner } = recording()
    const counter = { n: 0 }
    const { h, parsed } = withAudit(runner, () => `id-${++counter.n}`)
    await Promise.all([h.exec({ host: "box-a", command: "a" }), h.exec({ host: "box-b", command: "b" })])
    const all = parsed()
    expect(all).toHaveLength(4)
    const ids = [...new Set(all.map((l) => l.id))]
    expect(ids).toHaveLength(2)
    ids.forEach((id) => {
      const decisionAt = all.findIndex((l) => l.id === id && l.event === "decision")
      const resultAt = all.findIndex((l) => l.id === id && l.event === "result")
      expect(decisionAt).toBeGreaterThanOrEqual(0)
      expect(decisionAt).toBeLessThan(resultAt)
    })
  })
})
