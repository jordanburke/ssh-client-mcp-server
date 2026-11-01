import { constants } from "node:os"

import { type Either, Left, Option, Right } from "functype"
import { UserError } from "somamcp"
import { Client as SSHClient, type ConnectConfig } from "ssh2"

import { type CommandResult, exitLabel } from "./tmux.js"

// A signal number differs by OS only for rarer signals; KILL, TERM, INT and HUP match everywhere.
const signalCode = (signal: string): number =>
  Option((constants.signals as Readonly<Record<string, number>>)[`SIG${signal}`]).fold(
    () => 255,
    (n) => 128 + n,
  )

/**
 * The result of an ssh2 channel from its "close" arguments.
 * @interop ssh2 passes (code, signal) to "close" but @types/ssh2 declares none; code is null when
 * a signal ended the command, and signal is its name. ssh2 gives it as "SIGKILL" (observed against
 * OpenSSH on macOS); the SSH wire format says "KILL". Both become "KILL".
 */
export const channelResult = (stdout: string, stderr: string, code: unknown, signal: unknown): CommandResult => {
  if (typeof code === "number") return { stdout, stderr, code }
  // Neither: the channel closed before the host sent an exit status, e.g. the connection dropped.
  if (typeof signal !== "string" || signal === "") return { stdout, stderr, code: 255, noExitStatus: true }
  const name = signal.replace(/^SIG/, "")
  return { stdout, stderr, code: signalCode(name), signal: name }
}

/** Options for one command. Without `timeoutMs`, exec waits as long as the command runs. */
export type ExecOptions = Readonly<{ timeoutMs?: number }>

export const TIMEOUT_CODE = 124

export const timedOutResult = (stdout: string, stderr: string, timeoutMs: number): CommandResult => ({
  stdout,
  stderr,
  code: TIMEOUT_CODE,
  timedOutMs: timeoutMs,
})

/**
 * What `exec` returns for a finished command. A non-zero exit is the failure signal, not stderr:
 * many tools warn on stderr and exit 0. Neither stream is dropped. On success, stderr follows
 * stdout under a marker so warnings stay visible. A failure leads with the exit label and stderr,
 * the usual one-line reason, then stdout, which often holds the context.
 */
export const execOutput = (r: CommandResult): Either<string, string> => {
  if (r.code === 0) return Right(r.stderr ? `${r.stdout}\n[stderr]\n${r.stderr}` : r.stdout)
  const detail = r.stderr && r.stdout ? `${r.stderr}\n[stdout]\n${r.stdout}` : r.stderr || r.stdout
  return Left(`${exitLabel(r)}:\n${detail}`)
}

export const execSshResult = (sshConfig: ConnectConfig, command: string): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const conn = new SSHClient()
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new UserError(`SSH exec error: ${err.message}`))
          conn.end()
          return
        }
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        stream.on("close", (code: unknown, signal: unknown) => {
          conn.end()
          resolve(
            channelResult(Buffer.concat(stdoutChunks).toString(), Buffer.concat(stderrChunks).toString(), code, signal),
          )
        })
        stream.on("data", (data: Buffer) => stdoutChunks.push(data))
        stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data))
      })
    })
    conn.on("error", (err) => reject(new UserError(`SSH connection error: ${err.message}`)))
    conn.connect(sshConfig)
  })
