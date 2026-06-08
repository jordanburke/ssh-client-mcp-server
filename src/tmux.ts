import { type Either, Left, Right } from "functype"

export type CommandResult = Readonly<{ stdout: string; stderr: string; code: number }>

export type TmuxRunner = (command: string) => Promise<CommandResult>

const SESSION_RE = /^[A-Za-z0-9_-]+$/

export const validateSession = (name: string): Either<string, string> =>
  SESSION_RE.test(name)
    ? Right<string, string>(name)
    : Left<string, string>(
        `Invalid session name "${name}": only letters, digits, hyphen, and underscore are allowed`,
      )

export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

export const clampLines = (n: number): number => Math.max(1, Math.min(2000, Math.floor(n)))

export const trimTrailingBlankLines = (s: string): string => s.replace(/\s+$/, "")

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

export const buildList = (): string => "tmux list-sessions -F '#{session_name}'"

export const buildSend = (session: string, input: string, submit: boolean): Either<string, string> =>
  validateSession(session).map((s) => {
    const create = `tmux new-session -A -d -s ${s}`
    const send = `tmux send-keys -t ${s} -l -- ${shellQuote(input)}`
    const enter = submit ? ` && tmux send-keys -t ${s} Enter` : ""
    return `${create} && ${send}${enter}`
  })

export const buildRead = (session: string, lines: number): Either<string, string> =>
  validateSession(session).map((s) => `tmux capture-pane -t ${s} -p -J -S -${clampLines(lines)}`)

export const buildKeys = (session: string, keys: ReadonlyArray<string>): Either<string, string> =>
  validateSession(session).flatMap((s) => {
    if (keys.length === 0) return Left<string, string>("No keys provided")
    const bad = keys.find((k) => validateKey(k).isLeft())
    return bad === undefined
      ? Right<string, string>(`tmux send-keys -t ${s} ${keys.join(" ")}`)
      : Left<string, string>(`Unsupported key "${bad}"`)
  })
