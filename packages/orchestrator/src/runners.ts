import { lstat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  type CaKeySource,
  type CommandResult,
  type ConnectFactory,
  createPool,
  type Custody,
  type HostStatus,
  mint,
  nodeProcessRunner,
  type Openssh,
  opensshConnect,
  type Pool,
  type ProcessRunner,
  resolveAuth,
  socketPathFor,
  type TmuxRunner,
} from "@ssh-mcp/core"
import { Either, Left, Map, Option, Right, Set } from "functype"
import { Path } from "functype-os"
import { type ConnectConfig } from "ssh2"

import { type CaEntry, type CaKeyRef, type Fleet, type HostEntry } from "./fleet.js"
import { type HostPolicy } from "./policy.js"

export type FleetRunner = Readonly<{
  hostNames: string[]
  tmuxRunnerFor: (host: string, agent: string) => Either<string, TmuxRunner>
  exec: (host: string, command: string, agent: string) => Promise<CommandResult>
  sessionFor: (host: string) => string
  logOutputFor: (host: string) => boolean
  policyFor: (host: string) => Option<HostPolicy>
  status: () => HostStatus[]
  shutdown: () => Promise<void>
}>

// What CA hosts need at runtime. `openFor` replaces the real OpenSSH factory, for tests.
export type CaWiring = Readonly<{
  custody: Custody
  proc: ProcessRunner
  knownHosts: string
  openFor?: (agent: string, host: HostEntry) => Openssh
}>

const stateDir = (): string => join(homedir(), ".local", "state", "ssh-fleet")

export const defaultRuntimeDir = (): string => {
  const xdg = process.env.XDG_RUNTIME_DIR
  return xdg ? join(xdg, "ssh-fleet") : join(stateDir(), "run")
}

export const defaultKnownHosts = (): string => join(stateDir(), "known_hosts")

const fromFile = async (path: string): Promise<Either<string, string>> => {
  const expanded = Path.expand(path)
  if (expanded.isLeft()) return Left<string, string>(`key_file ${path}: ${expanded.value.message}`)
  const file = expanded.value
  const info = await lstat(file).catch((e: unknown) => e as Error)
  if (info instanceof Error) return Left<string, string>(`key_file ${file}: ${info.message}`)
  if (info.isSymbolicLink()) return Left<string, string>(`key_file ${file} is a symlink`)
  if (!info.isFile()) return Left<string, string>(`key_file ${file} is not a regular file`)
  if ((info.mode & 0o077) !== 0) return Left<string, string>(`key_file ${file} must be mode 0600 or stricter`)
  if (info.uid !== process.getuid?.()) return Left<string, string>(`key_file ${file} is not owned by the hub user`)
  return Right<string, string>(await readFile(file, "utf8"))
}

const readCaKey = async (ref: CaKeyRef, timeoutMs: number): Promise<Either<string, string>> => {
  switch (ref.kind) {
    case "cmd": {
      // A secrets-manager CLI may need its own environment (a service token, a keychain session),
      // so key_cmd sees the hub's environment; it is operator config, not an OpenSSH child.
      const env = Object.fromEntries(
        Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
      ) as Readonly<Record<string, string>>
      const r = await nodeProcessRunner
        .run("sh", ["-c", ref.cmd], { env, timeoutMs })
        .catch((e: unknown) => ({ code: -1, stdout: "", stderr: (e as Error).message }))
      return r.code === 0 && r.stdout.trim().length > 0
        ? Right<string, string>(`${r.stdout.trim()}\n`)
        : Left<string, string>(`key_cmd exited ${r.code}: ${r.stderr.trim() || "no output"}`)
    }
    case "env": {
      const value = process.env[ref.name]
      // Read once at startup, then gone, so no later child process inherits the key.
      delete process.env[ref.name]
      return value ? Right<string, string>(value) : Left<string, string>(`environment variable ${ref.name} is not set`)
    }
    case "file":
      return fromFile(ref.path)
  }
}

// key_cmd gets 30 s and no terminal: a command that would prompt fails instead of blocking startup.
export const KEY_CMD_TIMEOUT_MS = 30_000

// Options are an object, not a positional number, so `cas.map(caKeySource)` can't pass an index as a timeout.
export const caKeySource = (entry: CaEntry, opts: Readonly<{ timeoutMs?: number }> = {}): CaKeySource => ({
  name: entry.name,
  key: () => readCaKey(entry.key, opts.timeoutMs ?? KEY_CMD_TIMEOUT_MS),
})

// Mints and discards one certificate per CA, so a CA the agent can't sign with, or a certificate
// option ssh-keygen rejects, stops startup instead of failing every later call.
export const selfTestCas = async (
  custody: Custody,
  cas: ReadonlyArray<CaEntry>,
  proc: ProcessRunner,
): Promise<Either<string, void>> => {
  const tested = await Either.traverseAsync(cas, async (ca) => {
    const minted = await mint(
      custody,
      { ca: ca.name, agent: "self-test", principal: ca.principal, sourceAddress: ca.sourceAddress },
      proc,
    )
    return minted.fold(
      (msg) => Promise.resolve(Left<string, void>(msg)),
      (m) => m.dispose().then(() => Right<string, void>(undefined)),
    )
  })
  return tested.map(() => undefined)
}

const sshConfigFor = (h: HostEntry): ConnectConfig => ({
  host: h.host,
  port: h.port,
  username: h.user.orElse(process.env.USER ?? "root"),
})

const toSshConfig = async (h: HostEntry): Promise<Either<string, ConnectConfig>> => {
  const auth = await resolveAuth(h.auth)
  return auth.map((a) => ({ ...sshConfigFor(h), ...a }))
}

export const buildFleetRunner = async (
  fleet: Fleet,
  connect?: ConnectFactory,
  ca: Option<CaWiring> = Option.none<CaWiring>(),
): Promise<Either<string, FleetRunner>> => {
  // CA hosts never enter the ssh2 pool; they get OpenSSH pools per agent.
  const caHosts = fleet.hosts.filter((h) => h.ca.isSome())
  const sshHosts = fleet.hosts.filter((h) => h.ca.isNone())
  if (caHosts.length > 0 && ca.isNone())
    return Left<string, FleetRunner>(`host "${caHosts[0].name}" uses ca auth but CA custody is not running`)

  const resolved = await Either.traverseAsync(sshHosts, async (h) => {
    const cfg = await toSshConfig(h)
    return cfg.fold(
      (e) => Left<string, { name: string; sshConfig: ConnectConfig }>(`host "${h.name}": ${e}`),
      (sshConfig) => Right<string, { name: string; sshConfig: ConnectConfig }>({ name: h.name, sshConfig }),
    )
  })
  return resolved.map((hosts) => makeRunner(fleet, hosts, caHosts, ca, connect))
}

const realOpenssh = (wiring: CaWiring, caEntry: CaEntry, agent: string, host: HostEntry): Openssh => {
  const socket = socketPathFor(wiring.custody.runtimeDir, agent, host.name)
  return opensshConnect({
    proc: wiring.proc,
    knownHosts: wiring.knownHosts,
    socketPath: socket.orElse(""),
    mintFor: () =>
      socket.fold(
        (msg) => Promise.resolve(Left(msg)),
        () =>
          mint(
            wiring.custody,
            {
              ca: caEntry.name,
              agent,
              principal: host.principal.orElse(caEntry.principal),
              sourceAddress: caEntry.sourceAddress,
            },
            wiring.proc,
          ),
      ),
  })
}

type CaPool = Readonly<{ host: string; agent: string; pool: Pool; openssh: Openssh }>

const makeRunner = (
  fleet: Fleet,
  resolved: ReadonlyArray<{ name: string; sshConfig: ConnectConfig }>,
  caHosts: ReadonlyArray<HostEntry>,
  ca: Option<CaWiring>,
  connect?: ConnectFactory,
): FleetRunner => {
  const sessions = Map.of(...fleet.hosts.map((h): [string, string] => [h.name, h.tmuxSession]))
  const logOutput = Map.of(...fleet.hosts.map((h): [string, boolean] => [h.name, h.logOutput]))
  const policies = Map.of(...fleet.hosts.map((h): [string, HostPolicy] => [h.name, h.policy]))
  const caHostByName = Map.of(...caHosts.map((h): [string, HostEntry] => [h.name, h]))
  const caByName = Map.of(...fleet.cas.map((c): [string, CaEntry] => [c.name, c]))
  const sshPool = createPool(resolved, fleet.pool, connect)
  const names = Set.of(...fleet.hosts.map((h) => h.name))
  // One pool per (agent, CA host), created on first use: an agent never rides another's session.
  const caPools = new globalThis.Map<string, CaPool>()

  const caPoolFor = (host: HostEntry, agent: string, wiring: CaWiring): Pool => {
    const key = `${agent}\0${host.name}`
    const existing = caPools.get(key)
    if (existing !== undefined) return existing.pool
    const caEntry = caByName.get(host.ca.orElse("")).orThrow(new Error(`ca "${host.ca.orElse("")}" is not defined`))
    const openssh = (wiring.openFor ?? ((a, h) => realOpenssh(wiring, caEntry, a, h)))(agent, host)
    const pool = createPool([{ name: host.name, sshConfig: sshConfigFor(host) }], fleet.pool, openssh.connect)
    caPools.set(key, { host: host.name, agent, pool, openssh })
    return pool
  }

  const runOn = (host: string, command: string, agent: string): Promise<CommandResult> =>
    caHostByName.get(host).fold(
      () => sshPool.run(host, command),
      (h) =>
        ca.fold(
          () => Promise.reject(new Error(`host "${host}" uses ca auth but CA custody is not running`)),
          (wiring) => caPoolFor(h, agent, wiring).run(host, command),
        ),
    )

  const caStatus = (): HostStatus[] =>
    caHosts.flatMap((h) => {
      const pools = [...caPools.values()].filter((p) => p.host === h.name)
      return pools.length === 0
        ? [{ name: h.name, state: "disconnected" as const, inFlight: 0 }]
        : pools.flatMap((p) => p.pool.status().map((s) => ({ ...s, name: `${h.name} (${p.agent})` })))
    })

  return {
    hostNames: fleet.hosts.map((h) => h.name),
    sessionFor: (host) => sessions.get(host).orElse("agent"),
    logOutputFor: (host) => logOutput.get(host).orElse(false),
    policyFor: (host) => policies.get(host),
    tmuxRunnerFor: (host, agent) =>
      names.has(host)
        ? Right<string, TmuxRunner>((command) => runOn(host, command, agent))
        : Left<string, TmuxRunner>(`unknown host "${host}" — configured: ${[...names].join(", ")}`),
    exec: (host, command, agent) => runOn(host, command, agent),
    status: () => [...sshPool.status(), ...caStatus()],
    // Pools first (closes connections), then every master is awaited, and only then is the CA
    // agent stopped and the runtime dir removed.
    shutdown: async () => {
      const pools = [...caPools.values()]
      await Promise.all([sshPool.shutdown(), ...pools.map((p) => p.pool.shutdown())])
      await Promise.all(pools.map((p) => p.openssh.shutdown()))
      await ca.fold(
        () => Promise.resolve(),
        (wiring) => wiring.custody.shutdown(),
      )
    },
  }
}
