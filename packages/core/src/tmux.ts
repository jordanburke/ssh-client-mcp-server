import { type Either, Left, Right } from "functype"

/**
 * `signal` is set when a signal ended the command; `code` is then 128 + the signal number, as a shell
 * reports it. `timedOutMs` is set when exec's timeout stopped waiting; `code` is then 124, as
 * `timeout(1)` reports it, and stdout/stderr hold what arrived first.
 */
export type CommandResult = Readonly<{
  stdout: string
  stderr: string
  code: number
  signal?: string
  timedOutMs?: number
  // The channel closed with no exit status (the connection dropped); code is then 255.
  noExitStatus?: true
}>

/** "exit 1", "exit 137 (signal KILL)", "exit 255 (no exit status: channel closed)", or "timed out after 5000 ms". */
export const exitLabel = (r: CommandResult): string => {
  if (r.timedOutMs !== undefined) return `timed out after ${r.timedOutMs} ms`
  if (r.noExitStatus === true) return `exit ${r.code} (no exit status: channel closed)`
  return r.signal === undefined ? `exit ${r.code}` : `exit ${r.code} (signal ${r.signal})`
}

// Every message for a command that ran past its timeout carries this phrase, so callers can label it.
const TIMED_OUT_RE = /\btimed out after \d+ ms\b/

export const isTimedOutMessage = (message: string): boolean => TIMED_OUT_RE.test(message)

export type TmuxRunner = (command: string) => Promise<CommandResult>

const SESSION_RE = /^[A-Za-z0-9_-]+$/

export const validateSession = (name: string): Either<string, string> =>
  SESSION_RE.test(name)
    ? Right<string, string>(name)
    : Left<string, string>(`Invalid session name "${name}": only letters, digits, hyphen, and underscore are allowed`)

// The three argument errors the builders below return. Callers label them as validation errors
// (the caller sent a bad argument), not execution errors (the host failed).
const INPUT_ERROR_PREFIXES = ["Invalid session name ", "Unsupported key ", "No keys provided"] as const

export const isTmuxInputError = (message: string): boolean =>
  INPUT_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))

export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

export const clampLines = (n: number): number => Math.max(1, Math.min(2000, Math.floor(n)))

export const trimTrailingWhitespace = (s: string): string => s.replace(/\s+$/, "")

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "C-c",
  "C-d",
  "C-z",
  "C-l",
  "C-u",
  "C-a",
  "C-e",
  "C-r",
])

export const validateKey = (key: string): Either<string, string> =>
  ALLOWED_KEYS.has(key)
    ? Right<string, string>(key)
    : Left<string, string>(`Unsupported key "${key}": allowed keys are ${[...ALLOWED_KEYS].join(", ")}`)

// A command sent over SSH runs in a non-login shell, so on macOS PATH is only
// /usr/bin:/bin:/usr/sbin:/sbin and Homebrew's tmux (/opt/homebrew/bin, or /usr/local/bin on
// Intel) isn't found. Appending keeps a tmux already on the host's PATH first. PATH is exported,
// so the assignment reaches every tmux in the command.
const TMUX_PATH = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; '

const withTmuxPath = (command: string): string => `${TMUX_PATH}${command}`

export const buildList = (): string => withTmuxPath("tmux list-sessions -F '#{session_name}'")

export const buildSend = (session: string, input: string, submit: boolean): Either<string, string> =>
  validateSession(session).map((s) => {
    // s is interpolated unquoted into -s/-t because SESSION_RE guarantees no shell metacharacters;
    // if that regex is ever relaxed, quoting would be required here.
    //
    // Ensure the session exists WITHOUT attaching: `new-session -A` would attach when the
    // session already exists, which needs a TTY and fails over an SSH exec channel
    // ("open terminal failed: not a terminal"). `has-session || new-session -d` only ever
    // checks-or-creates detached, so it works headlessly on both the first and later sends.
    const ensure = `{ tmux has-session -t ${s} 2>/dev/null || tmux new-session -d -s ${s}; }`
    const send = `tmux send-keys -t ${s} -l -- ${shellQuote(input)}`
    const enter = submit ? ` && tmux send-keys -t ${s} Enter` : ""
    return withTmuxPath(`${ensure} && ${send}${enter}`)
  })

export const buildRead = (session: string, lines: number): Either<string, string> =>
  validateSession(session).map((s) => withTmuxPath(`tmux capture-pane -t ${s} -p -J -S -${clampLines(lines)}`))

export const buildKeys = (session: string, keys: ReadonlyArray<string>): Either<string, string> =>
  validateSession(session).flatMap((s) => {
    if (keys.length === 0) return Left<string, string>("No keys provided")
    const bad = keys.find((k) => validateKey(k).isLeft())
    return bad === undefined
      ? Right<string, string>(withTmuxPath(`tmux send-keys -t ${s} ${keys.join(" ")}`))
      : validateKey(bad)
  })

const TMUX_MISSING_MSG =
  "tmux not found on the remote host — install tmux (e.g. apt/brew install tmux) or use the exec tool instead"

// tmux phrases a missing target differently per subcommand: send-keys says
// "can't find session", capture-pane says "can't find pane". Match both.
const SESSION_MISSING_RE = /can't find session|can't find pane|session not found/i

// No sessions: "no server running" when the socket is stale, and "error connecting to <socket>
// (No such file or directory)" when it doesn't exist yet (tmux 3.4 on Linux, 3.7c on macOS).
const NO_SERVER_RE = /no server running|error connecting to \S+ \(No such file or directory\)/i

export const isTmuxMissing = (r: CommandResult): boolean =>
  r.code === 127 || /tmux: ([Cc]ommand )?not found/i.test(r.stderr)

const failure = (label: string, r: CommandResult): string =>
  r.timedOutMs === undefined ? `${label} failed: ${r.stderr.trim() || exitLabel(r)}` : `${label} ${exitLabel(r)}`

export const interpretList = (r: CommandResult): Either<string, ReadonlyArray<string>> => {
  if (isTmuxMissing(r)) return Left<string, ReadonlyArray<string>>(TMUX_MISSING_MSG)
  if (r.code === 0) {
    return Right<string, ReadonlyArray<string>>(
      r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    )
  }
  if (NO_SERVER_RE.test(r.stderr)) return Right<string, ReadonlyArray<string>>([])
  return Left<string, ReadonlyArray<string>>(failure("tmux list-sessions", r))
}

export const interpretAck =
  (label: string) =>
  (r: CommandResult): Either<string, void> => {
    if (isTmuxMissing(r)) return Left<string, void>(TMUX_MISSING_MSG)
    if (r.code === 0) return Right<string, void>(undefined)
    return Left<string, void>(failure(label, r))
  }

export const interpretRead =
  (session: string) =>
  (r: CommandResult): Either<string, string> => {
    if (isTmuxMissing(r)) return Left<string, string>(TMUX_MISSING_MSG)
    if (r.code === 0) return Right<string, string>(trimTrailingWhitespace(r.stdout))
    if (SESSION_MISSING_RE.test(r.stderr)) {
      return Left<string, string>(`No tmux session "${session}" — list with tmux_list, or tmux_send creates one`)
    }
    return Left<string, string>(failure("tmux capture-pane", r))
  }

export const interpretKeys =
  (session: string) =>
  (r: CommandResult): Either<string, void> => {
    if (isTmuxMissing(r)) return Left<string, void>(TMUX_MISSING_MSG)
    if (r.code === 0) return Right<string, void>(undefined)
    if (SESSION_MISSING_RE.test(r.stderr)) {
      return Left<string, void>(`No tmux session "${session}" — list with tmux_list, or tmux_send creates one`)
    }
    return Left<string, void>(failure("tmux send-keys", r))
  }

export const tmuxList = async (runner: TmuxRunner): Promise<Either<string, ReadonlyArray<string>>> =>
  interpretList(await runner(buildList()))

export const tmuxSend = async (
  runner: TmuxRunner,
  p: Readonly<{ session: string; input: string; submit: boolean }>,
): Promise<Either<string, void>> => {
  const cmd = buildSend(p.session, p.input, p.submit)
  if (cmd.isLeft()) return Left<string, void>(cmd.value)
  return interpretAck("tmux_send")(await runner(cmd.value))
}

export const tmuxRead = async (
  runner: TmuxRunner,
  p: Readonly<{ session: string; lines: number }>,
): Promise<Either<string, string>> => {
  const cmd = buildRead(p.session, p.lines)
  if (cmd.isLeft()) return Left<string, string>(cmd.value)
  return interpretRead(p.session)(await runner(cmd.value))
}

export const tmuxKeys = async (
  runner: TmuxRunner,
  p: Readonly<{ session: string; keys: ReadonlyArray<string> }>,
): Promise<Either<string, void>> => {
  const cmd = buildKeys(p.session, p.keys)
  if (cmd.isLeft()) return Left<string, void>(cmd.value)
  return interpretKeys(p.session)(await runner(cmd.value))
}
