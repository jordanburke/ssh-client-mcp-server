import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { childEnv, type ProcessRunner } from "@ssh-mcp/core"
import { Either, Left, Option, Right, Try } from "functype"
import { Path } from "functype-os"

import { type CaEntry } from "./fleet.js"
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

// Creates the key for each CA whose key_file is configured and missing (ENOENT only). Anything else at
// that path, including a symlink or a file with the wrong mode, is left for the key_file checks at
// custody start to report. key_cmd and key_env never create anything. Returns the created CAs' names.
export const ensureCaKeyFiles = async (
  cas: ReadonlyArray<CaEntry>,
  proc: ProcessRunner,
): Promise<Either<string, ReadonlyArray<string>>> => {
  const created = await Either.traverseAsync(cas, async (ca): Promise<Either<string, ReadonlyArray<string>>> => {
    if (ca.key.kind !== "file") return Right([])
    const expanded = Path.expand(ca.key.path)
    if (expanded.isLeft()) return Left(`CA "${ca.name}": key_file ${ca.key.path}: ${expanded.value.message}`)
    const path = expanded.value
    const missing = await lstat(path).then(
      () => false,
      (e: unknown) => isCode(e, "ENOENT"),
    )
    if (!missing) return Right([])
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
