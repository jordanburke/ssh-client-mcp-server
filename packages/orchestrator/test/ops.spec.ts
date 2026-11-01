import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Left, Map, Option, Right } from "functype"
import { UserError } from "somamcp"
import { describe, expect, it } from "vitest"
import { type CommandResult } from "@ssh-mcp/core"

import { createAuditor } from "../src/audit.js"
import { makeHandlers } from "../src/index.js"
import { EMPTY_TABLE, type HostPolicy, parsePolicyTable, resolvePolicy } from "../src/policy.js"
import { parseFleet } from "../src/fleet.js"
import { type FleetRunner } from "../src/runners.js"
import { type SetupContext } from "../src/setup.js"

const recording = (result: CommandResult = { stdout: "agent\n", stderr: "", code: 0 }) => {
  const calls: Array<{ host: string; command: string }> = []
  const agents: string[] = []
  const runner: FleetRunner = {
    hostNames: ["box-a", "box-b"],
    sessionFor: () => "agent",
    logOutputFor: () => false,
    policyFor: () => Option.none<HostPolicy>(),
    tmuxRunnerFor: (host) => Right((command: string) => run(host, command)),
    exec: (host, command, agent) => {
      agents.push(agent)
      return run(host, command)
    },
    status: () => [
      { name: "box-a", state: "idle", inFlight: 0 },
      { name: "box-b", state: "disconnected", inFlight: 0 },
    ],
    lastError: () => Option.none(),
    shutdown: async () => {},
  }
  const run = async (host: string, command: string): Promise<CommandResult> => {
    calls.push({ host, command })
    return result
  }
  return { runner, calls, agents }
}

const emptySetup = (configPath = "/cfg/fleet.toml"): SetupContext => ({
  configPath,
  configCreated: false,
  fleet: parseFleet("").orThrow(),
  loadedConfig: "",
  readConfig: () => Right(""),
  caPublicKeys: Map.of<string, string>(),
  caCreated: [],
  runtimeDir: Option.none(),
  knownHosts: Option.none(),
})

const withAudit = (runner: FleetRunner, newId: () => string = () => "id-1", setup: SetupContext = emptySetup()) => {
  const lines: string[] = []
  const auditor = createAuditor({ sink: (line) => lines.push(line), now: () => new Date(), newId })
  return { h: makeHandlers(runner, auditor, setup), lines, parsed: () => lines.map((l) => JSON.parse(l)) }
}

describe("orchestrator handlers", () => {
  it("hosts_list returns status JSON", async () => {
    const { runner } = recording()
    const { h } = withAudit(runner)
    const out = JSON.parse(await h.hostsList())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ name: "box-a", state: "idle" })
  })

  it("hosts_list marks a host whose last connection failed as error, with the reason", async () => {
    const { runner } = recording()
    const err = { message: "connect ECONNREFUSED", at: "2026-10-31T00:00:00.000Z" }
    const failing: FleetRunner = { ...runner, lastError: (host) => (host === "box-b" ? Option(err) : Option.none()) }
    const out = JSON.parse(await withAudit(failing).h.hostsList())
    expect(out).toEqual([
      { name: "box-a", state: "idle", inFlight: 0 },
      { name: "box-b", state: "error", inFlight: 0, last_error: err },
    ])
  })

  it("hosts_list leaves a disconnected host with no error as disconnected", async () => {
    const { runner } = recording()
    const out = JSON.parse(await withAudit(runner).h.hostsList())
    expect(out).toEqual([
      { name: "box-a", state: "idle", inFlight: 0 },
      { name: "box-b", state: "disconnected", inFlight: 0 },
    ])
  })

  it("hosts_list matches a CA host's per-agent rows to the host's error", async () => {
    const { runner } = recording()
    const err = { message: "Permission denied", at: "2026-10-31T00:00:00.000Z" }
    const ca: FleetRunner = {
      ...runner,
      status: () => [{ name: "nas (unknown)", state: "disconnected", inFlight: 0 }],
      lastError: (host) => (host === "nas" ? Option(err) : Option.none()),
    }
    const out = JSON.parse(await withAudit(ca).h.hostsList())
    expect(out).toEqual([{ name: "nas (unknown)", state: "error", inFlight: 0, last_error: err }])
  })

  it("exec passes the agent to the runner", async () => {
    const { runner, agents } = recording()
    const { h } = withAudit(runner)
    await h.exec({ host: "box-a", command: "ls" })
    expect(agents).toEqual(["unknown"])
  })

  describe("exec results", () => {
    const run = (result: CommandResult) => {
      const { runner } = recording(result)
      return withAudit(runner).h.exec({ host: "box-a", command: "x" })
    }

    it("exit 0 with stderr returns stdout and keeps the warning", async () => {
      const out = await run({ stdout: "out\n", stderr: "warn\n", code: 0 })
      expect(out).toBe("out\n\n[stderr]\nwarn\n")
    })

    it("exit 0 with no stderr returns stdout unchanged", async () => {
      expect(await run({ stdout: "out\n", stderr: "", code: 0 })).toBe("out\n")
    })

    it("a non-zero exit is an error with the code and stderr", async () => {
      await expect(run({ stdout: "", stderr: "denied\n", code: 1 })).rejects.toThrow("[box-a] exit 1:\ndenied")
    })

    it("a non-zero exit with stdout and stderr keeps both", async () => {
      await expect(run({ stdout: "compiling…\n", stderr: "make: *** Error 2\n", code: 2 })).rejects.toThrow(
        "[box-a] exit 2:\nmake: *** Error 2\n\n[stdout]\ncompiling…\n",
      )
    })

    it("a non-zero exit is audited as a completed call with its code", async () => {
      const { runner } = recording({ stdout: "", stderr: "nope\n", code: 5 })
      const { h, parsed } = withAudit(runner)
      await expect(h.exec({ host: "box-a", command: "x" })).rejects.toThrow("exit 5")
      expect(parsed()[1]).toMatchObject({ event: "result", status: "ok", code: 5 })
    })

    it("a non-zero exit with no stderr is still an error, with stdout", async () => {
      await expect(run({ stdout: "partial\n", stderr: "", code: 2 })).rejects.toThrow("[box-a] exit 2:\npartial")
    })
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

  it("tmux_keys logs the session and keys", async () => {
    const { runner } = recording({ stdout: "", stderr: "", code: 0 })
    const { h, parsed } = withAudit(runner)
    await h.tmuxKeys({ host: "box-a", keys: ["C-c"] })
    expect(parsed()[0]).toMatchObject({ tool: "tmux_keys", host: "box-a", session: "agent", keys: ["C-c"] })
  })

  it("hosts_list is audited without a host", async () => {
    const { runner } = recording()
    const { h, parsed } = withAudit(runner)
    await h.hostsList()
    const [decision, result] = parsed()
    expect(decision).toMatchObject({ event: "decision", tool: "hosts_list" })
    expect("host" in decision).toBe(false)
    expect(result).toMatchObject({ event: "result", status: "ok" })
  })

  it("fleet_setup is audited like hosts_list", async () => {
    const { runner } = recording()
    const { h, parsed } = withAudit(runner)
    const out = JSON.parse(await h.fleetSetup())
    expect(out.config.path).toBe("/cfg/fleet.toml")
    const [decision, result] = parsed()
    expect(decision).toMatchObject({ event: "decision", tool: "fleet_setup", decision: "allow" })
    expect("host" in decision).toBe(false)
    expect(result).toMatchObject({ event: "result", status: "ok" })
  })

  it("fleet_setup changes nothing on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-setup-ops-"))
    try {
      const config = join(dir, "fleet.toml")
      writeFileSync(config, "# mine\n", { mode: 0o600 })
      const snapshot = () =>
        readdirSync(dir).map((f) => {
          const st = statSync(join(dir, f))
          return [f, st.size, st.mtimeMs, st.mode]
        })
      const before = snapshot()
      const { runner } = recording()
      const { h } = withAudit(runner, undefined, emptySetup(config))
      await h.fleetSetup()
      expect(snapshot()).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

const policyOf = (raw: unknown): HostPolicy =>
  resolvePolicy("test", EMPTY_TABLE, parsePolicyTable(raw, "test").orThrow()).orThrow()

const withPolicy = (runner: FleetRunner, raw: unknown): FleetRunner => ({
  ...runner,
  policyFor: () => Option(policyOf(raw)),
})

describe("policy", () => {
  it("no policy configured: every tool still runs", async () => {
    const { runner } = recording({ stdout: "", stderr: "", code: 0 })
    const { h, parsed } = withAudit(withPolicy(runner, undefined))
    await h.exec({ host: "box-a", command: "ls" })
    await h.tmuxSend({ host: "box-a", input: "ls" })
    await h.tmuxKeys({ host: "box-a", keys: ["C-c"] })
    await h.tmuxRead({ host: "box-a" })
    await h.tmuxList({ host: "box-a" })
    const decisions = parsed().filter((l) => l.event === "decision")
    expect(decisions).toHaveLength(5)
    expect(decisions.every((l) => l.decision === "allow")).toBe(true)
  })

  it("readonly host denies exec outside the allow list without running it", async () => {
    const { runner, calls } = recording()
    const { h, parsed } = withAudit(withPolicy(runner, { mode: "readonly", allow: ["uptime"] }))
    await expect(h.exec({ host: "box-a", command: "rm x" })).rejects.toThrow(
      "[box-a] denied by rule readonly: command not in allow list",
    )
    expect(calls).toEqual([])
    expect(parsed()).toHaveLength(1)
    expect(parsed()[0]).toMatchObject({ decision: "deny" })
  })

  it("readonly host allows an allowlisted exec", async () => {
    const { runner } = recording()
    const { h, parsed } = withAudit(withPolicy(runner, { mode: "readonly", allow: ["uptime"] }))
    await h.exec({ host: "box-a", command: "uptime" })
    expect(parsed()[0]).toMatchObject({ decision: "allow", rule: "box-a:readonly" })
  })

  it("readonly host denies tmux_send", async () => {
    const { runner, calls } = recording()
    const { h } = withAudit(withPolicy(runner, { mode: "readonly" }))
    await expect(h.tmuxSend({ host: "box-a", input: "ls" })).rejects.toThrow("denied by rule readonly")
    expect(calls).toEqual([])
  })

  it("needs_approval denies a matching exec", async () => {
    const { runner, calls } = recording()
    const { h } = withAudit(withPolicy(runner, { needs_approval: ["sudo"] }))
    await expect(h.exec({ host: "box-a", command: "sudo ls" })).rejects.toThrow("denied by rule needs_approval")
    expect(calls).toEqual([])
  })

  it("an unknown host is not a policy denial", async () => {
    const { runner } = recording()
    const failing: FleetRunner = {
      ...runner,
      exec: async () => {
        throw new Error('unknown host "z"')
      },
    }
    const { h, parsed } = withAudit(failing)
    await expect(h.exec({ host: "z", command: "ls" })).rejects.toThrow(/unknown host/)
    expect(parsed()[0]).toMatchObject({ decision: "allow" })
    expect("rule" in parsed()[0]).toBe(false)
  })
})

// The label and hints the client sees. somamcp guesses a plain Error's label from its words, which
// once called an unknown host "internal" and told the model the maintainer should investigate.
describe("error labels", () => {
  const caught = async (p: Promise<unknown>): Promise<UserError> => {
    const e = await p.then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(UserError)
    return e as UserError
  }
  const throwing = (message: string): FleetRunner => {
    const { runner } = recording()
    return {
      ...runner,
      exec: async () => {
        throw new Error(message)
      },
      tmuxRunnerFor: () => Left(`unknown host "z" — configured: box-a, box-b`),
    }
  }

  it("a policy denial is auth, with a hint that names the policy", async () => {
    const { runner } = recording()
    const { h } = withAudit(withPolicy(runner, { mode: "readonly" }))
    const e = await caught(h.exec({ host: "box-a", command: "rm -rf /" }))
    expect(e.category).toBe("auth")
    expect(e.suggestions?.[0]).toMatch(/policy/)
  })

  it("an unknown host is not_found, pointing at hosts_list", async () => {
    const { h } = withAudit(throwing('unknown host "z"'))
    const e = await caught(h.exec({ host: "z", command: "true" }))
    expect(e.category).toBe("not_found")
    expect(e.suggestions).toEqual(["Call hosts_list for the configured host names."])
  })

  it("an unknown host on a tmux tool is not_found too", async () => {
    const { h } = withAudit(throwing("x"))
    const e = await caught(h.tmuxList({ host: "z" }))
    expect(e.category).toBe("not_found")
  })

  it("a connection failure is execution, names the host, and points at fleet_setup", async () => {
    const { h } = withAudit(throwing("connect ECONNREFUSED 127.0.0.1:22"))
    const e = await caught(h.exec({ host: "box-a", command: "true" }))
    expect(e.message).toBe("[box-a] connect ECONNREFUSED 127.0.0.1:22")
    expect(e.category).toBe("execution")
    expect(e.suggestions).toEqual(["Call fleet_setup to see box-a's connection state and what to configure."])
  })

  it("a busy pool is timeout", async () => {
    const { h } = withAudit(throwing('host "box-a" busy: no free connection slot after 30000ms'))
    const e = await caught(h.exec({ host: "box-a", command: "true" }))
    expect(e.category).toBe("timeout")
  })

  it("a non-zero exit is execution with no hints: the command's own output explains it", async () => {
    const { runner } = recording({ stdout: "", stderr: "nope\n", code: 1 })
    const e = await caught(withAudit(runner).h.exec({ host: "box-a", command: "x" }))
    expect(e.category).toBe("execution")
    expect(e.suggestions).toEqual([])
  })

  it("a tmux result error keeps its message and is execution", async () => {
    const { runner } = recording({ stdout: "", stderr: "tmux: command not found", code: 127 })
    const e = await caught(withAudit(runner).h.tmuxList({ host: "box-a" }))
    expect(e.message).toContain("tmux not found")
    expect(e.category).toBe("execution")
  })

  it("a bad tmux argument is validation: the caller sent it, the host never ran anything", async () => {
    const { runner } = recording()
    const { h } = withAudit(runner)
    expect((await caught(h.tmuxRead({ host: "box-a", session: "bad name;", lines: 10 }))).category).toBe("validation")
    expect((await caught(h.tmuxKeys({ host: "box-a", session: "s", keys: ["F13"] }))).category).toBe("validation")
    expect((await caught(h.tmuxKeys({ host: "box-a", session: "s", keys: [] }))).category).toBe("validation")
  })
})
