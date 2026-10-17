import { type ResolveAuthOptions, validateSession } from "@ssh-mcp/core"
import { type Either, Left, List, Option, Right, Try } from "functype"
import { parse as parseToml } from "smol-toml"

import { DEFAULT_AUDIT_PATH } from "./audit.js"

export type HostEntry = Readonly<{
  name: string
  host: string
  port: number
  user: Option<string>
  auth: ResolveAuthOptions
  tmuxSession: string
  logOutput: boolean
}>

export type PoolSettings = Readonly<{ maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }>

export type AuditSettings = Readonly<{ path: string }>

export type Fleet = Readonly<{ hosts: HostEntry[]; pool: PoolSettings; audit: AuditSettings }>

type RawHost = Record<string, unknown>

const str = (v: unknown): Option<string> => (typeof v === "string" && v.length > 0 ? Option(v) : Option.none<string>())
const num = (v: unknown): Option<number> => (typeof v === "number" ? Option(v) : Option.none<number>())

// Exactly-one-auth + secrets-by-reference. Returns the auth options or an error string.
const resolveHostAuth = (name: string, h: RawHost): Either<string, ResolveAuthOptions> => {
  if (h.password !== undefined || h.private_key !== undefined) {
    return Left<string, ResolveAuthOptions>(
      `host "${name}": secrets must not be inline; use key/key_env/agent/password_env`,
    )
  }
  const modes = [
    str(h.key).map(() => "key"),
    str(h.key_env).map(() => "key_env"),
    str(h.password_env).map(() => "password_env"),
    h.agent === true ? Option("agent") : Option.none<string>(),
  ].filter((o) => o.isSome())
  if (modes.length === 0)
    return Left<string, ResolveAuthOptions>(
      `host "${name}": no auth mode (need exactly one of key/key_env/agent/password_env)`,
    )
  if (modes.length > 1)
    return Left<string, ResolveAuthOptions>(`host "${name}": exactly one auth mode allowed, found ${modes.length}`)
  return Right<string, ResolveAuthOptions>({
    password: str(h.password_env)
      .flatMap((v) => Option(process.env[v] ?? ""))
      .filter((v) => v.length > 0),
    keyPath: str(h.key),
    keyEnvVar: str(h.key_env),
    useAgent: h.agent === true,
  })
}

const parsePool = (raw: Record<string, unknown>): PoolSettings => {
  const p = (raw.pool ?? {}) as Record<string, unknown>
  return {
    maxPerHost: num(p.max_per_host).orElse(2),
    idleTimeoutMs: num(p.idle_timeout_ms).orElse(60000),
    acquireTimeoutMs: num(p.acquire_timeout_ms).orElse(30000),
  }
}

const parseAudit = (raw: Record<string, unknown>): Either<string, AuditSettings> => {
  const a = (raw.audit ?? {}) as Record<string, unknown>
  if (a.path === undefined) return Right<string, AuditSettings>({ path: DEFAULT_AUDIT_PATH })
  return str(a.path).fold(
    () => Left<string, AuditSettings>("audit.path must be a non-empty string"),
    (path) => Right<string, AuditSettings>({ path }),
  )
}

export const parseFleet = (toml: string): Either<string, Fleet> => {
  const parsed = Try(() => parseToml(toml) as Record<string, unknown>)
  if (parsed.isFailure()) return Left<string, Fleet>(`Invalid TOML: ${(parsed.error as Error).message}`)
  const raw = parsed.orThrow()

  const defaults = (raw.defaults ?? {}) as Record<string, unknown>
  const defaultPort = num(defaults.port).orElse(22)
  const defaultUser = str(defaults.user)
  const defaultSession = str(defaults.tmux_session).orElse("agent")
  const rawHosts = Array.isArray(raw.hosts) ? (raw.hosts as RawHost[]) : []

  if (rawHosts.length === 0) return Left<string, Fleet>("Fleet config has no [[hosts]] entries")

  const names = rawHosts.map((h) => str(h.name).orElse(""))
  const parseHost = (h: RawHost, index: number): Either<string, HostEntry> => {
    const name = str(h.name).orElse("")
    if (!validateSession(name).isRight())
      return Left<string, HostEntry>(`invalid host name "${name}": only letters, digits, hyphen, underscore`)
    if (names.indexOf(name) < index) return Left<string, HostEntry>(`duplicate host name "${name}"`)
    const address = str(h.host)
    if (address.isNone()) return Left<string, HostEntry>(`host "${name}": missing host address`)
    if (h.log_output !== undefined && typeof h.log_output !== "boolean")
      return Left<string, HostEntry>(`host "${name}": log_output must be true or false`)
    return resolveHostAuth(name, h).map((auth) => ({
      name,
      host: address.orElse(""),
      port: num(h.port).orElse(defaultPort),
      user: str(h.user).or(defaultUser),
      auth,
      tmuxSession: str(h.tmux_session).orElse(defaultSession),
      logOutput: h.log_output === true,
    }))
  }

  const audit = parseAudit(raw)
  const results = rawHosts.map(parseHost)
  const errors = [audit, ...results].flatMap((r) =>
    r.fold<string[]>(
      (msg) => [msg],
      () => [],
    ),
  )
  const hosts = results.flatMap((r) =>
    r.fold<HostEntry[]>(
      () => [],
      (entry) => [entry],
    ),
  )

  return errors.length > 0
    ? Left<string, Fleet>(`Fleet config errors:\n${List(errors).toArray().join("\n")}`)
    : Right<string, Fleet>({ hosts, pool: parsePool(raw), audit: audit.orElse({ path: DEFAULT_AUDIT_PATH }) })
}
