import { type Either, Left, Option, Right, Try } from "functype"

export type PolicyMode = "readonly" | "readwrite" | "deny"
export type TmuxGate = "approve" | "open"

// One parsed `[defaults.policy]` or `[hosts.policy]` table; every key optional.
export type PolicyTable = Readonly<{
  mode: Option<PolicyMode>
  tmux: Option<TmuxGate>
  allow: Option<ReadonlyArray<string>>
  needsApproval: Option<ReadonlyArray<string>>
  agents: Option<ReadonlyArray<string>>
}>

// A host's effective policy. `allow` regexes are wrapped `^(?:…)$`; `needsApproval` match anywhere.
export type HostPolicy = Readonly<{
  mode: PolicyMode
  tmux: TmuxGate
  allow: ReadonlyArray<RegExp>
  needsApproval: ReadonlyArray<RegExp>
  agents: Option<ReadonlyArray<string>>
}>

const MODES: ReadonlyArray<string> = ["readonly", "readwrite", "deny"]
const GATES: ReadonlyArray<string> = ["approve", "open"]
const KEYS: ReadonlyArray<string> = ["mode", "tmux", "allow", "needs_approval", "agents"]

export const EMPTY_TABLE: PolicyTable = {
  mode: Option.none<PolicyMode>(),
  tmux: Option.none<TmuxGate>(),
  allow: Option.none<ReadonlyArray<string>>(),
  needsApproval: Option.none<ReadonlyArray<string>>(),
  agents: Option.none<ReadonlyArray<string>>(),
}

const isTable = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const oneOf = <A extends string>(
  v: unknown,
  values: ReadonlyArray<string>,
  error: string,
): Either<string, Option<A>> => {
  if (v === undefined) return Right<string, Option<A>>(Option.none<A>())
  return typeof v === "string" && values.includes(v) ? Right<string, Option<A>>(Option(v as A)) : Left(error)
}

const strings = (v: unknown, error: string): Either<string, Option<ReadonlyArray<string>>> => {
  if (v === undefined) return Right<string, Option<ReadonlyArray<string>>>(Option.none<ReadonlyArray<string>>())
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? Right<string, Option<ReadonlyArray<string>>>(Option<ReadonlyArray<string>>(v))
    : Left(error)
}

const errorOf = (r: Either<string, unknown>): ReadonlyArray<string> =>
  r.fold(
    (msg) => [msg],
    () => [],
  )

export const parsePolicyTable = (raw: unknown, where: string): Either<ReadonlyArray<string>, PolicyTable> => {
  if (raw === undefined) return Right<ReadonlyArray<string>, PolicyTable>(EMPTY_TABLE)
  if (!isTable(raw)) return Left<ReadonlyArray<string>, PolicyTable>([`${where} must be a table`])

  const mode = oneOf<PolicyMode>(raw.mode, MODES, `${where}.mode must be one of readonly, readwrite, deny`)
  const tmux = oneOf<TmuxGate>(raw.tmux, GATES, `${where}.tmux must be approve or open`)
  const allow = strings(raw.allow, `${where}.allow must be an array of strings`)
  const needsApproval = strings(raw.needs_approval, `${where}.needs_approval must be an array of strings`)
  const agents = strings(raw.agents, `${where}.agents must be an array of strings`)

  const errors = [
    ...Object.keys(raw)
      .filter((k) => !KEYS.includes(k))
      .map((k) => `${where}: unknown key "${k}"`),
    ...[mode, tmux, allow, needsApproval, agents].flatMap(errorOf),
  ]
  return errors.length > 0
    ? Left<ReadonlyArray<string>, PolicyTable>(errors)
    : Right<ReadonlyArray<string>, PolicyTable>({
        mode: mode.orElse(EMPTY_TABLE.mode),
        tmux: tmux.orElse(EMPTY_TABLE.tmux),
        allow: allow.orElse(EMPTY_TABLE.allow),
        needsApproval: needsApproval.orElse(EMPTY_TABLE.needsApproval),
        agents: agents.orElse(EMPTY_TABLE.agents),
      })
}

// An empty list means "not set", once a host's key has replaced the default's.
const nonEmpty = (o: Option<ReadonlyArray<string>>): ReadonlyArray<string> => o.filter((xs) => xs.length > 0).orElse([])

const compile = (
  where: string,
  key: string,
  patterns: ReadonlyArray<string>,
  wrap: (p: string) => string,
): Either<ReadonlyArray<string>, ReadonlyArray<RegExp>> => {
  const results = patterns.map((p) =>
    Try(() => new RegExp(wrap(p))).fold(
      (e) => Left<string, RegExp>(`${where}: invalid regex in ${key}: "${p}" (${(e as Error).message})`),
      (re) => Right<string, RegExp>(re),
    ),
  )
  const errors = results.flatMap(errorOf)
  return errors.length > 0
    ? Left<ReadonlyArray<string>, ReadonlyArray<RegExp>>(errors)
    : Right<ReadonlyArray<string>, ReadonlyArray<RegExp>>(
        results.flatMap((r) =>
          r.fold<RegExp[]>(
            () => [],
            (re) => [re],
          ),
        ),
      )
}

const errorsOf = (r: Either<ReadonlyArray<string>, unknown>): ReadonlyArray<string> =>
  r.fold(
    (errs) => errs,
    () => [],
  )

// Host keys replace default keys (lists are replaced, never concatenated); built-in defaults fill
// the rest, so a config with no policy behaves as before policy existed.
export const resolvePolicy = (
  where: string,
  defaults: PolicyTable,
  host: PolicyTable,
): Either<ReadonlyArray<string>, HostPolicy> => {
  const mode = host.mode.or(defaults.mode).orElse("readwrite")
  const tmux = host.tmux.or(defaults.tmux).orElse("open")
  const allowSrc = nonEmpty(host.allow.or(defaults.allow))
  const needsSrc = nonEmpty(host.needsApproval.or(defaults.needsApproval))
  const agents = nonEmpty(host.agents.or(defaults.agents))

  const allow = compile(where, "allow", allowSrc, (p) => `^(?:${p})$`)
  const needsApproval = compile(where, "needs_approval", needsSrc, (p) => p)
  const errors = [
    ...errorsOf(allow),
    ...errorsOf(needsApproval),
    ...(allowSrc.length > 0 && mode !== "readonly" ? [`${where}: allow applies only to mode = "readonly"`] : []),
    ...(needsSrc.length > 0 && mode !== "readwrite"
      ? [`${where}: needs_approval applies only to mode = "readwrite"`]
      : []),
  ]
  return errors.length > 0
    ? Left<ReadonlyArray<string>, HostPolicy>(errors)
    : Right<ReadonlyArray<string>, HostPolicy>({
        mode,
        tmux,
        allow: allow.orElse([]),
        needsApproval: needsApproval.orElse([]),
        agents: agents.length > 0 ? Option<ReadonlyArray<string>>(agents) : Option.none<ReadonlyArray<string>>(),
      })
}

export type PolicyTool = "exec" | "tmux_list" | "tmux_send" | "tmux_read" | "tmux_keys"

// Only exec carries a command.
export type PolicyRequest =
  | Readonly<{ tool: "exec"; agent: string; command: string }>
  | Readonly<{ tool: Exclude<PolicyTool, "exec">; agent: string }>

// `rule` is the short rule name; the auditor qualifies it with the host.
export type Verdict =
  Readonly<{ decision: "allow"; rule: Option<string> }> | Readonly<{ decision: "deny"; rule: string; reason: string }>

// For host-less tools and unknown hosts: no policy applies.
export const ALLOW: Verdict = { decision: "allow", rule: Option.none<string>() }

const allowBy = (rule: string): Verdict => ({ decision: "allow", rule: Option(rule) })
const denyBy = (rule: string, reason: string): Verdict => ({ decision: "deny", rule, reason })

// Line breaks, NUL, and every character the remote `$SHELL -c` gives meaning to: control
// operators, substitution, redirection, grouping, escapes, quotes, globs and `~`.
const READONLY_REJECT = /[\n\r\0;&|$`()<>{}\\'"*?[~]/

const listed = (agents: ReadonlyArray<string>, agent: string): boolean =>
  agents.some((e) => agent === e || agent.startsWith(`${e}@`))

const evaluateTmuxInput = (policy: HostPolicy): Verdict => {
  if (policy.mode === "readonly") return denyBy("readonly", "tmux input is not allowed on a readonly host")
  return policy.tmux === "approve"
    ? denyBy("tmux", "tmux input requires approval, which is not available yet")
    : allowBy("readwrite")
}

const evaluateExec = (policy: HostPolicy, command: string): Verdict => {
  if (policy.mode === "readonly") {
    if (READONLY_REJECT.test(command)) return denyBy("readonly", "command contains a newline or shell metacharacter")
    return policy.allow.some((re) => re.test(command))
      ? allowBy("readonly")
      : denyBy("readonly", "command not in allow list")
  }
  const tripped = policy.needsApproval.find((re) => re.test(command))
  return tripped === undefined
    ? allowBy("readwrite")
    : denyBy("needs_approval", `matches "${tripped.source}" and needs approval, which is not available yet`)
}

// First match wins: deny mode, then the agents list, then the per-tool rules.
export const evaluate = (policy: HostPolicy, req: PolicyRequest): Verdict => {
  if (policy.mode === "deny") return denyBy("deny", "host is closed by policy")
  if (
    policy.agents.fold(
      () => false,
      (agents) => !listed(agents, req.agent),
    )
  )
    return denyBy("agents", `agent "${req.agent}" is not in agents`)
  if (req.tool === "exec") return evaluateExec(policy, req.command)
  return req.tool === "tmux_send" || req.tool === "tmux_keys" ? evaluateTmuxInput(policy) : allowBy(policy.mode)
}
