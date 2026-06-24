# ssh-fleet-mcp-server

[![License](https://img.shields.io/github/license/jordanburke/ssh-client-mcp-server)](../../LICENSE)
[![NPM Version](https://img.shields.io/npm/v/ssh-fleet-mcp-server)](https://www.npmjs.com/package/ssh-fleet-mcp-server)

**ssh-fleet-mcp-server** is a Model Context Protocol (MCP) server that manages a fleet of SSH hosts behind a pooled connection layer. LLMs and MCP clients get a single server that can route `exec` and `tmux_*` commands to any configured host by name — no separate server process per host required.

Built on [`somamcp`](https://github.com/sapientsai/SomaMCP) and the shared `@ssh-mcp/core` package (pool, tmux builders, auth resolution).

## Contents

- [Quick Start](#quick-start)
- [Config Discovery](#config-discovery)
- [Fleet Config Schema](#fleet-config-schema)
- [Auth Modes](#auth-modes)
- [Secrets-by-Reference Rule](#secrets-by-reference-rule)
- [Tools](#tools)
- [Client Setup](#client-setup)
- [Development](#development)

## Quick Start

1. Copy `fleet.example.toml` (in this directory) to `~/.config/ssh-fleet/fleet.toml` and fill in your hosts.
2. Configure your MCP client to launch this server — see [Client Setup](#client-setup).
3. Ask your LLM to list hosts or run commands across the fleet.

## Config Discovery

The server looks for its fleet configuration in this order:

1. `--config=<path>` CLI flag — explicit path wins.
2. `SSH_FLEET_CONFIG` environment variable — useful in Docker / systemd.
3. Default location: `~/.config/ssh-fleet/fleet.toml`.

If the config file cannot be read, or if it contains validation errors, the server logs the problem and exits immediately (fail-fast). No host is connected until an MCP tool call is received (lazy connect via the pool).

## Fleet Config Schema

The fleet config is a [TOML](https://toml.io) file with three top-level sections.

### `[defaults]` (optional)

Default values applied to every host that does not override them.

| Key            | Type   | Default   | Description                                         |
| -------------- | ------ | --------- | --------------------------------------------------- |
| `port`         | int    | `22`      | SSH port.                                           |
| `user`         | string | OS user   | SSH username. Falls back to the OS user if omitted. |
| `tmux_session` | string | `"agent"` | Default tmux session name for `tmux_*` tools.       |

### `[pool]` (optional)

Controls the shared per-host connection pool.

| Key                  | Type | Default | Description                                                       |
| -------------------- | ---- | ------- | ----------------------------------------------------------------- |
| `max_per_host`       | int  | `2`     | Maximum concurrent SSH connections per host.                      |
| `idle_timeout_ms`    | int  | `60000` | Idle connection eviction interval (ms).                           |
| `acquire_timeout_ms` | int  | `30000` | How long to wait for a pool slot before failing a tool call (ms). |

### `[[hosts]]` (required, one or more)

Each `[[hosts]]` entry defines a remote machine. Host names must be unique and may contain only letters, digits, hyphens, and underscores.

| Key            | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `name`         | string | yes      | Logical name used as the `host` param in tool calls.               |
| `host`         | string | yes      | Hostname or IP address.                                            |
| `port`         | int    | no       | Overrides `[defaults].port`.                                       |
| `user`         | string | no       | Overrides `[defaults].user`.                                       |
| `tmux_session` | string | no       | Overrides `[defaults].tmux_session`.                               |
| `key`          | string | no\*     | Path to private SSH key (supports `~` and `$VAR`).                 |
| `key_env`      | string | no\*     | Name of env var holding the private key PEM.                       |
| `agent`        | bool   | no\*     | `true` to use `SSH_AUTH_SOCK` (ssh-agent / 1Password / Bitwarden). |
| `password_env` | string | no\*     | Name of env var holding the SSH password.                          |

\*Exactly one auth field is required per host. See [Auth Modes](#auth-modes).

## Auth Modes

Each host must specify exactly one authentication method:

| Mode         | Field          | How it works                                                             |
| ------------ | -------------- | ------------------------------------------------------------------------ |
| Key file     | `key`          | Path to a PEM private key; `~` and `$VAR` are expanded at startup.       |
| Key from env | `key_env`      | Name of an env var holding the PEM (injected by envpkt, Vault, Doppler). |
| SSH agent    | `agent = true` | Delegates to `SSH_AUTH_SOCK` — the server never sees the private key.    |
| Password env | `password_env` | Name of an env var holding the password; read once at startup.           |

## Secrets-by-Reference Rule

**Inline `password` and `private_key` fields are rejected at parse time.** The parser will refuse to start if you write:

```toml
# WRONG — fails validation
[[hosts]]
name = "bad"
host = "example.com"
password = "hunter2"
```

Use `password_env` pointing at an environment variable instead. This keeps secrets out of the config file and out of source control.

## Tools

All tools except `hosts_list` require a `host` parameter — the logical name of a configured fleet host (from `[[hosts]].name`). An unknown name raises an error immediately, before any SSH attempt.

### `hosts_list`

List configured fleet hosts and their live connection-pool status.

Parameters: none.

Returns a JSON array of `{ name, state, inFlight }` objects, where `state` is one of `"connected"`, `"idle"`, or `"disconnected"`, and `inFlight` is the count of currently active connections to that host.

### `exec`

Run a one-shot shell command on a fleet host over SSH.

| Parameter | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `host`    | string | yes      | Configured host name.     |
| `command` | string | yes      | Shell command to execute. |

Returns stdout. If the command exits non-zero and stderr is non-empty, the tool raises a `UserError` with the host name, exit code, and stderr text.

### `tmux_list`

List tmux sessions on a fleet host. Returns a JSON array of session names.

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `host`    | string | yes      | Configured host name. |

### `tmux_send`

Type text into a persistent tmux session on a fleet host. Creates the session if it does not exist.

| Parameter | Type    | Required | Description                                                |
| --------- | ------- | -------- | ---------------------------------------------------------- |
| `host`    | string  | yes      | Configured host name.                                      |
| `session` | string  | no       | tmux session name (defaults to the host's `tmux_session`). |
| `input`   | string  | yes      | Text to type.                                              |
| `submit`  | boolean | no       | Press Enter after the text (default `true`).               |

### `tmux_read`

Capture the recent pane transcript of a tmux session on a fleet host.

| Parameter | Type   | Required | Description                                                |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| `host`    | string | yes      | Configured host name.                                      |
| `session` | string | no       | tmux session name (defaults to the host's `tmux_session`). |
| `lines`   | int    | no       | Lines of scrollback (default 200; capped at 2000).         |

### `tmux_keys`

Send control/special keys (e.g. `C-c`) to a tmux session on a fleet host.

| Parameter | Type     | Required | Description                                                |
| --------- | -------- | -------- | ---------------------------------------------------------- |
| `host`    | string   | yes      | Configured host name.                                      |
| `session` | string   | no       | tmux session name (defaults to the host's `tmux_session`). |
| `keys`    | string[] | yes      | tmux key names, e.g. `["C-c"]`.                            |

## Example Config

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

## Client Setup

### `.mcp.json` / `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ssh-fleet": {
      "command": "node",
      "args": ["packages/orchestrator/dist/index.js", "--config=${SSH_FLEET_CONFIG}"]
    }
  }
}
```

Or via `npx` once published:

```json
{
  "mcpServers": {
    "ssh-fleet": {
      "command": "npx",
      "args": ["-y", "ssh-fleet-mcp-server", "--config=/path/to/fleet.toml"]
    }
  }
}
```

Set `SSH_FLEET_CONFIG` in your environment (or the MCP client's `env` block) if you prefer the env-var discovery path over an explicit `--config` flag.

## Development

All tooling is delegated to [`ts-builds`](https://github.com/jordanburke/ts-builds). Run from the repo root:

```bash
pnpm -r validate      # validate all packages (core, connector, orchestrator)
```

Or from this package directory:

```bash
pnpm validate         # format → lint → typecheck → test → build
pnpm test             # vitest run
pnpm test:watch       # vitest watch mode
pnpm build            # production build to dist/
```

Integration tests (requiring a live SSH server on localhost) are automatically skipped when the host is not reachable — CI remains green in environments without SSH available.
