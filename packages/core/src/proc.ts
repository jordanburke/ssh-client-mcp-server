import { spawn as nodeSpawn } from "node:child_process"

export type ProcResult = Readonly<{ code: number; stdout: string; stderr: string }>

// The whole environment a child gets; never merged with process.env.
export type Env = Readonly<Record<string, string>>

/**
 * A long-lived child, such as ssh-agent or an ssh ControlMaster.
 * @interop mirrors Node's child_process: the exit code is null when a signal ends the process, and pid is undefined when spawning failed.
 */
export type Child = Readonly<{
  onExit: (cb: (code: number | null) => void) => void
  kill: () => void
  stderr: () => string
  exited: () => boolean
  pid: () => number | undefined
}>

export type ProcessRunner = Readonly<{
  run: (cmd: string, args: ReadonlyArray<string>, opts: Readonly<{ env: Env; input?: string }>) => Promise<ProcResult>
  spawn: (cmd: string, args: ReadonlyArray<string>, opts: Readonly<{ env: Env }>) => Child
}>

// Only these pass through from the hub's own environment. In particular no SSH_AUTH_SOCK (the user's
// agent) and no DISPLAY, so an OpenSSH child can't reach an agent or a GUI prompt it wasn't given.
const PASS_THROUGH: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG"]

export const childEnv = (extra: Env = {}): Env => ({
  ...Object.fromEntries(
    PASS_THROUGH.flatMap((k) => {
      const v = process.env[k]
      return v === undefined ? [] : [[k, v]]
    }),
  ),
  ...extra,
})

const STDERR_TAIL = 4096

/** @interop Node's child_process is callback- and event-based; these adapters are the boundary. */
export const nodeProcessRunner: ProcessRunner = {
  // Resolves with the exit code, non-zero included; rejects only when the program can't start (ENOENT).
  run: (cmd, args, { env, input }) =>
    new Promise<ProcResult>((resolve, reject) => {
      const child = nodeSpawn(cmd, [...args], { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on("data", (d: Buffer) => out.push(d))
      child.stderr.on("data", (d: Buffer) => err.push(d))
      child.on("error", reject)
      child.on("close", (code) =>
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }),
      )
      child.stdin.on("error", () => undefined)
      child.stdin.end(input ?? "")
    }),

  spawn: (cmd, args, { env }) => {
    const child = nodeSpawn(cmd, [...args], { env: { ...env }, stdio: ["ignore", "ignore", "pipe"] })
    const state = { tail: "", exited: false, code: null as number | null }
    const listeners: Array<(code: number | null) => void> = []
    const finish = (code: number | null): void => {
      if (state.exited) return
      state.exited = true
      state.code = code
      listeners.splice(0).forEach((cb) => cb(code))
    }
    child.stderr.on("data", (d: Buffer) => {
      state.tail = (state.tail + d.toString()).slice(-STDERR_TAIL)
    })
    child.on("exit", (code) => finish(code))
    child.on("error", (e) => {
      state.tail = (state.tail + e.message).slice(-STDERR_TAIL)
      finish(null)
    })
    return {
      onExit: (cb) => {
        if (state.exited) queueMicrotask(() => cb(state.code))
        else listeners.push(cb)
      },
      kill: () => {
        if (!state.exited) child.kill()
      },
      stderr: () => state.tail,
      exited: () => state.exited,
      pid: () => child.pid,
    }
  },
}
