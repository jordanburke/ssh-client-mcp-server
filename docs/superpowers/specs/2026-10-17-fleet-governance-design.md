# Design: fleet-orchestrator MCP — governance layer

**Date:** 2026-10-17
**Status:** Draft; pending review
**Author:** Jordan Burke (with Claude)

## Summary

Turn `ssh-fleet-mcp-server` from a convenience tool into the **one governed way
agents reach machines**: every call is attributed to a named agent, checked
against per-host policy, optionally held for human approval, and written to an
audit log. Hosts stop trusting per-host keys and instead trust an SSH
certificate authority (CA) whose private key only the hub holds; the hub mints a
short-lived certificate per connection.

This builds on the connection-manager layer
(`2026-06-24-fleet-orchestrator-connection-manager-design.md`). The tool surface
is unchanged apart from attribution; the scheduler (subsystem B) remains out of
scope.

## Motivation

Several agents (Claude Code, Codex, other harnesses) need occasional admin
access to a small fleet that spans more than one tailnet and both macOS and
Linux. The existing options don't fit:

- **Tailscale SSH** can't target nodes running the macOS GUI app, and it is
  governed per tailnet, so it can't cover a cross-tailnet fleet.
- **Teleport** covers SSH and MCP but needs a cluster with a valid TLS
  certificate, and it's unclear what the free tier licenses and whether it
  includes MCP access. **Warpgate** records sessions but has no MCP support or
  per-agent identity.
- **Agent-specific brokers** (agent-ssh, ShellGuard) are early previews.

The fleet server already owns the registry, the pool, and the tool surface; the
missing pieces are identity, policy, approval, audit, and credential custody.

## The enforcement property

**A governance layer is only real if it is the only path.** If an agent has a
shell *and* a usable credential, it can run `ssh` itself and bypass every rule
here. Therefore:

1. **Agents never hold an SSH credential.** Hosts trust only the hub's CA.
2. **Agents can't add their own credential on a host.** A user-writable
   `~/.ssh/authorized_keys` lets any agent with write access append its own key
   and go around the hub for good. Enrolled hosts therefore use root-owned key
   files, in one of two ways:
   - `AuthorizedKeysFile /etc/ssh/authorized_keys/%u`
   - `TrustedUserCAKeys` plus `AuthorizedPrincipalsFile`
3. **The hub runs as a separate OS identity**, such as a dedicated user under
   launchd or systemd.
   - Agent processes, running as the interactive user, can't read the CA key,
     the minted certificates, or the audit log.
   - The interactive user must not have unrestricted `sudo` on the hub machine,
     or this separation is moot.
4. **Agents reach the hub over HTTP**, on localhost or the tailnet, not stdio. A
   stdio server is a child of the agent process and shares its identity.

**Limits, stated plainly:**
- A remote account with `readwrite` policy and `sudo` can't be contained against
  a determined agent. On such hosts, governance gives *attribution and
  approval*, not containment.
- Containment comes from a restricted remote account, as in Phase 2.

Running the server over stdio as the same user remains supported for
convenience. It is explicitly *not* governed, and the docs must say so.

## Seamless operation

**Goal:** after one-time setup, governance asks the human for nothing on a
normal day. Security that prompts daily gets disabled, so each credential below
is unattended by design.

| Thing | Set up | Recurring prompts |
|-------|--------|-------------------|
| Host enrollment | Once per host (one CA line) | None |
| CA key in the hub | Once: install it into the hub user's protected store | None, including across reboots and restarts |
| Agent tokens | Once per agent, in its MCP config | None; tokens don't expire, and are rotated by hand if leaked |
| Certificates | Never; minted and renewed automatically | None |
| Approvals | Policy decides which commands need one | Only flagged commands, with sticky grants (below) |

**CA key at boot.** The hub must restart unattended, so it can't depend on an
interactive vault unlock. The canonical copy lives in the user's password
manager (for backup and recovery). The hub reads its working copy at startup
from a store only the hub user can read:

- **macOS:** the hub user's keychain or the System keychain, read by the launchd
  daemon.
- **Linux:** a `0600` file owned by the hub user.
- **Alternative:** a non-interactive secrets service using a machine token, such
  as Bitwarden Secrets Manager or Infisical.

`ca_key_cmd` remains for these cases. Here, OS file and user separation is the
protection, the same boundary that already guards the agent socket.

**Sticky approvals.** An approval can be granted once, or for a window:

- **Approve 1h** grants the window for this agent, host and rule.
- **Approve today** lasts until local midnight.

The ntfy notification offers all three. Grants live in memory, are audited, and
are dropped on restart. This keeps a working session from producing a stream of
taps. Policy should be tuned so routine commands never need approval at all.

**The human's own SSH** is outside the hub. A password-manager SSH agent with
biometric unlock and an "until screen lock" timeout gives one Touch ID per
session, not per connection.

## Architecture

```
agent (Claude / Codex / …)
   │  HTTP + bearer token (per agent)
   ▼
ssh-fleet-mcp-server  ── runs as a dedicated OS user
   ├─ identify   token → agent name
   ├─ policy     fleet.toml rules → allow / deny / needs_approval
   ├─ approve    ntfy push (or MCP elicitation) → wait → allow / deny
   ├─ audit      append JSONL (before and after each call)
   ├─ mint       sign ephemeral key → cert (-I <agent>, -n <principal>, 10m)
   └─ pool       OpenSSH runner (ControlMaster), keyed by (host, agent)
                                                   │
host: root-owned authorized keys contain only      │
  cert-authority,principals="fleet" <ca.pub>  ◄────┘
```

New code lives in `packages/orchestrator` (`identity.ts`, `policy.ts`,
`approval.ts`, `audit.ts`) and in `packages/core` (`ca.ts`, `openssh.ts`). Each
module sits behind an injected seam, following the pool's `ConnectFactory`
pattern.

## Phases

Each phase ships independently and is useful alone. Phases 1 and 2 work with
the current auth modes. Phase 3 *adds* an `auth = "ca"` mode alongside them.

### Phase 1 — Audit log

Append one JSON line per tool call to `audit.jsonl`. The path comes from
config; the default is `~/.local/state/ssh-fleet/audit.jsonl` under the hub
user, with mode `0600`.

```json
{"ts":"2026-10-17T14:02:11Z","id":"01J…","agent":"claude","tool":"exec",
 "host":"box-a","command":"systemctl status cups","decision":"allow",
 "rule":"box-a:readonly","code":0,"ms":412,"stdout_bytes":1830}
```

- **Two lines per call.** Write a `decision` line **before** execution and a
  `result` line after, sharing `id`, so a call that hangs or crashes the server
  is still recorded.
- **Sizes, not contents.** Record the command text and the output *sizes*, not
  the output itself, because output can contain secrets. An opt-in
  `log_output = true` per host stores a truncated excerpt.
- **tmux tools:** `tmux_send` logs the input text; `tmux_read` logs only the
  line count.
- **Agent name:** before phase 4, and in stdio mode, `agent` is `"unknown"`.
- **Append-only is best effort locally,** since the hub user can truncate its
  own files.
  - For stronger integrity, set the OS append-only flag (`chattr +a` on Linux,
    `chflags uappend` on macOS) from an administrator account.
  - Alternatively, also forward lines to a remote sink such as syslog.
  - Rotation is out of scope.

### Phase 2 — Policy

Per-host rules in `fleet.toml`, evaluated before execution:

```toml
[defaults.policy]
mode = "readwrite"          # "readonly" | "readwrite" | "deny"
tmux = "approve"            # "approve" | "open" (applies to tmux_send/tmux_keys)

[[hosts]]
name = "box-a"
host = "10.0.0.11"
agent = true
  [hosts.policy]
  mode = "readonly"
  allow = ["systemctl (status|is-active) [\\w@.-]+", "journalctl -u [\\w@.-]+ -n \\d+", "df -h", "uptime"]
  agents = ["claude", "codex"]        # phase 4: who may use this host

[[hosts]]
name = "box-b"
host = "build.example.com"
agent = true
  [hosts.policy]
  mode = "readwrite"
  needs_approval = ["sudo", "reboot", "rm", "shutdown"]
```

**Evaluation order for `exec`**
1. Host `mode = "deny"`.
2. Agent not listed in `agents`.
3. **`readonly`:**
   - Reject the command if it contains a newline or a shell metacharacter
     (`; & | $ \` ( ) < > { }`).
   - Otherwise, require a full match against some `allow` pattern. Patterns are
     implicitly wrapped as `^(?:…)$`, so a match covers the whole command.
4. **`readwrite`:**
   - If any `needs_approval` pattern matches anywhere in the command, require
     approval.
   - Otherwise, allow.

**Rules and limits**
- **`readonly` is an allowlist.** There is no deny-list mode, because deny-lists
  over shell text are trivially bypassed (`r''m`, `$(…)`, `sh -c`).
- **`needs_approval` is a tripwire, not a boundary.** It catches honest
  mistakes. An adversarial agent can obfuscate around it, which is why the
  enforcement section above limits what it promises.
- **tmux tools:** `allow` and `needs_approval` apply to `exec` only.
  - `tmux_send` and `tmux_keys` type arbitrary input. Splitting input across
    calls, for example `submit=false` followed by `tmux_keys Enter`, defeats any
    text pattern.
  - Under `readonly` they are denied.
  - Under `readwrite`, the host's `tmux` setting decides: `"approve"` requires
    approval for every call; `"open"` is audit-only.
  - `tmux_list` and `tmux_read` are always allowed.
- **The real boundary is the remote account.** It is the account named by the
  host entry's `user`, plus that account's `sudoers`. The docs must show a
  sample restricted account.
- **Startup validation.** Policy checks join the existing fail-fast checks:
  - an invalid regex
  - an unknown `mode` or `tmux` value
  - `allow` set without `readonly`
- **Denials name the rule.** They return a `UserError` naming the rule, so the
  agent can explain or ask.
- **Timeouts.** A per-host `max_timeout_ms` is deferred: `exec` has no timeout
  today, and adding one belongs in the pool, not in policy.

### Phase 3 — CA custody and certificate minting

**Constraint discovered during design:** `ssh2` v1.17 has no OpenSSH
certificate support. Its key parser recognises the `-cert-v01` type names but
neither parses nor authenticates with certificates. Phase 3 therefore adds a
second `ConnectFactory`.

**`opensshConnect` (`core/openssh.ts`)** drives the system `ssh` binary through
a per-(host, agent) `ControlMaster` socket in the hub's private runtime
directory.

- **Exec:** `ssh -S <sock> -o ControlMaster=no <host> -- <cmd>`.
- **Masters** start with `-o IdentitiesOnly=yes -o IdentityFile=<ephemeral key>`,
  plus the certificate. A dead master can then never fall back to the hub
  user's own keys.
- **Close:** `ssh -S <sock> -O exit <host>`.
- This keeps the pool's contract (one persistent connection, one channel per
  call) and adds native certificate, `ProxyJump`, and `ssh_config` support.
- **Coexistence:** `defaultConnect` (ssh2) stays for the existing auth modes. A
  host with `auth = "ca"` uses the OpenSSH factory.

**Pool key.** In CA mode the pool is keyed by `(host, agent)`, not by host.
Each agent's connection carries a certificate naming that agent, and one agent
never rides another's session. Then the host's sshd log, which records the
certificate key ID, corroborates the hub's audit trail at agent granularity.
Per-request detail stays in the hub's audit log.

**CA custody (`core/ca.ts`)**
- **Loading:** at startup the hub loads the CA private key from a reference,
  either `ca_key_cmd` (a command that prints the key), `ca_key_env`, or a file
  or keychain item only the hub user can read. Loading must never need an
  interactive unlock (see *Seamless operation*).
  - Inline keys are rejected, consistent with the existing secrets rule.
  - The key is added to a **private `ssh-agent`** whose socket lives in the hub's
    runtime directory, then dropped from process memory.
- **Signing:** `ssh-keygen -U -s ca.pub` signs using the CA held in that agent,
  so the CA private key never touches disk.
- **Minting:** on connect, the hub generates an ephemeral ed25519 key pair in
  its private runtime directory, then signs it:

  ```
  ssh-keygen -U -s ca.pub -I <agent> -n <principal> -V -5m:+10m -z <serial> \
    -O no-port-forwarding -O no-agent-forwarding -O no-x11-forwarding \
    [-O source-address=<hub-ip>/32] ephemeral.pub
  ```

  - `-V -5m:+10m` tolerates clock skew.
  - `-z` assigns a monotonically increasing serial, so a key revocation list
    (KRL) stays possible later.
  - The ephemeral key and certificate are deleted when the master exits.

**Lifetime.**
- sshd checks the certificate **only at authentication**, and `ControlPersist`
  is an *idle* timer, not a maximum age. A busy master would otherwise live
  forever.
- The OpenSSH factory therefore records each master's start time. Once that
  exceeds the certificate validity, it runs `ssh -S <sock> -O stop <host>` to
  refuse new sessions.
- It then lets in-flight calls drain, runs `-O exit`, and re-mints on the next
  use.

**Host enrollment** is one line, done once per host. It goes in the root-owned
authorized-keys file for the target account:

```
cert-authority,principals="fleet" ssh-ed25519 AAAA… ssh-fleet-ca
```

- **Principal vs. account:** the principal is a label matched against the
  certificate. The restricting factor is *which account's* authorized keys
  carry the CA line, and that account's privileges.

**Revocation**
- Stop the hub: no new certificates can be minted. Outstanding certificates
  expire within 10 minutes, and masters are torn down at that age.
- To cut off all access immediately, remove the CA line.

**Multiple CAs.** Multiple CAs are supported (`[[cas]] name = "…"`), and each
host names its CA. Separate trust domains, such as fleets administered by
different parties, can then be revoked independently.

### Phase 4 — HTTP transport and agent identity

- **Transport:** serve with `transportType: "httpStream"` and FastMCP's
  `authenticate` hook.
  - somamcp ≥ 1.4 exposes both; bump the `^1.0.12` pin.
  - Bind to `127.0.0.1` by default; binding a tailnet address requires an
    explicit flag.
- **Tokens:** agents authenticate with a bearer token, configured by reference:
  `[[agents]] name = "claude"`, `token_env = "SSHFLEET_TOKEN_CLAUDE"`.
  - Compare in constant time.
  - Reject unknown tokens before any tool runs.
- **Where the identity is used:** the authenticated agent name flows into the
  audit log (phase 1), the policy `agents` check (phase 2), and the certificate
  key ID and pool key (phase 3).
- **Tokens give attribution, not isolation.** Local agents typically run as the
  same OS user and can read each other's MCP config, and with it each other's
  tokens. Per-agent tokens stop accidents and give clean logs. Separating
  agents from each other needs separate OS users.
- **Stdio mode** still works with `agent = "unknown"`; the startup banner warns
  that it is ungoverned.

### Phase 5 — Approval

For calls that require approval (from `needs_approval` or `tmux = "approve"`):

- **Primary channel: ntfy.** Publish the agent, host, and command to a
  configured topic, with Approve and Deny action buttons.
  - Each button carries its **own single-use nonce** (128-bit, random). Each
    calls back with **POST** to a separate approval listener bound to the
    tailnet, since the MCP port defaults to localhost.
  - **The topic must be private:** either a self-hosted ntfy server, or one
    with token-protected topic access control.
  - On public ntfy.sh, the topic name is the only secret and anyone subscribed
    could approve. In that case, send only "approval pending" and show details
    on the tailnet-only approval page.
- **Secondary channel: MCP elicitation,** when the client supports it, prompts
  in the agent's own UI. It is weaker because the agent's client renders the
  prompt, so ntfy wins when both are configured.
- **Fail closed:** no answer within `approval_timeout_ms` (default 5 minutes)
  means deny. A server restart drops pending approvals as denied. Nonces expire
  with the timeout.
- **Auditing:** the decision, the channel that approved it, and the latency are
  audited.

## Error handling

- **Fatal at startup:**
  - everything already fatal
  - an invalid policy
  - a CA reference that fails to resolve or load into the agent
  - a missing `ssh`, `ssh-keygen`, or `ssh-agent` binary when any host uses
    `auth = "ca"`
  - an unset agent token variable
  - an audit path that isn't writable
- **Per call:**
  - A denial returns, for example, `UserError("[box-a] denied by rule
    readonly: command not in allow list")`.
  - An approval timeout returns `UserError("[box-a] approval timed out after
    5m — denied")`.
  - A minting failure is reported as a connect error naming the CA.
- **An audit write failure is fatal for that call:** no unaudited execution.

## Testing strategy

- **policy.ts:** a table-driven pure test covering:
  - evaluation order
  - full-match anchoring
  - metacharacter and newline rejection, including `cmd; rm`, `cmd $(x)` and
    `cmd\nx`
  - tmux gating
  - per-agent restriction
- **audit.ts:** inject the writer. Assert that the decision line precedes
  execution, and that a runner that throws still yields both lines.
- **ca.ts:** sign with a throwaway CA held in a test `ssh-agent`, then assert
  the key ID, principals, validity, serial, and options with `ssh-keygen -L`.
  Gated on the OpenSSH binaries being present.
- **openssh.ts:**
  - Reuse the pool's lifecycle tests through the factory seam.
  - Add a max-age teardown test with fake timers.
  - Run the existing gated localhost integration test with `auth = "ca"`
    against a localhost `cert-authority` entry.
- **Identity and transport:** missing, unknown, and wrong tokens are rejected
  before handlers run.
- **approval.ts:** use a fake clock and a fake ntfy client. Cover approve, deny,
  timeout, a replayed nonce, the Deny nonce used for Approve, and a restart.
- **Regression:** the connector and existing orchestrator suites pass
  unchanged.

## Out of scope

- **Session recording or replay.** `tmux_read` already exposes output. Full
  recording means `script` or asciinema on the host; revisit if needed.
- **A web UI for the audit log.** `jq` over JSONL is enough at this scale.
- **A KRL.** Short validity makes one unnecessary for now; serials keep the door
  open.
- **Exec timeouts.** These are a pool feature, with their own change.
- **The scheduler and fan-out** (subsystem B).

## Open questions

- **How to isolate the hub:** a separate OS user or a container. A dedicated
  user is simpler, and launchd and systemd support it natively.
- **The single-host connector:** should it gain any of this? Probably audit
  only; governance belongs in the fleet server.
- **Where the approval listener lives:** the same process on a second port, or a
  tiny separate service. The same process is simpler; a separate service keeps
  the MCP port localhost-only with no exceptions.
