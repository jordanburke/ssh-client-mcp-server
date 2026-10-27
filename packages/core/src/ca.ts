import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"

import type { Option } from "functype"
import { Either, Left, Map, Right, Try } from "functype"

import { type Child, childEnv, type Env, type ProcessRunner } from "./proc.js"

// Where a CA's private key comes from at startup; the orchestrator builds these from config.
export type CaKeySource = Readonly<{ name: string; key: () => Promise<Either<string, string>> }>

export type Custody = Readonly<{
  runtimeDir: string
  agentSock: string
  pubPath: (ca: string) => Option<string>
  shutdown: () => Promise<void>
}>

// A passphrase-protected key must fail at once, with or without a terminal, never wait for input.
const NO_PROMPT: Env = { SSH_ASKPASS: "/bin/false", SSH_ASKPASS_REQUIRE: "force" }

// `-?` makes each tool print usage and exit; a bare `ssh-agent` would start an agent.
const PROBES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["ssh", ["-V"]],
  ["ssh-keygen", ["-?"]],
  ["ssh-agent", ["-?"]],
  ["ssh-add", ["-?"]],
]

export const checkOpenSsh = async (proc: ProcessRunner): Promise<Either<string, void>> => {
  const present = await Promise.all(
    PROBES.map(([cmd, args]) =>
      proc.run(cmd, args, { env: childEnv() }).then(
        () => true,
        () => false,
      ),
    ),
  )
  const missing = PROBES.filter((_, i) => !present[i]).map(([cmd]) => cmd)
  return missing.length === 0
    ? Right<string, void>(undefined)
    : Left<string, void>(`OpenSSH binaries missing: ${missing.join(", ")}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = (check: () => boolean, deadline: number): Promise<boolean> =>
  check()
    ? Promise.resolve(true)
    : Date.now() > deadline
      ? Promise.resolve(false)
      : sleep(50).then(() => waitFor(check, deadline))

const alive = (pid: number): boolean =>
  Try(() => process.kill(pid, 0)).fold(
    () => false,
    () => true,
  )

const isStale = (f: string): boolean =>
  f === "agent.sock" ||
  f === "agent.pid" ||
  /^m-.*\.(sock|pid)$/.test(f) ||
  f.startsWith("k-") ||
  /^ca-.*\.pub$/.test(f)

// Holds the PID of the hub using the runtime dir, so a second hub can't mistake it for a crash.
const LOCK = "hub.lock"

// Every file a hub creates in its runtime dir; anything else there belongs to someone else.
const isOwn = (f: string): boolean => f === LOCK || isStale(f)

const readPid = (path: string): number => Try(() => Number(readFileSync(path, "utf8").trim())).orElse(Number.NaN)

const isLive = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && alive(pid)

// Kills `pid` only if `ps` shows `program` running on `sock`, a path inside this hub's runtime dir.
// A reused PID, or the operator's own ssh or ssh-agent, can't match. `args` rather than `comm`:
// macOS prints `comm` as a full path, and OpenSSH may retitle a master `ssh: <sock> [mux]`.
const killIfOurs = async (pid: number, program: string, sock: string, proc: ProcessRunner): Promise<void> => {
  if (!isLive(pid)) return
  const ps = await proc
    .run("ps", ["-ww", "-p", String(pid), "-o", "args="], { env: childEnv() })
    .catch(() => ({ code: 1, stdout: "", stderr: "" }))
  const args = ps.stdout.trim()
  const argv0 = basename(args.split(" ")[0] ?? "").replace(/:$/, "")
  if (ps.code !== 0 || argv0 !== program || !args.includes(sock)) return
  Try(() => process.kill(pid, "SIGTERM"))
  await waitFor(() => !alive(pid), Date.now() + 2000)
}

// A previous run that crashed leaves its agent running (holding the CA key), its masters running
// (holding authenticated sessions to fleet hosts), and its sockets behind; ssh-agent refuses an
// existing socket path. Kill what is still ours, then clear the files.
const recover = async (dir: string, proc: ProcessRunner): Promise<void> => {
  await killIfOurs(readPid(join(dir, "agent.pid")), "ssh-agent", join(dir, "agent.sock"), proc)
  const masterPids = readdirSync(dir).filter((f) => /^m-.*\.pid$/.test(f))
  await Promise.all(
    masterPids.map((f) => killIfOurs(readPid(join(dir, f)), "ssh", join(dir, f.replace(/\.pid$/, ".sock")), proc)),
  )
  readdirSync(dir)
    .filter(isStale)
    .forEach((f) => Try(() => unlinkSync(join(dir, f))))
}

// Creates the runtime dir, or takes over an existing one only if it holds nothing but hub files:
// the hub chmods it and deletes its own files from it, so it must not be anyone else's directory.
const prepare = (dir: string): Either<string, void> =>
  Try(() => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return readdirSync(dir).filter((f) => !isOwn(f))
  }).fold(
    (e) => Left<string, void>(`runtime_dir ${dir}: ${e.message}`),
    (foreign) =>
      foreign.length > 0
        ? Left<string, void>(
            `runtime_dir ${dir} holds files the hub did not create (${foreign.slice(0, 3).join(", ")}); give runtime_dir a directory of its own`,
          )
        : Try(() => chmodSync(dir, 0o700)).fold(
            (e) => Left<string, void>(`runtime_dir ${dir}: ${e.message}`),
            () => Right<string, void>(undefined),
          ),
  )

// One hub per runtime dir: a second would take the first's agent and masters for a crash's leftovers.
const lock = (dir: string): Either<string, void> => {
  const path = join(dir, LOCK)
  const holder = readPid(path)
  if (isLive(holder))
    return Left<string, void>(
      `runtime_dir ${dir} is in use by pid ${holder}; give each hub its own runtime_dir (delete ${path} if that process is not a hub)`,
    )
  return Try(() => {
    Try(() => unlinkSync(path))
    writeFileSync(path, String(process.pid), { mode: 0o600, flag: "wx" })
  }).fold(
    (e) => Left<string, void>(`runtime_dir ${dir}: can't take ${LOCK}: ${e.message}`),
    () => Right<string, void>(undefined),
  )
}

// Deletes the hub's own files, lock included, and the dir itself once nothing else is left in it.
const release = (dir: string): void => {
  Try(() => readdirSync(dir))
    .orElse([])
    .filter(isOwn)
    .forEach((f) => Try(() => unlinkSync(join(dir, f))))
  Try(() => rmdirSync(dir))
}

const VALID_CA_NAME = /^[\w-]+$/

// Public keys the agent holds, one per line; empty when it holds none (ssh-add -L exits 1 then).
const listKeys = async (agentSock: string, proc: ProcessRunner): Promise<ReadonlyArray<string>> => {
  const r = await proc.run("ssh-add", ["-L"], { env: childEnv({ SSH_AUTH_SOCK: agentSock }) })
  return r.code === 0 ? r.stdout.split("\n").filter((line) => line.startsWith("ssh-")) : []
}

const loadCa = async (
  ca: CaKeySource,
  dir: string,
  agentSock: string,
  proc: ProcessRunner,
): Promise<Either<string, readonly [string, string]>> => {
  const fail = (step: string, detail: string) =>
    Left<string, readonly [string, string]>(`CA "${ca.name}": ${step} failed: ${detail.trim()}`)
  // The name becomes a file name in the runtime dir.
  if (!VALID_CA_NAME.test(ca.name)) return fail("naming", "use letters, digits, hyphen or underscore")
  const key = await ca.key()
  if (key.isLeft()) return fail("reading the key", key.value)
  const agentEnv = childEnv({ ...NO_PROMPT, SSH_AUTH_SOCK: agentSock })
  const before = await listKeys(agentSock, proc)
  // The private key reaches OpenSSH on stdin only; it is never written to disk. (`ssh-keygen -y -f
  // /dev/stdin` can't be used: Node gives children a socket, not a pipe, and /dev/stdin won't open.)
  const add = await proc.run("ssh-add", ["-"], { env: agentEnv, input: key.value })
  if (add.code !== 0) return fail("loading into the agent", add.stderr)
  // The CA's public key is the one line the agent gained, so it always matches what the agent signs with.
  const added = (await listKeys(agentSock, proc)).filter((line) => !before.includes(line))
  if (added.length !== 1) return fail("loading into the agent", "the key is already loaded for another CA")
  const pubPath = join(dir, `ca-${ca.name}.pub`)
  writeFileSync(pubPath, `${added[0]}\n`, { mode: 0o600 })
  return Right<string, readonly [string, string]>([ca.name, pubPath])
}

const stopAgent = async (agent: Child): Promise<void> => {
  agent.kill()
  await Promise.race([new Promise<void>((resolve) => agent.onExit(() => resolve())), sleep(2000)])
}

// Starts a private ssh-agent in `runtimeDir` and loads every CA key into it. On any failure the agent
// is stopped and its files removed, so a failed start never leaves a key behind.
export const startCaCustody = async (
  runtimeDir: string,
  cas: ReadonlyArray<CaKeySource>,
  proc: ProcessRunner,
): Promise<Either<string, Custody>> => {
  const ready = prepare(runtimeDir).flatMap(() => lock(runtimeDir))
  if (ready.isLeft()) return Left<string, Custody>(ready.value)
  await recover(runtimeDir, proc)

  const agentSock = join(runtimeDir, "agent.sock")
  const agent = proc.spawn("ssh-agent", ["-D", "-a", agentSock], { env: childEnv() })
  const up = await waitFor(() => existsSync(agentSock) || agent.exited(), Date.now() + 5000)
  if (!up || agent.exited()) {
    await stopAgent(agent)
    release(runtimeDir)
    return Left<string, Custody>(`ssh-agent failed to start: ${agent.stderr().trim() || "timed out"}`)
  }
  const pid = agent.pid()
  if (pid !== undefined) writeFileSync(join(runtimeDir, "agent.pid"), String(pid), { mode: 0o600 })

  const loaded = await Either.traverseAsync(cas, (ca) => loadCa(ca, runtimeDir, agentSock, proc))
  if (loaded.isLeft()) {
    await stopAgent(agent)
    release(runtimeDir)
    return Left<string, Custody>(loaded.value)
  }
  const pubs = Map.of(...loaded.value.map(([name, path]): [string, string] => [name, path]))

  return Right<string, Custody>({
    runtimeDir,
    agentSock,
    pubPath: (ca) => pubs.get(ca),
    shutdown: async () => {
      await stopAgent(agent)
      release(runtimeDir)
    },
  })
}

export type MintRequest = Readonly<{ ca: string; agent: string; principal: string; sourceAddress: Option<string> }>

// An ephemeral key and the certificate the CA signed for it. `dispose` deletes both and is safe to repeat.
export type Minted = Readonly<{
  keyPath: string
  certPath: string
  validUntil: Date
  serial: string
  dispose: () => Promise<void>
}>

const VALIDITY_MS = 10 * 60 * 1000

// OpenSSH binds a control socket at `<path>.<16 random chars>` before renaming it, so the usable
// length is the platform limit minus 17: 90 bytes on Linux (108), 86 on macOS (104).
const MAX_SOCKET_PATH = 86

// Each master adds `-<4 hex>` before `.sock` (see openssh.ts), so two masters never share a path.
const MASTER_SUFFIX = 5

export const socketPathFor = (runtimeDir: string, agent: string, host: string): Either<string, string> => {
  const digest = createHash("sha256").update(`${agent}\0${host}`).digest("hex").slice(0, 12)
  const path = join(runtimeDir, `m-${digest}.sock`)
  return Buffer.byteLength(path) + MASTER_SUFFIX <= MAX_SOCKET_PATH
    ? Right<string, string>(path)
    : Left<string, string>(
        `runtime_dir ${runtimeDir} is too long for control sockets (socket paths must be at most ${MAX_SOCKET_PATH} bytes)`,
      )
}

// Strictly increasing without stored state: microseconds since the epoch, bumped past the last
// serial when calls land in the same millisecond. Keeps a key revocation list possible later.
const serials = { last: 0n }

export const nextSerial = (nowMs: number): bigint => {
  const candidate = BigInt(nowMs) * 1000n
  serials.last = candidate > serials.last ? candidate : serials.last + 1n
  return serials.last
}

const certOptions = (sourceAddress: Option<string>): ReadonlyArray<string> => [
  "-O",
  "no-port-forwarding",
  "-O",
  "no-agent-forwarding",
  "-O",
  "no-x11-forwarding",
  "-O",
  "no-user-rc",
  ...sourceAddress.fold<string[]>(
    () => [],
    (cidr) => ["-O", `source-address=${cidr}`],
  ),
]

// Generates an ephemeral ed25519 key in the runtime dir and has the CA, held in the private agent,
// sign a ten-minute certificate for it naming the agent.
export const mint = async (
  custody: Custody,
  req: MintRequest,
  proc: ProcessRunner,
  now: () => Date = () => new Date(),
): Promise<Either<string, Minted>> => {
  const fail = (step: string, detail: string) =>
    Left<string, Minted>(`CA "${req.ca}": ${step} failed: ${detail.trim()}`)
  const caPub = custody.pubPath(req.ca)
  if (caPub.isNone()) return fail("signing", `no CA named "${req.ca}" in custody`)

  const keyPath = join(custody.runtimeDir, `k-${randomBytes(8).toString("hex")}`)
  const certPath = `${keyPath}-cert.pub`
  const files = [keyPath, `${keyPath}.pub`, certPath]
  const dispose = (): Promise<void> => {
    files.forEach((f) => Try(() => unlinkSync(f)))
    return Promise.resolve()
  }

  const gen = await proc.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", keyPath], {
    env: childEnv(),
  })
  if (gen.code !== 0) {
    await dispose()
    return fail("key generation", gen.stderr)
  }

  const at = now()
  const serial = nextSerial(at.getTime())
  const sign = await proc.run(
    "ssh-keygen",
    [
      "-U",
      "-s",
      caPub.orElse(""),
      "-I",
      req.agent,
      "-n",
      req.principal,
      "-V",
      "-5m:+10m",
      "-z",
      serial.toString(),
      ...certOptions(req.sourceAddress),
      `${keyPath}.pub`,
    ],
    { env: childEnv({ SSH_AUTH_SOCK: custody.agentSock }) },
  )
  if (sign.code !== 0) {
    await dispose()
    return fail("signing", sign.stderr)
  }
  return Right<string, Minted>({
    keyPath,
    certPath,
    validUntil: new Date(at.getTime() + VALIDITY_MS),
    serial: serial.toString(),
    dispose,
  })
}
