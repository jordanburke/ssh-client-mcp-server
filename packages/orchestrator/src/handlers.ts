import { type CommandResult, execOutput, tmuxKeys, tmuxList, tmuxRead, tmuxSend } from "@ssh-mcp/core"
import { type Either, Option } from "functype"

import { AGENT_UNKNOWN, type AuditCall, type AuditFields, type Auditor, excerpt } from "./audit.js"
import { ALLOW, evaluate, type PolicyRequest, type Verdict } from "./policy.js"
import { type FleetRunner, hostRows } from "./runners.js"
import { type SetupContext, setupReport } from "./setup.js"
import { resultError, routedError, timeoutError } from "./tool-errors.js"

/** @interop a thrown UserError sets the message, category and suggestions the client sees; any other throw gets a label somamcp guesses from its message. */
const unwrap = <T>(result: Either<string, T>): T =>
  result.fold(
    (msg) => {
      throw resultError(msg)
    },
    (value) => value,
  )

const bytes = (s: string): number => Buffer.byteLength(s, "utf8")
const noSummary = (): AuditFields => ({})

// Tool handlers, factored out so they can be unit-tested with a fake FleetRunner.
// Every call is checked against its host's policy and goes through the auditor: a decision line
// before it runs, a result line after. A denied call writes its decision line and never runs.
export const makeHandlers = (runner: FleetRunner, auditor: Auditor, setup: SetupContext) => {
  const call = (tool: string, host: Option<string>, verdict: Verdict, fields: AuditFields = {}): AuditCall => ({
    agent: AGENT_UNKNOWN,
    tool,
    host,
    fields,
    verdict,
  })

  // A host with no policy (an unknown host) gets ALLOW, so it reaches the runner and fails there.
  const gated = (host: string, req: PolicyRequest, fields: AuditFields = {}): AuditCall =>
    call(
      req.tool,
      Option(host),
      runner.policyFor(host).fold(
        () => ALLOW,
        (policy) => evaluate(policy, req),
      ),
      fields,
    )

  // Sizes only, unless the host opts in to an output excerpt with log_output.
  const summarizeExec =
    (host: string) =>
    (r: CommandResult): AuditFields => ({
      code: r.code,
      ...(r.signal === undefined ? {} : { signal: r.signal }),
      ...(r.timedOutMs === undefined ? {} : { timed_out_ms: r.timedOutMs }),
      ...(r.noExitStatus === true ? { no_exit_status: true } : {}),
      stdout_bytes: bytes(r.stdout),
      stderr_bytes: bytes(r.stderr),
      ...(runner.logOutputFor(host) ? { stdout_excerpt: excerpt(r.stdout), stderr_excerpt: excerpt(r.stderr) } : {}),
    })

  return {
    hostsList: (): Promise<string> =>
      auditor.audited(
        call("hosts_list", Option.none<string>(), ALLOW),
        () => Promise.resolve(JSON.stringify(hostRows(runner))),
        noSummary,
      ),
    fleetSetup: (): Promise<string> =>
      auditor.audited(
        call("fleet_setup", Option.none<string>(), ALLOW),
        () => Promise.resolve(JSON.stringify(setupReport(setup, runner))),
        noSummary,
      ),
    /** @interop a thrown UserError sets the message, category and suggestions the client sees; any other throw gets a label somamcp guesses from its message. */
    exec: async ({
      host,
      command,
      timeout_ms,
    }: {
      host: string
      command: string
      timeout_ms?: number
    }): Promise<string> => {
      const r = await auditor
        .audited(
          gated(
            host,
            { tool: "exec", agent: AGENT_UNKNOWN, command },
            { command, ...(timeout_ms === undefined ? {} : { timeout_ms }) },
          ),
          () => runner.exec(host, command, AGENT_UNKNOWN, timeout_ms),
          summarizeExec(host),
        )
        .catch(routedError(host))
      return execOutput(r).fold(
        (failure) => {
          throw r.timedOutMs === undefined ? resultError(`[${host}] ${failure}`) : timeoutError(host, failure)
        },
        (output) => output,
      )
    },
    tmuxList: ({ host }: { host: string }): Promise<string> =>
      auditor
        .audited(
          gated(host, { tool: "tmux_list", agent: AGENT_UNKNOWN }),
          async () => JSON.stringify(unwrap(await tmuxList(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN))))),
          noSummary,
        )
        .catch(routedError(host)),
    tmuxSend: ({
      host,
      session,
      input,
      submit,
    }: {
      host: string
      session?: string
      input: string
      submit?: boolean
    }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      const press = submit ?? true
      return auditor
        .audited(
          gated(host, { tool: "tmux_send", agent: AGENT_UNKNOWN }, { session: target, input, submit: press }),
          async () => {
            unwrap(
              await tmuxSend(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN)), {
                session: target,
                input,
                submit: press,
              }),
            )
            return `[${host}] sent to tmux session "${target}".`
          },
          noSummary,
        )
        .catch(routedError(host))
    },
    tmuxRead: ({ host, session, lines }: { host: string; session?: string; lines?: number }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      const count = lines ?? 200
      return auditor
        .audited(
          gated(host, { tool: "tmux_read", agent: AGENT_UNKNOWN }, { session: target, lines: count }),
          async () =>
            unwrap(
              await tmuxRead(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN)), { session: target, lines: count }),
            ),
          (transcript) => ({ stdout_bytes: bytes(transcript) }),
        )
        .catch(routedError(host))
    },
    tmuxKeys: ({ host, session, keys }: { host: string; session?: string; keys: string[] }): Promise<string> => {
      const target = session ?? runner.sessionFor(host)
      return auditor
        .audited(
          gated(host, { tool: "tmux_keys", agent: AGENT_UNKNOWN }, { session: target, keys }),
          async () => {
            unwrap(await tmuxKeys(unwrap(runner.tmuxRunnerFor(host, AGENT_UNKNOWN)), { session: target, keys }))
            return `[${host}] sent keys [${keys.join(", ")}] to tmux session "${target}".`
          },
          noSummary,
        )
        .catch(routedError(host))
    },
  }
}
