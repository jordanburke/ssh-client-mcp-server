import { type Either } from "functype"
import { describe, expect, it } from "vitest"

import { EMPTY_TABLE, type HostPolicy, parsePolicyTable, type PolicyTable, resolvePolicy } from "../src/policy.js"

const W = 'host "a": policy'

const errorsOf = (r: Either<ReadonlyArray<string>, unknown>): ReadonlyArray<string> =>
  r.fold(
    (errs) => errs,
    () => [],
  )

const table = (raw: unknown, where: string = W): PolicyTable =>
  parsePolicyTable(raw, where).fold(
    (errs) => {
      throw new Error(errs.join("; "))
    },
    (t) => t,
  )

const resolve = (defaults: unknown, host: unknown): Either<ReadonlyArray<string>, HostPolicy> =>
  resolvePolicy(W, table(defaults, "defaults.policy"), table(host))

const resolved = (defaults: unknown, host: unknown): HostPolicy =>
  resolve(defaults, host).fold(
    (errs) => {
      throw new Error(errs.join("; "))
    },
    (p) => p,
  )

describe("parsePolicyTable / resolvePolicy", () => {
  it("no tables resolve to the built-in default", () => {
    const p = resolvePolicy(W, EMPTY_TABLE, EMPTY_TABLE).orThrow()
    expect(p.mode).toBe("readwrite")
    expect(p.tmux).toBe("open")
    expect(p.allow).toEqual([])
    expect(p.needsApproval).toEqual([])
    expect(p.agents.isNone()).toBe(true)
  })

  it("host keys override defaults; lists replace", () => {
    const p = resolved({ mode: "readonly", allow: ["uptime"] }, { allow: ["df -h"] })
    expect(p.mode).toBe("readonly")
    expect(p.allow.map((r) => r.source)).toEqual(["^(?:df -h)$"])
  })

  it("rejects an unknown mode", () => {
    expect(errorsOf(parsePolicyTable({ mode: "nope" }, W))).toContain(
      'host "a": policy.mode must be one of readonly, readwrite, deny',
    )
  })

  it("rejects an unknown tmux value", () => {
    expect(errorsOf(parsePolicyTable({ tmux: "x" }, W))).toContain('host "a": policy.tmux must be approve or open')
  })

  it("rejects a non-array allow", () => {
    expect(errorsOf(parsePolicyTable({ allow: "uptime" }, W))).toContain(
      'host "a": policy.allow must be an array of strings',
    )
  })

  it("rejects an invalid regex", () => {
    const errs = errorsOf(resolve({}, { mode: "readonly", allow: ["("] }))
    expect(errs.some((e) => e.startsWith('host "a": policy: invalid regex in allow: "("'))).toBe(true)
  })

  it("rejects allow without readonly", () => {
    expect(errorsOf(resolve({}, { allow: ["uptime"] }))).toContain(
      'host "a": policy: allow applies only to mode = "readonly"',
    )
  })

  it("rejects needs_approval without readwrite", () => {
    expect(errorsOf(resolve({}, { mode: "readonly", needs_approval: ["rm"] }))).toContain(
      'host "a": policy: needs_approval applies only to mode = "readwrite"',
    )
  })

  it("rejects a non-table", () => {
    expect(errorsOf(parsePolicyTable("x", "defaults.policy"))).toContain("defaults.policy must be a table")
  })

  it("rejects an unknown key", () => {
    expect(errorsOf(parsePolicyTable({ needs_aproval: ["rm"] }, W))).toContain(
      'host "a": policy: unknown key "needs_aproval"',
    )
  })

  it("allow = [] drops an inherited allow", () => {
    const p = resolved({ mode: "readonly", allow: ["uptime"] }, { mode: "readwrite", allow: [] })
    expect(p.mode).toBe("readwrite")
    expect(p.allow).toEqual([])
  })

  it("an inherited allow under a readwrite override is an error", () => {
    expect(errorsOf(resolve({ mode: "readonly", allow: ["uptime"] }, { mode: "readwrite" }))).toContain(
      'host "a": policy: allow applies only to mode = "readonly"',
    )
  })

  it("agents = [] is not set", () => {
    expect(resolved({}, { agents: [] }).agents.isNone()).toBe(true)
  })
})
