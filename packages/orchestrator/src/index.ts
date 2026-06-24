#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { tmuxKeys, tmuxList, tmuxRead, tmuxSend } from "@ssh-mcp/core"
import { type Either, Try } from "functype"
import { createServer, UserError } from "somamcp"
import { z } from "zod"

import { parseFleet } from "./fleet.js"
import { buildFleetRunner, type FleetRunner } from "./runners.js"

const { version: pkgVersion } = createRequire(import.meta.url)("../package.json") as {
  version: `${number}.${number}.${number}`
}

const unwrap = <T>(result: Either<string, T>): T =>
  result.fold(
    (msg) => {
      throw new UserError(msg)
    },
    (value) => value,
  )

// Tool handlers, factored out so they can be unit-tested with a fake FleetRunner.
export const makeHandlers = (runner: FleetRunner) => ({
  hostsList: (): Promise<string> => Promise.resolve(JSON.stringify(runner.status())),
  exec: async ({ host, command }: { host: string; command: string }): Promise<string> => {
    const r = await runner.exec(host, command)
    if (r.stderr) throw new UserError(`[${host}] Error (code ${r.code}):\n${r.stderr}`)
    return r.stdout
  },
  tmuxList: async ({ host }: { host: string }): Promise<string> =>
    JSON.stringify(unwrap(await tmuxList(unwrap(runner.tmuxRunnerFor(host))))),
  tmuxSend: async ({
    host,
    session,
    input,
    submit,
  }: {
    host: string
    session?: string
    input: string
    submit?: boolean
  }): Promise<string> => {
    const target = session ?? runner.sessionFor(host)
    unwrap(await tmuxSend(unwrap(runner.tmuxRunnerFor(host)), { session: target, input, submit: submit ?? true }))
    return `[${host}] sent to tmux session "${target}".`
  },
  tmuxRead: async ({ host, session, lines }: { host: string; session?: string; lines?: number }): Promise<string> =>
    unwrap(
      await tmuxRead(unwrap(runner.tmuxRunnerFor(host)), {
        session: session ?? runner.sessionFor(host),
        lines: lines ?? 200,
      }),
    ),
  tmuxKeys: async ({ host, session, keys }: { host: string; session?: string; keys: string[] }): Promise<string> => {
    const target = session ?? runner.sessionFor(host)
    unwrap(await tmuxKeys(unwrap(runner.tmuxRunnerFor(host)), { session: target, keys }))
    return `[${host}] sent keys [${keys.join(", ")}] to tmux session "${target}".`
  },
})

const findConfigPath = (argv: ReadonlyArray<string>): string => {
  const flag = argv.find((a) => a.startsWith("--config="))
  if (flag) return flag.slice("--config=".length)
  return process.env.SSH_FLEET_CONFIG ?? join(homedir(), ".config", "ssh-fleet", "fleet.toml")
}

async function main(): Promise<void> {
  const configPath = findConfigPath(process.argv.slice(2))
  const raw = Try(() => readFileSync(configPath, "utf8")).fold(
    (e) => {
      console.error(`Cannot read fleet config at ${configPath}: ${(e as Error).message}`)
      return process.exit(1)
    },
    (content) => content,
  )

  const fleet = parseFleet(raw).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (f) => f,
  )

  const runner = (await buildFleetRunner(fleet)).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (r) => r,
  )

  const h = makeHandlers(runner)
  const server = createServer({
    name: "ssh-fleet-mcp-server",
    version: pkgVersion,
    instructions: "Manage a fleet of SSH hosts: pooled connections, host-routed exec and tmux tools.",
  })

  const hostParam = z.string().describe("Configured host name (see hosts_list)")

  server.addTool({
    name: "hosts_list",
    description: "List configured fleet hosts and their live connection status.",
    parameters: z.object({}),
    execute: () => h.hostsList(),
  })
  server.addTool({
    name: "exec",
    description: "Run a one-shot shell command on a fleet host over SSH.",
    parameters: z.object({ host: hostParam, command: z.string().min(1).describe("Shell command") }),
    execute: ({ host, command }) => h.exec({ host, command }),
  })
  server.addTool({
    name: "tmux_list",
    description: "List tmux sessions on a fleet host. Returns a JSON array of session names.",
    parameters: z.object({ host: hostParam }),
    execute: ({ host }) => h.tmuxList({ host }),
  })
  server.addTool({
    name: "tmux_send",
    description: "Type text into a persistent tmux session on a fleet host (creates it if absent).",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      input: z.string().min(1).describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after the text (default true)"),
    }),
    execute: ({ host, session, input, submit }) => h.tmuxSend({ host, session, input, submit }),
  })
  server.addTool({
    name: "tmux_read",
    description: "Capture the recent pane transcript of a tmux session on a fleet host.",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      lines: z.number().int().min(1).optional().describe("Lines of scrollback (default 200; capped at 2000)"),
    }),
    execute: ({ host, session, lines }) => h.tmuxRead({ host, session, lines }),
  })
  server.addTool({
    name: "tmux_keys",
    description: "Send control/special keys (e.g. C-c) to a tmux session on a fleet host.",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      keys: z.array(z.string()).min(1).describe("tmux key names, e.g. ['C-c']"),
    }),
    execute: ({ host, session, keys }) => h.tmuxKeys({ host, session, keys }),
  })

  await server.start({ transportType: "stdio" })
  console.error(`SSH Fleet MCP Server running on stdio (${runner.hostNames.length} hosts)`)

  const shutdown = async () => {
    await runner.shutdown()
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

// Only run when executed directly (not when imported by tests or other modules)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal error in main():", error)
    process.exit(1)
  })
}
