# SSH Client MCP Server

[![License](https://img.shields.io/github/license/jordanburke/ssh-client-mcp-server)](./LICENSE)
[![NPM Version](https://img.shields.io/npm/v/ssh-client-mcp-server)](https://www.npmjs.com/package/ssh-client-mcp-server)
[![CI](https://github.com/jordanburke/ssh-client-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/jordanburke/ssh-client-mcp-server/actions/workflows/ci.yml)

**SSH Client MCP Server** is a local Model Context Protocol (MCP) server that lets LLMs and other MCP clients execute shell commands on remote hosts over SSH. It runs from Linux, macOS, or Windows and targets any reachable SSH server (Linux, macOS, Windows with OpenSSH, etc.).

Built on [`somamcp`](https://github.com/sapientsai/SomaMCP) — a functional MCP framework over FastMCP with telemetry, introspection, and backend abstraction.

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Tools](#tools)
- [Installation](#installation)
- [Configuration](#configuration)
- [Client Setup](#client-setup)
- [Testing](#testing)
- [Development](#development)
- [Disclaimer](#disclaimer)

## Quick Start

1. Configure your MCP client (Claude Desktop, Cursor, Cline, etc.) to launch this server via `npx` — see [Client Setup](#client-setup).
2. Ask your LLM to run shell commands on the target host.

No global install required — `npx` fetches and runs the latest published version.

## Features

- **Single `exec` tool** — runs a shell command on the remote host, returns stdout. stderr surfaces as a structured error.
- **Auth** — password or SSH private key (or defer to the SSH agent when no credentials are provided).
- **Smart path expansion** — `--key` supports `~`, `$VAR`, `${VAR}`, and relative paths via [`functype-os`](https://github.com/jordanburke/functype-os). Unresolved variables fail fast with a typed error.
- **OS-user fallback** — `--user` defaults to the current OS username when omitted.
- **Fail-fast auth** — the SSH key is loaded and validated at server startup, not on the first `exec` call.
- **Introspection out-of-the-box** — `soma_health`, `soma_capabilities`, `soma_connections` auto-registered by somamcp.
- **Cross-platform** — runs on Linux, macOS, Windows (anywhere Node 22+ runs).

## Tools

| Tool                | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `exec`              | Execute a shell command on the remote SSH server and return stdout. |
| `soma_health`       | Server uptime, status, active session count.                        |
| `soma_capabilities` | Enumerate registered tools, resources, and prompts.                 |
| `soma_connections`  | Gateway connection status (unused here).                            |

## Installation

### Run via `npx` (recommended)

No install step — your MCP client launches it on demand. See [Client Setup](#client-setup).

### Global install

```bash
npm install -g ssh-client-mcp-server
# then:
ssh-client-mcp-server --host=1.2.3.4 --user=root --password=pass
```

### From source (for contributors)

```bash
git clone https://github.com/jordanburke/ssh-client-mcp-server.git
cd ssh-client-mcp-server
pnpm install
pnpm build
```

## Configuration

The server reads SSH connection info from CLI flags:

| Flag         | Required | Default     | Description                                                                    |
| ------------ | -------- | ----------- | ------------------------------------------------------------------------------ |
| `--host`     | yes      | —           | Hostname or IP of the remote SSH server.                                       |
| `--user`     | no       | OS username | SSH username. Falls back to the local OS user (`whoami`) when omitted.         |
| `--port`     | no       | `22`        | SSH port.                                                                      |
| `--password` | no\*     | —           | SSH password.                                                                  |
| `--key`      | no\*     | —           | Path to a private SSH key. Supports `~`, `$VAR`, `${VAR}`, and relative paths. |

\*If both `--password` and `--key` are omitted, the server starts anyway and delegates authentication to the SSH agent (or fails on first `exec` if none is available).

## Client Setup

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "ssh-client-mcp-server": {
      "command": "npx",
      "args": ["-y", "ssh-client-mcp-server", "--host=1.2.3.4", "--user=root", "--key=~/.ssh/id_ed25519"]
    }
  }
}
```

### Password auth

Replace the `--key` arg with `--password=hunter2`. Avoid checking this into version control.

### Using the current OS user

Omit `--user` entirely — the server defaults to your local username.

### Other MCP clients

Any client that speaks the stdio MCP transport works. Same `command` / `args` shape.

## Testing

### Against a published build

```bash
npx @modelcontextprotocol/inspector npx ssh-client-mcp-server --host=1.2.3.4 --user=root --key=~/.ssh/id_ed25519
```

### Against a local build (after `pnpm build`)

```bash
pnpm inspect
```

This builds and launches the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) pointed at `dist/index.js`.

## Development

All tooling is delegated to [`ts-builds`](https://github.com/jordanburke/ts-builds):

```bash
pnpm validate      # format → lint → typecheck → test → build
pnpm test          # vitest run
pnpm test:watch    # vitest watch mode
pnpm build         # production build to dist/
pnpm dev           # tsdown watch mode to lib/
pnpm inspect       # build + launch MCP Inspector
```

Pure helpers (`parseArgv`, `validateConfig`, `resolveAuth`, `effectiveUser`) live in `src/config.ts` and are covered by `test/config.spec.ts` (18 cases, including tempfile-backed key reads and env-var expansion).

## Disclaimer

Provided under the [MIT License](./LICENSE). Use at your own risk. Not affiliated with or endorsed by any SSH vendor or MCP provider. Be careful granting LLMs shell access — audit commands, restrict target-account privileges, and consider a jump box.

## Contributing

Issues and PRs welcome at [jordanburke/ssh-client-mcp-server](https://github.com/jordanburke/ssh-client-mcp-server). Please run `pnpm validate` before submitting.
