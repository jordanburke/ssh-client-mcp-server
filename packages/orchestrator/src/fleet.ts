import { type ResolveAuthOptions, validateSession } from "@ssh-mcp/core"
import { type Either, Left, List, Option, Right, Try } from "functype"
import { parse as parseToml } from "smol-toml"

export type HostEntry = Readonly<{
  name: string
  host: string
  port: number
  user: Option<string>
  auth: ResolveAuthOptions
  tmuxSession: string
}>

export type PoolSettings = Readonly<{ maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }>

export type Fleet = Readonly<{ hosts: HostEntry[]; pool: PoolSettings }>

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

  const seen = new Set<string>()
  const errors: string[] = []
  const hosts: HostEntry[] = []

  for (const h of rawHosts) {
    const name = str(h.name).orElse("")
    if (!validateSession(name).isRight()) {
      errors.push(`invalid host name "${name}": only letters, digits, hyphen, underscore`)
      continue
    }
    if (seen.has(name)) {
      errors.push(`duplicate host name "${name}"`)
      continue
    }
    seen.add(name)
    const address = str(h.host)
    if (address.isNone()) {
      errors.push(`host "${name}": missing host address`)
      continue
    }
    resolveHostAuth(name, h).fold(
      (msg) => errors.push(msg),
      (auth) =>
        hosts.push({
          name,
          host: address.orElse(""),
          port: num(h.port).orElse(defaultPort),
          user: str(h.user).or(defaultUser),
          auth,
          tmuxSession: str(h.tmux_session).orElse(defaultSession),
        }),
    )
  }

  return errors.length > 0
    ? Left<string, Fleet>(`Fleet config errors:\n${List(errors).toArray().join("\n")}`)
    : Right<string, Fleet>({ hosts, pool: parsePool(raw) })
}
