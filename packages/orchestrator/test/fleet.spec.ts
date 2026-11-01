import { describe, expect, it } from "vitest"

import { fleetWarnings, parseFleet } from "../src/fleet.js"

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
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value.hosts[0].port).toBe(22)
      expect(r.value.hosts[0].tmuxSession).toBe("agent")
    }
  })

  it("defaults the audit path", () => {
    expect(
      parseFleet(base)
        .map((f) => f.audit.path)
        .orElse(""),
    ).toBe("~/.local/state/ssh-fleet/audit.jsonl")
  })

  it("reads [audit].path", () => {
    const r = parseFleet(`[audit]\npath = "/var/log/fleet/audit.jsonl"\n${base}`)
    expect(r.map((f) => f.audit.path).orElse("")).toBe("/var/log/fleet/audit.jsonl")
  })

  it("rejects an empty [audit].path", () => {
    const r = parseFleet(`[audit]\npath = ""\n${base}`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain("audit.path must be a non-empty string")
  })

  it("reads log_output per host, default false", () => {
    const r = parseFleet(`${base}log_output = true

[[hosts]]
name = "box-b"
host = "10.0.0.12"
key = "/keys/id_b"
`)
    expect(r.map((f) => f.hosts.map((h) => h.logOutput)).orElse([])).toEqual([true, false])
  })

  it("rejects a non-boolean log_output", () => {
    const r = parseFleet(`${base}log_output = "yes"\n`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain('host "box-a": log_output must be true or false')
  })

  it("hosts get the built-in policy by default", () => {
    const p = parseFleet(base).map((f) => f.hosts[0].policy)
    expect(p.map((x) => x.mode).orElse("deny")).toBe("readwrite")
    expect(p.map((x) => x.tmux).orElse("approve")).toBe("open")
  })

  it("reads [defaults.policy] and [hosts.policy]", () => {
    const r = parseFleet(`[defaults.policy]
mode = "readwrite"
tmux = "approve"
${base}
[hosts.policy]
mode = "readonly"
allow = ["uptime"]
`)
    if (r.isLeft()) throw new Error(r.value)
    const p = r.value.hosts[0].policy
    expect(p.mode).toBe("readonly")
    expect(p.allow).toHaveLength(1)
    expect(p.tmux).toBe("approve")
  })

  it("reports policy errors with the host name", () => {
    const r = parseFleet(`${base}\n[hosts.policy]\nmode = "nope"\n`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value).toContain('host "box-a": policy.mode must be one of readonly, readwrite, deny')
  })

  it("reports a defaults.policy error once", () => {
    const r = parseFleet(`[defaults.policy]
tmux = "x"
${base}
[[hosts]]
name = "box-b"
host = "10.0.0.12"
key = "/keys/id_b"
`)
    expect(r.isLeft()).toBe(true)
    if (r.isLeft()) expect(r.value.split("defaults.policy.tmux must be approve or open")).toHaveLength(2)
  })

  it("warns for each host with agents set", () => {
    const r = parseFleet(`${base}
[hosts.policy]
agents = ["claude"]

[[hosts]]
name = "box-b"
host = "10.0.0.12"
key = "/keys/id_b"
`)
    if (r.isLeft()) throw new Error(r.value)
    expect(fleetWarnings(r.value)).toEqual([
      'host "box-a": policy.agents is set, so every call is denied until agent identity is available',
    ])
  })

  const caBase = `[[cas]]
name = "home"
key_cmd = "op read x"
`
  const caHost = `
[[hosts]]
name = "box-a"
host = "10.0.0.11"
ca = "home"
`
  const leftOf = (toml: string): string =>
    parseFleet(toml).fold(
      (e) => e,
      () => "",
    )

  it("reads [[cas]] with a default principal", () => {
    const r = parseFleet(caBase + caHost)
    if (r.isLeft()) throw new Error(r.value)
    const ca = r.value.cas[0]
    expect(ca).toMatchObject({ name: "home", key: { kind: "cmd", cmd: "op read x" }, principal: "fleet" })
    expect(ca.sourceAddress.isNone()).toBe(true)
  })

  it("a host can use ca auth", () => {
    const r = parseFleet(caBase + caHost)
    expect(r.map((f) => f.hosts[0].ca.orElse("")).orElse("x")).toBe("home")
  })

  it("ca counts as an auth mode", () => {
    expect(leftOf(caBase + caHost + "agent = true\n")).toContain('host "box-a": exactly one auth mode allowed, found 2')
  })

  it("the no-auth message lists ca", () => {
    expect(leftOf(`[[hosts]]\nname = "box-a"\nhost = "10.0.0.11"\n`)).toContain("key/key_env/agent/password_env/ca")
  })

  it("rejects a ca with no key reference", () => {
    expect(leftOf(`[[cas]]\nname = "home"\n` + caHost)).toContain(
      'ca "home": exactly one of key_cmd, key_env, key_file is required',
    )
  })

  it("rejects an inline ca key", () => {
    expect(leftOf(`[[cas]]\nname = "home"\nkey = "-----BEGIN"\n` + caHost)).toContain(
      'ca "home": keys must not be inline; use key_cmd, key_env or key_file',
    )
  })

  it("rejects two key references", () => {
    expect(leftOf(caBase + `key_env = "CA"\n` + caHost)).toContain(
      'ca "home": exactly one of key_cmd, key_env, key_file is required',
    )
  })

  it("rejects a principal with a comma", () => {
    expect(leftOf(caBase + `principal = "a,b"\n` + caHost)).toContain(
      'ca "home": principal must be non-empty with no commas',
    )
  })

  it("rejects a malformed source_address", () => {
    expect(leftOf(caBase + `source_address = "10.0.0.1"\n` + caHost)).toContain(
      'ca "home": source_address must be an IPv4 or IPv6 CIDR',
    )
    expect(leftOf(caBase + `source_address = "10.0.0.1/33"\n` + caHost)).toContain(
      'ca "home": source_address must be an IPv4 or IPv6 CIDR',
    )
    const ok = parseFleet(caBase + `source_address = "100.64.0.1/32"\n` + caHost)
    expect(ok.map((f) => f.cas[0].sourceAddress.orElse("")).orElse("")).toBe("100.64.0.1/32")
  })

  it("rejects a source_address with host bits set", () => {
    const msg = 'ca "home": source_address must be an IPv4 or IPv6 CIDR'
    expect(leftOf(caBase + `source_address = "100.64.0.1/24"\n` + caHost)).toContain(msg)
    expect(leftOf(caBase + `source_address = "fd00::1/64"\n` + caHost)).toContain(msg)
    const net4 = parseFleet(caBase + `source_address = "100.64.0.0/24"\n` + caHost)
    expect(net4.map((f) => f.cas[0].sourceAddress.orElse("")).orElse("")).toBe("100.64.0.0/24")
    const net6 = parseFleet(caBase + `source_address = "fd00::/64"\n` + caHost)
    expect(net6.isRight()).toBe(true)
  })

  it("rejects a host naming an undefined ca", () => {
    expect(leftOf(caBase + caHost.replace('ca = "home"', 'ca = "nope"'))).toContain(
      'host "box-a": ca "nope" is not defined in [[cas]]',
    )
  })

  it("rejects principal on a non-ca host", () => {
    expect(leftOf(`${base}principal = "fleet"\n`)).toContain('host "box-a": principal applies only to ca auth')
  })

  it("reads runtime_dir and known_hosts", () => {
    const r = parseFleet(`runtime_dir = "/run/fleet"\nknown_hosts = "/var/lib/fleet/known_hosts"\n${base}`)
    expect(r.map((f) => f.runtimeDir.orElse("")).orElse("")).toBe("/run/fleet")
    expect(r.map((f) => f.knownHosts.orElse("")).orElse("")).toBe("/var/lib/fleet/known_hosts")
    expect(
      parseFleet(base)
        .map((f) => f.runtimeDir.isNone())
        .orElse(false),
    ).toBe(true)
  })

  it("reads pool settings with defaults", () => {
    const r = parseFleet(base)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value.pool.maxPerHost).toBe(2)
      expect(r.value.pool.idleTimeoutMs).toBe(60000)
      expect(r.value.pool.execTimeoutMs).toBe(600_000)
      expect(r.value.pool.maxExecTimeoutMs).toBe(3_600_000)
    }
  })

  it("reads exec timeouts from [pool]", () => {
    const r = parseFleet(`[pool]\nexec_timeout_ms = 5000\nmax_exec_timeout_ms = 9000\n${base}`)
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.pool.execTimeoutMs).toBe(5000)
    expect(r.value.pool.maxExecTimeoutMs).toBe(9000)
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

  it("rejects an inline private_key literal (secrets must be by reference)", () => {
    const r = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
private_key = "-----BEGIN OPENSSH PRIVATE KEY-----"
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

describe("zero hosts and auth kinds", () => {
  it("a config with no hosts parses", () => {
    const r = parseFleet("")
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value.hosts).toEqual([])
      expect(r.value.audit.path).toBe("~/.local/state/ssh-fleet/audit.jsonl")
    }
  })

  it("no hosts is a warning", () => {
    const r = parseFleet("")
    if (r.isLeft()) throw new Error(r.value)
    expect(fleetWarnings(r.value)).toContain("no hosts configured; add a [[hosts]] entry and restart")
  })

  it("each host records its auth kind", () => {
    const r = parseFleet(`
[[cas]]
name = "home"
key_cmd = "op read x"
[[hosts]]
name = "p"
host = "h"
password_env = "FLEET_TEST_PW"
[[hosts]]
name = "k"
host = "h"
key = "/keys/k"
[[hosts]]
name = "ke"
host = "h"
key_env = "FLEET_TEST_KEY"
[[hosts]]
name = "a"
host = "h"
agent = true
[[hosts]]
name = "c"
host = "h"
ca = "home"
`)
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.hosts.map((h) => h.authKind)).toEqual(["password_env", "key", "key_env", "agent", "ca"])
  })

  it("password_env keeps the variable name, not just the value", () => {
    const toml = `
[[hosts]]
name = "mini"
host = "h"
password_env = "FLEET_TEST_MINI_PW"
`
    delete process.env.FLEET_TEST_MINI_PW
    const unset = parseFleet(toml)
    process.env.FLEET_TEST_MINI_PW = "pw"
    const set = parseFleet(toml)
    delete process.env.FLEET_TEST_MINI_PW
    for (const r of [unset, set]) {
      if (r.isLeft()) throw new Error(r.value)
      expect(r.value.hosts[0].passwordEnv.orElse("")).toBe("FLEET_TEST_MINI_PW")
    }
  })

  it("an unset password_env is a warning", () => {
    delete process.env.FLEET_TEST_MINI_PW
    const r = parseFleet(`
[[hosts]]
name = "mini"
host = "h"
password_env = "FLEET_TEST_MINI_PW"
`)
    if (r.isLeft()) throw new Error(r.value)
    expect(fleetWarnings(r.value)).toContain('host "mini": password_env FLEET_TEST_MINI_PW is not set')
  })
})

describe("TOML syntax errors", () => {
  // smol-toml quotes the offending source lines; an inline secret there must not reach stderr or
  // fleet_setup, which relays the error to the MCP client.
  it("give the line and column, not the source text", () => {
    const r = parseFleet('[[hosts]]\nname = "a"\nhost = "h"\npassword = hunter2-SECRET\n')
    expect(r.isLeft()).toBe(true)
    const msg = r.swap().orElse("")
    expect(msg).toBe("Invalid TOML at line 4, column 12: Invalid TOML document: invalid value")
    expect(msg).not.toContain("hunter2")
  })
})
