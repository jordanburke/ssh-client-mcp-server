import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ensureConfig, resolveConfigPath } from "../src/setup.js"
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
