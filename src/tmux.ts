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
