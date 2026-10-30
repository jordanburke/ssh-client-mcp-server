import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type CommandResult, socketPathFor } from "@ssh-mcp/core"
import { Map } from "functype"
import { describe, expect, it } from "vitest"

import { createAuditor } from "../src/audit.js"
import { checkRuntimeDir, readCheckConfig, runCheck } from "../src/check.js"
import { parseFleet } from "../src/fleet.js"

const ok: CommandResult = { stdout: "", stderr: "", code: 0 }

const harness = (toml: string, exec: (host: string) => Promise<CommandResult>, missingKeyCas: string[] = []) => {
  const out: string[] = []
  const lines: string[] = []
  const calls: Array<{ host: string; command: string; agent: string }> = []
  const auditor = createAuditor({ sink: (l) => lines.push(l), now: () => new Date(), newId: () => "id" })
  const run = () =>
    runCheck({
      fleet: parseFleet(toml).orThrow(),
      configPath: "/cfg/fleet.toml",
      runner: {
        exec: (host, command, agent) => {
          calls.push({ host, command, agent })
          return exec(host)
        },
      },
      auditor,
      missingKeyCas,
      caPublicKeys: Map.of<string, string>(),
      out: (l) => out.push(l),
    })
  return { run, out, calls, audit: () => lines.map((l) => JSON.parse(l)) }
}

const twoHosts = `
[[hosts]]
name = "mini"
host = "mini.local"
user = "me"
key = "/k"
[[hosts]]
name = "nas"
host = "nas.local"
agent = true
`

describe("runCheck", () => {
  it("every host passing exits 0", async () => {
    const t = harness(twoHosts, async () => ok)
    expect(await t.run()).toBe(0)
    expect(t.out.filter((l) => l.startsWith("ok "))).toHaveLength(2)
    expect(t.calls.every((c) => c.command === "true" && c.agent === "operator")).toBe(true)
  })

  it("a failing host exits 1", async () => {
    const t = harness(twoHosts, async (host) =>
      host === "nas" ? Promise.reject(new Error("connect ECONNREFUSED")) : ok,
    )
    expect(await t.run()).toBe(1)
    expect(t.out.find((l) => l.includes("nas"))).toMatch(/^FAIL .*ECONNREFUSED/)
  })

  it("a non-zero exit of true is a failure", async () => {
    const t = harness(twoHosts, async () => ({ stdout: "", stderr: "This account is restricted", code: 1 }))
    expect(await t.run()).toBe(1)
    expect(t.out.find((l) => l.includes("mini"))).toMatch(/^FAIL .*restricted/)
  })

  it("check writes an audit line per host", async () => {
    const t = harness(twoHosts, async () => ok)
    await t.run()
    const decisions = t.audit().filter((l) => l.event === "decision")
    expect(decisions.map((d) => d.host)).toEqual(expect.arrayContaining(["mini", "nas"]))
    decisions.forEach((d) =>
      expect(d).toMatchObject({ tool: "check", agent: "operator", decision: "allow", bypass: "policy" }),
    )
  })

  it("check ignores a readonly policy", async () => {
    const t = harness(
      `
[[hosts]]
name = "ro"
host = "h"
key = "/k"
  [hosts.policy]
  mode = "readonly"
`,
      async () => ok,
    )
    expect(await t.run()).toBe(0)
    expect(t.calls).toEqual([{ host: "ro", command: "true", agent: "operator" }])
  })

  it("a missing key_file fails only its CA's hosts", async () => {
    const t = harness(
      `
[[cas]]
name = "a"
key_file = "/missing/ca-a"
[[cas]]
name = "b"
key_cmd = "op read b"
[[hosts]]
name = "ha"
host = "h"
ca = "a"
[[hosts]]
name = "hb"
host = "h"
ca = "b"
[[hosts]]
name = "pw"
host = "h"
key = "/k"
`,
      async () => ok,
      ["a"],
    )
    expect(await t.run()).toBe(1)
    expect(t.out.find((l) => l.includes(" ha "))).toMatch(
      /^FAIL .*key_file missing: the server creates it on first start/,
    )
    expect(t.calls.map((c) => c.host).sort()).toEqual(["hb", "pw"])
  })

  it("zero hosts exits 0", async () => {
    const t = harness("", async () => ok)
    expect(await t.run()).toBe(0)
    expect(t.out).toContain("No hosts configured; add a [[hosts]] entry to /cfg/fleet.toml.")
  })
})

describe("check setup", () => {
  it("a missing config exits 1 without creating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-check-"))
    try {
      const path = join(dir, ".config", "ssh-fleet", "fleet.toml")
      const r = readCheckConfig(path)
      expect(r.swap().orElse("")).toBe(
        `No fleet config at ${path}. Start the server once to create one at the default path, or pass --config=.`,
      )
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("the check runtime dir is separate", () => {
    expect(checkRuntimeDir("/run/user/1000/ssh-fleet")).toBe("/run/user/1000/ssh-fleet-check")
    expect(socketPathFor(checkRuntimeDir(`/${"x".repeat(60)}`), "unknown", "host").isLeft()).toBe(true)
  })
})
