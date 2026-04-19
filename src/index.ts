#!/usr/bin/env node

import { Option } from "functype"
import { createServer, UserError } from "somamcp"
import { Client as SSHClient, type ConnectConfig } from "ssh2"
import { z } from "zod"

import { effectiveUser, parseArgv, resolveAuth, validateConfig } from "./config.js"

// Example: node dist/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=~/.ssh/id_rsa

const execSshCommand = (sshConfig: ConnectConfig, command: string): Promise<string> =>
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
        stream.on("data", (data: Buffer) => {
          stdoutChunks.push(data)
        })
        stream.stderr.on("data", (data: Buffer) => {
          stderrChunks.push(data)
        })
      })
    })
    conn.on("error", (err) => {
      reject(new UserError(`SSH connection error: ${err.message}`))
    })
    conn.connect(sshConfig)
  })

async function main() {
  const argv = parseArgv(process.argv.slice(2))

  validateConfig(argv).fold(
    (err) => {
      console.error(err)
      process.exit(1)
    },
    () => undefined,
  )

  const { host } = argv
  const user = effectiveUser(argv).orThrow(new Error("user unavailable after validation"))
  const port = Option(argv.port).map(Number).orElse(22)
  const password = Option(argv.password)
  const keyPath = Option(argv.key)

  const authResult = await resolveAuth(password, keyPath)
  const authConfig = authResult.fold<Partial<ConnectConfig>>(
    (err) => {
      console.error(err)
      process.exit(1)
    },
    (cfg) => cfg,
  )

  const sshConfig: ConnectConfig = { host, port, username: user, ...authConfig }

  const server = createServer({
    name: "ssh-client-mcp-server",
    version: "1.2.0",
    instructions: "Execute shell commands on a remote host over SSH.",
  })

  server.addTool({
    name: "exec",
    description: "Execute a shell command on the remote SSH server and return the output.",
    parameters: z.object({
      command: z.string().min(1).describe("Shell command to execute on the remote SSH server"),
    }),
    execute: async ({ command }) => execSshCommand(sshConfig, command),
  })

  await server.start({ transportType: "stdio" })
  console.error("SSH MCP Server running on stdio")

  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error) => {
  console.error("Fatal error in main():", error)
  process.exit(1)
})
