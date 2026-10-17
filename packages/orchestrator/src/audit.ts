import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, writeSync } from "node:fs"
import { dirname } from "node:path"

import { type Either, Left, type Option, Right, Try, type Wire } from "functype"
import { Path } from "functype-os"
import { UserError } from "somamcp"

export const AGENT_UNKNOWN = "unknown"
export const DEFAULT_AUDIT_PATH = "~/.local/state/ssh-fleet/audit.jsonl"
export const EXCERPT_CHARS = 1024

// Tool-specific fields of an audit line, in the shape written to disk.
export type AuditFields = Wire<Readonly<Record<string, string | number | boolean | ReadonlyArray<string> | undefined>>>

export type AuditCall = Readonly<{ agent: string; tool: string; host: Option<string>; fields: AuditFields }>

// Appends one line to the audit log; throws on failure.
export type AuditSink = (line: string) => void

export type Auditor = Readonly<{
  audited: <A>(call: AuditCall, run: () => Promise<A>, summarize: (a: A) => AuditFields) => Promise<A>
}>

export type AuditDeps = Readonly<{ sink: AuditSink; now: () => Date; newId: () => string }>

// The first EXCERPT_CHARS code points, so a surrogate pair is never split.
export const excerpt = (s: string): string => Array.from(s).slice(0, EXCERPT_CHARS).join("")

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** @interop somamcp reports a tool failure to the client only when the handler throws UserError. */
export const createAuditor = ({ sink, now, newId }: AuditDeps): Auditor => {
  const write = (line: Readonly<Record<string, unknown>>, failure: string): void =>
    Try(() => sink(JSON.stringify(line))).fold(
      (e) => {
        throw new UserError(`audit log write failed ${failure}: ${messageOf(e)}`)
      },
      () => undefined,
    )

  // A decision line is written before the call runs and a result line after it, sharing `id`,
  // so a call that hangs or crashes the server is still on record.
  const audited = async <A>(call: AuditCall, run: () => Promise<A>, summarize: (a: A) => AuditFields): Promise<A> => {
    const id = newId()
    const who = {
      agent: call.agent,
      tool: call.tool,
      ...call.host.fold(
        () => ({}),
        (host) => ({ host }),
      ),
    }
    const started = now()
    write(
      { ts: started.toISOString(), id, event: "decision", ...who, ...call.fields, decision: "allow" },
      "— call not executed",
    )

    const outcome = await Promise.resolve()
      .then(run)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    const finished = now()
    const result = { ts: finished.toISOString(), id, event: "result", ...who }
    const ms = finished.getTime() - started.getTime()

    if (outcome.ok) {
      write({ ...result, status: "ok", ms, ...summarize(outcome.value) }, "after execution")
      return outcome.value
    }
    write({ ...result, status: "error", ms, error: messageOf(outcome.error) }, "after execution")
    throw outcome.error
  }

  return { audited }
}

// Every append reopens the file, so a deleted or rotated log is recreated at 0600; O_NOFOLLOW
// refuses a symlink planted at the path instead of writing through it.
const APPEND_NOFOLLOW = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW

const withAppendFd = (file: string, use: (fd: number) => void): void => {
  const fd = openSync(file, APPEND_NOFOLLOW, 0o600)
  try {
    use(fd)
  } finally {
    closeSync(fd)
  }
}

/** @interop the AuditSink contract signals failure by throwing; createAuditor turns it into a UserError. */
const appendLine = (file: string, line: string): void =>
  withAppendFd(file, (fd) => {
    const text = `${line}\n`
    const expected = Buffer.byteLength(text)
    const written = writeSync(fd, text)
    if (written !== expected) throw new Error(`short write: ${written} of ${expected} bytes`)
  })

// The mode is fixed through the open fd, so there is no path lookup to race, and only when it isn't
// 0600 already: a file with the append-only flag (chattr +a, chflags uappend) refuses chmod.
const ensurePrivate = (fd: number): void => {
  if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
}

// Opens the audit log at `path`, creating it and its directories if needed, and tightens an
// existing file with wider permissions to 0600. Left when the file can't be opened for append.
export const openAuditLog = (path: string): Either<string, AuditSink> =>
  Path.expand(path).fold(
    (e) => Left<string, AuditSink>(`invalid audit path ${path}: ${messageOf(e)}`),
    (file) =>
      Try(() => {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        withAppendFd(file, ensurePrivate)
      }).fold(
        (e) => Left<string, AuditSink>(`audit log ${file} is not writable: ${messageOf(e)}`),
        () => Right<string, AuditSink>((line) => appendLine(file, line)),
      ),
  )
