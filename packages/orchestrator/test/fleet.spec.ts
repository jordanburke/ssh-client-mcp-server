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
