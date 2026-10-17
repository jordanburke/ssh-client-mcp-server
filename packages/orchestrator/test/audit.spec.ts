import { Option } from "functype"
import { UserError } from "somamcp"
import { describe, expect, it } from "vitest"

import { AGENT_UNKNOWN, type AuditCall, type AuditSink, createAuditor, excerpt } from "../src/audit.js"

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
      { agent: AGENT_UNKNOWN, tool: "hosts_list", host: Option.none<string>(), fields: {} },
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
