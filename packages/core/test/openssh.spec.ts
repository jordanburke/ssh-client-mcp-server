import { Left, Right } from "functype"
import { describe, expect, it, vi } from "vitest"

import { type Minted } from "../src/ca.js"
import { createPool } from "../src/pool.js"
import { type OpensshDeps, opensshConnect } from "../src/openssh.js"
import { type Child, type Env, type ProcessRunner, type ProcResult } from "../src/proc.js"

type Call = Readonly<{ cmd: string; args: ReadonlyArray<string>; env: Env }>

// A child whose exit the test fires; kill() exits it, as a real kill would.
const fakeChild = (stderr = "") => {
  const state = { exited: false, killed: 0, listeners: [] as Array<(code: number | null) => void> }
  const fire = (code: number | null): void => {
    state.exited = true
    state.listeners.forEach((cb) => cb(code))
  }
  const child: Child = {
    onExit: (cb) => {
      state.listeners.push(cb)
    },
    kill: () => {
      state.killed++
      fire(null)
    },
    stderr: () => stderr,
    exited: () => state.exited,
    pid: () => 4242,
  }
  return { child, fire, state }
}

const fakeProc = (
  opts: { check?: () => ProcResult; exec?: (args: ReadonlyArray<string>) => Promise<ProcResult> } = {},
) => {
  const runs: Call[] = []
  const spawns: Array<Call & { fake: ReturnType<typeof fakeChild> }> = []
  const childStderr = { next: "" }
  const proc: ProcessRunner = {
    run: async (cmd, args, { env }) => {
      runs.push({ cmd, args, env })
      const op = args.indexOf("-O")
      if (op >= 0)
        return args[op + 1] === "check" ? (opts.check ?? (() => ok))() : { code: 255, stdout: "", stderr: "" }
      return (opts.exec ?? (async () => ({ code: 0, stdout: "out", stderr: "" })))(args)
    },
    spawn: (cmd, args, { env }) => {
      const fake = fakeChild(childStderr.next)
      spawns.push({ cmd, args, env, fake })
      return fake.child
    },
  }
  return { proc, runs, spawns, childStderr }
}

const ok: ProcResult = { code: 0, stdout: "", stderr: "" }
const notUp: ProcResult = { code: 255, stdout: "", stderr: "Control socket connect: No such file" }

const minted = (): Minted & { dispose: ReturnType<typeof vi.fn> } => ({
  keyPath: "/run/k-1",
  certPath: "/run/k-1-cert.pub",
  validUntil: new Date(Date.now() + 600_000),
  serial: "1",
  dispose: vi.fn(async () => undefined),
})

const sshConfig = { host: "box-a", port: 2222, username: "deploy" }

const depsFor = (proc: ProcessRunner, m: Minted, extra: Partial<OpensshDeps> = {}): OpensshDeps => ({
  proc,
  mintFor: async () => Right<string, Minted>(m),
  socketPath: "/run/m-abc.sock",
  knownHosts: "/state/known_hosts",
  ...extra,
})

describe("opensshConnect", () => {
  it("starts a master that can only offer the certificate", async () => {
    const { proc, spawns } = fakeProc()
    await opensshConnect(depsFor(proc, minted())).connect(sshConfig)
    const master = spawns[0]
    expect(master.cmd).toBe("ssh")
    for (const arg of [
      "-F",
      "/dev/null",
      "-M",
      "-N",
      "-S",
      "/run/m-abc.sock",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "IdentityFile=/run/k-1",
      "CertificateFile=/run/k-1-cert.pub",
      "BatchMode=yes",
      "StrictHostKeyChecking=accept-new",
      "UserKnownHostsFile=/state/known_hosts",
      "ControlPersist=no",
      "-p",
      "2222",
      "deploy@box-a",
    ])
      expect(master.args).toContain(arg)
    expect(master.env.SSH_AUTH_SOCK).toBeUndefined()
  })

  it("exec cannot fall back to a direct connection", async () => {
    const { proc, runs } = fakeProc({ exec: async () => ({ code: 3, stdout: "hi", stderr: "warn" }) })
    const conn = await opensshConnect(depsFor(proc, minted())).connect(sshConfig)
    const result = await conn.exec("uptime")
    expect(result).toEqual({ stdout: "hi", stderr: "warn", code: 3 })
    const call = runs.find((r) => r.args.includes("uptime"))
    expect(call?.args).toEqual([
      "-F",
      "/dev/null",
      "-S",
      "/run/m-abc.sock",
      "-o",
      "ControlMaster=no",
      "-o",
      "ProxyCommand=false",
      "-o",
      "BatchMode=yes",
      "-p",
      "2222",
      "deploy@box-a",
      "--",
      "uptime",
    ])
    expect(call?.env.SSH_AUTH_SOCK).toBeUndefined()
  })

  it("exec on a dead master rejects without spawning", async () => {
    const { proc, runs, spawns } = fakeProc()
    const conn = await opensshConnect(depsFor(proc, minted())).connect(sshConfig)
    spawns[0].fake.fire(255)
    const before = runs.length
    await expect(conn.exec("uptime")).rejects.toThrow(/is gone/)
    expect(runs.length).toBe(before)
  })

  it("a master that exits fires onClose once", async () => {
    const { proc, spawns } = fakeProc()
    const m = minted()
    const conn = await opensshConnect(depsFor(proc, m)).connect(sshConfig)
    const onClose = vi.fn()
    conn.onClose(onClose)
    spawns[0].fake.fire(255)
    spawns[0].fake.fire(255)
    await vi.waitFor(() => expect(m.dispose).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it("close exits the master and disposes", async () => {
    const { proc, runs, spawns } = fakeProc()
    const m = minted()
    const conn = await opensshConnect(depsFor(proc, m)).connect(sshConfig)
    conn.close()
    await vi.waitFor(() => expect(runs.some((r) => r.args.includes("exit"))).toBe(true))
    spawns[0].fake.fire(255)
    await vi.waitFor(() => expect(m.dispose).toHaveBeenCalledTimes(1))
  })

  it("a mint failure rejects the connect", async () => {
    const { proc, spawns } = fakeProc()
    const deps = depsFor(proc, minted(), {
      mintFor: async () => Left<string, Minted>('CA "home": signing failed: x'),
    })
    await expect(opensshConnect(deps).connect(sshConfig)).rejects.toThrow('CA "home": signing failed: x')
    expect(spawns).toHaveLength(0)
  })

  it("a master that exits before it is ready rejects at once", async () => {
    const { proc, spawns, childStderr } = fakeProc({ check: () => notUp })
    childStderr.next = "Permission denied (publickey)."
    const m = minted()
    const started = Date.now()
    const pending = opensshConnect(depsFor(proc, m)).connect(sshConfig)
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    spawns[0].fake.fire(255)
    await expect(pending).rejects.toThrow(/exited: Permission denied/)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(m.dispose).toHaveBeenCalled()
  })

  it("a master that never comes up is killed", async () => {
    const { proc, spawns } = fakeProc({ check: () => notUp })
    const m = minted()
    await expect(opensshConnect(depsFor(proc, m, { readyTimeoutMs: 300 })).connect(sshConfig)).rejects.toThrow(
      /did not come up/,
    )
    expect(spawns[0].fake.state.killed).toBeGreaterThan(0)
    expect(m.dispose).toHaveBeenCalled()
  })

  it("shutdown waits for every master to exit", async () => {
    const { proc, spawns } = fakeProc()
    const openssh = opensshConnect(depsFor(proc, minted()))
    await openssh.connect(sshConfig)
    await openssh.connect(sshConfig)
    const done = { yes: false }
    const pending = openssh.shutdown().then(() => {
      done.yes = true
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(done.yes).toBe(false)
    spawns[0].fake.fire(255)
    await new Promise((r) => setTimeout(r, 20))
    expect(done.yes).toBe(false)
    spawns[1].fake.fire(255)
    await pending
    expect(done.yes).toBe(true)
  })
})

// Timers the test fires by hand: retirement and drain run when the test says so.
const manualTimers = () => {
  const pending: Array<{ cb: () => void; ms: number; cancelled: boolean }> = []
  return {
    setTimer: (cb: () => void, ms: number) => {
      const t = { cb, ms, cancelled: false }
      pending.push(t)
      return t
    },
    clearTimer: (t: unknown) => {
      ;(t as { cancelled: boolean }).cancelled = true
    },
    fire: (ms: number) =>
      pending
        .filter((t) => t.ms === ms && !t.cancelled)
        .forEach((t) => {
          t.cancelled = true
          t.cb()
        }),
  }
}

const RETIRE = 600_000
const DRAIN = 60_000

describe("retirement", () => {
  const controlOps = (runs: ReadonlyArray<Call>) =>
    runs.filter((r) => r.args.includes("-O")).map((r) => r.args[r.args.indexOf("-O") + 1])

  it("a master is retired when its certificate expires", async () => {
    const { proc, runs, spawns } = fakeProc()
    const timers = manualTimers()
    const m = minted()
    const conn = await opensshConnect(
      depsFor(proc, m, { ...timers, retireAfterMs: RETIRE, drainTimeoutMs: DRAIN }),
    ).connect(sshConfig)
    const onClose = vi.fn()
    conn.onClose(onClose)
    timers.fire(RETIRE)
    expect(onClose).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(controlOps(runs)).toContain("stop"))
    spawns[0].fake.fire(255)
    await vi.waitFor(() => expect(m.dispose).toHaveBeenCalledTimes(1))
    expect(controlOps(runs)).not.toContain("exit")
  })

  it("retiring lets in-flight execs finish", async () => {
    const release = { fn: (_: ProcResult) => undefined as void }
    const { proc, runs, spawns } = fakeProc({
      exec: () =>
        new Promise<ProcResult>((resolve) => {
          release.fn = resolve
        }),
    })
    const timers = manualTimers()
    const m = minted()
    const conn = await opensshConnect(
      depsFor(proc, m, { ...timers, retireAfterMs: RETIRE, drainTimeoutMs: DRAIN }),
    ).connect(sshConfig)
    const inFlight = conn.exec("sleep 5")
    await vi.waitFor(() => expect(runs.some((r) => r.args.includes("sleep 5"))).toBe(true))
    timers.fire(RETIRE)
    await vi.waitFor(() => expect(controlOps(runs)).toContain("stop"))
    expect(spawns[0].fake.state.killed).toBe(0)
    release.fn({ code: 0, stdout: "done", stderr: "" })
    await expect(inFlight).resolves.toEqual({ stdout: "done", stderr: "", code: 0 })
    spawns[0].fake.fire(0)
    await vi.waitFor(() => expect(m.dispose).toHaveBeenCalledTimes(1))
  })

  it("a master that ignores stop is killed after the drain timeout", async () => {
    const { proc, runs, spawns } = fakeProc()
    const timers = manualTimers()
    const m = minted()
    await opensshConnect(depsFor(proc, m, { ...timers, retireAfterMs: RETIRE, drainTimeoutMs: DRAIN })).connect(
      sshConfig,
    )
    timers.fire(RETIRE)
    await vi.waitFor(() => expect(controlOps(runs)).toContain("stop"))
    await new Promise((r) => setTimeout(r, 10))
    timers.fire(DRAIN)
    await vi.waitFor(() => expect(spawns[0].fake.state.killed).toBeGreaterThan(0))
    await vi.waitFor(() => expect(m.dispose).toHaveBeenCalledTimes(1))
  })

  it("a call after retirement mints a new master", async () => {
    const { proc, spawns } = fakeProc()
    const timers = manualTimers()
    const mintFor = vi.fn(async () => Right<string, Minted>(minted()))
    const openssh = opensshConnect({
      ...depsFor(proc, minted(), { ...timers, retireAfterMs: RETIRE, drainTimeoutMs: DRAIN }),
      mintFor,
    })
    const pool = createPool(
      [{ name: "box-a", sshConfig }],
      { maxPerHost: 2, idleTimeoutMs: 3_600_000, acquireTimeoutMs: 1000 },
      openssh.connect,
    )
    await pool.run("box-a", "one")
    // Retirement alone must drop the connection; the old master is still draining.
    timers.fire(RETIRE)
    await pool.run("box-a", "two")
    expect(mintFor).toHaveBeenCalledTimes(2)
    expect(spawns).toHaveLength(2)
    await pool.shutdown()
  })

  it("close cancels retirement", async () => {
    const { proc, runs } = fakeProc()
    const timers = manualTimers()
    const conn = await opensshConnect(
      depsFor(proc, minted(), { ...timers, retireAfterMs: RETIRE, drainTimeoutMs: DRAIN }),
    ).connect(sshConfig)
    conn.close()
    timers.fire(RETIRE)
    await new Promise((r) => setTimeout(r, 20))
    expect(controlOps(runs)).not.toContain("stop")
  })
})
