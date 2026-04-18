# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SSH Client MCP Server is a Model Context Protocol (MCP) server that exposes SSH capabilities to LLMs and MCP clients. It's a single-file TypeScript application that provides secure remote shell command execution via SSH.

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

- **Single entry point**: `src/index.ts` contains the entire MCP server implementation
- **MCP Tool**: `exec` tool for executing shell commands on remote servers
- **SSH Client**: Uses `ssh2` library for SSH connections with password or key authentication
- **Configuration**: Command-line argument parsing for SSH connection parameters

### Key Dependencies

- `@modelcontextprotocol/sdk` - MCP server framework
- `ssh2` - SSH client implementation
- `zod` - Schema validation for tool parameters

## Configuration

Server accepts these CLI arguments:

- `--host` (required): SSH server hostname/IP
- `--user` (required): SSH username
- `--port` (optional): SSH port (default: 22)
- `--password` (optional): SSH password
- `--key` (optional): Path to private SSH key

Either `--password` or `--key` must be provided for authentication.

## Build Output

- Dev builds → `lib/` (sourcemaps, unminified), production builds → `dist/` (minified)
- Binary entry point: `dist/index.js` (shebang preserved, executable bit set by tsdown)
- Published package contains `lib/` and `dist/` per `files` field in `package.json`
