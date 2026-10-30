import { readFileSync } from "node:fs"

import { type CommandResult } from "@ssh-mcp/core"
import { type Either, Left, type Map, Option, Right, Try } from "functype"

import { type Auditor } from "./audit.js"
import { type Fleet, type HostEntry } from "./fleet.js"
import { ALLOW } from "./policy.js"
import { type FleetRunner } from "./runners.js"
import { enrollLine, hostAddress } from "./setup.js"

export type CheckDeps = Readonly<{
  fleet: Fleet
  configPath: string
  runner: Pick<FleetRunner, "exec">
  auditor: Auditor
  // CAs whose key_file is missing: their hosts fail without a connection attempt.
  missingKeyCas: ReadonlyArray<string>
  caPublicKeys: Map<string, string>
  out: (line: string) => void
}>

// check never creates a config: a missing one is reported, not written.
export const readCheckConfig = (path: string): Either<string, string> =>
  Try(() => readFileSync(path, "utf8")).fold(
    (e) =>
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? Left(
            `No fleet config at ${path}. Start the server once to create one at the default path, or pass --config=.`,
          )
        : Left(`Cannot read fleet config at ${path}: ${(e as Error).message}`),
    (raw) => Right(raw),
  )

// Its own runtime dir, so a running server's hub.lock doesn't block a check.
export const checkRuntimeDir = (runtimeDir: string): string => `${runtimeDir}-check`

type Outcome = Readonly<{ ok: boolean; detail: string }>

const outcomeOf = (r: CommandResult, startedAt: number): Outcome =>
  r.code === 0
    ? { ok: true, detail: `${Date.now() - startedAt} ms` }
    : { ok: false, detail: r.stderr.trim() || `exit ${r.code}` }

// Runs `true` on every host as the operator and prints one line per host as each finishes. Policy is
// not evaluated: this is a terminal probe, not an agent call, and every probe is audited with
// bypass = "policy". Resolves to the process exit code.
export const runCheck = async (deps: CheckDeps): Promise<number> => {
  const { fleet, out } = deps
  if (fleet.hosts.length === 0) {
    out(`No hosts configured; add a [[hosts]] entry to ${deps.configPath}.`)
    return 0
  }
  const width = Math.max(...fleet.hosts.map((h) => h.name.length))
  const addrWidth = Math.max(...fleet.hosts.map((h) => hostAddress(h).length))
  const line = (h: HostEntry, o: Outcome): string =>
    [
      (o.ok ? "ok" : "FAIL").padEnd(5),
      h.name.padEnd(width),
      hostAddress(h).padEnd(addrWidth),
      h.authKind.padEnd(12),
      o.detail,
    ].join(" ")

  const probe = async (h: HostEntry): Promise<Outcome> => {
    if (h.ca.exists((name) => deps.missingKeyCas.includes(name)))
      return { ok: false, detail: "key_file missing: the server creates it on first start" }
    const startedAt = Date.now()
    return deps.auditor
      .audited(
        { agent: "operator", tool: "check", host: Option(h.name), fields: { bypass: "policy" }, verdict: ALLOW },
        () => deps.runner.exec(h.name, "true", "operator"),
        (r) => ({ code: r.code }),
      )
      .then(
        (r) => outcomeOf(r, startedAt),
        (e: unknown) => ({ ok: false, detail: (e as Error).message }),
      )
  }

  const outcomes = await Promise.all(
    fleet.hosts.map((h) =>
      probe(h).then((o) => {
        out(line(h, o))
        return o
      }),
    ),
  )
  fleet.cas.forEach((c) =>
    deps.caPublicKeys.get(c.name).forEach((pub) => out(`CA ${c.name}: ${enrollLine(c.principal, pub)}`)),
  )
  return outcomes.every((o) => o.ok) ? 0 : 1
}
