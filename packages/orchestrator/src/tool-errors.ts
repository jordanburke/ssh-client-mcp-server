import { isTmuxInputError } from "@ssh-mcp/core"
import { UserError } from "somamcp"

// Every failure a host-routed tool reports carries its own label and hints. somamcp guesses a plain
// Error's label from its words, which called an unknown host "internal" and told the model the
// tool's maintainer should investigate.

export const UNKNOWN_HOST_HINT = "Call hosts_list for the configured host names."

const isUnknownHost = (message: string): boolean => message.startsWith("unknown host")

/** A tool result that failed (a bad tmux argument, a tmux error, an exit code): the message says why, so no hints. */
export const resultError = (message: string): UserError => {
  if (isUnknownHost(message)) return new UserError(message, { category: "not_found", suggestions: [UNKNOWN_HOST_HINT] })
  if (isTmuxInputError(message)) return new UserError(message, { category: "validation", suggestions: [] })
  return new UserError(message, { category: "execution", suggestions: [] })
}

/** A call the host's policy refused. */
export const deniedError = (message: string): UserError =>
  new UserError(message, {
    category: "auth",
    suggestions: ["This host's policy doesn't allow it. Use a command or tool the policy allows, or ask the operator."],
  })

/**
 * Labels a runner failure: an unknown host, a busy pool, or a connection that failed.
 * @interop a `.catch` handler for a tool's promise; it rethrows as UserError so the label and hints are ours, not guessed.
 */
export const routedError =
  (host: string) =>
  (e: unknown): never => {
    if (e instanceof UserError) throw e
    // A TypeError or RangeError is a bug in this server, not a host failure: don't send the model to fleet_setup.
    if (e instanceof TypeError || e instanceof RangeError)
      throw new UserError(e.message, { category: "internal", suggestions: [] })
    const message = e instanceof Error ? e.message : String(e)
    if (isUnknownHost(message))
      throw new UserError(message, { category: "not_found", suggestions: [UNKNOWN_HOST_HINT] })
    if (message.includes(" busy: no free connection slot"))
      throw new UserError(message, {
        category: "timeout",
        suggestions: [`Every connection to ${host} is in use. Try again, or raise [pool].max_per_host.`],
      })
    throw new UserError(`[${host}] ${message}`, {
      category: "execution",
      suggestions: [`Call fleet_setup to see ${host}'s connection state and what to configure.`],
    })
  }
