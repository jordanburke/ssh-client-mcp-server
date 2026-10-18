import { type Either } from "functype"
import { describe, expect, it } from "vitest"

import {
  EMPTY_TABLE,
  evaluate,
  type HostPolicy,
  parsePolicyTable,
  type PolicyRequest,
  type PolicyTable,
  resolvePolicy,
  type Verdict,
} from "../src/policy.js"

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

  it("a pattern that only compiles when wrapped is rejected", () => {
    const errs = errorsOf(resolve({}, { mode: "readonly", allow: ["uptime)|(.*"] }))
    expect(errs.some((e) => e.startsWith('host "a": policy: invalid regex in allow: "uptime)|(.*"'))).toBe(true)
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

const exec = (command: string, agent = "unknown"): PolicyRequest => ({ tool: "exec", agent, command })
const tool = (name: "tmux_list" | "tmux_send" | "tmux_read" | "tmux_keys", agent = "unknown"): PolicyRequest => ({
  tool: name,
  agent,
})
const ruleOf = (v: Verdict): string => (v.decision === "allow" ? v.rule.orElse("") : v.rule)
const reasonOf = (v: Verdict): string => (v.decision === "deny" ? v.reason : "")

const META = "command contains a newline or shell metacharacter"
const metaRows = [
  "cmd; rm",
  "cmd && x",
  "cmd | x",
  "cmd $(x)",
  "cmd `x`",
  "cmd > f",
  "cmd < f",
  "cmd {a,b}",
  "cmd\nx",
  "cmd\0x",
  "cmd \\x",
  "cmd 'x'",
  'cmd "x"',
  "ls *",
  "ls ?",
  "ls [ab]",
  "cat ~/x",
].map((cmd): [string, unknown, PolicyRequest, "allow" | "deny", string, string] => [
  `metacharacter ${JSON.stringify(cmd)}`,
  { mode: "readonly", allow: [".*"] },
  exec(cmd),
  "deny",
  "readonly",
  META,
])

const rows: ReadonlyArray<[string, unknown, PolicyRequest, "allow" | "deny", string, string]> = [
  ["deny mode denies exec", { mode: "deny" }, exec("ls"), "deny", "deny", "host is closed by policy"],
  ["deny mode denies tmux_read", { mode: "deny" }, tool("tmux_read"), "deny", "deny", ""],
  ["deny is checked before agents", { mode: "deny", agents: ["unknown"] }, exec("ls"), "deny", "deny", ""],
  [
    "agents is checked before the allow list",
    { mode: "readonly", allow: ["uptime"], agents: ["claude"] },
    exec("uptime"),
    "deny",
    "agents",
    "",
  ],
  ["agents excludes unknown", { agents: ["claude"] }, exec("ls"), "deny", "agents", 'agent "unknown" is not in agents'],
  ["agents match by name", { agents: ["claude"] }, exec("ls", "claude"), "allow", "readwrite", ""],
  ["agents match by name@instance", { agents: ["claude"] }, exec("ls", "claude@laptop"), "allow", "readwrite", ""],
  ["agents are not a plain prefix", { agents: ["claude"] }, exec("ls", "claudex"), "deny", "agents", ""],
  ["agents match the name before @", { agents: ["claude"] }, exec("ls", "x@claude"), "deny", "agents", ""],
  [
    "readonly allows an allowlisted command",
    { mode: "readonly", allow: ["uptime"] },
    exec("uptime"),
    "allow",
    "readonly",
    "",
  ],
  [
    "readonly is a full match",
    { mode: "readonly", allow: ["uptime"] },
    exec("uptime --help"),
    "deny",
    "readonly",
    "command not in allow list",
  ],
  ["trailing space is not trimmed", { mode: "readonly", allow: ["uptime"] }, exec("uptime "), "deny", "readonly", ""],
  ["alternation: df -h", { mode: "readonly", allow: ["df -h|uptime"] }, exec("df -h"), "allow", "readonly", ""],
  ["alternation: uptime", { mode: "readonly", allow: ["df -h|uptime"] }, exec("uptime"), "allow", "readonly", ""],
  [
    "alternation is anchored: xuptime",
    { mode: "readonly", allow: ["df -h|uptime"] },
    exec("xuptime"),
    "deny",
    "readonly",
    "",
  ],
  [
    "alternation is anchored: df -hx",
    { mode: "readonly", allow: ["df -h|uptime"] },
    exec("df -hx"),
    "deny",
    "readonly",
    "",
  ],
  ...metaRows,
  ["carriage return is a newline", { mode: "readonly", allow: [".*"] }, exec("cmd\rx"), "deny", "readonly", META],
  ["a tab is not a metacharacter", { mode: "readonly", allow: ["echo\\ta"] }, exec("echo\ta"), "allow", "readonly", ""],
  [
    "readonly denies tmux_send",
    { mode: "readonly" },
    tool("tmux_send"),
    "deny",
    "readonly",
    "tmux input is not allowed on a readonly host",
  ],
  ["readonly allows tmux_read", { mode: "readonly" }, tool("tmux_read"), "allow", "readonly", ""],
  [
    "readwrite needs_approval matches anywhere",
    { needs_approval: ["rm"] },
    exec("sudo rm -rf x"),
    "deny",
    "needs_approval",
    'matches "rm" and needs approval, which is not available yet',
  ],
  ["readwrite allows anything else", {}, exec("ls"), "allow", "readwrite", ""],
  [
    "tmux approve denies tmux_keys",
    { tmux: "approve" },
    tool("tmux_keys"),
    "deny",
    "tmux",
    "tmux input requires approval, which is not available yet",
  ],
  ["tmux open allows tmux_send", {}, tool("tmux_send"), "allow", "readwrite", ""],
]

const LONG = "a".repeat(4097)
const TOO_LONG = "command is longer than 4096 characters"

describe("evaluate: command length", () => {
  it("an over-long command is denied on a readonly host before any regex runs", () => {
    // (\w+ ?)+ backtracks catastrophically; the cap must stop it before it runs.
    const v = evaluate(resolved({}, { mode: "readonly", allow: ["(\\w+ ?)+"] }), exec(`${LONG}!`))
    expect(v).toMatchObject({ decision: "deny", rule: "readonly", reason: TOO_LONG })
  })

  it("an over-long command is denied when needs_approval patterns would run", () => {
    const v = evaluate(resolved({}, { needs_approval: ["(\\w+ ?)+x"] }), exec(LONG))
    expect(v).toMatchObject({ decision: "deny", rule: "needs_approval", reason: TOO_LONG })
  })

  it("a long command is allowed on a readwrite host with no needs_approval", () => {
    expect(evaluate(resolved({}, {}), exec(LONG)).decision).toBe("allow")
  })
})

describe("evaluate", () => {
  it.each(rows)("%s", (_name, host, req, decision, rule, reason) => {
    const v = evaluate(resolved({}, host), req)
    expect(v.decision).toBe(decision)
    expect(ruleOf(v)).toBe(rule)
    if (reason) expect(reasonOf(v)).toBe(reason)
  })
})
