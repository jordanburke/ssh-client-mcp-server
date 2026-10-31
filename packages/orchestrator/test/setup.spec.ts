import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { nodeProcessRunner, type ProcessRunner } from "@ssh-mcp/core"
import { Left, Map, Option, Right } from "functype"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type CaEntry, type CaKeyRef, parseFleet } from "../src/fleet.js"
import { caKeySource, type FleetRunner, type HostError } from "../src/runners.js"
import { ensureCaKeyFiles, ensureConfig, resolveConfigPath, type SetupContext, setupReport } from "../src/setup.js"
import { FLEET_TEMPLATE } from "../src/template.js"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fleet-setup-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const defaultPath = (): string => join(home, ".config", "ssh-fleet", "fleet.toml")

describe("resolveConfigPath", () => {
  it("resolveConfigPath prefers the flag, then the env var, then the default", () => {
    expect(resolveConfigPath(["--config=/a.toml"], { SSH_FLEET_CONFIG: "/b.toml" }, home)).toEqual({
      path: "/a.toml",
      explicit: true,
    })
    expect(resolveConfigPath([], { SSH_FLEET_CONFIG: "/b.toml" }, home)).toEqual({ path: "/b.toml", explicit: true })
    expect(resolveConfigPath([], {}, home)).toEqual({ path: defaultPath(), explicit: false })
  })
})

describe("ensureConfig", () => {
  it("the default path is created from the template", () => {
    const r = ensureConfig({ path: defaultPath(), explicit: false })
    expect(r.isRight() && r.value.created).toBe(true)
    expect(readFileSync(defaultPath(), "utf8")).toBe(FLEET_TEMPLATE)
    expect(statSync(defaultPath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, ".config", "ssh-fleet")).mode & 0o777).toBe(0o700)
  })

  it("an existing config is left alone", () => {
    mkdirSync(join(home, ".config", "ssh-fleet"), { recursive: true })
    writeFileSync(defaultPath(), "# mine\n")
    const r = ensureConfig({ path: defaultPath(), explicit: true })
    expect(r.isRight() && r.value.created).toBe(false)
    expect(readFileSync(defaultPath(), "utf8")).toBe("# mine\n")
  })

  it("an explicit path that doesn't exist is not created", () => {
    const path = join(home, "typo.toml")
    const r = ensureConfig({ path, explicit: true })
    expect(r.isLeft()).toBe(true)
    expect(r.swap().orElse("")).toContain(path)
    expect(() => statSync(path)).toThrow()
  })

  it("an existing default config hits EEXIST, not an error", () => {
    mkdirSync(join(home, ".config", "ssh-fleet"), { recursive: true })
    writeFileSync(defaultPath(), "# mine\n")
    const r = ensureConfig({ path: defaultPath(), explicit: false })
    expect(r.isRight() && r.value.created).toBe(false)
    expect(readFileSync(defaultPath(), "utf8")).toBe("# mine\n")
  })
})

const hasOpenSsh = spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error === undefined

const ca = (name: string, key: CaKeyRef): CaEntry => ({ name, key, principal: "fleet", sourceAddress: Option.none() })

// Records every run; answers with `result`.
const fakeProc = (result = { code: 0, stdout: "", stderr: "" }) => {
  const calls: string[] = []
  const proc: ProcessRunner = {
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "))
      return result
    },
    spawn: () => {
      throw new Error("spawn not expected")
    },
  }
  return { proc, calls }
}

describe.skipIf(!hasOpenSsh)("ensureCaKeyFiles (OpenSSH)", () => {
  it("a missing key_file is created 0600", async () => {
    const path = join(home, "state", "ca-home")
    const r = await ensureCaKeyFiles([ca("home", { kind: "file", path })], nodeProcessRunner)
    expect(r.orElse([])).toEqual(["home"])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(`${path}.pub`).isFile()).toBe(true)
    expect((await caKeySource(ca("home", { kind: "file", path })).key()).isRight()).toBe(true)
  })
})

describe("ensureCaKeyFiles", () => {
  it("an existing key_file is not touched", async () => {
    const path = join(home, "ca-home")
    writeFileSync(path, "KEY", { mode: 0o600 })
    const before = statSync(path).mtimeMs
    const { proc, calls } = fakeProc()
    const r = await ensureCaKeyFiles([ca("home", { kind: "file", path })], proc)
    expect(r.orElse(["x"])).toEqual([])
    expect(calls).toEqual([])
    expect(readFileSync(path, "utf8")).toBe("KEY")
    expect(statSync(path).mtimeMs).toBe(before)
  })

  it("a wrong-mode key_file is not replaced", async () => {
    const path = join(home, "ca-home")
    writeFileSync(path, "KEY")
    chmodSync(path, 0o644)
    const { proc, calls } = fakeProc()
    await ensureCaKeyFiles([ca("home", { kind: "file", path })], proc)
    expect(calls).toEqual([])
    expect(statSync(path).mode & 0o777).toBe(0o644)
    expect((await caKeySource(ca("home", { kind: "file", path })).key()).isLeft()).toBe(true)
  })

  it("a dangling symlink is not followed or replaced", async () => {
    const path = join(home, "ca-home")
    symlinkSync(join(home, "nowhere"), path)
    const { proc, calls } = fakeProc()
    await ensureCaKeyFiles([ca("home", { kind: "file", path })], proc)
    expect(calls).toEqual([])
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe(join(home, "nowhere"))
  })

  it("key_cmd and key_env never create anything", async () => {
    const { proc, calls } = fakeProc()
    const r = await ensureCaKeyFiles(
      [ca("a", { kind: "cmd", cmd: "op read x" }), ca("b", { kind: "env", name: "CA_B" })],
      proc,
    )
    expect(r.orElse(["x"])).toEqual([])
    expect(calls).toEqual([])
  })

  it("a failed ssh-keygen stops startup naming the CA", async () => {
    const { proc } = fakeProc({ code: 1, stdout: "", stderr: "boom" })
    const r = await ensureCaKeyFiles([ca("home", { kind: "file", path: join(home, "ca-home") })], proc)
    expect(r.isLeft()).toBe(true)
    expect(r.swap().orElse("")).toContain('CA "home"')
    expect(r.swap().orElse("")).toContain("boom")
  })

  it("losing the creation race to another process is not an error", async () => {
    const path = join(home, "ca-home")
    const proc: ProcessRunner = {
      run: async () => {
        writeFileSync(path, "KEY", { mode: 0o600 })
        return { code: 1, stdout: "", stderr: "ca-home already exists." }
      },
      spawn: () => {
        throw new Error("spawn not expected")
      },
    }
    const r = await ensureCaKeyFiles([ca("home", { kind: "file", path })], proc)
    expect(r.orElse(["x"])).toEqual([])
  })
})

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITEST ssh-fleet-ca-home"

const contextFor = (toml: string, over: Partial<SetupContext> = {}): SetupContext => ({
  configPath: "/cfg/fleet.toml",
  configCreated: false,
  fleet: parseFleet(toml).orThrow(),
  loadedConfig: toml,
  readConfig: () => Right(toml),
  caPublicKeys: Map.of<string, string>(),
  caCreated: [],
  runtimeDir: Option.none(),
  knownHosts: Option.none(),
  ...over,
})

const runnerWith = (errors: Record<string, HostError> = {}): Pick<FleetRunner, "status" | "lastError"> => ({
  status: () => [],
  lastError: (host) => Option(errors[host]),
})

const caToml = `
[[cas]]
name = "home"
key_file = "~/.local/state/ssh-fleet/ca-home"
`

describe("setupReport", () => {
  it("an empty fleet says to add a host", () => {
    const r = setupReport(contextFor("", { configCreated: true }), runnerWith(), {})
    expect(r.config).toEqual({ path: "/cfg/fleet.toml", created_this_start: true, changed_since_start: false })
    expect(r.next_steps[0]).toBe("Add a [[hosts]] entry to /cfg/fleet.toml, then restart the server.")
  })

  it("a created CA is flagged with its enrollment line", () => {
    const r = setupReport(
      contextFor(caToml, { caPublicKeys: Map.of(["home", PUB]), caCreated: ["home"] }),
      runnerWith(),
      {},
    )
    const ca = r.cas[0]
    expect(ca).toMatchObject({ name: "home", key_source: "key_file", created_this_start: true, public_key: PUB })
    expect(ca.enroll_line).toBe(`cert-authority,principals="fleet" ${PUB}`)
    expect(r.next_steps.some((s) => s.includes('CA "home"') && s.includes(ca.enroll_line ?? "?"))).toBe(true)
  })

  it("a CA with no hosts still shows its line", () => {
    const r = setupReport(contextFor(caToml, { caPublicKeys: Map.of(["home", PUB]) }), runnerWith(), {})
    expect(r.hosts).toEqual([])
    expect(r.cas[0].public_key).toBe(PUB)
    expect(r.cas[0].enroll_line).toContain(PUB)
  })

  it("a host principal override changes the host's line only", () => {
    const r = setupReport(
      contextFor(
        `${caToml}
[[hosts]]
name = "nas"
host = "nas.local"
user = "fleet"
ca = "home"
principal = "ops"
`,
        { caPublicKeys: Map.of(["home", PUB]) },
      ),
      runnerWith(),
      {},
    )
    expect(r.hosts[0].enroll_line).toBe(`cert-authority,principals="ops" ${PUB}`)
    expect(r.cas[0].enroll_line).toBe(`cert-authority,principals="fleet" ${PUB}`)
  })

  it("auth kinds are reported", () => {
    const r = setupReport(
      contextFor(`${caToml}
[[hosts]]
name = "p"
host = "h"
password_env = "FLEET_T_PW"
[[hosts]]
name = "k"
host = "h"
key = "/k"
[[hosts]]
name = "ke"
host = "h"
key_env = "FLEET_T_KEY"
[[hosts]]
name = "a"
host = "h"
agent = true
[[hosts]]
name = "c"
host = "h"
ca = "home"
`),
      runnerWith(),
      {},
    )
    expect(r.hosts.map((h) => h.auth)).toEqual(["password_env", "key", "key_env", "agent", "ca"])
  })

  it("the report never contains a key_cmd string", () => {
    const r = setupReport(
      contextFor(`
[[cas]]
name = "vault"
key_cmd = "bws get --token SECRET123"
`),
      runnerWith(),
      {},
    )
    const text = JSON.stringify(r)
    expect(text).not.toContain("SECRET123")
    expect(text).not.toContain("bws")
    expect(r.cas[0].key_source).toBe("key_cmd")
  })

  const pwHost = `
[[hosts]]
name = "mini"
host = "mini.local"
user = "me"
password_env = "MINI_PW"
`

  it("the report never contains a password value", () => {
    process.env.MINI_PW = "SECRET-PW"
    const ctx = contextFor(pwHost)
    delete process.env.MINI_PW
    const r = setupReport(ctx, runnerWith(), { MINI_PW: "SECRET-PW" })
    expect(JSON.stringify(r)).not.toContain("SECRET-PW")
    expect(r.hosts[0]).toMatchObject({ address: "me@mini.local:22", password_env: "MINI_PW", env_set: true })
  })

  it("an unset password_env is a next step", () => {
    const r = setupReport(contextFor(pwHost), runnerWith(), {})
    expect(r.hosts[0].env_set).toBe(false)
    expect(r.next_steps).toContain("mini: set MINI_PW in the MCP client's env for this server, then restart.")
  })

  it("a host's last error appears in the report and next_steps", () => {
    const err = { message: "connect ECONNREFUSED", at: "2026-10-30T00:00:00.000Z" }
    const r = setupReport(contextFor(pwHost), runnerWith({ mini: err }), { MINI_PW: "x" })
    expect(r.hosts[0].last_error).toEqual(err)
    expect(r.next_steps).toEqual(["mini: connect ECONNREFUSED"])
  })
})

describe("config changed since start", () => {
  const twoHosts = `
[[hosts]]
name = "a"
host = "h"
key = "/k"
[[hosts]]
name = "b"
host = "h"
key = "/k"
`

  it("an unchanged config is not flagged", () => {
    const r = setupReport(contextFor(""), runnerWith(), {})
    expect(r.config.changed_since_start).toBe(false)
    expect(r.next_steps[0]).toBe("Add a [[hosts]] entry to /cfg/fleet.toml, then restart the server.")
  })

  it("hosts added after start say to reconnect, not to add a host", () => {
    const r = setupReport(contextFor("", { readConfig: () => Right(twoHosts) }), runnerWith(), {})
    expect(r.config).toMatchObject({ changed_since_start: true, hosts_on_disk: 2 })
    expect(r.next_steps).toEqual([
      "fleet.toml changed since the server started (2 hosts on disk, 0 loaded): reconnect the server to load it (in Claude Code: /mcp, then reconnect).",
    ])
  })

  it("a changed config with errors says to fix them first", () => {
    const r = setupReport(contextFor("", { readConfig: () => Right("[[hosts]]\nname = 1\n") }), runnerWith(), {})
    expect(r.config.changed_since_start).toBe(true)
    expect(r.config.errors_on_disk).toContain("Fleet config errors")
    expect(r.next_steps[0]).toMatch(
      /^fleet\.toml changed since the server started and now has errors; fix them before reconnecting:/,
    )
  })

  it("a config that can't be read now is reported", () => {
    const r = setupReport(contextFor(twoHosts, { readConfig: () => Left("ENOENT: no such file") }), runnerWith(), {})
    expect(r.config).toMatchObject({ changed_since_start: true, errors_on_disk: "ENOENT: no such file" })
  })
})
