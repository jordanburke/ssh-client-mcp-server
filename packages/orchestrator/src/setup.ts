import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { childEnv, type ProcessRunner } from "@ssh-mcp/core"
import { Either, Left, type Map, Option, Right, Try } from "functype"
import { Path } from "functype-os"

import { type AuthKind, type CaEntry, type Fleet, type HostEntry, parseFleet } from "./fleet.js"
import { type FleetRunner, type HostError } from "./runners.js"
import { FLEET_TEMPLATE } from "./template.js"

export type ConfigPath = Readonly<{ path: string; explicit: boolean }>

// --config= wins, then SSH_FLEET_CONFIG, then the default. Only the default is ever created.
export const resolveConfigPath = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv, home: string): ConfigPath => {
  const flag = argv.find((a) => a.startsWith("--config="))
  if (flag) return { path: flag.slice("--config=".length), explicit: true }
  return Option(env.SSH_FLEET_CONFIG)
    .filter((p) => p.length > 0)
    .fold<ConfigPath>(
      () => ({ path: join(home, ".config", "ssh-fleet", "fleet.toml"), explicit: false }),
      (p) => ({ path: p, explicit: true }),
    )
}

const isCode = (e: unknown, c: string): boolean => (e as NodeJS.ErrnoException).code === c

// Writes the starter config at the default path when it is missing. An explicit path is never
// written: a typo there must fail startup, not produce a healthy-looking server with no hosts.
export const ensureConfig = (config: ConfigPath): Either<string, Readonly<{ path: string; created: boolean }>> => {
  const { path } = config
  if (config.explicit)
    return Try(() => statSync(path)).fold(
      (e) =>
        Left(
          isCode(e, "ENOENT")
            ? `Cannot read fleet config at ${path}: no such file (only the default path is created on first start)`
            : `Cannot read fleet config at ${path}: ${(e as Error).message}`,
        ),
      () => Right({ path, created: false }),
    )
  // No existence check first: "wx" fails with EEXIST when the file is there, whether it always was
  // or another client created it a moment ago.
  return Try(() => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, FLEET_TEMPLATE, { flag: "wx", mode: 0o600 })
  }).fold(
    (e) =>
      isCode(e, "EEXIST")
        ? Right({ path, created: false })
        : Left(`Cannot create fleet config at ${path}: ${(e as Error).message}`),
    () => Right({ path, created: true }),
  )
}

// The expanded key_file path when the CA uses key_file and nothing is at that path (ENOENT only:
// lstat, so a dangling symlink counts as present).
export const missingKeyFile = async (ca: CaEntry): Promise<Either<string, Option<string>>> => {
  if (ca.key.kind !== "file") return Right(Option.none<string>())
  const expanded = Path.expand(ca.key.path)
  if (expanded.isLeft()) return Left(`CA "${ca.name}": key_file ${ca.key.path}: ${expanded.value.message}`)
  const path = expanded.value
  const missing = await lstat(path).then(
    () => false,
    (e: unknown) => isCode(e, "ENOENT"),
  )
  return Right(missing ? Option(path) : Option.none<string>())
}

// Creates the key for each CA whose key_file is configured and missing (ENOENT only). Anything else at
// that path, including a symlink or a file with the wrong mode, is left for the key_file checks at
// custody start to report. key_cmd and key_env never create anything. Returns the created CAs' names.
export const ensureCaKeyFiles = async (
  cas: ReadonlyArray<CaEntry>,
  proc: ProcessRunner,
): Promise<Either<string, ReadonlyArray<string>>> => {
  const created = await Either.traverseAsync(cas, async (ca): Promise<Either<string, ReadonlyArray<string>>> => {
    const missing = await missingKeyFile(ca)
    if (missing.isLeft()) return Left(missing.value)
    if (missing.value.isNone()) return Right([])
    const path = missing.value.orElse("")
    const made = Try(() => mkdirSync(dirname(path), { recursive: true, mode: 0o700 }))
    if (made.isFailure()) return Left(`CA "${ca.name}": creating key_file ${path} failed: ${made.error.message}`)
    const r = await proc.run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", `ssh-fleet-ca-${ca.name}`, "-f", path],
      { env: childEnv(), input: "" },
    )
    if (r.code === 0) return Right([ca.name])
    // ssh-keygen refuses an existing file, so a failure with the file present means another
    // process created it first.
    if (existsSync(path)) return Right([])
    return Left(`CA "${ca.name}": creating key_file ${path} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  })
  return created.map((names) => names.flat())
}

// What fleet_setup reports from, fixed once startup finishes.
export type SetupContext = Readonly<{
  configPath: string
  configCreated: boolean
  fleet: Fleet
  // The config text loaded at start, and a way to read the file now, to notice edits made after start.
  loadedConfig: string
  readConfig: () => Either<string, string>
  // CA name → its public key line, as loaded into custody.
  caPublicKeys: Map<string, string>
  caCreated: ReadonlyArray<string>
  runtimeDir: Option<string>
  knownHosts: Option<string>
}>

type ConnectionRow = ReturnType<FleetRunner["status"]>[number]

export type HostReport = Readonly<{
  name: string
  address: string
  auth: AuthKind
  password_env?: string
  env_set?: boolean
  ca?: string
  principal?: string
  connections: ReadonlyArray<ConnectionRow>
  last_error?: HostError
  enroll_line?: string
}>

export type CaReport = Readonly<{
  name: string
  key_source: "key_cmd" | "key_env" | "key_file"
  key_file?: string
  created_this_start: boolean
  public_key?: string
  enroll_line?: string
}>

export type SetupReport = Readonly<{
  config: Readonly<{
    path: string
    created_this_start: boolean
    changed_since_start: boolean
    hosts_on_disk?: number
    errors_on_disk?: string
  }>
  next_steps: ReadonlyArray<string>
  hosts: ReadonlyArray<HostReport>
  cas: ReadonlyArray<CaReport>
  audit_log: string
  runtime_dir?: string
  known_hosts?: string
}>

export const enrollLine = (principal: string, publicKey: string): string =>
  `cert-authority,principals="${principal}" ${publicKey.trim()}`

export const hostAddress = (h: HostEntry): string =>
  h.user.fold(
    () => `${h.host}:${h.port}`,
    (u) => `${u}@${h.host}:${h.port}`,
  )

const KEY_SOURCE = { cmd: "key_cmd", env: "key_env", file: "key_file" } as const

// Built field by field: a HostEntry carries a resolved password in `auth`, so no whole entry, and no
// key_cmd string, may reach the report.
const hostReport = (
  h: HostEntry,
  ctx: SetupContext,
  runner: Pick<FleetRunner, "status" | "lastError">,
  env: NodeJS.ProcessEnv,
): HostReport => {
  const ca = h.ca.flatMap((name) => Option(ctx.fleet.cas.find((c) => c.name === name)))
  const principal = h.principal.or(ca.map((c) => c.principal))
  const enroll = ca
    .flatMap((c) => ctx.caPublicKeys.get(c.name))
    .flatMap((pub) => principal.map((p) => enrollLine(p, pub)))
  return {
    name: h.name,
    address: hostAddress(h),
    auth: h.authKind,
    ...h.passwordEnv.fold(
      () => ({}),
      (v) => ({ password_env: v, env_set: Boolean(env[v]) }),
    ),
    ...h.ca.fold(
      () => ({}),
      (name) => ({ ca: name, principal: principal.orElse("") }),
    ),
    connections: runner.status().filter((row) => row.name === h.name || row.name.startsWith(`${h.name} (`)),
    ...runner.lastError(h.name).fold(
      () => ({}),
      (e) => ({ last_error: e }),
    ),
    ...enroll.fold(
      () => ({}),
      (line) => ({ enroll_line: line }),
    ),
  }
}

const caReport = (c: CaEntry, ctx: SetupContext): CaReport => {
  const pub = ctx.caPublicKeys.get(c.name)
  return {
    name: c.name,
    key_source: KEY_SOURCE[c.key.kind],
    ...(c.key.kind === "file" ? { key_file: c.key.path } : {}),
    created_this_start: ctx.caCreated.includes(c.name),
    ...pub.fold(
      () => ({}),
      (p) => ({ public_key: p.trim(), enroll_line: enrollLine(c.principal, p) }),
    ),
  }
}

type Drift = Readonly<{
  changed: boolean
  fields: Readonly<{ changed_since_start: boolean; hosts_on_disk?: number; errors_on_disk?: string }>
  step: ReadonlyArray<string>
}>

const RECONNECT = "reconnect the server to load it (in Claude Code: /mcp, then reconnect)"

// The server reads fleet.toml once. An edit after start is invisible until a reconnect, so compare the
// file now with the text loaded at start, and parse it to say what a reconnect would load.
const configDrift = (ctx: SetupContext): Drift => {
  const now = ctx.readConfig()
  if (now.isRight() && now.value === ctx.loadedConfig)
    return { changed: false, fields: { changed_since_start: false }, step: [] }
  const parsed = now.flatMap(parseFleet)
  return parsed.fold<Drift>(
    (errors) => ({
      changed: true,
      fields: { changed_since_start: true, errors_on_disk: errors },
      step: [`fleet.toml changed since the server started and now has errors; fix them before reconnecting: ${errors}`],
    }),
    (onDisk) => ({
      changed: true,
      fields: { changed_since_start: true, hosts_on_disk: onDisk.hosts.length },
      step: [
        `fleet.toml changed since the server started (${onDisk.hosts.length} hosts on disk, ${ctx.fleet.hosts.length} loaded): ${RECONNECT}.`,
      ],
    }),
  )
}

// The fleet_setup tool's answer: what is configured, its live state, and what to do next.
export const setupReport = (
  ctx: SetupContext,
  runner: Pick<FleetRunner, "status" | "lastError">,
  env: NodeJS.ProcessEnv = process.env,
): SetupReport => {
  const hosts = ctx.fleet.hosts.map((h) => hostReport(h, ctx, runner, env))
  const cas = ctx.fleet.cas.map((c) => caReport(c, ctx))
  const drift = configDrift(ctx)
  const nextSteps = [
    ...drift.step,
    ...(hosts.length === 0 && !drift.changed
      ? [`Add a [[hosts]] entry to ${ctx.configPath}, then restart the server.`]
      : []),
    ...hosts
      .filter((h) => h.env_set === false)
      .map((h) => `${h.name}: set ${h.password_env} in the MCP client's env for this server, then restart.`),
    ...cas
      .filter((c) => c.created_this_start && c.enroll_line !== undefined)
      .map(
        (c) =>
          `Add CA "${c.name}"'s line to a root-owned authorized-keys file on each host that uses it: ${c.enroll_line}`,
      ),
    ...hosts.flatMap((h) => (h.last_error ? [`${h.name}: ${h.last_error.message}`] : [])),
  ]
  return {
    config: { path: ctx.configPath, created_this_start: ctx.configCreated, ...drift.fields },
    next_steps: nextSteps,
    hosts,
    cas,
    audit_log: ctx.fleet.audit.path,
    ...ctx.runtimeDir.fold(
      () => ({}),
      (d) => ({ runtime_dir: d }),
    ),
    ...ctx.knownHosts.fold(
      () => ({}),
      (k) => ({ known_hosts: k }),
    ),
  }
}
