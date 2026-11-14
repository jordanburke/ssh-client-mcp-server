import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

import {
  checkOpenSsh,
  type Custody,
  nodeProcessRunner,
  type ProcessRunner,
  socketPathFor,
  startCaCustody,
} from "@ssh-mcp/core"
import { Either, Left, Map, Option, Right, Try } from "functype"
import { Path } from "functype-os"

import { checkRuntimeDir } from "./check.js"
import { type CaEntry, type Fleet } from "./fleet.js"
import { caKeySource, type CaWiring, defaultKnownHosts, defaultRuntimeDir, selfTestCas } from "./runners.js"
import { ensureCaKeyFiles } from "./setup.js"

export type CaStart = Readonly<{ wiring: Option<CaWiring>; created: ReadonlyArray<string> }>

// The side effects startCa needs, so tests can run it without OpenSSH or an agent.
export type CaStartDeps = Readonly<{
  proc: ProcessRunner
  checkOpenSsh: () => Promise<Either<string, void>>
  ensureKeyFiles: (cas: ReadonlyArray<CaEntry>) => Promise<Either<string, ReadonlyArray<string>>>
  makeDir: (dir: string) => void
  startCustody: (runtimeDir: string, cas: ReadonlyArray<CaEntry>) => Promise<Either<string, Custody>>
  selfTest: (custody: Custody, cas: ReadonlyArray<CaEntry>) => Promise<Either<string, void>>
  log: (line: string) => void
}>

export const nodeCaStartDeps: CaStartDeps = {
  proc: nodeProcessRunner,
  checkOpenSsh: () => checkOpenSsh(nodeProcessRunner),
  ensureKeyFiles: (cas) => ensureCaKeyFiles(cas, nodeProcessRunner),
  makeDir: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  startCustody: (runtimeDir, cas) =>
    startCaCustody(
      runtimeDir,
      cas.map((c) => caKeySource(c)),
      nodeProcessRunner,
    ),
  selfTest: (custody, cas) => selfTestCas(custody, cas, nodeProcessRunner),
  log: (line) => console.error(line),
}

const expanded = (path: string): Either<string, string> =>
  Path.expand(path).fold(
    (e) => Left<string, string>(`invalid path ${path}: ${e.message}`),
    (p) => Right<string, string>(p),
  )

const NO_CA: CaStart = { wiring: Option.none<CaWiring>(), created: [] }

// When any [[cas]] entry exists (with or without hosts using it yet): check OpenSSH, check the runtime
// dir, create any missing key_file, prepare known_hosts, and load every CA key into a private
// ssh-agent. The checks that write nothing come first, so a failed start creates no key. `check`
// creates nothing and uses its own runtime dir. A Left means startup must stop; no agent is left
// running behind it.
export const startCa = async (
  fleet: Fleet,
  mode: "serve" | "check",
  deps: CaStartDeps = nodeCaStartDeps,
): Promise<Either<string, CaStart>> => {
  if (fleet.cas.length === 0) return Right<string, CaStart>(NO_CA)
  const openssh = await deps.checkOpenSsh()
  if (openssh.isLeft()) return Left<string, CaStart>(openssh.value)
  const configured = fleet.runtimeDir.fold(() => Right<string, string>(defaultRuntimeDir()), expanded)
  if (configured.isLeft()) return Left<string, CaStart>(configured.value)
  const runtimeDir = mode === "check" ? checkRuntimeDir(configured.value) : configured.value
  const hosts = fleet.knownHosts.fold(() => Right<string, string>(defaultKnownHosts()), expanded)
  if (hosts.isLeft()) return Left<string, CaStart>(hosts.value)
  const knownHosts = hosts.value
  // Socket paths are fixed-length below runtimeDir, so one check covers every (agent, host).
  const socket = socketPathFor(runtimeDir, "unknown", "host")
  if (socket.isLeft()) return Left<string, CaStart>(socket.value)

  const made = mode === "serve" ? await deps.ensureKeyFiles(fleet.cas) : Right<string, ReadonlyArray<string>>([])
  if (made.isLeft()) return Left<string, CaStart>(made.value)
  const created = made.value
  fleet.cas
    .filter((c) => created.includes(c.name))
    .forEach((c) =>
      deps.log(
        `created CA "${c.name}" key at ${c.key.kind === "file" ? c.key.path : ""}; add its line to each host (see fleet_setup)`,
      ),
    )

  const dir = Try(() => deps.makeDir(dirname(knownHosts)))
  if (dir.isFailure()) return Left<string, CaStart>(`cannot create ${dirname(knownHosts)}: ${dir.error.message}`)
  const custody = await deps.startCustody(runtimeDir, fleet.cas)
  if (custody.isLeft()) return Left<string, CaStart>(custody.value)
  // Mint and discard one certificate per CA: a CA that can't sign stops startup now, not every call.
  const tested = await deps.selfTest(custody.value, fleet.cas)
  if (tested.isLeft()) {
    await custody.value.shutdown()
    return Left<string, CaStart>(tested.value)
  }
  return Right<string, CaStart>({
    wiring: Option<CaWiring>({ custody: custody.value, proc: deps.proc, knownHosts }),
    created,
  })
}

// The public key of every CA in custody, for its enroll line. Custody writes each `.pub` itself
// while loading the key, so one it can't read means something is wrong now: a Left stops startup
// rather than leaving a CA with no line to add.
export const caPublicKeys = (
  cas: ReadonlyArray<CaEntry>,
  ca: Option<CaWiring>,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Either<string, Map<string, string>> =>
  ca.fold(
    () => Right<string, Map<string, string>>(Map.of<string, string>()),
    (wiring) =>
      Either.traverse(cas, (c) =>
        wiring.custody.pubPath(c.name).fold(
          () => Left<string, readonly [string, string]>(`CA "${c.name}": custody has no public key for it`),
          (path) =>
            Try(() => read(path)).fold(
              (e) => Left<string, readonly [string, string]>(`CA "${c.name}": cannot read ${path}: ${e.message}`),
              (pub) => Right<string, readonly [string, string]>([c.name, pub.trim()]),
            ),
        ),
      ).map((pairs) => Map.of(...pairs.map(([k, v]): [string, string] => [k, v]))),
  )
