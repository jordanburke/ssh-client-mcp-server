import {
  type CommandResult,
  type ConnectFactory,
  createPool,
  type HostStatus,
  resolveAuth,
  type TmuxRunner,
} from "@ssh-mcp/core"
import { Either, Left, Map, type Option, Right, Set } from "functype"
import { type ConnectConfig } from "ssh2"

import { type Fleet, type HostEntry } from "./fleet.js"
import { type HostPolicy } from "./policy.js"

export type FleetRunner = Readonly<{
  hostNames: string[]
  tmuxRunnerFor: (host: string) => Either<string, TmuxRunner>
  exec: (host: string, command: string) => Promise<CommandResult>
  sessionFor: (host: string) => string
  logOutputFor: (host: string) => boolean
  policyFor: (host: string) => Option<HostPolicy>
  status: () => HostStatus[]
  shutdown: () => Promise<void>
}>

const toSshConfig = async (h: HostEntry): Promise<Either<string, ConnectConfig>> => {
  const auth = await resolveAuth(h.auth)
  return auth.map((a) => ({
    host: h.host,
    port: h.port,
    username: h.user.orElse(process.env.USER ?? "root"),
    ...a,
  }))
}

export const buildFleetRunner = async (
  fleet: Fleet,
  connect?: ConnectFactory,
): Promise<Either<string, FleetRunner>> => {
  const resolved = await Either.traverseAsync(fleet.hosts, async (h) => {
    const cfg = await toSshConfig(h)
    return cfg.fold(
      (e) => Left<string, { name: string; sshConfig: ConnectConfig }>(`host "${h.name}": ${e}`),
      (sshConfig) => Right<string, { name: string; sshConfig: ConnectConfig }>({ name: h.name, sshConfig }),
    )
  })
  return resolved.map((hosts) => makeRunner(fleet, hosts, connect))
}

const makeRunner = (
  fleet: Fleet,
  resolved: ReadonlyArray<{ name: string; sshConfig: ConnectConfig }>,
  connect?: ConnectFactory,
): FleetRunner => {
  const sessions = Map.of(...fleet.hosts.map((h): [string, string] => [h.name, h.tmuxSession]))
  const logOutput = Map.of(...fleet.hosts.map((h): [string, boolean] => [h.name, h.logOutput]))
  const policies = Map.of(...fleet.hosts.map((h): [string, HostPolicy] => [h.name, h.policy]))
  const pool = createPool(resolved, fleet.pool, connect)
  const names = Set.of(...resolved.map((r) => r.name))

  return {
    hostNames: [...names],
    sessionFor: (host) => sessions.get(host).orElse("agent"),
    logOutputFor: (host) => logOutput.get(host).orElse(false),
    policyFor: (host) => policies.get(host),
    tmuxRunnerFor: (host) =>
      names.has(host)
        ? Right<string, TmuxRunner>((command) => pool.run(host, command))
        : Left<string, TmuxRunner>(`unknown host "${host}" — configured: ${[...names].join(", ")}`),
    exec: (host, command) => pool.run(host, command),
    status: () => pool.status(),
    shutdown: () => pool.shutdown(),
  }
}
