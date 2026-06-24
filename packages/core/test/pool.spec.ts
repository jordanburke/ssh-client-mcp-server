import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type ConnectFactory, createPool, type PooledConnection } from "../src/pool.js"

// A controllable fake connection. Records exec calls; lets tests resolve/reject.
const makeFakeConn = () => {
  let closeCb: (() => void) | undefined
  const calls: string[] = []
  const conn: PooledConnection = {
    exec: async (command: string) => {
      calls.push(command)
      return { stdout: `ran:${command}`, stderr: "", code: 0 }
    },
    close: () => closeCb?.(),
    onClose: (cb) => {
      closeCb = cb
    },
  }
  return { conn, calls, fail: () => closeCb?.() }
}

// A gateable fake connection: each exec() call blocks until you call gate.open() or gate.fail().
type Gate = { open: (result?: string) => void; fail: (err: Error) => void }
const makeGatedConn = () => {
  let closeCb: (() => void) | undefined
  const execCalls: string[] = []
  const pending: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = []

  const conn: PooledConnection = {
    exec: async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
      execCalls.push(command)
      return new Promise((resolve, reject) => {
        pending.push({
          resolve: (s) => resolve({ stdout: s, stderr: "", code: 0 }),
          reject,
        })
      })
    },
    close: () => closeCb?.(),
    onClose: (cb) => {
      closeCb = cb
    },
  }

  const gate: Gate = {
    open: (result = "ok") => {
      const p = pending.shift()
      if (p) p.resolve(result)
    },
    fail: (err) => {
      const p = pending.shift()
      if (p) p.reject(err)
    },
  }

  return { conn, execCalls, gate, pendingCount: () => pending.length }
}

const opts = { maxPerHost: 2, idleTimeoutMs: 1000, acquireTimeoutMs: 1000 }
const host = { name: "h1", sshConfig: { host: "10.0.0.1" } }

describe("createPool", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("connects lazily and reuses one connection across calls", async () => {
    let connects = 0
    const factory: ConnectFactory = async () => {
      connects++
      return makeFakeConn().conn
    }
    const pool = createPool([host], opts, factory)
    expect(await pool.run("h1", "a")).toEqual({ stdout: "ran:a", stderr: "", code: 0 })
    await pool.run("h1", "b")
    expect(connects).toBe(1)
    await pool.shutdown()
  })

  it("rejects an unknown host", async () => {
    const pool = createPool([host], opts, async () => makeFakeConn().conn)
    await expect(pool.run("nope", "x")).rejects.toThrow(/unknown host "nope"/i)
    await pool.shutdown()
  })

  it("reconnects after the connection drops", async () => {
    let connects = 0
    const conns: ReturnType<typeof makeFakeConn>[] = []
    const factory: ConnectFactory = async () => {
      connects++
      const f = makeFakeConn()
      conns.push(f)
      return f.conn
    }
    const pool = createPool([host], opts, factory)
    await pool.run("h1", "a")
    conns[0].fail() // simulate the link dying while idle
    await pool.run("h1", "b")
    expect(connects).toBe(2)
    await pool.shutdown()
  })

  it("evicts an idle connection after idleTimeoutMs", async () => {
    let closed = 0
    const factory: ConnectFactory = async () => {
      const f = makeFakeConn()
      const orig = f.conn.close
      f.conn.close = () => {
        closed++
        orig()
      }
      return f.conn
    }
    const pool = createPool([host], opts, factory)
    await pool.run("h1", "a")
    await vi.advanceTimersByTimeAsync(1001)
    expect(closed).toBe(1)
    expect(pool.status()[0].state).toBe("disconnected")
    await pool.shutdown()
  })

  it("reports status", async () => {
    const pool = createPool([host], opts, async () => makeFakeConn().conn)
    expect(pool.status()).toEqual([{ name: "h1", state: "disconnected", inFlight: 0 }])
    await pool.run("h1", "a")
    expect(pool.status()[0].state).toBe("idle")
    await pool.shutdown()
  })

  it("concurrency cap queues excess calls and unblocks on release", async () => {
    const gated = makeGatedConn()
    const pool = createPool([host], opts, async () => gated.conn)

    // Start 3 concurrent runs without awaiting — maxPerHost is 2
    const p1 = pool.run("h1", "c1")
    const p2 = pool.run("h1", "c2")
    const p3 = pool.run("h1", "c3")

    // Flush microtasks: advanceTimersByTimeAsync(0) drains the microtask queue
    await vi.advanceTimersByTimeAsync(0)

    // Only 2 exec calls should have started; the 3rd is waiting for a slot
    expect(gated.execCalls.length).toBe(2)

    // Release slot 1 → the 3rd run should start
    gated.gate.open("result-1")
    await vi.advanceTimersByTimeAsync(0)

    expect(gated.execCalls.length).toBe(3)

    // Drain remaining held execs
    gated.gate.open("result-2")
    gated.gate.open("result-3")

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.stdout).toBe("result-1")
    expect(r2.stdout).toBe("result-2")
    expect(r3.stdout).toBe("result-3")

    await pool.shutdown()
  })

  it("acquire timeout throws a busy error and leaves the pool healthy", async () => {
    const gated = makeGatedConn()
    const pool = createPool([host], { ...opts, acquireTimeoutMs: 500 }, async () => gated.conn)

    // Hold 2 slots open (maxPerHost = 2)
    const p1 = pool.run("h1", "hold1")
    const p2 = pool.run("h1", "hold2")
    await vi.advanceTimersByTimeAsync(0)
    expect(gated.execCalls.length).toBe(2)

    // Start 3rd run — it will queue and eventually time out.
    // Capture the rejection promise before advancing timers so Node never sees an unhandled rejection.
    const p3 = pool.run("h1", "will-timeout")
    const p3Result = p3.then(
      () => "resolved" as const,
      (e: unknown) => ({ err: e }),
    )

    // Advance timers past acquireTimeoutMs
    await vi.advanceTimersByTimeAsync(600)

    const outcome = await p3Result
    expect(outcome).toMatchObject({ err: expect.objectContaining({ message: expect.stringMatching(/busy/) }) })

    // Release the held slots; the timed-out waiter must NOT have corrupted the pool
    gated.gate.open("r1")
    gated.gate.open("r2")
    await Promise.all([p1, p2])

    // A fresh run must succeed
    const p4 = pool.run("h1", "fresh")
    await vi.advanceTimersByTimeAsync(0)
    gated.gate.open("fresh-result")
    const r4 = await p4
    expect(r4.stdout).toBe("fresh-result")

    await pool.shutdown()
  })

  it("mid-flight reconnect: retries on a fresh connection after exec failure", async () => {
    let callCount = 0
    const factory: ConnectFactory = async () => {
      callCount++
      if (callCount === 1) {
        // First connection: exec always throws (simulates dropped link)
        const conn: PooledConnection = {
          exec: async () => {
            throw new Error("connection reset")
          },
          close: () => {},
          onClose: () => {},
        }
        return conn
      }
      // Second connection: succeeds
      return makeFakeConn().conn
    }

    const pool = createPool([host], opts, factory)
    const result = await pool.run("h1", "cmd")
    expect(result).toEqual({ stdout: "ran:cmd", stderr: "", code: 0 })
    expect(callCount).toBe(2)
    await pool.shutdown()
  })
})
