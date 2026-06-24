# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **pnpm monorepo** containing three packages:

| Package | npm name | Role |
| ------- | -------- | ---- |
| `packages/core` | `@ssh-mcp/core` (private) | Shared SSH pool (`createPool`), tmux command builders (`tmuxList`/`tmuxSend`/`tmuxRead`/`tmuxKeys`), auth resolution (`resolveAuth`), and SSH exec helpers. Bundled into both servers; not published separately. |
| `packages/connector` | `ssh-client-mcp-server` | Single-host MCP server — `exec` + `tmux_*` tools for one SSH host, configured via CLI flags. |
| `packages/orchestrator` | `ssh-fleet-mcp-server` | Multi-host fleet MCP server — `hosts_list` + host-routed `exec`/`tmux_*` tools, driven by a TOML fleet config (`--config=` flag or `SSH_FLEET_CONFIG` env or `~/.config/ssh-fleet/fleet.toml`). |

Both servers consume `@ssh-mcp/core` for all SSH and tmux logic. Run the full suite with `pnpm -r validate`.

The connector package (`ssh-client-mcp-server`) retains its original published identity and public API unchanged.

## Development Commands

Each package delegates all tooling to [`ts-builds`](https://github.com/jordanburke/ts-builds). Run from the **repo root** to hit all packages:

- **Validate all**: `pnpm -r validate` - Full chain per package: format → lint → typecheck → test → build
- **Per-package**: `cd packages/<name> && pnpm validate`

Within any package:

- **Build**: `pnpm build` - Production build via tsdown → `dist/` (dev builds go to `lib/`)
- **Dev**: `pnpm dev` - tsdown watch mode
- **Test**: `pnpm test` / `pnpm test:watch` / `pnpm test:coverage`
- **Lint/Format**: `pnpm lint` / `pnpm format` (both auto-fix); `*:check` variants for CI
- **Inspect** (connector/orchestrator): `pnpm inspect` - Build + launch MCP Inspector

## Architecture

### `@ssh-mcp/core` (`packages/core`)

Shared logic consumed by both servers. Not published; bundled by tsdown into each server's `dist/`.

- **`pool.ts`** — `createPool(hosts, opts, factory?)` returns a `Pool` with per-host SSH connection pooling (concurrency cap, idle eviction, acquire timeout, reconnect-once, graceful shutdown).
- **`tmux.ts`** — Pure tmux command builders and result interpreters: `tmuxList`, `tmuxSend`, `tmuxRead`, `tmuxKeys`. All accept a `TmuxRunner` (a thin `(cmd: string) => Promise<CommandResult>` function). Also exports `validateSession` and `validateKey` for session-name and key validation.
- **`auth.ts`** — `resolveAuth(opts)` resolves the four auth modes (key file, key env var, ssh-agent, password env) into an `ssh2` `ConnectConfig` fragment.
- **`ssh.ts`** — Low-level SSH exec over an `ssh2` connection.

### `ssh-client-mcp-server` (`packages/connector`)

Single-host MCP server. Entry point: `src/index.ts`.

- **MCP Tools**: `exec`, `tmux_list`, `tmux_send`, `tmux_read`, `tmux_keys` (all routing to one configured SSH host).
- **Configuration**: CLI flags `--host`, `--user`, `--port`, `--password`/`--key`/`--key-env`/`--agent`, `--tmux-session`.
- **Transport**: stdio.

### `ssh-fleet-mcp-server` (`packages/orchestrator`)

Multi-host fleet MCP server. Entry point: `src/index.ts`.

- **`fleet.ts`** — TOML fleet config parser (`parseFleet`). Enforces the secrets-by-reference rule (inline `password`/`private_key` rejected). Produces a validated `Fleet` with `HostEntry[]` and `PoolSettings`.
- **`runners.ts`** — `buildFleetRunner` resolves per-host SSH configs and wraps the `@ssh-mcp/core` pool into a `FleetRunner`.
- **`src/index.ts`** — `makeHandlers` + server wiring. Registers `hosts_list`, `exec`, `tmux_list`, `tmux_send`, `tmux_read`, `tmux_keys` (all with a required `host` param).
- **Config discovery**: `--config=<path>` → `SSH_FLEET_CONFIG` env → `~/.config/ssh-fleet/fleet.toml`.

### Key Dependencies (shared)

- `somamcp` - MCP framework (wraps FastMCP; provides `createServer`, `UserError`, telemetry, introspection tools)
- `functype` - Functional types (`Option`, `Either`, `List`, `Try`) for config parsing and error accumulation
- `functype-os` - OS helpers: `Path.expand` (tilde/env expansion), `Fs.readFile`, `Platform.userInfo()`
- `ssh2` - SSH client implementation
- `smol-toml` - TOML parser (orchestrator only)
- `zod` - Schema validation for tool parameters

### Introspection

somamcp auto-registers these tools alongside the server's own tools:

- `soma_health` — server uptime, status, session count
- `soma_capabilities` — registered tools / resources / prompts
- `soma_connections` — gateway connection status

Disable with `enableIntrospection: false` in `createServer()` options.

## Build Output (per package)

- Dev builds → `lib/` (sourcemaps, unminified), production builds → `dist/` (minified)
- Binary entry point: `dist/index.js` (shebang preserved, executable bit set by tsdown)
- Published packages contain `lib/` and `dist/` per `files` field in `package.json`
