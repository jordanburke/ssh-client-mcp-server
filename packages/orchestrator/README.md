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
- [Policy](#policy)
- [Audit Log](#audit-log)
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

The fleet config is a [TOML](https://toml.io) file with four top-level sections.

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

### `[audit]` (optional)

Where the audit log is written. See [Audit Log](#audit-log).

| Key    | Type   | Default                                | Description                                                         |
| ------ | ------ | -------------------------------------- | ------------------------------------------------------------------- |
| `path` | string | `~/.local/state/ssh-fleet/audit.jsonl` | Audit log file (supports `~` and `$VAR`). Created with mode `0600`. |

### `[defaults.policy]` / `[hosts.policy]` (optional)

Per-host rules checked before every tool call. See [Policy](#policy). A key in a host's `[hosts.policy]` replaces the same key from `[defaults.policy]`; lists are replaced, not merged.

| Key              | Type     | Built-in default | Description                                                                               |
| ---------------- | -------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `mode`           | string   | `"readwrite"`    | `"readonly"`, `"readwrite"` or `"deny"`.                                                  |
| `tmux`           | string   | `"open"`         | `"approve"` or `"open"`; gates `tmux_send` / `tmux_keys` on a `readwrite` host.           |
| `allow`          | string[] | —                | `readonly` only: regexes a whole `exec` command must match.                               |
| `needs_approval` | string[] | —                | `readwrite` only: regexes that, matching anywhere in an `exec` command, require approval. |
| `agents`         | string[] | —                | Agents allowed on this host. `claude` matches `claude` and every `claude@<instance>`.     |

An empty list means "not set": `allow = []` is how a host drops an `allow` list it would otherwise inherit. With no policy anywhere, every call is allowed, as before policy existed.

### `[[hosts]]` (required, one or more)

Each `[[hosts]]` entry defines a remote machine. Host names must be unique and may contain only letters, digits, hyphens, and underscores.

| Key            | Type   | Required | Description                                                                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `name`         | string | yes      | Logical name used as the `host` param in tool calls.                                                               |
| `host`         | string | yes      | Hostname or IP address.                                                                                            |
| `port`         | int    | no       | Overrides `[defaults].port`.                                                                                       |
| `user`         | string | no       | Overrides `[defaults].user`.                                                                                       |
| `tmux_session` | string | no       | Overrides `[defaults].tmux_session`.                                                                               |
| `log_output`   | bool   | no       | Add a 1024-character excerpt of `exec` output to the audit log. Off by default because output can contain secrets. |
| `key`          | string | no\*     | Path to private SSH key (supports `~` and `$VAR`).                                                                 |
| `key_env`      | string | no\*     | Name of env var holding the private key PEM.                                                                       |
| `agent`        | bool   | no\*     | `true` to use `SSH_AUTH_SOCK` (ssh-agent / 1Password / Bitwarden).                                                 |
| `password_env` | string | no\*     | Name of env var holding the SSH password.                                                                          |

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

## Policy

Each host-routed call is checked against its host's policy before it runs. `hosts_list` is never gated. The first matching rule decides:

1. **`mode = "deny"`** — every tool on the host is denied.
2. **`agents`** — if set and the calling agent isn't listed, the call is denied.
3. **`tmux_list` / `tmux_read`** — allowed.
4. **`tmux_send` / `tmux_keys`** — denied on a `readonly` host. On a `readwrite` host, `tmux = "approve"` requires approval and `tmux = "open"` allows. (`allow` and `needs_approval` can't gate tmux input: it can be split across calls.)
5. **`exec` on a `readonly` host** — denied if the command contains a newline, carriage return, NUL or any of ``; & | $ ` ( ) < > { } \ ' " * ? [ ~``. Otherwise it must match some `allow` pattern **as a whole** (each pattern is wrapped as `^(?:…)$`, no regex flags).
6. **`exec` on a `readwrite` host** — requires approval if any `needs_approval` pattern matches anywhere in the command; otherwise allowed.

A denied call returns `[<host>] denied by rule <rule>: <reason>` to the agent and is logged with `decision: "deny"`, `rule` and `reason` (see [Audit Log](#audit-log)).

**Read before relying on it:**

- **`readonly` is an allowlist, on purpose.** There is no deny-list mode: deny-lists over shell text are trivially bypassed (`r''m`, `$(…)`, `sh -c`). Spell out the characters a pattern allows, as in `systemctl status [\w@.-]+`. **Never use `.`, `.*` or `\S` in an `allow` pattern.**
- **Write patterns as TOML literal strings.** In a TOML double-quoted string `\w` is an invalid escape and fails startup. Use single quotes, `'systemctl status [\w@.-]+'`, or double each backslash, `"systemctl status [\\w@.-]+"`. Patterns have no regex flags, so group an emoji or other astral character before repeating it: `(?:😀)+`.
- **Avoid nested quantifiers** such as `(\w+ ?)+` in `allow` and `needs_approval`. Patterns run synchronously, and one that backtracks badly can stall the whole server, not just one host. As a backstop, a command longer than 4096 characters is denied whenever policy patterns would be matched against it (any `readonly` host, or a `readwrite` host with `needs_approval`).
- **`needs_approval` is a tripwire, not a boundary.** It catches honest mistakes; an agent trying to get around it can.
- **Approval isn't available yet,** so anything that requires approval is **denied**. `tmux = "approve"` is the recommended setting once approval ships; the built-in default is `"open"`.
- **Agent identity isn't available yet** — every agent is `"unknown"` — so a host with `agents` set denies every call. The server prints a warning naming each such host at startup.
- **Over stdio, nothing is governed.** A stdio server runs as the agent's own OS user, so the agent can bypass every rule here with its own shell and credentials. Governance needs the hub to run as a separate user that alone holds the SSH credentials.
- **The real boundary is the remote account** the host entry logs in as, and its `sudoers`.

### Sample restricted account

On a `readonly` host, log in as a dedicated account that can only read. For example, a `fleet-ro` user with no `sudo` except this `/etc/sudoers.d/fleet-ro`:

```
fleet-ro ALL=(root) NOPASSWD: /usr/bin/systemctl status *, /usr/bin/journalctl -u *
```

- In sudoers, `*` matches **any** trailing arguments, so these entries allow `systemctl status` and `journalctl -u` with anything after them. Keep the list to commands that are harmless with any arguments.
- The `allow` patterns must then include the `sudo ` prefix, for example `sudo systemctl status [\w@.-]+` and `sudo journalctl -u [\w@.-]+ -n \d+`.

## Audit Log

Every tool call that runs writes two JSON lines to the audit log (see [`[audit]`](#audit-optional)): a `decision` line **before** the call runs and a `result` line after it, sharing `id`. A call that hangs or crashes the server is still on record. A call denied by [policy](#policy) never runs, so it writes only its decision line.

```json
{"ts":"2026-10-17T14:02:11.000Z","id":"5f0c…","event":"decision","agent":"unknown","tool":"exec","host":"box-a","command":"systemctl status cups","decision":"allow","rule":"box-a:readonly"}
{"ts":"2026-10-17T14:02:11.412Z","id":"5f0c…","event":"result","agent":"unknown","tool":"exec","host":"box-a","status":"ok","ms":412,"code":0,"stdout_bytes":1830,"stderr_bytes":0}
```

What each tool records:

| Tool         | Decision line                | Result line                                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------- |
| `hosts_list` | (no `host`)                  | —                                                                                     |
| `exec`       | `command`                    | `code`, `stdout_bytes`, `stderr_bytes`; plus excerpts when the host sets `log_output` |
| `tmux_list`  | —                            | —                                                                                     |
| `tmux_send`  | `session`, `input`, `submit` | —                                                                                     |
| `tmux_read`  | `session`, `lines`           | `stdout_bytes` (never the transcript)                                                 |
| `tmux_keys`  | `session`, `keys`            | —                                                                                     |

- **Sizes, not contents.** Output can contain secrets, so only byte counts are logged. A host with `log_output = true` also gets `stdout_excerpt` / `stderr_excerpt` (first 1024 characters) on `exec`.
- **`status`** is `"ok"` when the call completed (an `exec` with a non-zero exit is still `"ok"`, with its `code`) and `"error"` with an `error` message when it didn't, for example an unknown host.
- **`decision`** is `"allow"` or `"deny"`. **`rule`** names the policy rule that decided, qualified by host (`box-a:readonly`); it is absent when no policy applies (`hosts_list`, an unknown host). A deny line also has a **`reason`**.
- **`agent`** is `"unknown"` until per-agent identity lands.
- **No unaudited calls.** The server refuses to start if the log can't be written, and a call whose audit line can't be written fails.
- **The file is reopened for every line,** so a deleted or rotated log is recreated at mode `0600`. A symlink at the audit path is refused rather than followed.
- **Append-only is best effort** — the server's user can truncate its own file. For stronger integrity, set the OS append-only flag from an administrator account: `sudo chattr +a <file>` (Linux) or `sudo chflags uappend <file>` (macOS). Rotation is out of scope.

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
user = "fleet-ro"
key = "~/.ssh/id_ed25519"
  [hosts.policy]
  mode = "readonly"
  allow = ['sudo systemctl status [\w@.-]+', 'sudo journalctl -u [\w@.-]+ -n \d+', 'df -h', 'uptime']

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
