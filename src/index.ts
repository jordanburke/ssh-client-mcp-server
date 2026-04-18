#!/usr/bin/env node

import { createServer, UserError } from "somamcp"
import { Client as SSHClient, type ConnectConfig } from "ssh2"
import { z } from "zod"

// Example usage: node dist/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=path/to/key
function parseArgv() {
  const args = process.argv.slice(2)
  const config: Record<string, string> = {}
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) {
      config[match[1]] = match[2]
    }
  }
  return config
}

const argvConfig = parseArgv()

const HOST = argvConfig.host
const PORT = argvConfig.port ? parseInt(argvConfig.port) : 22
const USER = argvConfig.user
const PASSWORD = argvConfig.password
const KEY = argvConfig.key

function validateConfig(config: Record<string, string>) {
  const errors: string[] = []
  if (!config.host) errors.push("Missing required --host")
  if (!config.user) errors.push("Missing required --user")
  if (config.port && isNaN(Number(config.port))) errors.push("Invalid --port")
  if (errors.length > 0) {
    throw new Error("Configuration error:\n" + errors.join("\n"))
  }
}

validateConfig(argvConfig)

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
  execute: async ({ command }) => {
    const sshConfig: ConnectConfig = {
      host: HOST,
      port: PORT,
      username: USER,
    }
    if (PASSWORD) {
      sshConfig.password = PASSWORD
    } else if (KEY) {
      const fs = await import("fs/promises")
      sshConfig.privateKey = await fs.readFile(KEY, "utf8")
    }
    return await execSshCommand(sshConfig, command)
  },
})

async function execSshCommand(sshConfig: ConnectConfig, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient()
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new UserError(`SSH exec error: ${err.message}`))
          conn.end()
          return
        }
        let stdout = ""
        let stderr = ""
        stream.on("close", (code: number) => {
          conn.end()
          if (stderr) {
            reject(new UserError(`Error (code ${code}):\n${stderr}`))
          } else {
            resolve(stdout)
          }
        })
        stream.on("data", (data: Buffer) => {
          stdout += data.toString()
        })
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString()
        })
      })
    })
    conn.on("error", (err) => {
      reject(new UserError(`SSH connection error: ${err.message}`))
    })
    conn.connect(sshConfig)
  })
}

async function main() {
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
