import { unlinkSync } from "node:fs"

import { type Either, Left, Option, Right, Try } from "functype"
import { type ConnectConfig } from "ssh2"

import { type Minted } from "./ca.js"
import { type ConnectFactory, type PooledConnection } from "./pool.js"
import { type Child, childEnv, type ProcessRunner } from "./proc.js"

// One factory serves one (agent, host): its masters all use the same control socket path.
export type OpensshDeps = Readonly<{
  proc: ProcessRunner
  mintFor: () => Promise<Either<string, Minted>>
  socketPath: string
  knownHosts: string
  readyTimeoutMs?: number
  retireAfterMs?: number
  drainTimeoutMs?: number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}>

export type Openssh = Readonly<{ connect: ConnectFactory; shutdown: () => Promise<void> }>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const target = (c: ConnectConfig): ReadonlyArray<string> => [
  "-p",
  String(c.port ?? 22),
  `${c.username ?? ""}@${c.host ?? ""}`,
]

// `-F /dev/null` and `IdentityAgent=none` keep the hub user's own config and agent out, so the master
// can offer only the minted certificate; a dead certificate can never fall back to another key.
const masterArgs = (c: ConnectConfig, socketPath: string, knownHosts: string, m: Minted): ReadonlyArray<string> => [
  "-F",
  "/dev/null",
  "-M",
  "-N",
  "-S",
  socketPath,
  "-o",
  "ControlPersist=no",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "IdentityAgent=none",
  "-o",
  `IdentityFile=${m.keyPath}`,
  "-o",
  `CertificateFile=${m.certPath}`,
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `UserKnownHostsFile=${knownHosts}`,
  "-o",
  "ConnectTimeout=10",
  ...target(c),
]

// `ProxyCommand=false`: if the control socket is gone, the call fails instead of opening a direct
// connection with whatever identities ssh would otherwise find.
const execArgs = (c: ConnectConfig, socketPath: string, command: string): ReadonlyArray<string> => [
  "-F",
  "/dev/null",
  "-S",
  socketPath,
  "-o",
  "ControlMaster=no",
  "-o",
  "ProxyCommand=false",
  "-o",
  "BatchMode=yes",
  ...target(c),
  "--",
  command,
]

// Runs `fn` on the first call; later calls get the same promise.
const once = (fn: () => Promise<void>): (() => Promise<void>) => {
  const state = { run: Option.none<Promise<void>>() }
  return () =>
    state.run.fold(
      () => {
        const run = fn()
        state.run = Option(run)
        return run
      },
      (run) => run,
    )
}

/** @interop ConnectFactory and PooledConnection are the pool's promise-and-callback contract. */
export const opensshConnect = (deps: OpensshDeps): Openssh => {
  const { proc, socketPath, knownHosts } = deps
  const readyTimeoutMs = deps.readyTimeoutMs ?? 15_000
  const drainTimeoutMs = deps.drainTimeoutMs ?? 60_000
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))

  // Resolves when the child exits, or after `timeoutMs` if it doesn't.
  const exitOf = (child: Child, timeoutMs: number): Promise<void> =>
    Promise.race([
      new Promise<void>((resolve) => child.onExit(() => resolve())),
      new Promise<void>((resolve) => setTimer(resolve, timeoutMs)),
    ])

  // Waits for the master to exit (in-flight sessions finish first), then makes sure it is gone.
  const drain = (child: Child, dispose: () => Promise<void>): Promise<void> =>
    exitOf(child, drainTimeoutMs).then(() => {
      child.kill()
      return dispose()
    })
  const live = new globalThis.Set<Readonly<{ child: Child; close: () => void }>>()

  const control = (op: string, c: ConnectConfig) =>
    proc.run("ssh", ["-F", "/dev/null", "-S", socketPath, "-O", op, ...target(c)], { env: childEnv() })

  const waitReady = (child: Child, c: ConnectConfig, deadline: number): Promise<Either<string, void>> => {
    if (child.exited())
      return Promise.resolve(Left<string, void>(`master for ${c.host} exited: ${child.stderr().trim()}`))
    if (Date.now() > deadline)
      return Promise.resolve(Left<string, void>(`master for ${c.host} did not come up: ${child.stderr().trim()}`))
    return control("check", c).then((r) =>
      r.code === 0 && !child.exited()
        ? Right<string, void>(undefined)
        : sleep(100).then(() => waitReady(child, c, deadline)),
    )
  }

  const connect: ConnectFactory = async (c) => {
    const minted = await deps.mintFor()
    if (minted.isLeft()) throw new Error(minted.value)
    const m = minted.value
    const dispose = once(m.dispose)

    // A stale socket from a crashed run would make this master run without multiplexing.
    Try(() => unlinkSync(socketPath))
    const child = proc.spawn("ssh", masterArgs(c, socketPath, knownHosts, m), { env: childEnv() })

    const ready = await waitReady(child, c, Date.now() + readyTimeoutMs)
    if (ready.isLeft()) {
      child.kill()
      await dispose()
      throw new Error(ready.value)
    }

    const state = { closing: false, closed: false, retired: false }
    const closeCbs: Array<() => void> = []
    const fireClose = (): void => {
      if (state.closed) return
      state.closed = true
      closeCbs.splice(0).forEach((cb) => cb())
    }
    child.onExit(() => {
      fireClose()
      void dispose()
    })

    // sshd checks a certificate only at authentication, so a master would outlive its certificate.
    // At expiry: drop it from the pool, refuse new sessions (`-O stop`; the master exits once its
    // in-flight sessions end), then make sure it is gone. The next call mints a fresh master.
    const retire = (): void => {
      if (state.closing || state.retired) return
      state.retired = true
      fireClose()
      void control("stop", c)
        .catch(() => undefined)
        .then(() => drain(child, dispose))
    }
    const retireTimer = setTimer(retire, deps.retireAfterMs ?? Math.max(0, m.validUntil.getTime() - Date.now()))
    child.onExit(() => clearTimer(retireTimer))

    const close = (): void => {
      clearTimer(retireTimer)
      if (state.closing || state.retired) return
      state.closing = true
      // `-O exit` exits 255 once the master is gone; that is success here, not an error.
      void control("exit", c)
        .catch(() => undefined)
        .then(() => drain(child, dispose))
    }
    const entry = { child, close }
    live.add(entry)
    child.onExit(() => live.delete(entry))

    const conn: PooledConnection = {
      exec: async (command) => {
        if (child.exited() || state.closing || state.retired) throw new Error(`master for ${c.host} is gone`)
        const r = await proc.run("ssh", execArgs(c, socketPath, command), { env: childEnv() })
        return { stdout: r.stdout, stderr: r.stderr, code: r.code }
      },
      close,
      onClose: (cb) => {
        closeCbs.push(cb)
      },
    }
    return conn
  }

  const shutdown = async (): Promise<void> => {
    const entries = [...live]
    entries.forEach((e) => e.close())
    await Promise.all(entries.map((e) => (e.child.exited() ? Promise.resolve() : exitOf(e.child, drainTimeoutMs))))
  }

  return { connect, shutdown }
}
