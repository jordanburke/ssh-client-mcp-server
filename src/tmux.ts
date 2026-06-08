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
