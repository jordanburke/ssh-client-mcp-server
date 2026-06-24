import { Client as SSHClient, type ConnectConfig } from "ssh2"

import { type CommandResult } from "./tmux.js"

export type PooledConnection = {
  exec: (command: string) => Promise<CommandResult>
  close: () => void
  onClose: (cb: () => void) => void
}

export type ConnectFactory = (sshConfig: ConnectConfig) => Promise<PooledConnection>

export type PoolOptions = { maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }

export type HostStatus = { name: string; state: "connected" | "idle" | "disconnected"; inFlight: number }

export type Pool = {
  run: (hostName: string, command: string) => Promise<CommandResult>
  status: () => HostStatus[]
  shutdown: () => Promise<void>
}

type HostState = {
  name: string
  sshConfig: ConnectConfig
  conn?: PooledConnection
  connecting?: Promise<PooledConnection>
  inFlight: number
  waiters: Array<() => void>
  idleTimer?: ReturnType<typeof setTimeout>
}

// Default factory: a persistent ssh2 client; exec runs each command on its own channel.
export const defaultConnect: ConnectFactory = (sshConfig) =>
  new Promise<PooledConnection>((resolve, reject) => {
    const client = new SSHClient()
    const closeCbs: Array<() => void> = []
    client.on("ready", () =>
      resolve({
        exec: (command) =>
          new Promise<CommandResult>((res, rej) => {
            client.exec(command, (err, stream) => {
              if (err) {
                rej(err)
                return
              }
              const out: Buffer[] = []
              const errb: Buffer[] = []
              stream.on("close", (code: number) =>
                res({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(errb).toString(), code: code ?? 0 }),
              )
              stream.on("data", (d: Buffer) => out.push(d))
              stream.stderr.on("data", (d: Buffer) => errb.push(d))
            })
          }),
        close: () => client.end(),
        onClose: (cb) => closeCbs.push(cb),
      }),
    )
    client.on("error", (err) => {
      closeCbs.forEach((cb) => cb())
      reject(err)
    })
    client.on("close", () => closeCbs.forEach((cb) => cb()))
    client.connect({ keepaliveInterval: 15000, ...sshConfig })
  })

export const createPool = (
  hosts: ReadonlyArray<{ name: string; sshConfig: ConnectConfig }>,
  opts: PoolOptions,
  connect: ConnectFactory = defaultConnect,
): Pool => {
  const states = new Map<string, HostState>(
    hosts.map((h) => [h.name, { name: h.name, sshConfig: h.sshConfig, inFlight: 0, waiters: [] }]),
  )

  const dropConn = (st: HostState): void => {
    st.conn = undefined
    if (st.idleTimer) {
      clearTimeout(st.idleTimer)
      st.idleTimer = undefined
    }
  }

  const ensureConn = async (st: HostState): Promise<PooledConnection> => {
    if (st.conn) return st.conn
    if (!st.connecting) {
      st.connecting = connect(st.sshConfig).then((c) => {
        c.onClose(() => {
          if (st.conn === c) dropConn(st)
        })
        st.conn = c
        st.connecting = undefined
        return c
      })
      st.connecting.catch(() => {
        st.connecting = undefined
      })
    }
    return st.connecting
  }

  const acquireSlot = async (st: HostState): Promise<void> => {
    if (st.inFlight < opts.maxPerHost) {
      st.inFlight++
      return
    }
    const refs: { release: (() => void) | undefined; timer: ReturnType<typeof setTimeout> | undefined } = {
      release: undefined,
      timer: undefined,
    }
    try {
      await new Promise<void>((resolve, reject) => {
        refs.release = resolve
        st.waiters.push(resolve)
        refs.timer = setTimeout(
          () => reject(new Error(`host "${st.name}" busy: no free connection slot after ${opts.acquireTimeoutMs}ms`)),
          opts.acquireTimeoutMs,
        )
      })
      // Woken by releaseSlot: the slot was transferred to us, so inFlight already counts it.
    } catch (e) {
      if (refs.release) {
        const idx = st.waiters.indexOf(refs.release)
        if (idx !== -1) st.waiters.splice(idx, 1)
      }
      throw e
    } finally {
      if (refs.timer) clearTimeout(refs.timer)
    }
  }

  const releaseSlot = (st: HostState): void => {
    const next = st.waiters.shift()
    if (next) {
      next() // transfer the slot to the waiter; inFlight is unchanged (count carries over)
      return
    }
    st.inFlight--
    if (st.inFlight === 0 && st.conn) {
      st.idleTimer = setTimeout(() => {
        st.conn?.close()
        dropConn(st)
      }, opts.idleTimeoutMs)
    }
  }

  const run = async (hostName: string, command: string): Promise<CommandResult> => {
    const st = states.get(hostName)
    if (!st) throw new Error(`unknown host "${hostName}"`)
    if (st.idleTimer) {
      clearTimeout(st.idleTimer)
      st.idleTimer = undefined
    }
    await acquireSlot(st)
    try {
      const conn = await ensureConn(st)
      try {
        return await conn.exec(command)
      } catch {
        // connection likely dead — drop, reconnect once, retry
        dropConn(st)
        const fresh = await ensureConn(st)
        return await fresh.exec(command)
      }
    } finally {
      releaseSlot(st)
    }
  }

  const status = (): HostStatus[] =>
    [...states.values()].map((st) => ({
      name: st.name,
      state: st.conn ? (st.inFlight > 0 ? "connected" : "idle") : "disconnected",
      inFlight: st.inFlight,
    }))

  const shutdown = (): Promise<void> => {
    states.forEach((st) => {
      if (st.idleTimer) clearTimeout(st.idleTimer)
      st.conn?.close()
      dropConn(st)
    })
    return Promise.resolve()
  }

  return { run, status, shutdown }
}
