import { validateSession } from "@ssh-mcp/core"
import { type Either, Left, List, Option, Right } from "functype"
import { Platform } from "functype-os"

export { resolveAuth, type ResolveAuthOptions } from "@ssh-mcp/core"

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
    config["tmux-session"] !== undefined
      ? validateSession(config["tmux-session"]).fold(
          (msg) => Option(`Invalid --tmux-session: ${msg}`),
          (_) => Option.none<string>(),
        )
      : Option.none<string>(),
  ).flatMap((o) => o.toList())

  return errors.isEmpty
    ? Right<string, void>(undefined)
    : Left<string, void>(`Configuration error:\n${errors.toArray().join("\n")}`)
}
