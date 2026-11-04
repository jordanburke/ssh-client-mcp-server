#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname } from "node:path"

import { checkOpenSsh, nodeProcessRunner, socketPathFor, startCaCustody } from "@ssh-mcp/core"
import { Either, Left, Map, Option, Right, Try } from "functype"
import { Path } from "functype-os"
import { createServer } from "somamcp/node"
import { z } from "zod"

import { CLIENT_LABEL_ENV, clientLabel, createAuditor, openAuditLog, reportedClient } from "./audit.js"
import { buildInfo } from "./build-info.js"
import { checkRuntimeDir, readCheckConfig, runCheck } from "./check.js"
import { type Fleet, fleetWarnings, parseFleet } from "./fleet.js"
import { makeHandlers } from "./handlers.js"
import {
  buildFleetRunner,
  caKeySource,
  type CaWiring,
  defaultKnownHosts,
  defaultRuntimeDir,
  type FleetRunner,
  selfTestCas,
} from "./runners.js"
import { ensureCaKeyFiles, ensureConfig, missingKeyFile, resolveConfigPath, type SetupContext } from "./setup.js"

const { version: pkgVersion } = createRequire(import.meta.url)("../package.json") as {
  version: `${number}.${number}.${number}`
}

const fatal = (msg: string): never => {
  console.error(msg)
  return process.exit(1)
}

const expanded = (path: string): string =>
  Path.expand(path).fold(
    (e) => fatal(`invalid path ${path}: ${e.message}`),
    (p) => p,
  )

type CaStart = Readonly<{ wiring: Option<CaWiring>; created: ReadonlyArray<string> }>

// When any [[cas]] entry exists (with or without hosts using it yet): check OpenSSH, create any missing
// key_file, prepare the runtime dir and known_hosts, and load every CA key into a private ssh-agent.
// Each failure stops startup. `check` creates nothing and uses its own runtime dir.
const startCa = async (fleet: Fleet, mode: "serve" | "check"): Promise<CaStart> => {
  if (fleet.cas.length === 0) return { wiring: Option.none<CaWiring>(), created: [] }
  ;(await checkOpenSsh(nodeProcessRunner)).fold(fatal, () => undefined)
  const created =
    mode === "serve" ? (await ensureCaKeyFiles(fleet.cas, nodeProcessRunner)).fold(fatal, (names) => names) : []
  fleet.cas
    .filter((c) => created.includes(c.name))
    .forEach((c) =>
      console.error(
        `created CA "${c.name}" key at ${c.key.kind === "file" ? c.key.path : ""}; add its line to each host (see fleet_setup)`,
      ),
    )
  const configured = fleet.runtimeDir.map(expanded).orElse(defaultRuntimeDir())
  const runtimeDir = mode === "check" ? checkRuntimeDir(configured) : configured
  const knownHosts = fleet.knownHosts.map(expanded).orElse(defaultKnownHosts())
  // Socket paths are fixed-length below runtimeDir, so one check covers every (agent, host).
  socketPathFor(runtimeDir, "unknown", "host").fold(fatal, () => undefined)
  mkdirSync(dirname(knownHosts), { recursive: true, mode: 0o700 })
  const custody = (
    await startCaCustody(
      runtimeDir,
      fleet.cas.map((c) => caKeySource(c)),
      nodeProcessRunner,
    )
  ).fold(fatal, (c) => c)
  // Mint and discard one certificate per CA: a CA that can't sign stops startup now, not every call.
  const selfTest = await selfTestCas(custody, fleet.cas, nodeProcessRunner)
  if (selfTest.isLeft()) {
    await custody.shutdown()
    fatal(selfTest.value)
  }
  return { wiring: Option<CaWiring>({ custody, proc: nodeProcessRunner, knownHosts }), created }
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

const caPublicKeysOf = (fleet: Fleet, ca: Option<CaWiring>): Map<string, string> =>
  ca.fold(
    () => Map.of<string, string>(),
    (wiring) =>
      Map.of(
        ...fleet.cas.flatMap((c): Array<[string, string]> =>
          wiring.custody
            .pubPath(c.name)
            .flatMap((path) => Try(() => readFileSync(path, "utf8")).toOption())
            .fold(
              () => [],
              (pub) => [[c.name, pub.trim()]],
            ),
        ),
      ),
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
  // Probe only what can start: a CA with no key_file, and its hosts, are reported without a connection.
  const probeFleet: Fleet = {
    ...fleet,
    cas: fleet.cas.filter((c) => !missingKeyCas.includes(c.name)),
    hosts: fleet.hosts.filter((h) => !h.ca.exists((name) => missingKeyCas.includes(name))),
  }
  const { wiring: ca } = await startCa(probeFleet, "check")
  const runner = await buildRunnerOrExit(probeFleet, ca)
  const code = await runCheck({
    fleet,
    configPath: path,
    runner,
    auditor: createAuditor({ sink, now: () => new Date(), newId: randomUUID }),
    missingKeyCas,
    caPublicKeys: caPublicKeysOf(probeFleet, ca),
    out: (line) => console.log(line),
  })
  await runner.shutdown()
  process.exit(code)
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

  const { wiring: ca, created: caCreated } = await startCa(fleet, "serve")
  const runner = await buildRunnerOrExit(fleet, ca)
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
    caPublicKeys: caPublicKeysOf(fleet, ca),
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
