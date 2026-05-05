import { type Either, Left, List, Option, Right } from "functype"
import { Fs, Path, Platform } from "functype-os"
import { type ConnectConfig } from "ssh2"

export type ArgvConfig = Readonly<Record<string, string>>

export const parseArgv = (args: ReadonlyArray<string>): ArgvConfig =>
  List(args).fold<Record<string, string>>({}, (acc, arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    return match ? { ...acc, [match[1]]: match[2] } : acc
  })

// If --user is omitted, fall back to the OS-reported username (`whoami`-style).
export const effectiveUser = (argv: ArgvConfig): Option<string> =>
  Option(argv.user).or(Platform.userInfo().map((info) => info.username))

export const validateConfig = (config: ArgvConfig): Either<string, void> => {
  const errors = List.of(
    config.host ? Option.none<string>() : Option("Missing required --host"),
    effectiveUser(config).fold(
      () => Option("Missing --user (and OS user unavailable)"),
      (_) => Option.none<string>(),
    ),
    config.port && isNaN(Number(config.port)) ? Option("Invalid --port") : Option.none<string>(),
  ).flatMap((o) => o.toList())

  return errors.isEmpty
    ? Right<string, void>(undefined)
    : Left<string, void>(`Configuration error:\n${errors.toArray().join("\n")}`)
}

export type ResolveAuthOptions = Readonly<{
  password: Option<string>
  keyPath: Option<string>
  keyEnvVar: Option<string>
  useAgent: boolean
}>

// Auth precedence: password → key file → key from env var → ssh-agent → empty.
// Empty surfaces as ssh2's no-auth path, which fails on connect with a clear ssh2 error.
export const resolveAuth = async (options: ResolveAuthOptions): Promise<Either<string, Partial<ConnectConfig>>> => {
  if (options.password.isSome()) {
    return Right<string, Partial<ConnectConfig>>({ password: options.password.value })
  }
  if (options.keyPath.isSome()) {
    const expandResult = Path.expand(options.keyPath.value)
    if (expandResult.isLeft()) {
      return Left<string, Partial<ConnectConfig>>(
        `Invalid SSH key path ${options.keyPath.value}: ${expandResult.value.message}`,
      )
    }
    const expanded = expandResult.value
    const result = await Fs.readFile(expanded)
    return result.fold<Either<string, Partial<ConnectConfig>>>(
      (err) => Left<string, Partial<ConnectConfig>>(`Failed to read SSH key ${expanded}: ${err.message}`),
      (contents) => Right<string, Partial<ConnectConfig>>({ privateKey: contents }),
    )
  }
  if (options.keyEnvVar.isSome()) {
    const varName = options.keyEnvVar.value
    const keyValue = process.env[varName]
    if (!keyValue) {
      return Left<string, Partial<ConnectConfig>>(`--key-env=${varName} but environment variable is not set or empty`)
    }
    return Right<string, Partial<ConnectConfig>>({ privateKey: keyValue })
  }
  if (options.useAgent) {
    const sock = process.env.SSH_AUTH_SOCK
    if (!sock) {
      return Left<string, Partial<ConnectConfig>>(
        "--agent set but SSH_AUTH_SOCK is not set; start ssh-agent or unlock your password manager's SSH agent",
      )
    }
    return Right<string, Partial<ConnectConfig>>({ agent: sock })
  }
  return Right<string, Partial<ConnectConfig>>({})
}
