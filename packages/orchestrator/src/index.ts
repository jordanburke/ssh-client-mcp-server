#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname } from "node:path"

import {
  checkOpenSsh,
  type CommandResult,
  nodeProcessRunner,
  socketPathFor,
  startCaCustody,
  tmuxKeys,
  tmuxList,
  tmuxRead,
  tmuxSend,
} from "@ssh-mcp/core"
import { Either, Map, Option, Try } from "functype"
import { Path } from "functype-os"
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
import { checkRuntimeDir, readCheckConfig, runCheck } from "./check.js"
import { isEntryPoint } from "./entry.js"
import { type Fleet, fleetWarnings, parseFleet } from "./fleet.js"
import { ALLOW, evaluate, type PolicyRequest, type Verdict } from "./policy.js"
import {
  buildFleetRunner,
  caKeySource,
  type CaWiring,
  defaultKnownHosts,
  defaultRuntimeDir,
  type FleetRunner,
  selfTestCas,
} from "./runners.js"
import {
  ensureCaKeyFiles,
  ensureConfig,
  missingKeyFile,
  resolveConfigPath,
  type SetupContext,
  setupReport,
} from "./setup.js"

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
// Every call is checked against its host's policy and goes through the auditor: a decision line
// before it runs, a result line after. A denied call writes its decision line and never runs.
export const makeHandlers = (runner: FleetRunner, auditor: Auditor, setup: SetupContext) => {
  const call = (tool: string, host: Option<string>, verdict: Verdict, fields: AuditFields = {}): AuditCall => ({
    agent: AGENT_UNKNOWN,
    tool,
    host,
    fields,
    verdict,
  })

  // A host with no policy (an unknown host) gets ALLOW, so it reaches the runner and fails there.
  const gated = (host: string, req: PolicyRequest, fields: AuditFields = {}): AuditCall =>
    call(
      req.tool,
      Option(host),
      runner.policyFor(host).fold(
        () => ALLOW,
        (policy) => evaluate(policy, req),
      ),
      fields,
    )

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
        call("hosts_list", Option.none<string>(), ALLOW),
        () => Promise.resolve(JSON.stringify(runner.status())),
        noSummary,
      ),
    fleetSetup: (): Promise<string> =>
      auditor.audited(
        call("fleet_setup", Option.none<string>(), ALLOW),
        () => Promise.resolve(JSON.stringify(setupReport(setup, runner))),
        noSummary,
      ),
    /** @interop somamcp reports a tool failure to the client only when the handler throws UserError. */
    exec: async ({ host, command }: { host: string; command: string }): Promise<string> => {
      const r = await auditor.audited(
        gated(host, { tool: "exec", agent: AGENT_UNKNOWN, command }, { command }),
        () => runner.exec(host, command, AGENT_UNKNOWN),
        summarizeExec(host),
      )
      if (r.stderr) throw new UserError(`[${host}] Error (code ${r.code}):\n${r.stderr}`)
      return r.stdout
    },
    tmuxList: ({ host }: { host: string }): Promise<string> =>
      auditor.audited(
        gated(host, { tool: "tmux_list", agent: AGENT_UNKNOWN }),
        async () => JSON.stringify(unwrap(await tmuxList(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN))))),
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
        gated(host, { tool: "tmux_send", agent: AGENT_UNKNOWN }, { session: target, input, submit: press }),
        async () => {
          unwrap(
            await tmuxSend(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN)), {
              session: target,
              input,
              submit: press,
            }),
          )
          return `[${host}] sent to tmux session "${target}".`
        },
        noSummary,
      )
    },
    tmuxRead: ({ host, session, lines }: { host: string; session?: string; lines?: number }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      const count = lines ?? 200
      return auditor.audited(
        gated(host, { tool: "tmux_read", agent: AGENT_UNKNOWN }, { session: target, lines: count }),
        async () =>
          unwrap(await tmuxRead(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN)), { session: target, lines: count })),
        (transcript) => ({ stdout_bytes: bytes(transcript) }),
      )
    },
    tmuxKeys: ({ host, session, keys }: { host: string; session?: string; keys: string[] }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      return auditor.audited(
        gated(host, { tool: "tmux_keys", agent: AGENT_UNKNOWN }, { session: target, keys }),
        async () => {
          unwrap(await tmuxKeys(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN)), { session: target, keys }))
          return `[${host}] sent keys [${keys.join(", ")}] to tmux session "${target}".`
        },
        noSummary,
      )
    },
  }
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
    caPublicKeys: caPublicKeysOf(fleet, ca),
    caCreated,
    runtimeDir: ca.map((wiring) => wiring.custody.runtimeDir),
    knownHosts: ca.map((wiring) => wiring.knownHosts),
  }
  const h = makeHandlers(runner, createAuditor({ sink, now: () => new Date(), newId: randomUUID }), setup)
  const server = createServer({
    name: "ssh-fleet-mcp-server",
    version: pkgVersion,
    instructions:
      "Manage a fleet of SSH hosts: pooled connections, host-routed exec and tmux tools. " +
      "Call fleet_setup first if hosts_list is empty or a host fails to connect; it says what to configure next.",
  })

  const hostParam = z.string().describe("Configured host name (see hosts_list)")

  server.addTool({
    name: "hosts_list",
    description: "List configured fleet hosts and their live connection status.",
    parameters: z.object({}),
    execute: () => h.hostsList(),
  })
  server.addTool({
    name: "fleet_setup",
    description:
      "Show setup state: config path, each host's connection state and last error, each CA's public key and the line to add on hosts, and what to do next. Read-only.",
    parameters: z.object({}),
    execute: () => h.fleetSetup(),
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

// Only run when executed directly or through npm's bin link, not when imported by tests.
if (isEntryPoint(Option(process.argv[1]), import.meta.url)) {
  const entry = process.argv[2] === "check" ? checkMain : main
  entry().catch((error) => {
    console.error("Fatal error in main():", error)
    process.exit(1)
  })
}
