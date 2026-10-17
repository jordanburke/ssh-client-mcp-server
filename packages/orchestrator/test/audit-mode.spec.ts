import * as fs from "node:fs"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { openAuditLog } from "../src/audit.js"

// Wrap the real fs calls so tests can see which ones openAuditLog makes. A file with the
// append-only flag (chattr +a / chflags uappend) refuses chmod, so startup must not change the
// mode of a file that is already 0600 — and must change it through the open fd, not the path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    fchmodSync: vi.fn(actual.fchmodSync),
    writeSync: vi.fn(actual.writeSync),
  }
})

const freshFile = () => join(mkdtempSync(join(tmpdir(), "audit-mode-")), "audit.jsonl")

describe("openAuditLog mode handling", () => {
  beforeEach(() => {
    vi.mocked(fs.chmodSync).mockClear()
    vi.mocked(fs.fchmodSync).mockClear()
    vi.mocked(fs.writeSync).mockClear()
  })

  it("does not change the mode of a file already at 0600", () => {
    const file = freshFile()
    writeFileSync(file, "", { mode: 0o600 })
    expect(openAuditLog(file).isRight()).toBe(true)
    expect(fs.chmodSync).not.toHaveBeenCalled()
    expect(fs.fchmodSync).not.toHaveBeenCalled()
  })

  it("tightens a wider file through the open fd, not the path", () => {
    const file = freshFile()
    writeFileSync(file, "", { mode: 0o644 })
    expect(openAuditLog(file).isRight()).toBe(true)
    expect(fs.chmodSync).not.toHaveBeenCalled()
    expect(fs.fchmodSync).toHaveBeenCalledTimes(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("a short write fails the append", () => {
    const sink = openAuditLog(freshFile()).orThrow()
    vi.mocked(fs.writeSync).mockImplementationOnce(() => 2)
    expect(() => sink("abcdef")).toThrow(/short write/)
  })
})
