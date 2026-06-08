# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SSH Client MCP Server is a Model Context Protocol (MCP) server that exposes SSH capabilities to LLMs and MCP clients. It's a single-file TypeScript application that provides secure remote shell command execution via SSH.

Built on [`somamcp`](https://github.com/sapientsai/SomaMCP) — a functional MCP framework that wraps FastMCP behind a backend abstraction and adds telemetry, introspection (`soma_health`, `soma_capabilities`, `soma_connections`), and an optional dashboard.

## Development Commands

This project uses [`ts-builds`](https://github.com/jordanburke/ts-builds) to delegate all tooling. Scripts in `package.json` call `ts-builds <cmd>`.

- **Validate**: `pnpm validate` - Full chain: format → lint → typecheck → test → build
- **Build**: `pnpm build` - Production build via tsdown → `dist/` (dev builds go to `lib/`)
- **Dev**: `pnpm dev` - tsdown watch mode
- **Test**: `pnpm test` / `pnpm test:watch` / `pnpm test:coverage`
- **Lint/Format**: `pnpm lint` / `pnpm format` (both auto-fix); `*:check` variants for CI
- **Inspect**: `pnpm inspect` - Build and launch MCP Inspector against `dist/index.js`

## Architecture

### Core Components

- **Single entry point**: `src/index.ts` wires up the server via `createServer()` and registers a single `exec` tool
- **MCP Tools**:
  - `exec` — runs a one-shot shell command on the remote host, returns stdout as a string. stderr becomes a `UserError`
  - `tmux_list` / `tmux_send` / `tmux_read` / `tmux_keys` — persistent interactive sessions backed by remote tmux (see `src/tmux.ts`). tmux is the state-holder; each tool is one tmux subcommand over the same one-shot SSH transport. Pure command builders + interpreters live in `src/tmux.ts`; `execSshResult` in `src/index.ts` is the stderr-tolerant runner they use.
- **SSH Client**: Uses `ssh2` library; password or key authentication
- **Configuration**: CLI arg parsing for SSH connection parameters (host/port/user/password/key)
- **Transport**: stdio (single `server.start({ transportType: "stdio" })` call)

### Key Dependencies

- `somamcp` - MCP framework (wraps FastMCP; provides `createServer`, `UserError`, telemetry, introspection)
- `functype` - Functional types (`Option`, `Either`, `List`) used for argv parsing and config validation
- `functype-os` - OS helpers:
  - `Path.expand` — `~`, `$VAR`/`${VAR}`, and absolute-path resolution in one call, returns `Either<PathError, string>`
  - `Fs.readFile` — returns `TaskResult<string>` (async `Either`-like); key errors surface at startup
  - `Platform.userInfo()` — when `--user` is omitted, falls back to the OS user (whoami-style)
- `ssh2` - SSH client implementation
- `zod` - Schema validation for tool parameters

### Introspection

somamcp auto-registers these tools alongside `exec`:

- `soma_health` — server uptime, status, session count
- `soma_capabilities` — registered tools / resources / prompts
- `soma_connections` — gateway connection status (unused here)

Disable with `enableIntrospection: false` in `createServer()` options if you want a strict 1-tool surface.

## Configuration

Server accepts these CLI arguments:

- `--host` (required): SSH server hostname/IP
- `--user` (required): SSH username
- `--port` (optional): SSH port (default: 22)
- `--password` (optional): SSH password
- `--key` (optional): Path to private SSH key
- `--tmux-session` (optional): default tmux session name for the tmux\_\* tools (default: `agent`)

Either `--password` or `--key` must be provided for authentication.

## Build Output

- Dev builds → `lib/` (sourcemaps, unminified), production builds → `dist/` (minified)
- Binary entry point: `dist/index.js` (shebang preserved, executable bit set by tsdown)
- Published package contains `lib/` and `dist/` per `files` field in `package.json`
