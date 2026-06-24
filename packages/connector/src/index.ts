#!/usr/bin/env node

import { createRequire } from "node:module"

import { execSshCommand, execSshResult, tmuxKeys, tmuxList, tmuxRead, type TmuxRunner, tmuxSend } from "@ssh-mcp/core"
import { type Either, Option } from "functype"
import { createServer, UserError } from "somamcp"
import { type ConnectConfig } from "ssh2"
import { z } from "zod"

import { effectiveUser, parseArgv, resolveAuth, validateConfig } from "./config.js"

// Single source of truth for the server version: read the package's own
// package.json at runtime so it can never drift from the published version.
const { version: pkgVersion } = createRequire(import.meta.url)("../package.json") as {
  version: `${number}.${number}.${number}`
}

// Example: node dist/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=~/.ssh/id_rsa

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
  const keyEnvVar = Option(argv["key-env"])
  const useAgent = Option(argv.agent)
    .map((v) => v === "true" || v === "1" || v === "yes")
    .orElse(false)

  const authResult = await resolveAuth({ password, keyPath, keyEnvVar, useAgent })
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
    version: pkgVersion,
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

  const defaultSession = Option(argv["tmux-session"]).orElse("agent")
  const tmuxRunner: TmuxRunner = (command) => execSshResult(sshConfig, command)
  const unwrap = <T>(result: Either<string, T>): T =>
    result.fold(
      (msg) => {
        throw new UserError(msg)
      },
      (value) => value,
    )

  server.addTool({
    name: "tmux_list",
    description: "List live tmux sessions on the remote host. Returns a JSON array of session names.",
    parameters: z.object({}),
    execute: async () => JSON.stringify(unwrap(await tmuxList(tmuxRunner))),
  })

  server.addTool({
    name: "tmux_send",
    description:
      "Type text into a persistent tmux session on the remote host (creates the session if it does not exist). Use to dispatch work to a long-running interactive process such as a coding agent.",
    parameters: z.object({
      session: z.string().optional().describe("tmux session name (defaults to --tmux-session)"),
      input: z.string().min(1).describe("Text to type into the session"),
      submit: z.boolean().optional().describe("Press Enter after the text (default true)"),
    }),
    execute: async ({ session, input, submit }) => {
      const target = session ?? defaultSession
      unwrap(await tmuxSend(tmuxRunner, { session: target, input, submit: submit ?? true }))
      return `Sent to tmux session "${target}".`
    },
  })

  server.addTool({
    name: "tmux_read",
    description: "Capture the recent output (pane transcript) of a tmux session on the remote host.",
    parameters: z.object({
      session: z.string().optional().describe("tmux session name (defaults to --tmux-session)"),
      lines: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Lines of scrollback to capture (default 200; capped at 2000)"),
    }),
    execute: async ({ session, lines }) =>
      unwrap(await tmuxRead(tmuxRunner, { session: session ?? defaultSession, lines: lines ?? 200 })),
  })

  server.addTool({
    name: "tmux_keys",
    description:
      "Send control/special keys to a tmux session (e.g. C-c to interrupt, Escape, Up). Use tmux_send for ordinary text.",
    parameters: z.object({
      session: z.string().optional().describe("tmux session name (defaults to --tmux-session)"),
      keys: z.array(z.string()).min(1).describe("tmux key names, e.g. ['C-c'] or ['Escape']"),
    }),
    execute: async ({ session, keys }) => {
      const target = session ?? defaultSession
      unwrap(await tmuxKeys(tmuxRunner, { session: target, keys }))
      return `Sent keys [${keys.join(", ")}] to tmux session "${target}".`
    },
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
