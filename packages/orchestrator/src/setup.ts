import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { type Either, Left, Option, Right, Try } from "functype"

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
