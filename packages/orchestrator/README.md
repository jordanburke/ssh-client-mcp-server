# ssh-fleet-mcp-server

[![License](https://img.shields.io/github/license/jordanburke/ssh-client-mcp-server)](../../LICENSE)
[![NPM Version](https://img.shields.io/npm/v/ssh-fleet-mcp-server)](https://www.npmjs.com/package/ssh-fleet-mcp-server)

**ssh-fleet-mcp-server** is a Model Context Protocol (MCP) server that manages a fleet of SSH hosts behind a pooled connection layer. LLMs and MCP clients get a single server that can route `exec` and `tmux_*` commands to any configured host by name — no separate server process per host required.

Built on [`somamcp`](https://github.com/sapientsai/SomaMCP) and the shared `@ssh-mcp/core` package (pool, tmux builders, auth resolution).

## Contents

- [Quick Start](#quick-start)
- [First Run](#first-run)
- [Config Discovery](#config-discovery)
- [Fleet Config Schema](#fleet-config-schema)
- [Auth Modes](#auth-modes)
- [Secrets-by-Reference Rule](#secrets-by-reference-rule)
- [Tools](#tools)
- [Policy](#policy)
- [Audit Log](#audit-log)
- [CA Mode](#ca-mode)
- [Client Setup](#client-setup)
- [Running on Several Machines](#running-on-several-machines)
- [Command Line](#command-line)
- [Development](#development)

## Quick Start

1. Add the server to your MCP client with no `--config` — see [Client Setup](#client-setup).
2. Ask your LLM to call `fleet_setup`. On first start the server wrote a commented starter config; `fleet_setup` says where.
3. Uncomment an example host in that file, restart the server, and ask your LLM to list hosts or run commands.

## First Run

When no `--config` flag or `SSH_FLEET_CONFIG` is given and `~/.config/ssh-fleet/fleet.toml` doesn't exist, the server writes a starter config there (mode `0600`, folder `0700`) and starts with zero hosts. The file is all comments, with example blocks for a password host, a key host, a read-only policy and a CA; remove the leading `# ` from a block's lines to use it. Edits take effect on restart (in Claude Code, `/mcp` and reconnect).

- **Only the default path is created.** A `--config` or `SSH_FLEET_CONFIG` path that doesn't exist fails startup, so a typo can't give you a healthy-looking server with no hosts.
- **`fleet_setup` says what's missing:** an unset `password_env` variable, a host's last connection error, or a new CA's line to add on hosts.
- **A misconfigured host doesn't stop the server.** A `key` file that can't be read, an unset `key_env`, or `agent = true` without `SSH_AUTH_SOCK` (Claude Desktop doesn't pass it) fails that host's calls with the reason, and `fleet_setup` shows it from the first start.
- **A CA `key_file` that doesn't exist is created** (`ssh-keygen`, ed25519, `0600`). This keeps the key on disk; use `key_cmd` or `key_env` to keep it off disk instead. A typo in `key_file` creates a new CA that no host trusts, so check `fleet_setup` after any CA change.
- **One client per config in CA mode.** A second server on the same config fails on the `runtime_dir` lock before it can explain itself, and Claude Desktop hides stderr. Give each client its own config with its own `runtime_dir`.
- **Don't list the hub machine as a fleet host when its CA is a `key_file`.** An agent with `exec` there could read the key or use the server's private agent and sign its own certificates.
- **Two clients starting at once** can race to create the same CA key; the loser fails to load it, and a restart fixes it.

## Config Discovery

The server looks for its fleet configuration in this order:

1. `--config=<path>` CLI flag — explicit path wins.
2. `SSH_FLEET_CONFIG` environment variable — useful in Docker / systemd.
3. Default location: `~/.config/ssh-fleet/fleet.toml`.

If the default config is missing, the server creates it (see [First Run](#first-run)). If any other config file cannot be read, or a config contains validation errors, the server logs the problem and exits immediately (fail-fast). No host is connected until an MCP tool call is received (lazy connect via the pool).

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

### `[[hosts]]` (zero or more)

With none, the server starts and `fleet_setup` says what to add.

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

| Mode         | Field          | How it works                                                                             |
| ------------ | -------------- | ---------------------------------------------------------------------------------------- |
| Key file     | `key`          | Path to a PEM private key; `~` and `$VAR` are expanded at startup.                       |
| Key from env | `key_env`      | Name of an env var holding the PEM (injected by envpkt, Vault, Doppler).                 |
| SSH agent    | `agent = true` | Delegates to `SSH_AUTH_SOCK` — the server never sees the private key.                    |
| Password env | `password_env` | Name of an env var holding the password; read once at startup.                           |
| CA           | `ca`           | Names a `[[cas]]` entry; connects with a 10-minute certificate. See [CA Mode](#ca-mode). |

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

All tools except `hosts_list` and `fleet_setup` require a `host` parameter — the logical name of a configured fleet host (from `[[hosts]].name`). An unknown name raises an error immediately, before any SSH attempt.

The server also has somamcp's `info` tool. It reports the name, version and build: the short commit it was built from (with `-dirty` when the tree had uncommitted changes), the branch and the build date. Use it to tell which build a hub runs.

### `hosts_list`

List configured fleet hosts and their live connection-pool status.

Parameters: none.

Returns a JSON array of `{ name, state, inFlight }` objects, where `inFlight` is the count of currently active connections to that host. `state` is one of:

- `"connected"`: a pooled connection is open and running a command.
- `"idle"`: a pooled connection is open and waiting.
- `"disconnected"`: no open connection. This is normal: hosts connect on their first call and close after `idle_timeout_ms`.
- `"error"`: no open connection, and the last call failed for a connection reason: refused, auth, or a busy pool's `acquire_timeout_ms`. The row adds `last_error: { message, at }`, and stays `error` until the host's next successful call.

A CA host shows one row under its own name until its first call, then one row per agent, named `<host> (<agent>)`. If a host you added to the config is missing, the server started before the edit; `fleet_setup` says so.

### `fleet_setup`

Show setup state and what to do next. Read-only: it never writes config or keys. Audited like `hosts_list`.

Parameters: none.

Returns JSON:

- `config`: `{ path, created_this_start, changed_since_start }`. The server reads `fleet.toml` once, at start. When the file on disk differs, `config` adds `hosts_on_disk` (or `errors_on_disk`, if the new file doesn't parse), and the first next step says to reconnect the server.
- `next_steps`: what to do, in order: reconnect after a config edit (or fix the edited file's errors), add a host, set a missing `password_env` variable, add a new CA's line on hosts, and each host's last connection error.
- `hosts`: per host, `name`, `address` (`user@host:port`), `auth` (`password_env`, `key`, `key_env`, `agent` or `ca`), `connections` (the `hosts_list` rows for it), and when they apply `password_env` with `env_set` (never the value), `ca`, `principal`, `last_error` `{ message, at }`, and `enroll_line`.
- `cas`: per CA, `name`, `key_source` (`key_cmd`, `key_env` or `key_file`; a `key_cmd` string is never shown), `key_file`, `created_this_start`, `public_key` and `enroll_line` (`cert-authority,principals="…" <public key>`).
- `audit_log`, and in CA mode `runtime_dir` and `known_hosts`.

### `exec`

Run a one-shot shell command on a fleet host over SSH.

| Parameter | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `host`    | string | yes      | Configured host name.     |
| `command` | string | yes      | Shell command to execute. |

Returns stdout. If the command also wrote to stderr, the stderr text follows under a `[stderr]` line, so warnings stay visible. A non-zero exit raises a `UserError` with the host name, exit code, and stderr, then stdout under a `[stdout]` line (either one alone when the other is empty). Exit code 0 always succeeds, even with stderr: many tools, such as `systemctl`, warn on stderr and exit 0.

### `tmux_list`

List tmux sessions on a fleet host. Returns a JSON array of session names, empty when no tmux server is running.

The `tmux_*` tools find tmux on the host's `PATH`, then in `/opt/homebrew/bin` and `/usr/local/bin`. That covers Homebrew on macOS, where a command sent over SSH gets only `/usr/bin:/bin:/usr/sbin:/sbin`. `exec` gets no such help: to run other Homebrew tools through it, load Homebrew's `PATH` in the host's `~/.zshenv`.

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

## CA Mode

With `ca = "<name>"`, a host trusts one SSH certificate authority instead of a per-host key. The server holds the CA in a private `ssh-agent`, signs a **10-minute certificate** for each connection, and connects with the system `ssh` binary (OpenSSH: `ssh`, `ssh-keygen`, `ssh-agent`, `ssh-add`). Agents never hold an SSH credential.

```toml
runtime_dir = "/run/ssh-fleet"                 # optional; sockets and ephemeral keys
known_hosts = "~/.local/state/ssh-fleet/known_hosts"  # optional; the hub's own

[[cas]]
name = "home"
key_cmd = "security find-generic-password -s ssh-fleet-ca -w"   # or key_env / key_file
principal = "fleet"                  # default
source_address = "100.64.0.1/32"     # optional: certificates only work from here

[[hosts]]
name = "box-a"
host = "10.0.0.11"
user = "fleet-ro"
ca = "home"
```

| `[[cas]]` key    | Description                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `name`           | Letters, digits, hyphen, underscore. Hosts refer to it with `ca = "<name>"`.                          |
| `key_cmd`        | A shell command whose output is the CA private key (a keychain or password-manager read).             |
| `key_env`        | An env var holding the CA private key; removed from the environment once read.                        |
| `key_file`       | A key file: a regular file (not a symlink), mode `0600` or stricter, owned by the hub user.           |
| `principal`      | The principal certificates name (default `"fleet"`). A host may override it with its own `principal`. |
| `source_address` | An IPv4 or IPv6 CIDR; certificates are only accepted from those addresses.                            |

Exactly one of `key_cmd`, `key_env` or `key_file`. Inline keys are rejected.

`runtime_dir` (default `$XDG_RUNTIME_DIR/ssh-fleet`, else `~/.local/state/ssh-fleet/run`) must be a directory of its own: startup refuses one that holds files the server didn't create, and shutdown deletes only the server's own files. One server per `runtime_dir`: a second server started on the same one (say Claude Desktop and Claude Code with the same fleet config) fails startup with `runtime_dir … is in use by pid N` and leaves the first running. Give each its own config with its own `runtime_dir`.

### Enrolling a host

Add one line to a **root-owned** authorized-keys file for the account the host entry logs in as:

```
cert-authority,principals="fleet" ssh-ed25519 AAAA… ssh-fleet-ca
```

Use `AuthorizedKeysFile /etc/ssh/authorized_keys/%u` in `sshd_config`, or `TrustedUserCAKeys` plus `AuthorizedPrincipalsFile`. A user-writable `~/.ssh/authorized_keys` defeats the point: any agent with write access could append its own key and bypass the hub for good. The principal is just a label the certificate must carry; what limits access is **which account's** file holds the CA line, and that account's rights.

### The CA key at boot

The server loads the CA at startup with no interactive unlock, so it restarts unattended. Keep the canonical copy in your password manager, and give the server a working copy only it can read:

- **macOS:** `key_cmd` reading the hub user's keychain (`security find-generic-password -s ssh-fleet-ca -w`).
- **Linux:** a `0600` `key_file` owned by the hub user. If the file doesn't exist, the server creates it on first start, and `fleet_setup` shows the line to add on hosts.
- **Either:** `key_cmd` against a non-interactive secrets service (`op read …`, Bitwarden Secrets Manager, Infisical), or `key_env`.

The key reaches `ssh-add` on stdin; the server never writes it to disk except when it creates a missing `key_file`. A `key_cmd` must finish within 30 seconds and runs without a terminal, so a command that would prompt fails startup, naming the CA, instead of hanging.

### What a certificate allows

- **10 minutes,** key ID = the agent's name, the configured principal, and an increasing serial.
- **No** port forwarding, agent forwarding, X11 forwarding or `~/.ssh/rc`; optional `source_address`.
- Each (agent, host) pair gets its own master connection and its own certificate, so one agent never rides another's session, and the host's sshd log names the agent (`Accepted certificate ID "claude"`).
- A master is retired when its certificate expires; calls in flight finish, and the next call gets a fresh certificate.
- Host keys are trusted on first use, recorded in the hub's own `known_hosts`.
- `~/.ssh/config` is **ignored** (`-F /dev/null`), so nothing in it can add an identity. `ProxyJump` isn't supported yet.
- At startup the server mints and discards one certificate per CA, so a CA it can't sign with, or a certificate option `ssh-keygen` rejects, stops startup instead of failing every call.
- A master to a host that stops answering drops within about 45 seconds (SSH keepalives).
- After a crash, the next start stops the old agent and any masters it left running, and clears stale sockets and keys from `runtime_dir`. It stops a process only if `ps` shows it is `ssh-agent` or `ssh` on a socket in that `runtime_dir`, so a reused process ID never takes down anything else.

### Revoking access

- **Stop the server:** no new certificates; outstanding ones expire within 10 minutes and their masters are retired.
- **Cut access now:** remove the CA line from the host.
- **Separate trust domains** (fleets run by different parties): use separate `[[cas]]` entries, so each can be revoked alone.

### Enforcement

CA mode governs access only if the server is the **only** path. Run it as its own OS user (a launchd or systemd service), so agent processes running as you can't read the CA key, the certificates or the audit log, and don't give your interactive user unrestricted `sudo`. Over stdio, as the same user as the agent, nothing is governed.

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

With no `--config`, the server uses `~/.config/ssh-fleet/fleet.toml` and creates it on first start (see [First Run](#first-run)). Put each host's `password_env` / `key_env` variables in the `env` block:

```json
{
  "mcpServers": {
    "ssh-fleet": {
      "command": "node",
      "args": ["packages/orchestrator/dist/index.js"],
      "env": { "MINI_SSH_PASSWORD": "…" }
    }
  }
}
```

Or via `npx` once published, with an explicit config (which must already exist):

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

Set `SSH_FLEET_CONFIG` in your environment (or the MCP client's `env` block) if you prefer the env-var discovery path over an explicit `--config` flag. In CA mode, give each client its own config and `runtime_dir`.

These examples run from a clone of this repo. For an installed server on another machine, see [Running on Several Machines](#running-on-several-machines).

## Running on Several Machines

A machine that runs this server and logs in to fleet hosts is a **hub**. Each hub keeps its own config (`~/.config/ssh-fleet/fleet.toml`), its own audit log, and its own credentials.

### Where to register the server

Register it in the MCP config of a folder you start admin sessions from (for example `~/admin/.mcp.json`), not in your user-wide config. Only sessions started there get fleet access. Claude Code asks you to approve a folder's servers the first time; until then `claude mcp list` shows them as pending approval.

In CA mode, two Claude Code sessions started in that folder load the same config, so the second session's server fails on the `runtime_dir` lock. Start the second one from another folder, or with `claude --strict-mcp-config --mcp-config <file>`, where `<file>` starts the server with a `--config` that has its own `runtime_dir`. Without `--strict-mcp-config`, the folder's `.mcp.json` still loads and its server still collides.

Use full paths. An MCP client launched from a GUI may not have Homebrew's `PATH`, and the package's `#!/usr/bin/env node` needs `node` on it. On an Apple silicon Mac with Homebrew (`/usr/local/bin` on Intel):

```json
{
  "mcpServers": {
    "ssh-fleet": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/opt/homebrew/bin/ssh-fleet-mcp-server"]
    }
  }
}
```

### Installing before an npm release

Until `ssh-fleet-mcp-server` is on npm, pack it on a machine with this repo, copy the tarball to the hub, and install it there:

```sh
cd packages/orchestrator && pnpm build && pnpm pack          # → ssh-fleet-mcp-server-<version>.tgz
scp ssh-fleet-mcp-server-<version>.tgz <hub>:/tmp/
```

Then, in a terminal on the hub (not `ssh <hub> npm …`, which gets the bare `PATH` described under [macOS hosts](#macos-hosts) and won't find Homebrew's or nvm's `npm`):

```sh
npm install -g /tmp/ssh-fleet-mcp-server-<version>.tgz
```

`npm uninstall -g ssh-fleet-mcp-server` removes it. A later npm release replaces it the same way.

### Credentials: one key per hub and host

Start with a separate key for each hub and host it logs in to. Leave it without a passphrase (`-N ""`): the server can't unlock one.

```sh
ssh-keygen -t ed25519 -N "" -C ssh-fleet@<hub> -f ~/.ssh/fleet_<host>   # on the hub
```

On the host, add the public key to the fleet account's `~/.ssh/authorized_keys`, limited to the hub's address (a CIDR such as `10.0.0.0/24` if it changes) and with forwarding and terminals turned off. The server runs every tool on a plain exec channel, so it needs none of them:

```
from="<hub address>",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… ssh-fleet@<hub>
```

In CA mode the certificate carries the same limits, so hosts need no such options.

Then `key = "~/.ssh/fleet_<host>"` in the hub's config, and `ssh-fleet-mcp-server check` on the hub. To cut off one hub, delete its line on each host; the other hubs keep working. The cost grows with the fleet: three hubs and five hosts is fifteen lines to add and remove.

### Why not one key in a password manager

A password manager's SSH agent (1Password, Bitwarden) can serve one key to every hub through `agent = true`, but it fits a fleet server badly:

- **It needs the app running and unlocked,** and it may ask you to approve each use. On a hub that restarts unattended, nobody is there to approve.
- **Claude Desktop doesn't pass `SSH_AUTH_SOCK`.** An `agent = true` host there fails every call, and `fleet_setup` says why, unless you set `SSH_AUTH_SOCK` in the server's `env` block.
- **One shared key widens the damage.** A compromised hub exposes every host, and revoking the key cuts off every hub.

### Centralizing: CA mode

To manage access in one place, use [CA Mode](#ca-mode) instead:

- **One CA key; each host trusts it once,** with one `cert-authority` line in a root-owned authorized-keys file. Each hub signs itself a 10-minute certificate per connection.
- **Adding a hub doesn't touch the hosts.** The new hub gets a working copy of the CA key.
- **Keep the canonical copy in your password manager,** and give each hub its working copy once (see [The CA key at boot](#the-ca-key-at-boot)). No hub needs the password manager unlocked at runtime.
- **The config can be shared.** When every host uses `ca`, `fleet.toml` holds no secrets. A dotfiles manager can sync one copy to every hub if every hub reads the CA key the same way: `key_env`, or a `key_file` at the same path under `~`. Two traps:
  - **Place the hub's working CA copy before the config arrives.** Otherwise the server finds no `key_file`, creates a new CA that no host trusts, and every connection fails.
  - **Widen `source_address` to cover every hub,** or certificates signed on the other hubs are refused.

Two limits: enrolling a host needs root once, and only one server can run per `runtime_dir`, so two sessions on one hub need separate configs.

### macOS hosts

- **Turn on Remote Login** (System Settings → General → Sharing).
- **`tmux_*` tools find Homebrew's tmux** without setup (see [`tmux_list`](#tmux_list)).
- **`exec` gets a bare `PATH`** (`/usr/bin:/bin:/usr/sbin:/sbin`): a command sent over SSH runs in a non-login shell, and zsh, the macOS default, doesn't read `~/.zprofile` then. For Homebrew tools through `exec`, add `eval "$(/opt/homebrew/bin/brew shellenv)"` (`/usr/local/bin/brew` on Intel) to the fleet account's `~/.zshenv`.

## Command Line

### `check`

```sh
ssh-fleet-mcp-server check [--config=<path>]
```

Connects to every host from a terminal and runs `true`, printing one line per host as it finishes, then each CA's enrollment line. Exits 0 when every host passes (or there are none), 1 otherwise.

```
ok    mini me@mini.local:22   password_env 212 ms
FAIL  nas  fleet@nas.local:22 ca           Permission denied (publickey).
CA home: cert-authority,principals="fleet" ssh-ed25519 AAAA… ssh-fleet-ca-home
```

- It never creates a config or key. A CA whose `key_file` is missing fails its hosts with a hint, without connecting.
- It skips policy, so it can run `true` even on a `readonly` or `deny` host. Each probe is audited with `tool: "check"`, `agent: "operator"`, `bypass: "policy"`. It isn't reachable over MCP.
- It uses its own runtime dir (`<runtime_dir>-check`), so it works while the server is running.
- A `ForceCommand` account that doesn't allow `true` fails the check.
- Run it with the same environment the MCP client gives the server, so `password_env` and `key_env` variables are set.

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
