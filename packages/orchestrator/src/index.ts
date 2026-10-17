#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { type CommandResult, tmuxKeys, tmuxList, tmuxRead, tmuxSend } from "@ssh-mcp/core"
import { type Either, Option, Try } from "functype"
import { createServer, UserError } from "somamcp"
import { z } from "zod"

import {
  AGENT_UNKNOWN,
  type AuditCall,
  type AuditFields,
  type Auditor,
  createAuditor,
  excerpt,
  openAuditLog,
} from "./audit.js"
import { parseFleet } from "./fleet.js"
import { buildFleetRunner, type FleetRunner } from "./runners.js"

const { version: pkgVersion } = createRequire(import.meta.url)("../package.json") as {
  version: `${number}.${number}.${number}`
}

/** @interop somamcp reports a tool failure to the client only when the handler throws UserError. */
const unwrap = <T>(result: Either<string, T>): T =>
  result.fold(
    (msg) => {
      throw new UserError(msg)
    },
    (value) => value,
  )

const bytes = (s: string): number => Buffer.byteLength(s, "utf8")
const noSummary = (): AuditFields => ({})

// Tool handlers, factored out so they can be unit-tested with a fake FleetRunner.
// Every call goes through the auditor: a decision line before it runs, a result line after.
export const makeHandlers = (runner: FleetRunner, auditor: Auditor) => {
  const call = (tool: string, host: Option<string>, fields: AuditFields = {}): AuditCall => ({
    agent: AGENT_UNKNOWN,
    tool,
    host,
    fields,
  })

  // Sizes only, unless the host opts in to an output excerpt with log_output.
  const summarizeExec =
    (host: string) =>
    (r: CommandResult): AuditFields => ({
      code: r.code,
      stdout_bytes: bytes(r.stdout),
      stderr_bytes: bytes(r.stderr),
      ...(runner.logOutputFor(host) ? { stdout_excerpt: excerpt(r.stdout), stderr_excerpt: excerpt(r.stderr) } : {}),
    })

  return {
    hostsList: (): Promise<string> =>
      auditor.audited(
        call("hosts_list", Option.none<string>()),
        () => Promise.resolve(JSON.stringify(runner.status())),
        noSummary,
      ),
    /** @interop somamcp reports a tool failure to the client only when the handler throws UserError. */
    exec: async ({ host, command }: { host: string; command: string }): Promise<string> => {
      const r = await auditor.audited(
        call("exec", Option(host), { command }),
        () => runner.exec(host, command),
        summarizeExec(host),
      )
      if (r.stderr) throw new UserError(`[${host}] Error (code ${r.code}):\n${r.stderr}`)
      return r.stdout
    },
    tmuxList: ({ host }: { host: string }): Promise<string> =>
      auditor.audited(
        call("tmux_list", Option(host)),
        async () => JSON.stringify(unwrap(await tmuxList(unwrap(runner.tmuxRunnerFor(host))))),
        noSummary,
      ),
    tmuxSend: ({
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
      const press = submit ?? true
      return auditor.audited(
        call("tmux_send", Option(host), { session: target, input, submit: press }),
        async () => {
          unwrap(await tmuxSend(unwrap(runner.tmuxRunnerFor(host)), { session: target, input, submit: press }))
          return `[${host}] sent to tmux session "${target}".`
        },
        noSummary,
      )
    },
    tmuxRead: ({ host, session, lines }: { host: string; session?: string; lines?: number }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      const count = lines ?? 200
      return auditor.audited(
        call("tmux_read", Option(host), { session: target, lines: count }),
        async () => unwrap(await tmuxRead(unwrap(runner.tmuxRunnerFor(host)), { session: target, lines: count })),
        (transcript) => ({ stdout_bytes: bytes(transcript) }),
      )
    },
    tmuxKeys: ({ host, session, keys }: { host: string; session?: string; keys: string[] }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      return auditor.audited(
        call("tmux_keys", Option(host), { session: target, keys }),
        async () => {
          unwrap(await tmuxKeys(unwrap(runner.tmuxRunnerFor(host)), { session: target, keys }))
          return `[${host}] sent keys [${keys.join(", ")}] to tmux session "${target}".`
        },
        noSummary,
      )
    },
  }
}

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

  // Fail fast: no call may run unaudited, so an unwritable audit log stops startup.
  const sink = openAuditLog(fleet.audit.path).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (s) => s,
  )

  const runner = (await buildFleetRunner(fleet)).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (r) => r,
  )

  const h = makeHandlers(runner, createAuditor({ sink, now: () => new Date(), newId: randomUUID }))
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
  console.error(
    `SSH Fleet MCP Server running on stdio (${runner.hostNames.length} hosts); audit log: ${fleet.audit.path}`,
  )

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
