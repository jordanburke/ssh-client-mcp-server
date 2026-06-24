import { UserError } from "somamcp"
import { Client as SSHClient, type ConnectConfig } from "ssh2"

import { type CommandResult } from "./tmux.js"

export const execSshCommand = (sshConfig: ConnectConfig, command: string): Promise<string> =>
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
        stream.on("close", (code: number) => {
          conn.end()
          const stdout = Buffer.concat(stdoutChunks).toString()
          const stderr = Buffer.concat(stderrChunks).toString()
          if (stderr) {
            reject(new UserError(`Error (code ${code}):\n${stderr}`))
          } else {
            resolve(stdout)
          }
        })
        stream.on("data", (data: Buffer) => stdoutChunks.push(data))
        stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data))
      })
    })
    conn.on("error", (err) => reject(new UserError(`SSH connection error: ${err.message}`)))
    conn.connect(sshConfig)
  })

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
        stream.on("close", (code: number) => {
          conn.end()
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString(),
            stderr: Buffer.concat(stderrChunks).toString(),
            code: code ?? 0,
          })
        })
        stream.on("data", (data: Buffer) => stdoutChunks.push(data))
        stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data))
      })
    })
    conn.on("error", (err) => reject(new UserError(`SSH connection error: ${err.message}`)))
    conn.connect(sshConfig)
  })
