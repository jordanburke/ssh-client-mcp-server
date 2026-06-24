import { type Either, Left, Right } from "functype"
import {
  type CommandResult,
  type ConnectFactory,
  createPool,
  type HostStatus,
  resolveAuth,
  type TmuxRunner,
} from "@ssh-mcp/core"
import { type ConnectConfig } from "ssh2"

import { type Fleet, type HostEntry } from "./fleet.js"

export type FleetRunner = Readonly<{
  hostNames: string[]
  tmuxRunnerFor: (host: string) => Either<string, TmuxRunner>
  exec: (host: string, command: string) => Promise<CommandResult>
  sessionFor: (host: string) => string
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
  const resolved: Array<{ name: string; sshConfig: ConnectConfig }> = []
  const sessions = new Map<string, string>()
  for (const h of fleet.hosts) {
    const cfg = await toSshConfig(h)
    if (cfg.isLeft()) return Left<string, FleetRunner>(`host "${h.name}": ${cfg.value}`)
    resolved.push({ name: h.name, sshConfig: cfg.value })
    sessions.set(h.name, h.tmuxSession)
  }

  const pool = createPool(resolved, fleet.pool, connect)
  const names = new Set(resolved.map((r) => r.name))

  return Right<string, FleetRunner>({
    hostNames: [...names],
    sessionFor: (host) => sessions.get(host) ?? "agent",
    tmuxRunnerFor: (host) =>
      names.has(host)
        ? Right<string, TmuxRunner>((command) => pool.run(host, command))
        : Left<string, TmuxRunner>(`unknown host "${host}" — configured: ${[...names].join(", ")}`),
    exec: (host, command) => pool.run(host, command),
    status: () => pool.status(),
    shutdown: () => pool.shutdown(),
  })
}
