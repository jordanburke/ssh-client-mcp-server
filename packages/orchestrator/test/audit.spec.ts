import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Option } from "functype"
import { UserError } from "somamcp"
import { afterEach, describe, expect, it } from "vitest"

import { AGENT_UNKNOWN, type AuditCall, type AuditSink, createAuditor, excerpt, openAuditLog } from "../src/audit.js"
import { ALLOW, type Verdict } from "../src/policy.js"

const clock = () => {
  const times = [new Date("2026-10-17T14:02:11.000Z"), new Date("2026-10-17T14:02:11.412Z")]
  const next = { i: 0 }
  return () => times[Math.min(next.i++, times.length - 1)]
}

const memory = (failOn: ReadonlyArray<number> = []) => {
  const lines: string[] = []
  const writes = { n: 0 }
  const sink: AuditSink = (line) => {
    writes.n++
    if (failOn.includes(writes.n)) throw new Error("disk full")
    lines.push(line)
  }
  return { lines, sink }
}

const execCall: AuditCall = {
  agent: AGENT_UNKNOWN,
  tool: "exec",
  host: Option("box-a"),
  fields: { command: "uptime" },
  verdict: ALLOW,
}

const auditorWith = (sink: AuditSink) => createAuditor({ sink, now: clock(), newId: () => "id-1" })

describe("createAuditor", () => {
  it("writes a decision line before running the call", async () => {
    const { lines, sink } = memory()
    const seenAtRun: string[] = []
    await auditorWith(sink).audited(
      execCall,
      async () => {
        seenAtRun.push(...lines)
        return { code: 0 }
      },
      () => ({}),
    )
    expect(seenAtRun).toHaveLength(1)
    expect(JSON.parse(seenAtRun[0])).toMatchObject({
      id: "id-1",
      event: "decision",
      agent: "unknown",
      tool: "exec",
      host: "box-a",
      command: "uptime",
      decision: "allow",
    })
  })

  it("writes a result line with status, ms and the summary", async () => {
    const { lines, sink } = memory()
    const out = await auditorWith(sink).audited(
      execCall,
      async () => ({ code: 0 }),
      () => ({ code: 0, stdout_bytes: 6 }),
    )
    expect(out).toEqual({ code: 0 })
    expect(JSON.parse(lines[1])).toMatchObject({
      id: "id-1",
      event: "result",
      status: "ok",
      ms: 412,
      code: 0,
      stdout_bytes: 6,
    })
  })

  it("a run that throws still yields both lines and rethrows", async () => {
    const { lines, sink } = memory()
    const boom = new Error("boom")
    await expect(
      auditorWith(sink).audited(
        execCall,
        () => Promise.reject(boom),
        () => ({}),
      ),
    ).rejects.toBe(boom)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1])).toMatchObject({ status: "error", error: "boom" })
  })

  it("a decision write failure stops the call", async () => {
    const { sink } = memory([1])
    const ran = { called: false }
    const result = auditorWith(sink).audited(
      execCall,
      async () => {
        ran.called = true
        return 1
      },
      () => ({}),
    )
    await expect(result).rejects.toBeInstanceOf(UserError)
    await expect(result).rejects.toThrow("call not executed")
    expect(ran.called).toBe(false)
  })

  it("a result write failure fails the call", async () => {
    const { sink } = memory([2])
    const result = auditorWith(sink).audited(
      execCall,
      async () => 1,
      () => ({}),
    )
    await expect(result).rejects.toBeInstanceOf(UserError)
    await expect(result).rejects.toThrow("after execution")
  })

  it("the audit error wins when both the call and the result write fail", async () => {
    const { sink } = memory([2])
    const result = auditorWith(sink).audited(
      execCall,
      () => Promise.reject(new Error("boom")),
      () => ({}),
    )
    await expect(result).rejects.toBeInstanceOf(UserError)
    await expect(result).rejects.toThrow("after execution")
  })

  it("an allow verdict with a rule records it", async () => {
    const { lines, sink } = memory()
    await auditorWith(sink).audited(
      { ...execCall, verdict: { decision: "allow", rule: Option("readonly") } },
      async () => 1,
      () => ({}),
    )
    expect(JSON.parse(lines[0])).toMatchObject({ decision: "allow", rule: "box-a:readonly" })
  })

  it("an allow verdict without a rule omits rule", async () => {
    const { lines, sink } = memory()
    await auditorWith(sink).audited(
      execCall,
      async () => 1,
      () => ({}),
    )
    expect("rule" in JSON.parse(lines[0])).toBe(false)
  })

  const denied: Verdict = { decision: "deny", rule: "readonly", reason: "command not in allow list" }

  it("a deny verdict writes one line and never runs", async () => {
    const { lines, sink } = memory()
    const ran = { called: false }
    const result = auditorWith(sink).audited(
      { ...execCall, verdict: denied },
      async () => {
        ran.called = true
        return 1
      },
      () => ({}),
    )
    await expect(result).rejects.toBeInstanceOf(UserError)
    await expect(result).rejects.toThrow(/^\[box-a\] denied by rule readonly: command not in allow list$/)
    expect(ran.called).toBe(false)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "decision",
      decision: "deny",
      rule: "box-a:readonly",
      reason: "command not in allow list",
    })
  })

  it('a failed deny-line write is still "call not executed"', async () => {
    const { sink } = memory([1])
    const result = auditorWith(sink).audited(
      { ...execCall, verdict: denied },
      async () => 1,
      () => ({}),
    )
    await expect(result).rejects.toBeInstanceOf(UserError)
    await expect(result).rejects.toThrow("call not executed")
  })

  it("a command with a newline stays one line", async () => {
    const { lines, sink } = memory()
    const command = 'echo "a"\nrm x'
    await auditorWith(sink).audited(
      { ...execCall, fields: { command } },
      async () => 1,
      () => ({}),
    )
    expect(lines.every((l) => !l.includes("\n"))).toBe(true)
    expect(JSON.parse(lines[0]).command).toBe(command)
  })

  it("omits host for host-less tools", async () => {
    const { lines, sink } = memory()
    await auditorWith(sink).audited(
      { agent: AGENT_UNKNOWN, tool: "hosts_list", host: Option.none<string>(), fields: {}, verdict: ALLOW },
      async () => 1,
      () => ({}),
    )
    expect("host" in JSON.parse(lines[0])).toBe(false)
    expect("host" in JSON.parse(lines[1])).toBe(false)
  })
})

describe("excerpt", () => {
  it("excerpt keeps whole code points", () => {
    expect(excerpt("x".repeat(2000))).toHaveLength(1024)
    expect(Array.from(excerpt("😀".repeat(2000)))).toHaveLength(1024)
  })
})

describe("openAuditLog", () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), "audit-"))
  const modeOf = (file: string) => statSync(file).mode & 0o777
  const savedHome = process.env.HOME

  afterEach(() => {
    process.env.HOME = savedHome
  })

  it("creates missing directories and a 0600 file", () => {
    const file = join(freshDir(), "a/b/audit.jsonl")
    expect(openAuditLog(file).isRight()).toBe(true)
    expect(modeOf(file)).toBe(0o600)
  })

  it("tightens an existing 0644 file to 0600", () => {
    const file = join(freshDir(), "audit.jsonl")
    writeFileSync(file, "", { mode: 0o644 })
    expect(openAuditLog(file).isRight()).toBe(true)
    expect(modeOf(file)).toBe(0o600)
  })

  it("appends lines after existing content", () => {
    const file = join(freshDir(), "audit.jsonl")
    writeFileSync(file, "old\n")
    const sink = openAuditLog(file).orThrow()
    sink("a")
    sink("b")
    expect(readFileSync(file, "utf8")).toBe("old\na\nb\n")
  })

  it("fails when the path is a directory", () => {
    const dir = freshDir()
    mkdirSync(join(dir, "sub"))
    const result = openAuditLog(join(dir, "sub"))
    expect(result.isLeft()).toBe(true)
    expect(
      result.fold(
        (msg) => msg,
        () => "",
      ),
    ).toContain(join(dir, "sub"))
  })

  it("expands ~", () => {
    const dir = freshDir()
    process.env.HOME = dir
    expect(openAuditLog("~/x/audit.jsonl").isRight()).toBe(true)
    expect(modeOf(join(dir, "x/audit.jsonl"))).toBe(0o600)
  })

  it("recreates a deleted log at 0600", () => {
    const file = join(freshDir(), "audit.jsonl")
    const sink = openAuditLog(file).orThrow()
    unlinkSync(file)
    sink("a")
    expect(modeOf(file)).toBe(0o600)
    expect(readFileSync(file, "utf8")).toBe("a\n")
  })

  it("refuses a symlink at the audit path at startup", () => {
    const dir = freshDir()
    writeFileSync(join(dir, "target"), "")
    symlinkSync(join(dir, "target"), join(dir, "audit.jsonl"))
    expect(openAuditLog(join(dir, "audit.jsonl")).isLeft()).toBe(true)
  })

  it("refuses a dangling symlink at the audit path at startup", () => {
    const dir = freshDir()
    symlinkSync(join(dir, "missing"), join(dir, "audit.jsonl"))
    const result = openAuditLog(join(dir, "audit.jsonl"))
    expect(
      result.fold(
        (msg) => msg,
        () => "",
      ),
    ).toContain("ELOOP")
  })

  it("refuses to follow a symlink swapped in after startup", () => {
    const dir = freshDir()
    const file = join(dir, "audit.jsonl")
    const sink = openAuditLog(file).orThrow()
    writeFileSync(join(dir, "target"), "")
    unlinkSync(file)
    symlinkSync(join(dir, "target"), file)
    expect(() => sink("a")).toThrow(/ELOOP/)
    expect(readFileSync(join(dir, "target"), "utf8")).toBe("")
  })
})
