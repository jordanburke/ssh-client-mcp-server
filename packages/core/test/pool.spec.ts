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
})
