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
import { Option } from "functype"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type CaEntry, type CaKeyRef } from "../src/fleet.js"
import { caKeySource } from "../src/runners.js"
import { ensureCaKeyFiles, ensureConfig, resolveConfigPath } from "../src/setup.js"
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
