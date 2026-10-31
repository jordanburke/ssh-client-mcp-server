import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { Option } from "functype"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { isEntryPoint } from "../src/entry.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-entry-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("isEntryPoint", () => {
  it("is true when run directly", () => {
    const file = join(dir, "index.js")
    writeFileSync(file, "")
    expect(isEntryPoint(Option(file), pathToFileURL(file).href)).toBe(true)
  })

  // npm and npx run a package's bin through a link in node_modules/.bin.
  it("is true when run through a symlink, as npm's bin link does", () => {
    const file = join(dir, "index.js")
    writeFileSync(file, "")
    const link = join(dir, "ssh-fleet-mcp-server")
    symlinkSync(file, link)
    expect(isEntryPoint(Option(link), pathToFileURL(file).href)).toBe(true)
  })

  it("is false when another file is the entry, as when a test imports the module", () => {
    const file = join(dir, "index.js")
    const runner = join(dir, "vitest.mjs")
    writeFileSync(file, "")
    writeFileSync(runner, "")
    expect(isEntryPoint(Option(runner), pathToFileURL(file).href)).toBe(false)
  })

  it("is false with no argv[1] or a path that doesn't exist", () => {
    const file = join(dir, "index.js")
    writeFileSync(file, "")
    expect(isEntryPoint(Option.none(), pathToFileURL(file).href)).toBe(false)
    expect(isEntryPoint(Option(join(dir, "missing")), pathToFileURL(file).href)).toBe(false)
  })
})
