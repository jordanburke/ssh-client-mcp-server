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

export const resolveAuth = async (
  password: Option<string>,
  keyPath: Option<string>,
): Promise<Either<string, Partial<ConnectConfig>>> => {
  if (password.isSome()) {
    return Right<string, Partial<ConnectConfig>>({ password: password.value })
  }
  if (keyPath.isSome()) {
    const expandResult = Path.expand(keyPath.value)
    if (expandResult.isLeft()) {
      return Left<string, Partial<ConnectConfig>>(
        `Invalid SSH key path ${keyPath.value}: ${expandResult.value.message}`,
      )
    }
    const expanded = expandResult.value
    const result = await Fs.readFile(expanded)
    return result.fold<Either<string, Partial<ConnectConfig>>>(
      (err) => Left<string, Partial<ConnectConfig>>(`Failed to read SSH key ${expanded}: ${err.message}`),
      (contents) => Right<string, Partial<ConnectConfig>>({ privateKey: contents }),
    )
  }
  return Right<string, Partial<ConnectConfig>>({})
}
