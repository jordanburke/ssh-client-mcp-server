import { isIP } from "node:net"

import { type ResolveAuthOptions, validateSession } from "@ssh-mcp/core"
import { type Either, Left, List, Option, Right, Try } from "functype"
import { parse as parseToml } from "smol-toml"

import { DEFAULT_AUDIT_PATH } from "./audit.js"
import { EMPTY_TABLE, type HostPolicy, parsePolicyTable, type PolicyTable, resolvePolicy } from "./policy.js"

export type HostEntry = Readonly<{
  name: string
  host: string
  port: number
  user: Option<string>
  auth: ResolveAuthOptions
  // Which auth field the host set. Kept apart from `auth`, which holds a resolved password.
  authKind: AuthKind
  passwordEnv: Option<string>
  tmuxSession: string
  logOutput: boolean
  policy: HostPolicy
  // The [[cas]] entry this host authenticates through, when it uses ca auth.
  ca: Option<string>
  principal: Option<string>
}>

export type AuthKind = "password_env" | "key" | "key_env" | "agent" | "ca"

export type PoolSettings = Readonly<{ maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }>

export type AuditSettings = Readonly<{ path: string }>

// Where a CA's private key comes from. Never the key itself: inline keys are rejected.
export type CaKeyRef =
  | Readonly<{ kind: "cmd"; cmd: string }>
  | Readonly<{ kind: "env"; name: string }>
  | Readonly<{ kind: "file"; path: string }>

export type CaEntry = Readonly<{ name: string; key: CaKeyRef; principal: string; sourceAddress: Option<string> }>

export type Fleet = Readonly<{
  hosts: HostEntry[]
  pool: PoolSettings
  audit: AuditSettings
  cas: ReadonlyArray<CaEntry>
  runtimeDir: Option<string>
  knownHosts: Option<string>
}>

type RawHost = Record<string, unknown>

const str = (v: unknown): Option<string> => (typeof v === "string" && v.length > 0 ? Option(v) : Option.none<string>())
const num = (v: unknown): Option<number> => (typeof v === "number" ? Option(v) : Option.none<number>())

// Exactly-one-auth + secrets-by-reference. Returns the auth options or an error string.
type HostAuth = Readonly<{ auth: ResolveAuthOptions; kind: AuthKind }>

const resolveHostAuth = (name: string, h: RawHost): Either<string, HostAuth> => {
  if (h.password !== undefined || h.private_key !== undefined) {
    return Left<string, HostAuth>(`host "${name}": secrets must not be inline; use key/key_env/agent/password_env/ca`)
  }
  const modes = [
    str(h.key).map((): AuthKind => "key"),
    str(h.key_env).map((): AuthKind => "key_env"),
    str(h.password_env).map((): AuthKind => "password_env"),
    h.agent === true ? Option<AuthKind>("agent") : Option.none<AuthKind>(),
    str(h.ca).map((): AuthKind => "ca"),
  ].flatMap((o) => o.toArray())
  if (modes.length === 0)
    return Left<string, HostAuth>(
      `host "${name}": no auth mode (need exactly one of key/key_env/agent/password_env/ca)`,
    )
  if (modes.length > 1)
    return Left<string, HostAuth>(`host "${name}": exactly one auth mode allowed, found ${modes.length}`)
  const auth: ResolveAuthOptions = {
    password: str(h.password_env)
      .flatMap((v) => Option(process.env[v] ?? ""))
      .filter((v) => v.length > 0),
    keyPath: str(h.key),
    keyEnvVar: str(h.key_env),
    useAgent: h.agent === true,
  }
  return Right<string, HostAuth>({ auth, kind: modes[0] })
}

const parsePool = (raw: Record<string, unknown>): PoolSettings => {
  const p = (raw.pool ?? {}) as Record<string, unknown>
  return {
    maxPerHost: num(p.max_per_host).orElse(2),
    idleTimeoutMs: num(p.idle_timeout_ms).orElse(60000),
    acquireTimeoutMs: num(p.acquire_timeout_ms).orElse(30000),
  }
}

const validPrincipal = (p: string): boolean => p.length > 0 && !p.includes(",")

const ipv4Value = (addr: string): bigint => addr.split(".").reduce((acc, octet) => (acc << 8n) + BigInt(octet), 0n)

// Expands `::`; an IPv6 address with an embedded dotted IPv4 tail is not accepted here.
const ipv6Value = (addr: string): Option<bigint> => {
  if (addr.includes(".")) return Option.none<bigint>()
  const [head, tail = ""] = addr.split("::")
  const headGroups = head ? head.split(":") : []
  const tailGroups = addr.includes("::") && tail ? tail.split(":") : []
  const fill = addr.includes("::") ? 8 - headGroups.length - tailGroups.length : 0
  const groups = [...headGroups, ...Array.from({ length: fill }, () => "0"), ...tailGroups]
  return groups.length === 8
    ? Option(groups.reduce((acc, g) => (acc << 16n) + BigInt(`0x${g || "0"}`), 0n))
    : Option.none<bigint>()
}

const hostBitsClear = (value: bigint, width: number, prefix: number): boolean =>
  (value & ((1n << BigInt(width - prefix)) - 1n)) === 0n

// `a.b.c.d/n` (n ≤ 32) or an IPv6 address with `/n` (n ≤ 128), with no host bits set: ssh-keygen
// rejects `100.64.0.1/24`, so it must fail here rather than at every connect.
const validCidr = (v: string): boolean => {
  const parts = v.split("/")
  if (parts.length !== 2) return false
  const [addr, prefix] = parts
  if (!/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  const family = isIP(addr)
  if (family === 4) return bits <= 32 && hostBitsClear(ipv4Value(addr), 32, bits)
  if (family === 6)
    return (
      bits <= 128 &&
      ipv6Value(addr).fold(
        () => false,
        (value) => hostBitsClear(value, 128, bits),
      )
    )
  return false
}

const parseCa = (c: RawHost): Either<string, CaEntry> => {
  const name = str(c.name)
  if (name.isNone()) return Left<string, CaEntry>("[[cas]] entry has no name")
  const n = name.orElse("")
  if (c.key !== undefined || c.private_key !== undefined)
    return Left<string, CaEntry>(`ca "${n}": keys must not be inline; use key_cmd, key_env or key_file`)
  const refs: ReadonlyArray<CaKeyRef> = [
    ...str(c.key_cmd).fold<CaKeyRef[]>(
      () => [],
      (cmd) => [{ kind: "cmd", cmd }],
    ),
    ...str(c.key_env).fold<CaKeyRef[]>(
      () => [],
      (envName) => [{ kind: "env", name: envName }],
    ),
    ...str(c.key_file).fold<CaKeyRef[]>(
      () => [],
      (path) => [{ kind: "file", path }],
    ),
  ]
  if (refs.length !== 1)
    return Left<string, CaEntry>(`ca "${n}": exactly one of key_cmd, key_env, key_file is required`)
  const key = refs[0]
  const principal = c.principal === undefined ? "fleet" : typeof c.principal === "string" ? c.principal : ""
  if (!validPrincipal(principal)) return Left<string, CaEntry>(`ca "${n}": principal must be non-empty with no commas`)
  const sourceAddress = str(c.source_address)
  if (c.source_address !== undefined && !sourceAddress.fold(() => false, validCidr))
    return Left<string, CaEntry>(`ca "${n}": source_address must be an IPv4 or IPv6 CIDR`)
  return Right<string, CaEntry>({ name: n, key, principal, sourceAddress })
}

const parseAudit = (raw: Record<string, unknown>): Either<string, AuditSettings> => {
  const a = (raw.audit ?? {}) as Record<string, unknown>
  if (a.path === undefined) return Right<string, AuditSettings>({ path: DEFAULT_AUDIT_PATH })
  return str(a.path).fold(
    () => Left<string, AuditSettings>("audit.path must be a non-empty string"),
    (path) => Right<string, AuditSettings>({ path }),
  )
}

// smol-toml's message quotes the offending source lines, which can hold an inline secret, and
// fleet_setup relays this text to the MCP client. Keep the location and the first line only.
/** @interop smol-toml throws an Error carrying line and column fields. */
const tomlError = (e: unknown): string => {
  const err = e as Error & { line?: number; column?: number }
  const summary = err.message.split("\n")[0]
  return err.line === undefined
    ? `Invalid TOML: ${summary}`
    : `Invalid TOML at line ${err.line}, column ${err.column}: ${summary}`
}

export const parseFleet = (toml: string): Either<string, Fleet> => {
  const parsed = Try(() => parseToml(toml) as Record<string, unknown>)
  if (parsed.isFailure()) return Left<string, Fleet>(tomlError(parsed.error))
  const raw = parsed.orThrow()

  const defaults = (raw.defaults ?? {}) as Record<string, unknown>
  const defaultPort = num(defaults.port).orElse(22)
  const defaultUser = str(defaults.user)
  const defaultSession = str(defaults.tmux_session).orElse("agent")
  const rawHosts = Array.isArray(raw.hosts) ? (raw.hosts as RawHost[]) : []
  // Parsed once; if it fails, hosts resolve against EMPTY_TABLE so its errors appear once.
  const defaultsPolicy = parsePolicyTable(defaults.policy, "defaults.policy")
  const defaultsTable: PolicyTable = defaultsPolicy.orElse(EMPTY_TABLE)

  const names = rawHosts.map((h) => str(h.name).orElse(""))
  const rawCas = Array.isArray(raw.cas) ? (raw.cas as RawHost[]) : []
  const caNames = rawCas.map((c) => str(c.name).orElse(""))
  const parseHost = (h: RawHost, index: number): Either<string, HostEntry> => {
    const name = str(h.name).orElse("")
    if (!validateSession(name).isRight())
      return Left<string, HostEntry>(`invalid host name "${name}": only letters, digits, hyphen, underscore`)
    if (names.indexOf(name) < index) return Left<string, HostEntry>(`duplicate host name "${name}"`)
    const address = str(h.host)
    if (address.isNone()) return Left<string, HostEntry>(`host "${name}": missing host address`)
    if (h.log_output !== undefined && typeof h.log_output !== "boolean")
      return Left<string, HostEntry>(`host "${name}": log_output must be true or false`)
    const ca = str(h.ca)
    if (ca.isSome() && !caNames.includes(ca.orElse("")))
      return Left<string, HostEntry>(`host "${name}": ca "${ca.orElse("")}" is not defined in [[cas]]`)
    const principal = typeof h.principal === "string" ? Option(h.principal) : Option.none<string>()
    if (h.principal !== undefined && ca.isNone())
      return Left<string, HostEntry>(`host "${name}": principal applies only to ca auth`)
    if (h.principal !== undefined && !principal.fold(() => false, validPrincipal))
      return Left<string, HostEntry>(`host "${name}": principal must be non-empty with no commas`)
    const where = `host "${name}": policy`
    const policy = parsePolicyTable(h.policy, where)
      .flatMap((table) => resolvePolicy(where, defaultsTable, table))
      .mapLeft((errs) => errs.join("\n"))
    return resolveHostAuth(name, h).flatMap(({ auth, kind }) =>
      policy.map((p) => ({
        name,
        host: address.orElse(""),
        port: num(h.port).orElse(defaultPort),
        user: str(h.user).or(defaultUser),
        auth,
        authKind: kind,
        passwordEnv: str(h.password_env),
        tmuxSession: str(h.tmux_session).orElse(defaultSession),
        logOutput: h.log_output === true,
        policy: p,
        ca,
        principal,
      })),
    )
  }

  const audit = parseAudit(raw)
  const results = rawHosts.map(parseHost)
  const casResults = rawCas.map(parseCa)
  const caErrors = [
    ...casResults.flatMap((r) =>
      r.fold<string[]>(
        (msg) => [msg],
        () => [],
      ),
    ),
    ...caNames.filter((n, i) => n !== "" && caNames.indexOf(n) < i).map((n) => `ca "${n}": duplicate name`),
  ]
  const errors = [
    ...caErrors,
    ...defaultsPolicy.fold(
      (errs) => [...errs],
      () => [],
    ),
    ...[audit, ...results].flatMap((r) =>
      r.fold<string[]>(
        (msg) => [msg],
        () => [],
      ),
    ),
  ]
  const hosts = results.flatMap((r) =>
    r.fold<HostEntry[]>(
      () => [],
      (entry) => [entry],
    ),
  )

  return errors.length > 0
    ? Left<string, Fleet>(`Fleet config errors:\n${List(errors).toArray().join("\n")}`)
    : Right<string, Fleet>({
        hosts,
        pool: parsePool(raw),
        audit: audit.orElse({ path: DEFAULT_AUDIT_PATH }),
        cas: casResults.flatMap((r) =>
          r.fold<CaEntry[]>(
            () => [],
            (c) => [c],
          ),
        ),
        runtimeDir: str(raw.runtime_dir),
        knownHosts: str(raw.known_hosts),
      })
}

// Startup warnings: an empty fleet, a password variable that isn't set, and hosts that will deny
// every call until agent identity exists (the agent is "unknown" until then).
export const fleetWarnings = (fleet: Fleet): ReadonlyArray<string> => [
  ...(fleet.hosts.length === 0 ? ["no hosts configured; add a [[hosts]] entry and restart"] : []),
  ...fleet.hosts.flatMap((h) =>
    h.passwordEnv
      .filter((v) => !process.env[v])
      .fold(
        () => [],
        (v) => [`host "${h.name}": password_env ${v} is not set`],
      ),
  ),
  ...fleet.hosts
    .filter((h) => h.policy.agents.isSome())
    .map((h) => `host "${h.name}": policy.agents is set, so every call is denied until agent identity is available`),
]
