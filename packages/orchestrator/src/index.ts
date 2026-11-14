#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"

import { Either, Left, type Option, Right, Try } from "functype"
import { createServer } from "somamcp/node"
import { z } from "zod"

import { CLIENT_LABEL_ENV, clientLabel, createAuditor, openAuditLog, reportedClient } from "./audit.js"
import { buildInfo } from "./build-info.js"
import { caPublicKeys, type CaStart, startCa } from "./ca-start.js"
import { probeFleetOf, readCheckConfig, runCheck } from "./check.js"
import { type Fleet, fleetWarnings, parseFleet } from "./fleet.js"
import { makeHandlers } from "./handlers.js"
import { buildFleetRunner, type CaWiring, type FleetRunner } from "./runners.js"
import { ensureConfig, missingKeyFile, resolveConfigPath, type SetupContext } from "./setup.js"

const { version: pkgVersion } = createRequire(import.meta.url)("../package.json") as {
  version: `${number}.${number}.${number}`
}

const fatal = (msg: string): never => {
  console.error(msg)
  return process.exit(1)
}

// Never leave a CA agent holding the key behind a failed start.
const buildRunnerOrExit = async (fleet: Fleet, ca: Option<CaWiring>): Promise<FleetRunner> =>
  (await buildFleetRunner(fleet, undefined, ca)).fold(
    async (msg) => {
      console.error(msg)
      await ca.fold(
        () => Promise.resolve(),
        (wiring) => wiring.custody.shutdown(),
      )
      return process.exit(1)
    },
    (r) => Promise.resolve(r),
  )

const startCaOrExit = async (fleet: Fleet, mode: "serve" | "check"): Promise<CaStart> =>
  (await startCa(fleet, mode)).fold(fatal, (c) => c)

// The runner owns the CA agent, so shutting it down before exiting leaves no key behind.
const caPublicKeysOrExit = async (fleet: Fleet, ca: Option<CaWiring>, runner: FleetRunner) =>
  caPublicKeys(fleet.cas, ca).fold(
    async (msg) => {
      await runner.shutdown()
      return fatal(msg)
    },
    (keys) => Promise.resolve(keys),
  )

const parseOrExit = (raw: string): Fleet => {
  const fleet = parseFleet(raw).fold(fatal, (f) => f)
  fleetWarnings(fleet).forEach((w) => console.error(`warning: ${w}`))
  return fleet
}

// `ssh-fleet-mcp-server check`: connect to every host from a terminal and print one line each.
async function checkMain(): Promise<void> {
  const { path } = resolveConfigPath(process.argv.slice(2), process.env, homedir())
  const fleet = parseOrExit(readCheckConfig(path).fold(fatal, (raw) => raw))
  const sink = openAuditLog(fleet.audit.path).fold(fatal, (s) => s)
  const missing = await Either.traverseAsync(fleet.cas, async (c) =>
    (await missingKeyFile(c)).map((m) =>
      m.fold<string[]>(
        () => [],
        () => [c.name],
      ),
    ),
  )
  const missingKeyCas = missing.fold(fatal, (names) => names.flat())
  const probeFleet = probeFleetOf(fleet, missingKeyCas)
  const { wiring: ca } = await startCaOrExit(probeFleet, "check")
  const runner = await buildRunnerOrExit(probeFleet, ca)
  // A signal (`timeout 30 … check`, or Ctrl-C while a host is unreachable) still stops the check's
  // own CA agent. One that arrives earlier, while custody starts or self-tests, isn't caught; the
  // next start's recovery cleans up after it.
  const stopWith = (code: number) => () => void runner.shutdown().finally(() => process.exit(code))
  process.on("SIGINT", stopWith(130))
  process.on("SIGTERM", stopWith(143))
  const publicKeys = await caPublicKeysOrExit(probeFleet, ca, runner)
  const code = await runCheck({
    fleet,
    configPath: path,
    runner,
    auditor: createAuditor({ sink, now: () => new Date(), newId: randomUUID }),
    missingKeyCas,
    caPublicKeys: publicKeys,
    out: (line) => console.log(line),
  })
  await runner.shutdown()
  // exitCode, not exit(): Node writes stdout to a pipe asynchronously on macOS, and exit() can drop
  // the last lines.
  process.exitCode = code
}

async function main(): Promise<void> {
  const config = ensureConfig(resolveConfigPath(process.argv.slice(2), process.env, homedir())).fold(fatal, (c) => c)
  if (config.created) console.error(`created fleet config at ${config.path}`)
  const configPath = config.path
  const raw = Try(() => readFileSync(configPath, "utf8")).fold(
    (e) => {
      console.error(`Cannot read fleet config at ${configPath}: ${(e as Error).message}`)
      return process.exit(1)
    },
    (content) => content,
  )

  const fleet = parseOrExit(raw)

  // Fail fast: no call may run unaudited, so an unwritable audit log stops startup.
  const sink = openAuditLog(fleet.audit.path).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (s) => s,
  )

  const { wiring: ca, created: caCreated } = await startCaOrExit(fleet, "serve")
  const runner = await buildRunnerOrExit(fleet, ca)
  const publicKeys = await caPublicKeysOrExit(fleet, ca, runner)
  fleet.hosts.forEach((host) => runner.lastError(host.name).forEach((e) => console.error(`warning: ${e.message}`)))

  const setup: SetupContext = {
    configPath,
    configCreated: config.created,
    fleet,
    loadedConfig: raw,
    readConfig: () =>
      Try(() => readFileSync(configPath, "utf8")).fold(
        (e) => Left<string, string>(`Cannot read ${configPath}: ${e.message}`),
        (text) => Right<string, string>(text),
      ),
    caPublicKeys: publicKeys,
    caCreated,
    runtimeDir: ca.map((wiring) => wiring.custody.runtimeDir),
    knownHosts: ca.map((wiring) => wiring.knownHosts),
  }
  const label = clientLabel(process.env[CLIENT_LABEL_ENV])
  // The client is known per call, so each call gets handlers whose auditor records it.
  const handlers = (context: Readonly<{ client: Parameters<typeof reportedClient>[0] }>) =>
    makeHandlers(
      runner,
      createAuditor({
        sink,
        now: () => new Date(),
        newId: randomUUID,
        client: label.or(reportedClient(context.client)).orUndefined(),
      }),
      setup,
    )
  const server = createServer({
    name: "ssh-fleet-mcp-server",
    version: pkgVersion,
    build: buildInfo(),
    instructions:
      "Manage a fleet of SSH hosts: pooled connections, host-routed exec and tmux tools. " +
      "Call fleet_setup first if hosts_list is empty or a host fails to connect; it says what to configure next.",
  })

  const hostParam = z.string().describe("Configured host name (see hosts_list)")

  server.addTool({
    name: "hosts_list",
    description:
      "List configured fleet hosts and their live connection status. If a host you expect is missing, call fleet_setup: the config may have changed since the server started.",
    parameters: z.object({}),
    execute: (_args, context) => handlers(context).hostsList(),
  })
  server.addTool({
    name: "fleet_setup",
    description:
      "Show setup state: config path, each host's connection state and last error, each CA's public key and the line to add on hosts, and what to do next. Read-only.",
    parameters: z.object({}),
    execute: (_args, context) => handlers(context).fleetSetup(),
  })
  server.addTool({
    name: "exec",
    description: "Run a one-shot shell command on a fleet host over SSH.",
    parameters: z.object({
      host: hostParam,
      command: z.string().min(1).describe("Shell command"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `How long to wait, in ms. Default ${fleet.pool.execTimeoutMs}; at most ${fleet.pool.maxExecTimeoutMs}, and a larger value is lowered to it. On timeout the call fails with the output so far, and the command may still be running. For longer jobs, run them in tmux (tmux_send, then tmux_read).`,
        ),
    }),
    execute: ({ host, command, timeout_ms }, context) => handlers(context).exec({ host, command, timeout_ms }),
  })
  server.addTool({
    name: "tmux_list",
    description: "List tmux sessions on a fleet host. Returns a JSON array of session names.",
    parameters: z.object({ host: hostParam }),
    execute: ({ host }, context) => handlers(context).tmuxList({ host }),
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
    execute: ({ host, session, input, submit }, context) =>
      handlers(context).tmuxSend({ host, session, input, submit }),
  })
  server.addTool({
    name: "tmux_read",
    description: "Capture the recent pane transcript of a tmux session on a fleet host.",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      lines: z.number().int().min(1).optional().describe("Lines of scrollback (default 200; capped at 2000)"),
    }),
    execute: ({ host, session, lines }, context) => handlers(context).tmuxRead({ host, session, lines }),
  })
  server.addTool({
    name: "tmux_keys",
    description: "Send control/special keys (e.g. C-c) to a tmux session on a fleet host.",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      keys: z.array(z.string()).min(1).describe("tmux key names, e.g. ['C-c']"),
    }),
    execute: ({ host, session, keys }, context) => handlers(context).tmuxKeys({ host, session, keys }),
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

const entry = process.argv[2] === "check" ? checkMain : main
entry().catch((error) => {
  console.error("Fatal error in main():", error)
  process.exit(1)
})
