# Fleet-Orchestrator MCP (Connection-Manager Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new MCP server that manages a fleet of SSH hosts — TOML host registry, pooled persistent SSH connections per host, and host-routed `exec`/`tmux_*` tools — reusing the existing connector's pure tmux logic.

**Architecture:** Convert the repo into a pnpm-workspace monorepo: `packages/core` (private, bundled — shared tmux logic + SSH runners + connection pool), `packages/connector` (today's published `ssh-client-mcp-server`, relocated, behavior unchanged), `packages/orchestrator` (new published server). The orchestrator binds a per-host pooled `TmuxRunner` from core and feeds it the same pure tmux builders.

**Tech Stack:** TypeScript (ESM), pnpm 11 workspaces, ts-builds (tsdown/vitest/eslint), functype (`Either`/`Option`/`List`), functype-os, somamcp, ssh2, zod, smol-toml, vitest.

**Spec:** `docs/superpowers/specs/2026-06-24-fleet-orchestrator-connection-manager-design.md`

**Branch:** `feat/fleet-orchestrator` (exists, holds the spec).

## Global Constraints

- **Node ≥ 22; pnpm 11** (`packageManager` pinned). `.nvmrc` = `24`.
- **ESM only**, `.js` import extensions in TS sources, `type: "module"`.
- **Prettier:** no semicolons, double quotes, 120-col, 2-space. **Functype FP style** (`Either`/`Option`/`List`, immutability, pure functions); mirror `packages/connector/src/config.ts`.
- **`packages/core/src/tmux.ts` stays pure** — imports only `functype` (no ssh2/somamcp/zod). Other core modules may use ssh2/somamcp.
- **`packages/core` is `private: true`** — never published; bundled into each server's `dist` by tsdown.
- **The connector keeps its published identity** — package name `ssh-client-mcp-server`, its `bin`, `server.json`, version, and `publish.yml`. Its full test suite must pass **unchanged** after every task.
- **Secrets never inline** — fleet config accepts only auth *references* (key path / `*_env` var / agent); literal `password`/`private_key` fields are rejected.
- Accepted lint warnings (do not "fix"): `functype/prefer-either` on `unwrap`'s throw-in-fold, `functype/prefer-fold`/`no-unnecessary-condition` on existing ternaries, `functype/prefer-functype-set` on the native key `Set`.

---

## File Structure (end state)

```
ssh-client-mcp-server/                  (repo root — private workspace manager)
├── package.json                        (private; fan-out scripts via pnpm -r)
├── pnpm-workspace.yaml                 (+ packages: ["packages/*"]; existing pnpm settings kept)
├── pnpm-lock.yaml                      (workspace lockfile)
├── README.md  CLAUDE.md  LICENSE  docs/  .github/  .gitignore  .nvmrc
└── packages/
    ├── core/                           @ssh-mcp/core (private)
    │   ├── package.json  tsconfig.json  vitest.config.ts  eslint.config.mjs  ts-builds.config.json
    │   ├── src/{index.ts, tmux.ts, ssh.ts, auth.ts, pool.ts}
    │   └── test/{tmux.spec.ts, tmux.integration.spec.ts, pool.spec.ts}
    ├── connector/                      ssh-client-mcp-server (published; relocated as-is, then repointed at core)
    │   ├── package.json  server.json  tsdown.config.ts  vitest.config.ts  tsconfig.json  ts-builds.config.json  eslint.config.mjs  .prettierignore
    │   ├── scripts/check-versions.ts
    │   ├── src/{index.ts, config.ts}
    │   └── test/{config.spec.ts}
    └── orchestrator/                   ssh-fleet-mcp-server (new; published)
        ├── package.json  server.json  tsdown.config.ts  vitest.config.ts  tsconfig.json  ts-builds.config.json  eslint.config.mjs
        └── src/{index.ts, fleet.ts, runners.ts}
            test/{fleet.spec.ts, runners.spec.ts, ops.spec.ts, integration.spec.ts}
```

`@ssh-mcp/core` is the private package name; `ssh-fleet-mcp-server` is the orchestrator package name (settable).

---

## Task 1: Monorepo skeleton — relocate the connector unchanged

Move the entire existing package into `packages/connector` with **zero code changes** and stand up the workspace. Connector behavior and tests are identical; only locations and CI/publish paths change.

**Files:**
- Create: `packages/connector/` (move all package files here)
- Create: `package.json` (new private root)
- Modify: `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`

**Interfaces:**
- Produces: a working `packages/connector` package (`ssh-client-mcp-server`) whose `pnpm --filter ssh-client-mcp-server validate` passes; root `pnpm -r validate` runs it.

- [ ] **Step 1: Move the package into `packages/connector`**

```bash
cd /home/jordanburke/IdeaProjects/ssh-client-mcp-server
mkdir -p packages/connector
git mv src test scripts server.json package.json \
       tsdown.config.ts vitest.config.ts tsconfig.json ts-builds.config.json \
       eslint.config.mjs .prettierignore packages/connector/
# dist/ and node_modules/ are gitignored; remove the stale root ones
rm -rf dist node_modules
```

- [ ] **Step 2: Add `packages: ["packages/*"]` to `pnpm-workspace.yaml`**

Prepend this key to the existing file (keep all existing `publicHoistPattern` / `minimumReleaseAgeExclude` / `allowBuilds` content unchanged):

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Create the new private root `package.json`**

```json
{
  "name": "ssh-mcp-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.5.2+sha512.71c631e382066efc25625d5cf029075de07b61b37f6e27350fbd84b1bda5864c8c1967adc280776b45c30a715c0359a3be08fef42d5bb09e2b99029979692916",
  "engines": { "node": ">=22" },
  "scripts": {
    "validate": "pnpm -r validate",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "format": "pnpm -r format",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "ts-builds": "^3.0.1",
    "tsdown": "^0.22.2",
    "tsx": "^4.22.4"
  }
}
```

- [ ] **Step 4: Point the publish workflow at `packages/connector`**

In `.github/workflows/publish.yml`, set every build/pack/publish/registry step to run inside the package. Add `defaults.run.working-directory` to the job, but keep `pnpm install` at the repo root. Edit the `publish` job: after `jobs.publish.runs-on`, add:

```yaml
    defaults:
      run:
        working-directory: packages/connector
```

Then change the install step to run at the root (override the default):

```yaml
      - name: Install dependencies
        working-directory: .
        run: pnpm install --frozen-lockfile
```

Leave the remaining steps (`pnpm validate`, `npm pack --dry-run`, `npm publish`, MCP publisher, `server.json` login/publish) as-is — they now run in `packages/connector`.

- [ ] **Step 5: Keep CI building the whole workspace**

In `.github/workflows/ci.yml`, the `pnpm install --frozen-lockfile` and `pnpm run validate` steps already run at root; root `validate` now fans out via `pnpm -r validate`. No path change needed — verify the file still reads `run: pnpm run validate`.

- [ ] **Step 6: Install and validate**

```bash
cd /home/jordanburke/IdeaProjects/ssh-client-mcp-server
CI=true pnpm install --no-frozen-lockfile
pnpm -r validate
```
Expected: connector validate passes — format, lint, typecheck, **70 tests**, build. (Same suite as before, now under `packages/connector`.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(repo): convert to pnpm monorepo, relocate connector to packages/connector"
```

---

## Task 2: Extract `packages/core` (tmux + SSH runners + auth), repoint the connector

Move the reusable code out of the connector into the new private `core` package; the connector imports it. Behavior identical — connector suite passes **unchanged**.

**Files:**
- Create: `packages/core/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `ts-builds.config.json`
- Create: `packages/core/src/{tmux.ts, ssh.ts, auth.ts, index.ts}`, `packages/core/test/{tmux.spec.ts, tmux.integration.spec.ts}`
- Modify: `packages/connector/src/index.ts`, `packages/connector/src/config.ts`, `packages/connector/package.json`
- Delete: `packages/connector/src/tmux.ts`, `packages/connector/test/tmux.spec.ts`, `packages/connector/test/tmux.integration.spec.ts`

**Interfaces:**
- Produces (`@ssh-mcp/core` exports): everything currently in `tmux.ts` (`CommandResult`, `TmuxRunner`, `validateSession`, `validateKey`, `buildSend`, `buildList`, `buildRead`, `buildKeys`, `interpret*`, `tmuxList`, `tmuxSend`, `tmuxRead`, `tmuxKeys`); plus `execSshCommand(sshConfig, command): Promise<string>`, `execSshResult(sshConfig, command): Promise<CommandResult>`; plus `resolveAuth(options: ResolveAuthOptions): Promise<Either<string, Partial<ConnectConfig>>>` and `type ResolveAuthOptions`.

- [ ] **Step 1: Create the core package manifest and configs**

`packages/core/package.json`:
```json
{
  "name": "@ssh-mcp/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "validate": "ts-builds validate",
    "format": "ts-builds format",
    "format:check": "ts-builds format:check",
    "lint": "ts-builds lint",
    "lint:check": "ts-builds lint:check",
    "typecheck": "ts-builds typecheck",
    "test": "ts-builds test",
    "build": "ts-builds build",
    "dev": "ts-builds dev"
  },
  "prettier": "ts-builds/prettier",
  "dependencies": {
    "functype": "^1.3.1",
    "functype-os": "^1.3.1",
    "somamcp": "^1.0.12",
    "ssh2": "^1.17.0"
  },
  "devDependencies": {
    "@types/node": "^24.13.1",
    "@types/ssh2": "^1.15.5",
    "ts-builds": "^3.0.1",
    "tsdown": "^0.22.2"
  }
}
```

Core is consumed as TypeScript source (bundled by each server's tsdown), so `build` is a no-op safety net and `main`/`exports` point at `./src/index.ts`.

`packages/core/tsconfig.json`:
```json
{
  "extends": "ts-builds/tsconfig",
  "compilerOptions": { "rootDir": "src", "outDir": "lib" },
  "include": ["src/**/*"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from "vitest/config"
import baseConfig from "ts-builds/vitest"

export default mergeConfig(baseConfig, defineConfig({}))
```

`packages/core/eslint.config.mjs`:
```js
import baseConfig from "ts-builds/eslint-functype"

export default [
  ...baseConfig,
  {
    files: ["test/**/*.ts", "**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "functype/no-let": "off",
    },
  },
]
```

`packages/core/ts-builds.config.json`:
```json
{
  "srcDir": "./src",
  "validateChain": ["format", "lint", "typecheck", "test"]
}
```
(No `build` in core's chain — it ships as source.)

- [ ] **Step 2: Move tmux + tests into core verbatim**

```bash
cd /home/jordanburke/IdeaProjects/ssh-client-mcp-server
mkdir -p packages/core/src packages/core/test
git mv packages/connector/src/tmux.ts packages/core/src/tmux.ts
git mv packages/connector/test/tmux.spec.ts packages/core/test/tmux.spec.ts
git mv packages/connector/test/tmux.integration.spec.ts packages/core/test/tmux.integration.spec.ts
```
In `packages/core/test/tmux.spec.ts` and `tmux.integration.spec.ts`, the import path `../src/tmux.js` is already correct for the new location — no edit needed.

- [ ] **Step 3: Create `packages/core/src/ssh.ts`** (cut from connector `index.ts`)

```ts
import { UserError } from "somamcp"
import { Client as SSHClient, type ConnectConfig } from "ssh2"

import { type CommandResult } from "./tmux.js"

export const execSshCommand = (sshConfig: ConnectConfig, command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const conn = new SSHClient()
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new UserError(`SSH exec error: ${err.message}`))
          conn.end()
          return
        }
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        stream.on("close", (code: number) => {
          conn.end()
          const stdout = Buffer.concat(stdoutChunks).toString()
          const stderr = Buffer.concat(stderrChunks).toString()
          if (stderr) {
            reject(new UserError(`Error (code ${code}):\n${stderr}`))
          } else {
            resolve(stdout)
          }
        })
        stream.on("data", (data: Buffer) => stdoutChunks.push(data))
        stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data))
      })
    })
    conn.on("error", (err) => reject(new UserError(`SSH connection error: ${err.message}`)))
    conn.connect(sshConfig)
  })

export const execSshResult = (sshConfig: ConnectConfig, command: string): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const conn = new SSHClient()
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new UserError(`SSH exec error: ${err.message}`))
          conn.end()
          return
        }
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        stream.on("close", (code: number) => {
          conn.end()
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString(),
            stderr: Buffer.concat(stderrChunks).toString(),
            code: code ?? 0,
          })
        })
        stream.on("data", (data: Buffer) => stdoutChunks.push(data))
        stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data))
      })
    })
    conn.on("error", (err) => reject(new UserError(`SSH connection error: ${err.message}`)))
    conn.connect(sshConfig)
  })
```

- [ ] **Step 4: Create `packages/core/src/auth.ts`** (cut `resolveAuth` + `ResolveAuthOptions` from connector `config.ts`)

```ts
import { type Either, Left, Option, Right } from "functype"
import { Fs, Path } from "functype-os"
import { type ConnectConfig } from "ssh2"

export type ResolveAuthOptions = Readonly<{
  password: Option<string>
  keyPath: Option<string>
  keyEnvVar: Option<string>
  useAgent: boolean
}>

// Auth precedence: password → key file → key from env var → ssh-agent → empty.
export const resolveAuth = async (options: ResolveAuthOptions): Promise<Either<string, Partial<ConnectConfig>>> => {
  if (options.password.isSome()) {
    return Right<string, Partial<ConnectConfig>>({ password: options.password.value })
  }
  if (options.keyPath.isSome()) {
    const expandResult = Path.expand(options.keyPath.value)
    if (expandResult.isLeft()) {
      return Left<string, Partial<ConnectConfig>>(
        `Invalid SSH key path ${options.keyPath.value}: ${expandResult.value.message}`,
      )
    }
    const expanded = expandResult.value
    const result = await Fs.readFile(expanded)
    return result.fold<Either<string, Partial<ConnectConfig>>>(
      (err) => Left<string, Partial<ConnectConfig>>(`Failed to read SSH key ${expanded}: ${err.message}`),
      (contents) => Right<string, Partial<ConnectConfig>>({ privateKey: contents }),
    )
  }
  if (options.keyEnvVar.isSome()) {
    const varName = options.keyEnvVar.value
    const keyValue = process.env[varName]
    if (!keyValue) {
      return Left<string, Partial<ConnectConfig>>(`key-env ${varName} but environment variable is not set or empty`)
    }
    return Right<string, Partial<ConnectConfig>>({ privateKey: keyValue })
  }
  if (options.useAgent) {
    const sock = process.env.SSH_AUTH_SOCK
    if (!sock) {
      return Left<string, Partial<ConnectConfig>>("agent set but SSH_AUTH_SOCK is not set")
    }
    return Right<string, Partial<ConnectConfig>>({ agent: sock })
  }
  return Right<string, Partial<ConnectConfig>>({})
}
```

- [ ] **Step 5: Create `packages/core/src/index.ts`**

```ts
export * from "./tmux.js"
export * from "./ssh.js"
export * from "./auth.js"
```

- [ ] **Step 6: Repoint the connector at core**

In `packages/connector/package.json`, add to `dependencies`:
```json
"@ssh-mcp/core": "workspace:*"
```

In `packages/connector/src/index.ts`: delete the two local `execSshCommand`/`execSshResult` function definitions, and replace the tmux + ssh import lines with:
```ts
import {
  type CommandResult,
  execSshCommand,
  execSshResult,
  tmuxKeys,
  tmuxList,
  tmuxRead,
  tmuxSend,
  type TmuxRunner,
} from "@ssh-mcp/core"
```
(Keep the `type Either, Option` functype import, `createServer, UserError` somamcp import, `Client as SSHClient` removal if now unused — remove the `ssh2` import if `SSHClient` is no longer referenced; keep `type ConnectConfig` import from ssh2 since `sshConfig` is typed with it.)

In `packages/connector/src/config.ts`: delete the `resolveAuth` function and `ResolveAuthOptions` type (now in core) and re-export them so existing test imports keep working:
```ts
export { resolveAuth, type ResolveAuthOptions } from "@ssh-mcp/core"
```
Also change `validateConfig`'s `validateSession` usage: replace any local reference by importing from core if needed (the connector's `config.ts` does not currently use `validateSession`; leave as-is). Keep `parseArgv`, `effectiveUser`, `validateConfig` in connector.

- [ ] **Step 7: Install and verify the connector suite passes unchanged**

```bash
cd /home/jordanburke/IdeaProjects/ssh-client-mcp-server
CI=true pnpm install --no-frozen-lockfile
pnpm -r validate
```
Expected: `@ssh-mcp/core` validate passes (tmux unit + integration tests — **37 + regression** as before, now in core); connector validate passes (**config tests** + typecheck + build). Total unchanged behavior; connector still produces `dist/index.js` with all 5 tools.

- [ ] **Step 8: Smoke-test the connector still boots with all tools**

```bash
cd packages/connector
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| timeout 6 node dist/index.js --host=dummy --user=test --password= 2>/dev/null \
| tr ',' '\n' | grep -oE '"name":"[a-z_]+"' | sort -u
```
Expected: `exec`, `tmux_keys`, `tmux_list`, `tmux_read`, `tmux_send` present.

- [ ] **Step 9: Commit**

```bash
cd /home/jordanburke/IdeaProjects/ssh-client-mcp-server
git add -A
git commit -m "refactor(core): extract @ssh-mcp/core (tmux, ssh runners, auth); connector imports it"
```

---

## Task 3: Connection pool in `core` (injected connect factory)

**Files:**
- Create: `packages/core/src/pool.ts`, `packages/core/test/pool.spec.ts`
- Modify: `packages/core/src/index.ts` (export pool)

**Interfaces:**
- Consumes: `CommandResult` (core/tmux), `ConnectConfig` (ssh2).
- Produces:
  - `type PooledConnection = { exec: (command: string) => Promise<CommandResult>; close: () => void; onClose: (cb: () => void) => void }`
  - `type ConnectFactory = (sshConfig: ConnectConfig) => Promise<PooledConnection>`
  - `type PoolOptions = { maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }`
  - `type HostStatus = { name: string; state: "connected" | "idle" | "disconnected"; inFlight: number }`
  - `type Pool = { run: (hostName: string, command: string) => Promise<CommandResult>; status: () => HostStatus[]; shutdown: () => Promise<void> }`
  - `createPool(hosts: ReadonlyArray<{ name: string; sshConfig: ConnectConfig }>, opts: PoolOptions, connect?: ConnectFactory): Pool`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/pool.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type ConnectFactory, createPool, type PooledConnection } from "../src/pool.js"

// A controllable fake connection. Records exec calls; lets tests resolve/reject.
const makeFakeConn = () => {
  let closeCb: (() => void) | undefined
  const calls: string[] = []
  const conn: PooledConnection = {
    exec: async (command: string) => {
      calls.push(command)
      return { stdout: `ran:${command}`, stderr: "", code: 0 }
    },
    close: () => closeCb?.(),
    onClose: (cb) => {
      closeCb = cb
    },
  }
  return { conn, calls, fail: () => closeCb?.() }
}

const opts = { maxPerHost: 2, idleTimeoutMs: 1000, acquireTimeoutMs: 1000 }
const host = { name: "h1", sshConfig: { host: "10.0.0.1" } }

describe("createPool", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("connects lazily and reuses one connection across calls", async () => {
    let connects = 0
    const factory: ConnectFactory = async () => {
      connects++
      return makeFakeConn().conn
    }
    const pool = createPool([host], opts, factory)
    expect(await pool.run("h1", "a")).toEqual({ stdout: "ran:a", stderr: "", code: 0 })
    await pool.run("h1", "b")
    expect(connects).toBe(1)
    await pool.shutdown()
  })

  it("rejects an unknown host", async () => {
    const pool = createPool([host], opts, async () => makeFakeConn().conn)
    await expect(pool.run("nope", "x")).rejects.toThrow(/unknown host "nope"/i)
    await pool.shutdown()
  })

  it("reconnects after the connection drops", async () => {
    let connects = 0
    const conns: ReturnType<typeof makeFakeConn>[] = []
    const factory: ConnectFactory = async () => {
      connects++
      const f = makeFakeConn()
      conns.push(f)
      return f.conn
    }
    const pool = createPool([host], opts, factory)
    await pool.run("h1", "a")
    conns[0].fail() // simulate the link dying while idle
    await pool.run("h1", "b")
    expect(connects).toBe(2)
    await pool.shutdown()
  })

  it("evicts an idle connection after idleTimeoutMs", async () => {
    let closed = 0
    const factory: ConnectFactory = async () => {
      const f = makeFakeConn()
      const orig = f.conn.close
      f.conn.close = () => {
        closed++
        orig()
      }
      return f.conn
    }
    const pool = createPool([host], opts, factory)
    await pool.run("h1", "a")
    await vi.advanceTimersByTimeAsync(1001)
    expect(closed).toBe(1)
    expect(pool.status()[0].state).toBe("disconnected")
    await pool.shutdown()
  })

  it("reports status", async () => {
    const pool = createPool([host], opts, async () => makeFakeConn().conn)
    expect(pool.status()).toEqual([{ name: "h1", state: "disconnected", inFlight: 0 }])
    await pool.run("h1", "a")
    expect(pool.status()[0].state).toBe("idle")
    await pool.shutdown()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ssh-mcp/core exec vitest run test/pool.spec.ts`
Expected: FAIL — cannot resolve `../src/pool.js`.

- [ ] **Step 3: Implement `packages/core/src/pool.ts`**

```ts
import { Client as SSHClient, type ConnectConfig } from "ssh2"

import { type CommandResult } from "./tmux.js"

export type PooledConnection = {
  exec: (command: string) => Promise<CommandResult>
  close: () => void
  onClose: (cb: () => void) => void
}

export type ConnectFactory = (sshConfig: ConnectConfig) => Promise<PooledConnection>

export type PoolOptions = { maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }

export type HostStatus = { name: string; state: "connected" | "idle" | "disconnected"; inFlight: number }

export type Pool = {
  run: (hostName: string, command: string) => Promise<CommandResult>
  status: () => HostStatus[]
  shutdown: () => Promise<void>
}

type HostState = {
  name: string
  sshConfig: ConnectConfig
  conn?: PooledConnection
  connecting?: Promise<PooledConnection>
  inFlight: number
  waiters: Array<() => void>
  idleTimer?: ReturnType<typeof setTimeout>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Default factory: a persistent ssh2 client; exec runs each command on its own channel.
export const defaultConnect: ConnectFactory = (sshConfig) =>
  new Promise<PooledConnection>((resolve, reject) => {
    const client = new SSHClient()
    const closeCbs: Array<() => void> = []
    client.on("ready", () =>
      resolve({
        exec: (command) =>
          new Promise<CommandResult>((res, rej) => {
            client.exec(command, (err, stream) => {
              if (err) {
                rej(err)
                return
              }
              const out: Buffer[] = []
              const errb: Buffer[] = []
              stream.on("close", (code: number) =>
                res({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(errb).toString(), code: code ?? 0 }),
              )
              stream.on("data", (d: Buffer) => out.push(d))
              stream.stderr.on("data", (d: Buffer) => errb.push(d))
            })
          }),
        close: () => client.end(),
        onClose: (cb) => closeCbs.push(cb),
      }),
    )
    client.on("error", (err) => {
      closeCbs.forEach((cb) => cb())
      reject(err)
    })
    client.on("close", () => closeCbs.forEach((cb) => cb()))
    client.connect({ keepaliveInterval: 15000, ...sshConfig })
  })

export const createPool = (
  hosts: ReadonlyArray<{ name: string; sshConfig: ConnectConfig }>,
  opts: PoolOptions,
  connect: ConnectFactory = defaultConnect,
): Pool => {
  const states = new Map<string, HostState>(
    hosts.map((h) => [h.name, { name: h.name, sshConfig: h.sshConfig, inFlight: 0, waiters: [] }]),
  )

  const dropConn = (st: HostState): void => {
    st.conn = undefined
    if (st.idleTimer) {
      clearTimeout(st.idleTimer)
      st.idleTimer = undefined
    }
  }

  const ensureConn = async (st: HostState): Promise<PooledConnection> => {
    if (st.conn) return st.conn
    if (!st.connecting) {
      st.connecting = connect(st.sshConfig).then((c) => {
        c.onClose(() => {
          if (st.conn === c) dropConn(st)
        })
        st.conn = c
        st.connecting = undefined
        return c
      })
      st.connecting.catch(() => {
        st.connecting = undefined
      })
    }
    return st.connecting
  }

  const acquireSlot = async (st: HostState): Promise<void> => {
    if (st.inFlight < opts.maxPerHost) {
      st.inFlight++
      return
    }
    await Promise.race([
      new Promise<void>((resolve) => st.waiters.push(resolve)),
      wait(opts.acquireTimeoutMs).then(() => {
        throw new Error(`host "${st.name}" busy: no free connection slot after ${opts.acquireTimeoutMs}ms`)
      }),
    ])
    st.inFlight++
  }

  const releaseSlot = (st: HostState): void => {
    st.inFlight--
    const next = st.waiters.shift()
    if (next) next()
    else if (st.inFlight === 0 && st.conn) {
      st.idleTimer = setTimeout(() => {
        st.conn?.close()
        dropConn(st)
      }, opts.idleTimeoutMs)
    }
  }

  const run = async (hostName: string, command: string): Promise<CommandResult> => {
    const st = states.get(hostName)
    if (!st) throw new Error(`unknown host "${hostName}"`)
    if (st.idleTimer) {
      clearTimeout(st.idleTimer)
      st.idleTimer = undefined
    }
    await acquireSlot(st)
    try {
      const conn = await ensureConn(st)
      try {
        return await conn.exec(command)
      } catch {
        // connection likely dead — drop, reconnect once, retry
        dropConn(st)
        const fresh = await ensureConn(st)
        return await fresh.exec(command)
      }
    } finally {
      releaseSlot(st)
    }
  }

  const status = (): HostStatus[] =>
    [...states.values()].map((st) => ({
      name: st.name,
      state: st.conn ? (st.inFlight > 0 ? "connected" : "idle") : "disconnected",
      inFlight: st.inFlight,
    }))

  const shutdown = async (): Promise<void> => {
    for (const st of states.values()) {
      if (st.idleTimer) clearTimeout(st.idleTimer)
      st.conn?.close()
      dropConn(st)
    }
  }

  return { run, status, shutdown }
}
```

- [ ] **Step 4: Export the pool from core**

In `packages/core/src/index.ts` add:
```ts
export * from "./pool.js"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ssh-mcp/core exec vitest run test/pool.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Validate core and commit**

```bash
pnpm --filter @ssh-mcp/core validate
git add -A && git commit -m "feat(core): add connection pool with injected connect factory"
```

---

## Task 4: Orchestrator scaffold + fleet config (TOML parse + validate)

**Files:**
- Create: `packages/orchestrator/{package.json, tsconfig.json, vitest.config.ts, eslint.config.mjs, ts-builds.config.json, tsdown.config.ts, server.json}`
- Create: `packages/orchestrator/src/fleet.ts`, `packages/orchestrator/test/fleet.spec.ts`

**Interfaces:**
- Produces:
  - `type HostEntry = { name: string; host: string; port: number; user: Option<string>; auth: ResolveAuthOptions; tmuxSession: string }`
  - `type PoolSettings = { maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }`
  - `type Fleet = { hosts: HostEntry[]; pool: PoolSettings }`
  - `parseFleet(toml: string): Either<string, Fleet>` — parse + validate, accumulating all errors.

- [ ] **Step 1: Create the orchestrator package manifest and configs**

`packages/orchestrator/package.json`:
```json
{
  "name": "ssh-fleet-mcp-server",
  "version": "0.1.0",
  "license": "MIT",
  "description": "MCP server that manages a fleet of SSH hosts: pooled connections and host-routed exec/tmux tools.",
  "author": "Jordan Burke <jordan.burke@gmail.com>",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } },
  "bin": { "ssh-fleet-mcp-server": "dist/index.js" },
  "files": ["lib", "dist"],
  "engines": { "node": ">=22" },
  "scripts": {
    "validate": "ts-builds validate",
    "format": "ts-builds format",
    "format:check": "ts-builds format:check",
    "lint": "ts-builds lint",
    "lint:check": "ts-builds lint:check",
    "typecheck": "ts-builds typecheck",
    "test": "ts-builds test",
    "build": "ts-builds build",
    "dev": "ts-builds dev",
    "inspect": "pnpm build && npx @modelcontextprotocol/inspector dist/index.js"
  },
  "prettier": "ts-builds/prettier",
  "dependencies": {
    "@ssh-mcp/core": "workspace:*",
    "functype": "^1.3.1",
    "functype-os": "^1.3.1",
    "smol-toml": "^1.3.1",
    "somamcp": "^1.0.12",
    "ssh2": "^1.17.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^24.13.1",
    "@types/ssh2": "^1.15.5",
    "ts-builds": "^3.0.1",
    "tsdown": "^0.22.2"
  }
}
```

`tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `ts-builds.config.json`, `tsdown.config.ts` — identical to the connector's (copy `packages/connector/{tsconfig.json,vitest.config.ts,eslint.config.mjs,ts-builds.config.json,tsdown.config.ts}` into `packages/orchestrator/`):
```bash
cp packages/connector/tsconfig.json packages/orchestrator/tsconfig.json
cp packages/connector/vitest.config.ts packages/orchestrator/vitest.config.ts
cp packages/connector/eslint.config.mjs packages/orchestrator/eslint.config.mjs
cp packages/connector/ts-builds.config.json packages/orchestrator/ts-builds.config.json
cp packages/connector/tsdown.config.ts packages/orchestrator/tsdown.config.ts
```

`packages/orchestrator/server.json` (MCP registry; `mcpName` style mirrors the connector):
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.jordanburke/ssh-fleet-mcp-server",
  "description": "MCP server that manages a fleet of SSH hosts via pooled connections.",
  "repository": { "url": "https://github.com/jordanburke/ssh-client-mcp-server", "source": "github" },
  "version": "0.1.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "ssh-fleet-mcp-server",
      "version": "0.1.0",
      "transport": { "type": "stdio" },
      "packageArguments": [
        { "type": "named", "name": "--config", "description": "Path to fleet TOML config", "isRequired": false, "format": "filepath", "isSecret": false }
      ]
    }
  ]
}
```

- [ ] **Step 2: Add `smol-toml` to the workspace allow/age lists**

In `pnpm-workspace.yaml`, no change needed (smol-toml is third-party, ages normally; it has no build script). If `pnpm install` later flags `ERR_PNPM_IGNORED_BUILDS` for it, add `smol-toml: false` under `allowBuilds`.

- [ ] **Step 3: Write the failing tests for `parseFleet`**

```ts
// packages/orchestrator/test/fleet.spec.ts
import { describe, expect, it } from "vitest"

import { parseFleet } from "../src/fleet.js"

const base = `
[[hosts]]
name = "box-a"
host = "10.0.0.11"
key = "/keys/id_a"
`

describe("parseFleet", () => {
  it("parses hosts with defaults applied", () => {
    const r = parseFleet(`
[defaults]
port = 2222
user = "agent"
tmux_session = "work"
${base}`)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      const h = r.value.hosts[0]
      expect(h.name).toBe("box-a")
      expect(h.host).toBe("10.0.0.11")
      expect(h.port).toBe(2222)
      expect(h.tmuxSession).toBe("work")
      expect(h.auth.keyPath.isSome()).toBe(true)
    }
  })

  it("defaults port 22 and tmux_session 'agent'", () => {
    const r = parseFleet(base)
    if (r.isRight()) {
      expect(r.value.hosts[0].port).toBe(22)
      expect(r.value.hosts[0].tmuxSession).toBe("agent")
    }
  })

  it("reads pool settings with defaults", () => {
    const r = parseFleet(base)
    if (r.isRight()) {
      expect(r.value.pool.maxPerHost).toBe(2)
      expect(r.value.pool.idleTimeoutMs).toBe(60000)
    }
  })

  it("rejects malformed TOML", () => {
    expect(parseFleet("this is = = not toml").isLeft()).toBe(true)
  })

  it("rejects a host with no auth mode", () => {
    const r = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain('host "x"')
  })

  it("rejects a host with multiple auth modes", () => {
    const r = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
key = "/k"
agent = true
`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain("exactly one auth")
  })

  it("rejects an inline password literal (secrets must be by reference)", () => {
    const r = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
password = "hunter2"
`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain("must not be inline")
  })

  it("rejects duplicate host names", () => {
    const r = parseFleet(`${base}${base}`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain("duplicate host name")
  })

  it("rejects an unsafe host name", () => {
    const r = parseFleet(`
[[hosts]]
name = "a b"
host = "1.2.3.4"
agent = true
`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain("invalid host name")
  })
})
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/fleet.spec.ts`
Expected: FAIL — cannot resolve `../src/fleet.js`.

- [ ] **Step 5: Implement `packages/orchestrator/src/fleet.ts`**

```ts
import { type Either, Left, List, Option, Right } from "functype"
import { type ResolveAuthOptions, validateSession } from "@ssh-mcp/core"
import { parse as parseToml } from "smol-toml"

export type HostEntry = Readonly<{
  name: string
  host: string
  port: number
  user: Option<string>
  auth: ResolveAuthOptions
  tmuxSession: string
}>

export type PoolSettings = Readonly<{ maxPerHost: number; idleTimeoutMs: number; acquireTimeoutMs: number }>

export type Fleet = Readonly<{ hosts: HostEntry[]; pool: PoolSettings }>

type RawHost = Record<string, unknown>

const str = (v: unknown): Option<string> => (typeof v === "string" && v.length > 0 ? Option(v) : Option.none<string>())
const num = (v: unknown): Option<number> => (typeof v === "number" ? Option(v) : Option.none<number>())

// Exactly-one-auth + secrets-by-reference. Returns the auth options or an error string.
const resolveHostAuth = (name: string, h: RawHost): Either<string, ResolveAuthOptions> => {
  if (h.password !== undefined || h.private_key !== undefined) {
    return Left<string, ResolveAuthOptions>(`host "${name}": secrets must not be inline; use key/key_env/agent/password_env`)
  }
  const modes = [
    str(h.key).map(() => "key"),
    str(h.key_env).map(() => "key_env"),
    str(h.password_env).map(() => "password_env"),
    h.agent === true ? Option("agent") : Option.none<string>(),
  ].filter((o) => o.isSome())
  if (modes.length === 0) return Left<string, ResolveAuthOptions>(`host "${name}": no auth mode (need exactly one of key/key_env/agent/password_env)`)
  if (modes.length > 1) return Left<string, ResolveAuthOptions>(`host "${name}": exactly one auth mode allowed, found ${modes.length}`)
  return Right<string, ResolveAuthOptions>({
    password: str(h.password_env).flatMap((v) => Option(process.env[v] ?? "")).filter((v) => v.length > 0),
    keyPath: str(h.key),
    keyEnvVar: str(h.key_env),
    useAgent: h.agent === true,
  })
}

const parsePool = (raw: Record<string, unknown>): PoolSettings => {
  const p = (raw.pool ?? {}) as Record<string, unknown>
  return {
    maxPerHost: num(p.max_per_host).orElse(2),
    idleTimeoutMs: num(p.idle_timeout_ms).orElse(60000),
    acquireTimeoutMs: num(p.acquire_timeout_ms).orElse(30000),
  }
}

export const parseFleet = (toml: string): Either<string, Fleet> => {
  let raw: Record<string, unknown>
  try {
    raw = parseToml(toml) as Record<string, unknown>
  } catch (e) {
    return Left<string, Fleet>(`Invalid TOML: ${(e as Error).message}`)
  }

  const defaults = (raw.defaults ?? {}) as Record<string, unknown>
  const defaultPort = num(defaults.port).orElse(22)
  const defaultUser = str(defaults.user)
  const defaultSession = str(defaults.tmux_session).orElse("agent")
  const rawHosts = Array.isArray(raw.hosts) ? (raw.hosts as RawHost[]) : []

  if (rawHosts.length === 0) return Left<string, Fleet>("Fleet config has no [[hosts]] entries")

  const seen = new Set<string>()
  const errors: string[] = []
  const hosts: HostEntry[] = []

  for (const h of rawHosts) {
    const name = str(h.name).orElse("")
    if (!validateSession(name).isRight()) {
      errors.push(`invalid host name "${name}": only letters, digits, hyphen, underscore`)
      continue
    }
    if (seen.has(name)) {
      errors.push(`duplicate host name "${name}"`)
      continue
    }
    seen.add(name)
    const address = str(h.host)
    if (address.isNone()) {
      errors.push(`host "${name}": missing host address`)
      continue
    }
    resolveHostAuth(name, h).fold(
      (msg) => errors.push(msg),
      (auth) =>
        hosts.push({
          name,
          host: address.value,
          port: num(h.port).orElse(defaultPort),
          user: str(h.user).or(defaultUser),
          auth,
          tmuxSession: str(h.tmux_session).orElse(defaultSession),
        }),
    )
  }

  return errors.length > 0
    ? Left<string, Fleet>(`Fleet config errors:\n${List(errors).toArray().join("\n")}`)
    : Right<string, Fleet>({ hosts, pool: parsePool(raw) })
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/fleet.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Install (links the new package) and commit**

```bash
cd /home/jordanburke/IdeaProjects/ssh-client-mcp-server
CI=true pnpm install --no-frozen-lockfile
pnpm --filter ssh-fleet-mcp-server typecheck
git add -A && git commit -m "feat(orchestrator): scaffold package + fleet TOML config parser/validator"
```

---

## Task 5: Build per-host pooled runners from the fleet (startup wiring)

Resolve each host's auth into an `ssh2.ConnectConfig`, build the pool, and expose a per-host `TmuxRunner` plus a `runExec` for the one-shot tool.

**Files:**
- Create: `packages/orchestrator/src/runners.ts`, `packages/orchestrator/test/runners.spec.ts`

**Interfaces:**
- Consumes: `Fleet`, `HostEntry` (fleet.ts); `createPool`, `Pool`, `resolveAuth`, `TmuxRunner` (core).
- Produces:
  - `buildFleetRunner(fleet: Fleet, connect?: ConnectFactory): Promise<Either<string, FleetRunner>>`
  - `type FleetRunner = { hostNames: string[]; tmuxRunnerFor: (host: string) => Either<string, TmuxRunner>; exec: (host: string, command: string) => Promise<CommandResult>; sessionFor: (host: string) => string; status: () => HostStatus[]; shutdown: () => Promise<void> }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/orchestrator/test/runners.spec.ts
import { describe, expect, it } from "vitest"
import { type ConnectFactory, type PooledConnection } from "@ssh-mcp/core"

import { parseFleet } from "../src/fleet.js"
import { buildFleetRunner } from "../src/runners.js"

const fakeConn: PooledConnection = {
  exec: async (command) => ({ stdout: `out:${command}`, stderr: "", code: 0 }),
  close: () => {},
  onClose: () => {},
}
const connect: ConnectFactory = async () => fakeConn

const fleet = parseFleet(`
[[hosts]]
name = "box-a"
host = "10.0.0.11"
agent = true
tmux_session = "sess-a"
`)

describe("buildFleetRunner", () => {
  it("exposes host names and a per-host tmux runner", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value.hostNames).toEqual(["box-a"])
      expect(r.value.sessionFor("box-a")).toBe("sess-a")
      const tr = r.value.tmuxRunnerFor("box-a")
      expect(tr.isRight()).toBe(true)
      if (tr.isRight()) expect(await tr.value("tmux list-sessions")).toEqual({ stdout: "out:tmux list-sessions", stderr: "", code: 0 })
      await r.value.shutdown()
    }
  })

  it("errors the tmux runner for an unknown host", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    if (r.isRight()) {
      expect(r.value.tmuxRunnerFor("ghost").isLeft()).toBe(true)
      await r.value.shutdown()
    }
  })

  it("fails when a host's auth cannot resolve (missing key-env)", async () => {
    delete process.env.NOPE_KEY
    const f = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
key_env = "NOPE_KEY"
`)
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    expect(r.isLeft()).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/runners.spec.ts`
Expected: FAIL — cannot resolve `../src/runners.js`.

- [ ] **Step 3: Implement `packages/orchestrator/src/runners.ts`**

```ts
import { type Either, Left, Option, Right } from "functype"
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
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/runners.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): build per-host pooled runners from fleet config"
```

---

## Task 6: Orchestrator tools + server entry

Register `hosts_list` + host-routed `exec`/`tmux_*`, wire config loading and graceful shutdown.

**Files:**
- Create: `packages/orchestrator/src/index.ts`, `packages/orchestrator/test/ops.spec.ts`

**Interfaces:**
- Consumes: `buildFleetRunner`, `FleetRunner` (runners.ts); `parseFleet` (fleet.ts); core tmux ops (`tmuxList`, `tmuxSend`, `tmuxRead`, `tmuxKeys`); `createServer`, `UserError` (somamcp); `z` (zod).
- Produces: an MCP server registering tools `hosts_list`, `exec`, `tmux_list`, `tmux_send`, `tmux_read`, `tmux_keys`.

- [ ] **Step 1: Write the failing tests (pure tool-handler behavior via a fake FleetRunner)**

Factor the tool handlers into a testable `makeHandlers(runner: FleetRunner)` so they can be tested without the MCP transport.

```ts
// packages/orchestrator/test/ops.spec.ts
import { describe, expect, it } from "vitest"
import { type CommandResult } from "@ssh-mcp/core"

import { makeHandlers } from "../src/index.js"
import { type FleetRunner } from "../src/runners.js"

const recording = () => {
  const calls: Array<{ host: string; command: string }> = []
  const runner: FleetRunner = {
    hostNames: ["box-a", "box-b"],
    sessionFor: () => "agent",
    tmuxRunnerFor: (host) =>
      ({ isRight: () => true, isLeft: () => false, value: (command: string) => run(host, command) }) as never,
    exec: (host, command) => run(host, command),
    status: () => [
      { name: "box-a", state: "idle", inFlight: 0 },
      { name: "box-b", state: "disconnected", inFlight: 0 },
    ],
    shutdown: async () => {},
  }
  const run = async (host: string, command: string): Promise<CommandResult> => {
    calls.push({ host, command })
    return { stdout: "agent\n", stderr: "", code: 0 }
  }
  return { runner, calls }
}

describe("orchestrator handlers", () => {
  it("hosts_list returns status JSON", async () => {
    const { runner } = recording()
    const h = makeHandlers(runner)
    const out = JSON.parse(await h.hostsList())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ name: "box-a", state: "idle" })
  })

  it("exec routes the command to the named host", async () => {
    const { runner, calls } = recording()
    const h = makeHandlers(runner)
    await h.exec({ host: "box-b", command: "whoami" })
    expect(calls).toContainEqual({ host: "box-b", command: "whoami" })
  })

  it("tmux_list runs list-sessions on the host", async () => {
    const { runner, calls } = recording()
    const h = makeHandlers(runner)
    const out = await h.tmuxList({ host: "box-a" })
    expect(calls[0]).toMatchObject({ host: "box-a" })
    expect(calls[0].command).toContain("list-sessions")
    expect(out).toContain("agent")
  })

  it("rejects an unknown host on exec", async () => {
    const { runner } = recording()
    const failing: FleetRunner = { ...runner, exec: async () => { throw new Error('unknown host "z"') } }
    const h = makeHandlers(failing)
    await expect(h.exec({ host: "z", command: "x" })).rejects.toThrow(/unknown host/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/ops.spec.ts`
Expected: FAIL — cannot resolve `../src/index.js` / `makeHandlers` not exported.

- [ ] **Step 3: Implement `packages/orchestrator/src/index.ts`**

```ts
#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { type Either, Option } from "functype"
import { createServer, UserError } from "somamcp"
import { z } from "zod"
import { tmuxKeys, tmuxList, tmuxRead, tmuxSend } from "@ssh-mcp/core"

import { parseFleet } from "./fleet.js"
import { buildFleetRunner, type FleetRunner } from "./runners.js"

const { version: pkgVersion } = (await import("node:module"))
  .createRequire(import.meta.url)("../package.json") as { version: `${number}.${number}.${number}` }

const unwrap = <T>(result: Either<string, T>): T =>
  result.fold(
    (msg) => {
      throw new UserError(msg)
    },
    (value) => value,
  )

// Tool handlers, factored out so they can be unit-tested with a fake FleetRunner.
export const makeHandlers = (runner: FleetRunner) => ({
  hostsList: async (): Promise<string> => JSON.stringify(runner.status()),
  exec: async ({ host, command }: { host: string; command: string }): Promise<string> => {
    const r = await runner.exec(host, command)
    if (r.stderr) throw new UserError(`[${host}] Error (code ${r.code}):\n${r.stderr}`)
    return r.stdout
  },
  tmuxList: async ({ host }: { host: string }): Promise<string> =>
    JSON.stringify(unwrap(await tmuxList(unwrap(runner.tmuxRunnerFor(host))))),
  tmuxSend: async ({ host, session, input, submit }: { host: string; session?: string; input: string; submit?: boolean }): Promise<string> => {
    const target = session ?? runner.sessionFor(host)
    unwrap(await tmuxSend(unwrap(runner.tmuxRunnerFor(host)), { session: target, input, submit: submit ?? true }))
    return `[${host}] sent to tmux session "${target}".`
  },
  tmuxRead: async ({ host, session, lines }: { host: string; session?: string; lines?: number }): Promise<string> =>
    unwrap(await tmuxRead(unwrap(runner.tmuxRunnerFor(host)), { session: session ?? runner.sessionFor(host), lines: lines ?? 200 })),
  tmuxKeys: async ({ host, session, keys }: { host: string; session?: string; keys: string[] }): Promise<string> => {
    const target = session ?? runner.sessionFor(host)
    unwrap(await tmuxKeys(unwrap(runner.tmuxRunnerFor(host)), { session: target, keys }))
    return `[${host}] sent keys [${keys.join(", ")}] to tmux session "${target}".`
  },
})

const findConfigPath = (argv: ReadonlyArray<string>): string => {
  const flag = argv.find((a) => a.startsWith("--config="))
  if (flag) return flag.slice("--config=".length)
  return process.env.SSH_FLEET_CONFIG ?? join(homedir(), ".config", "ssh-fleet", "fleet.toml")
}

async function main(): Promise<void> {
  const configPath = findConfigPath(process.argv.slice(2))
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (e) {
    console.error(`Cannot read fleet config at ${configPath}: ${(e as Error).message}`)
    process.exit(1)
  }

  const fleet = parseFleet(raw).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (f) => f,
  )

  const runner = (await buildFleetRunner(fleet)).fold(
    (msg) => {
      console.error(msg)
      process.exit(1)
    },
    (r) => r,
  )

  const h = makeHandlers(runner)
  const server = createServer({
    name: "ssh-fleet-mcp-server",
    version: pkgVersion,
    instructions: "Manage a fleet of SSH hosts: pooled connections, host-routed exec and tmux tools.",
  })

  const hostParam = z.string().describe("Configured host name (see hosts_list)")

  server.addTool({
    name: "hosts_list",
    description: "List configured fleet hosts and their live connection status.",
    parameters: z.object({}),
    execute: () => h.hostsList(),
  })
  server.addTool({
    name: "exec",
    description: "Run a one-shot shell command on a fleet host over SSH.",
    parameters: z.object({ host: hostParam, command: z.string().min(1).describe("Shell command") }),
    execute: ({ host, command }) => h.exec({ host, command }),
  })
  server.addTool({
    name: "tmux_list",
    description: "List tmux sessions on a fleet host. Returns a JSON array of session names.",
    parameters: z.object({ host: hostParam }),
    execute: ({ host }) => h.tmuxList({ host }),
  })
  server.addTool({
    name: "tmux_send",
    description: "Type text into a persistent tmux session on a fleet host (creates it if absent).",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      input: z.string().min(1).describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after the text (default true)"),
    }),
    execute: ({ host, session, input, submit }) => h.tmuxSend({ host, session, input, submit }),
  })
  server.addTool({
    name: "tmux_read",
    description: "Capture the recent pane transcript of a tmux session on a fleet host.",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      lines: z.number().int().min(1).optional().describe("Lines of scrollback (default 200; capped at 2000)"),
    }),
    execute: ({ host, session, lines }) => h.tmuxRead({ host, session, lines }),
  })
  server.addTool({
    name: "tmux_keys",
    description: "Send control/special keys (e.g. C-c) to a tmux session on a fleet host.",
    parameters: z.object({
      host: hostParam,
      session: z.string().optional().describe("tmux session (defaults to the host's configured session)"),
      keys: z.array(z.string()).min(1).describe("tmux key names, e.g. ['C-c']"),
    }),
    execute: ({ host, session, keys }) => h.tmuxKeys({ host, session, keys }),
  })

  await server.start({ transportType: "stdio" })
  console.error(`SSH Fleet MCP Server running on stdio (${runner.hostNames.length} hosts)`)

  const shutdown = async () => {
    await runner.shutdown()
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error) => {
  console.error("Fatal error in main():", error)
  process.exit(1)
})
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/ops.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Validate + build the orchestrator**

Run: `pnpm --filter ssh-fleet-mcp-server validate`
Expected: format, lint, typecheck, tests, build all pass; `packages/orchestrator/dist/index.js` produced with a shebang.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): register hosts_list + host-routed exec/tmux tools"
```

---

## Task 7: Gated integration test (pool + tmux over localhost SSH)

**Files:**
- Create: `packages/orchestrator/test/integration.spec.ts`

**Interfaces:**
- Consumes: `parseFleet`, `buildFleetRunner`; core `tmuxSend`/`tmuxRead`.

- [ ] **Step 1: Write the gated integration test**

```ts
// packages/orchestrator/test/integration.spec.ts
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"
import { tmuxRead, tmuxSend } from "@ssh-mcp/core"

import { parseFleet } from "../src/fleet.js"
import { buildFleetRunner } from "../src/runners.js"

// Requires: tmux, an SSH server reachable at localhost, and agent auth that can log in.
const canSsh = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "localhost", "true"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!canSsh)("orchestrator integration (localhost SSH)", () => {
  const session = `ssh-fleet-it-${randomBytes(4).toString("hex")}`
  const fleet = parseFleet(`
[[hosts]]
name = "local"
host = "localhost"
agent = true
tmux_session = "${session}"
`)

  afterAll(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    } catch {
      // ignore
    }
  })

  it("creates a session on the host and reads it back over a pooled connection", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value)
    expect(r.isRight()).toBe(true)
    if (!r.isRight()) return
    const tr = r.value.tmuxRunnerFor("local")
    if (!tr.isRight()) throw new Error(tr.value)

    const sent = await tmuxSend(tr.value, { session, input: "echo fleet-roundtrip-ok", submit: true })
    expect(sent.isRight()).toBe(true)
    await wait(500)
    const read = await tmuxRead(tr.value, { session, lines: 50 })
    expect(read.isRight()).toBe(true)
    if (read.isRight()) expect(read.value).toContain("fleet-roundtrip-ok")

    // second send reuses the pooled connection (no reconnect, no TTY)
    const again = await tmuxSend(tr.value, { session, input: "echo second-pooled-send", submit: true })
    expect(again.isRight()).toBe(true)

    await r.value.shutdown()
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter ssh-fleet-mcp-server exec vitest run test/integration.spec.ts`
Expected: PASS if localhost SSH+tmux available; otherwise SKIPPED. (On a box without localhost sshd, this skips — that's expected and CI stays green.)

- [ ] **Step 3: Run the whole workspace suite**

Run: `pnpm -r test`
Expected: core + connector + orchestrator all pass.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(orchestrator): add gated localhost-SSH pool+tmux integration test"
```

---

## Task 8: Docs + final workspace validation

**Files:**
- Create: `packages/orchestrator/README.md`, `packages/orchestrator/fleet.example.toml`
- Modify: root `README.md`, `CLAUDE.md`

- [ ] **Step 1: Add an example fleet config**

`packages/orchestrator/fleet.example.toml`:
```toml
[defaults]
port = 22
user = "agent"
tmux_session = "agent"

[pool]
max_per_host = 2
idle_timeout_ms = 60000

[[hosts]]
name = "box-a"
host = "10.0.0.11"
user = "jordan"
key = "~/.ssh/id_ed25519"

[[hosts]]
name = "box-b"
host = "build.example.com"
agent = true

[[hosts]]
name = "box-c"
host = "192.168.1.50"
password_env = "BOXC_SSH_PASSWORD"   # value read from the env var, never inline
```

- [ ] **Step 2: Write `packages/orchestrator/README.md`**

Document: purpose, `--config` flag + discovery order, the TOML schema (defaults/pool/hosts + the four auth modes), the secrets-by-reference rule, and the tool list (`hosts_list`, `exec`, `tmux_list/send/read/keys` with the `host` param). Include the example config above and an `.mcp.json` snippet:
```json
{ "mcpServers": { "ssh-fleet": { "command": "node", "args": ["packages/orchestrator/dist/index.js", "--config=${SSH_FLEET_CONFIG}"] } } }
```

- [ ] **Step 3: Update the root README and CLAUDE.md**

In root `README.md`, add a short "Monorepo" section listing the three packages (`core` private, `connector` = `ssh-client-mcp-server`, `orchestrator` = `ssh-fleet-mcp-server`) and that `pnpm -r validate` runs everything.

In `CLAUDE.md`, update the Architecture/Overview to note the monorepo layout and that tmux/ssh/pool logic now lives in `@ssh-mcp/core`, consumed by both servers.

- [ ] **Step 4: Full workspace validation**

Run: `pnpm -r validate`
Expected: core, connector, and orchestrator all green (format, lint, typecheck, tests, build).

- [ ] **Step 5: Commit, push, open PR**

```bash
git add -A && git commit -m "docs(orchestrator): fleet README, example config; note monorepo in root docs"
git push -u origin feat/fleet-orchestrator
gh pr create --base main --title "Fleet-orchestrator MCP: connection-manager layer + monorepo" \
  --body "Implements docs/superpowers/specs/2026-06-24-fleet-orchestrator-connection-manager-design.md"
```

> Version bumps / publishing the new `ssh-fleet-mcp-server` and the relocated connector are handled separately via the release flow — not part of this plan.

---

## Self-Review

**Spec coverage:**
- Monorepo (core private/bundled, connector relocated keeps identity, orchestrator new) → Tasks 1, 2, 4. ✓
- Connector behavior unchanged / suite passes → Task 1 Step 6, Task 2 Steps 7–8 (smoke). ✓
- Embed pooled multi-host SSH; reuse pure tmux builders → Task 3 (pool) + Task 5 (per-host `TmuxRunner` feeding core ops) + Task 6. ✓
- TOML fleet config, defaults, discovery (`--config` → env → `~/.config/...`) → Task 4 (parse) + Task 6 (`findConfigPath`). ✓
- Auth modes key/key_env/agent/password_env; secrets-by-reference enforced (inline rejected) → Task 4 `resolveHostAuth` + tests. ✓
- Startup validation fail-fast, accumulate; reachability lazy → Task 4 (accumulation) + Task 6 (`main` exits on Left) + pool lazy connect (Task 3). ✓
- Pool: 1 persistent conn/host, concurrency cap + queue + timeout, idle eviction, reconnect-once, keepalive, graceful shutdown, injected factory → Task 3 + tests. ✓
- Tool surface `hosts_list` + host-routed `exec`/`tmux_*`; `host` required + validated; `session` defaulting → Task 6 + tests. ✓
- Error handling: unknown host, connect/auth, tmux interpreters reused with host prefix, exec stderr fatal, pool saturation → Task 6 handlers + Task 3 `acquireSlot` timeout. ✓
- Per-host isolation → separate `HostState` per host (Task 3); ops test routes per host (Task 6). ✓
- Deferred (fan-out, tmux_kill, add_host, default host) → not implemented. ✓
- Testing: pure unit (config, pool via fake factory, handlers via fake runner) + gated integration + connector regression + `pnpm -r test` → Tasks 3–7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; config/doc steps give exact file contents or precise content requirements. Task 8 Steps 2–3 describe doc content rather than verbatim prose — acceptable for human-readable docs, but the required elements are enumerated.

**Type consistency:** `CommandResult`, `TmuxRunner`, `ConnectFactory`, `PooledConnection`, `Pool`, `HostStatus` defined in core (Tasks 2–3) and consumed with matching signatures in `runners.ts`/`index.ts` (Tasks 5–6). `Fleet`/`HostEntry`/`PoolSettings`/`ResolveAuthOptions` defined in Task 4 and consumed in Task 5. `FleetRunner` shape defined in Task 5 and used by `makeHandlers` in Task 6. `parseFleet`/`buildFleetRunner`/`makeHandlers` names consistent across tasks. `PoolOptions` fields (`maxPerHost`/`idleTimeoutMs`/`acquireTimeoutMs`) match `PoolSettings` and the fleet parser's `pool` mapping.
