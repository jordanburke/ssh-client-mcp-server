import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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
  f === "agent.sock" || f === "agent.pid" || /^m-.*\.sock$/.test(f) || f.startsWith("k-") || /^ca-.*\.pub$/.test(f)

// A previous run that crashed leaves its agent running (holding the CA key) and its sockets behind;
// ssh-agent refuses an existing socket path and a stale control socket disables multiplexing.
// Kill the old agent only if the PID really is an ssh-agent — a reused PID could be anything.
const recover = async (dir: string, proc: ProcessRunner): Promise<void> => {
  const pid = Try(() => Number(readFileSync(join(dir, "agent.pid"), "utf8").trim())).orElse(Number.NaN)
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    const ps = await proc
      .run("ps", ["-p", String(pid), "-o", "comm="], { env: childEnv() })
      .catch(() => ({ code: 1, stdout: "", stderr: "" }))
    if (ps.code === 0 && ps.stdout.includes("ssh-agent")) {
      Try(() => process.kill(pid, "SIGTERM"))
      await waitFor(() => !alive(pid), Date.now() + 2000)
    }
  }
  readdirSync(dir)
    .filter(isStale)
    .forEach((f) => Try(() => unlinkSync(join(dir, f))))
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
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  chmodSync(runtimeDir, 0o700)
  await recover(runtimeDir, proc)

  const agentSock = join(runtimeDir, "agent.sock")
  const agent = proc.spawn("ssh-agent", ["-D", "-a", agentSock], { env: childEnv() })
  const up = await waitFor(() => existsSync(agentSock) || agent.exited(), Date.now() + 5000)
  if (!up || agent.exited()) {
    await stopAgent(agent)
    return Left<string, Custody>(`ssh-agent failed to start: ${agent.stderr().trim() || "timed out"}`)
  }
  const pid = agent.pid()
  if (pid !== undefined) writeFileSync(join(runtimeDir, "agent.pid"), String(pid), { mode: 0o600 })

  const loaded = await Either.traverseAsync(cas, (ca) => loadCa(ca, runtimeDir, agentSock, proc))
  if (loaded.isLeft()) {
    await stopAgent(agent)
    await recover(runtimeDir, proc)
    return Left<string, Custody>(loaded.value)
  }
  const pubs = Map.of(...loaded.value.map(([name, path]): [string, string] => [name, path]))

  return Right<string, Custody>({
    runtimeDir,
    agentSock,
    pubPath: (ca) => pubs.get(ca),
    shutdown: async () => {
      await stopAgent(agent)
      Try(() => rmSync(runtimeDir, { recursive: true, force: true }))
    },
  })
}
