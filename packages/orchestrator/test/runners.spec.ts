import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Option, Right } from "functype"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type ConnectFactory,
  type Custody,
  nodeProcessRunner,
  type Openssh,
  type PooledConnection,
  socketPathFor,
  startCaCustody,
} from "@ssh-mcp/core"

import { type CaEntry, type Fleet, parseFleet } from "../src/fleet.js"
import { buildFleetRunner, type CaWiring, caKeySource, selfTestCas } from "../src/runners.js"

const fakeConn: PooledConnection = {
  exec: async (command) => ({ stdout: `out:${command}`, stderr: "", code: 0 }),
  close: () => {},
  onClose: () => {},
}
const connect: ConnectFactory = async () => fakeConn

const fleet = parseFleet(`
[[hosts]]
name = "box-a"
host = "10.0.0.11"
agent = true
tmux_session = "sess-a"
`)

// resolveAuth checks SSH_AUTH_SOCK when agent = true; provide a fake value so
// the test does not depend on a live ssh-agent (connect is injected anyway).
let savedSshAuthSock: string | undefined

describe("buildFleetRunner", () => {
  beforeAll(() => {
    savedSshAuthSock = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock"
  })

  afterAll(() => {
    if (savedSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK
    } else {
      process.env.SSH_AUTH_SOCK = savedSshAuthSock
    }
  })
  it("exposes host names and a per-host tmux runner", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    expect(r.isRight()).toBe(true)
    if (r.isRight()) {
      expect(r.value.hostNames).toEqual(["box-a"])
      expect(r.value.sessionFor("box-a")).toBe("sess-a")
      const tr = r.value.tmuxRunnerFor("box-a")
      expect(tr.isRight()).toBe(true)
      if (tr.isRight())
        expect(await tr.value("tmux list-sessions")).toEqual({ stdout: "out:tmux list-sessions", stderr: "", code: 0 })
      await r.value.shutdown()
    }
  })

  it("logOutputFor reflects the host entry", async () => {
    const f = parseFleet(`
[[hosts]]
name = "box-a"
host = "10.0.0.11"
agent = true
log_output = true

[[hosts]]
name = "box-b"
host = "10.0.0.12"
agent = true
`)
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.logOutputFor("box-a")).toBe(true)
    expect(r.value.logOutputFor("box-b")).toBe(false)
    expect(r.value.logOutputFor("nope")).toBe(false)
    await r.value.shutdown()
  })

  it("policyFor returns the host policy", async () => {
    const f = parseFleet(`
[[hosts]]
name = "box-a"
host = "10.0.0.11"
agent = true
  [hosts.policy]
  mode = "readonly"
`)
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    if (r.isLeft()) throw new Error(r.value)
    expect(
      r.value
        .policyFor("box-a")
        .map((p) => p.mode)
        .orElse("deny"),
    ).toBe("readonly")
    expect(r.value.policyFor("nope").isNone()).toBe(true)
    await r.value.shutdown()
  })

  it("errors the tmux runner for an unknown host", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    if (r.isRight()) {
      expect(r.value.tmuxRunnerFor("ghost").isLeft()).toBe(true)
      await r.value.shutdown()
    }
  })

  it("an empty fleet builds a runner", async () => {
    const f = parseFleet("")
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.status()).toEqual([])
    await expect(r.value.exec("x", "true", "unknown")).rejects.toThrow()
    await r.value.shutdown()
  })

  it("unknown host with no hosts says so", async () => {
    const f = parseFleet("")
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.tmuxRunnerFor("x", "unknown").swap().orElse("")).toBe('unknown host "x" — no hosts are configured')
    await r.value.shutdown()
  })

  it("a failed connect is recorded", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const refused: ConnectFactory = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.11:22")
    }
    const r = await buildFleetRunner(fleet.value, refused)
    if (r.isLeft()) throw new Error(r.value)
    await expect(r.value.exec("box-a", "true", "unknown")).rejects.toThrow("ECONNREFUSED")
    expect(
      r.value
        .lastError("box-a")
        .map((e) => e.message)
        .orElse(""),
    ).toContain("ECONNREFUSED")
    await r.value.shutdown()
  })

  it("a later success clears it", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    let fail = true
    const flaky: ConnectFactory = async () => {
      if (fail) throw new Error("connect ECONNREFUSED")
      return fakeConn
    }
    const r = await buildFleetRunner(fleet.value, flaky)
    if (r.isLeft()) throw new Error(r.value)
    await expect(r.value.exec("box-a", "true", "unknown")).rejects.toThrow()
    fail = false
    await r.value.exec("box-a", "true", "unknown")
    expect(r.value.lastError("box-a").isNone()).toBe(true)
    await r.value.shutdown()
  })

  it("a non-zero exit is not a connect error", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const exits1: ConnectFactory = async () => ({
      ...fakeConn,
      exec: async () => ({ stdout: "", stderr: "nope", code: 1 }),
    })
    const r = await buildFleetRunner(fleet.value, exits1)
    if (r.isLeft()) throw new Error(r.value)
    await r.value.exec("box-a", "false", "unknown")
    expect(r.value.lastError("box-a").isNone()).toBe(true)
    await r.value.shutdown()
  })

  it("an unknown host is not recorded", async () => {
    if (fleet.isLeft()) throw new Error(fleet.value)
    const r = await buildFleetRunner(fleet.value, connect)
    if (r.isLeft()) throw new Error(r.value)
    await expect(r.value.exec("nope", "true", "unknown")).rejects.toThrow()
    expect(r.value.lastError("nope").isNone()).toBe(true)
    await r.value.shutdown()
  })

  it("fails when a host's auth cannot resolve (missing key-env)", async () => {
    delete process.env.NOPE_KEY
    const f = parseFleet(`
[[hosts]]
name = "x"
host = "1.2.3.4"
key_env = "NOPE_KEY"
`)
    if (f.isLeft()) throw new Error(f.value)
    const r = await buildFleetRunner(f.value, connect)
    expect(r.isLeft()).toBe(true)
  })
})

const caFleetToml = `
[[cas]]
name = "home"
key_env = "UNUSED_CA_KEY"

[[hosts]]
name = "box-a"
host = "10.0.0.11"
ca = "home"

[[hosts]]
name = "box-b"
host = "10.0.0.12"
agent = true
`

const caFleet = (): Fleet => parseFleet(caFleetToml).orThrow()

// Fake custody and OpenSSH: records which (agent, host) pairs open, their sockets, and shutdown order.
const caWiring = (order: string[] = []) => {
  const opened: Array<{ agent: string; host: string; socket: string; connections: number }> = []
  const custody: Custody = {
    runtimeDir: "/run/fleet",
    agentSock: "/run/fleet/agent.sock",
    pubPath: () => Option("/run/fleet/ca-home.pub"),
    shutdown: async () => {
      order.push("custody")
    },
  }
  const wiring: CaWiring = {
    custody,
    proc: nodeProcessRunner,
    knownHosts: "/state/known_hosts",
    openFor: (agent, host): Openssh => {
      const record = {
        agent,
        host: host.name,
        socket: socketPathFor("/run/fleet", agent, host.name).orElse(""),
        connections: 0,
      }
      opened.push(record)
      return {
        connect: async () => {
          record.connections++
          return {
            exec: async (command) => ({ stdout: `${agent}:${command}`, stderr: "", code: 0 }),
            close: () => {
              order.push("pool")
            },
            onClose: () => {},
          }
        },
        shutdown: async () => {
          order.push("masters")
        },
      }
    },
  }
  return { wiring, opened }
}

describe("CA routing", () => {
  beforeAll(() => {
    process.env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK ?? "/tmp/fake-agent.sock"
  })

  it("a ca host without custody fails to build", async () => {
    const r = await buildFleetRunner(caFleet(), connect)
    expect(
      r.fold(
        (e) => e,
        () => "",
      ),
    ).toBe('host "box-a" uses ca auth but CA custody is not running')
  })

  it("two agents get separate pools and sockets on a CA host", async () => {
    const { wiring, opened } = caWiring()
    const runner = (await buildFleetRunner(caFleet(), connect, Option(wiring))).orThrow()
    expect((await runner.exec("box-a", "x", "claude")).stdout).toBe("claude:x")
    expect((await runner.exec("box-a", "x", "codex")).stdout).toBe("codex:x")
    await runner.exec("box-a", "y", "claude")
    expect(opened.map((o) => [o.agent, o.host, o.connections])).toEqual([
      ["claude", "box-a", 1],
      ["codex", "box-a", 1],
    ])
    expect(opened[0].socket).not.toBe(opened[1].socket)
    await runner.shutdown()
  })

  it("non-ca hosts ignore the agent", async () => {
    const connections = { n: 0 }
    const counting: ConnectFactory = async () => {
      connections.n++
      return fakeConn
    }
    const { wiring } = caWiring()
    const runner = (await buildFleetRunner(caFleet(), counting, Option(wiring))).orThrow()
    await runner.exec("box-b", "x", "claude")
    await runner.exec("box-b", "x", "codex")
    expect(connections.n).toBe(1)
    await runner.shutdown()
  })

  it("ca hosts appear in hosts_list before first use", async () => {
    const { wiring } = caWiring()
    const runner = (await buildFleetRunner(caFleet(), connect, Option(wiring))).orThrow()
    expect(runner.hostNames).toEqual(["box-a", "box-b"])
    expect(runner.status()).toContainEqual({ name: "box-a", state: "disconnected", inFlight: 0 })
    expect(runner.tmuxRunnerFor("box-a", "unknown").isRight()).toBe(true)
    await runner.shutdown()
  })

  it("shutdown stops pools, then masters, then custody", async () => {
    const order: string[] = []
    const { wiring } = caWiring(order)
    const runner = (await buildFleetRunner(caFleet(), connect, Option(wiring))).orThrow()
    await runner.exec("box-a", "x", "claude")
    await runner.shutdown()
    expect(order).toEqual(["pool", "masters", "custody"])
  })
})

describe("caKeySource", () => {
  const entry = (key: CaEntry["key"]): CaEntry => ({
    name: "home",
    key,
    principal: "fleet",
    sourceAddress: Option.none(),
  })

  it("caKeySource reads and clears env, and refuses a world-readable file", async () => {
    process.env.FLEET_TEST_CA = "KEY"
    expect((await caKeySource(entry({ kind: "env", name: "FLEET_TEST_CA" })).key()).orElse("")).toBe("KEY")
    expect(process.env.FLEET_TEST_CA).toBeUndefined()

    const dir = mkdtempSync(join(tmpdir(), "cakey-"))
    const file = join(dir, "ca")
    writeFileSync(file, "KEY\n", { mode: 0o644 })
    chmodSync(file, 0o644)
    const loose = await caKeySource(entry({ kind: "file", path: file })).key()
    expect(
      loose.fold(
        (e) => e,
        () => "",
      ),
    ).toContain("0600")

    chmodSync(file, 0o600)
    expect((await caKeySource(entry({ kind: "file", path: file })).key()).orElse("")).toBe("KEY\n")

    symlinkSync(file, join(dir, "link"))
    const linked = await caKeySource(entry({ kind: "file", path: join(dir, "link") })).key()
    expect(
      linked.fold(
        (e) => e,
        () => "",
      ),
    ).toContain("symlink")

    const cmd = await caKeySource(entry({ kind: "cmd", cmd: "printf KEY" })).key()
    expect(cmd.orElse("")).toBe("KEY\n")
  })
})

describe("key_cmd timeout", () => {
  it("a key_cmd that hangs fails instead of blocking startup", async () => {
    const entry: CaEntry = {
      name: "home",
      key: { kind: "cmd", cmd: "sleep 5" },
      principal: "fleet",
      sourceAddress: Option.none(),
    }
    const started = Date.now()
    const r = await caKeySource(entry, { timeoutMs: 200 }).key()
    expect(
      r.fold(
        (e) => e,
        () => "",
      ),
    ).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

const hasOpenSsh = ["ssh-keygen", "ssh-agent", "ssh-add"].every(
  (bin) => spawnSync(bin, ["-?"], { stdio: "ignore" }).error === undefined,
)

describe.skipIf(!hasOpenSsh)("selfTestCas (OpenSSH)", () => {
  it("a CA whose certificate options ssh-keygen rejects fails at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selftest-"))
    try {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(dir, "ca")])
      const key = readFileSync(join(dir, "ca"), "utf8")
      const custody = (
        await startCaCustody(
          join(dir, "run"),
          [{ name: "home", key: async () => Right<string, string>(key) }],
          nodeProcessRunner,
        )
      ).orThrow()
      try {
        const good: CaEntry = {
          name: "home",
          key: { kind: "env", name: "X" },
          principal: "fleet",
          sourceAddress: Option.none(),
        }
        expect((await selfTestCas(custody, [good], nodeProcessRunner)).isRight()).toBe(true)
        // Bypasses config validation on purpose: ssh-keygen itself must be the backstop.
        const bad: CaEntry = { ...good, sourceAddress: Option("100.64.0.1/24") }
        const r = await selfTestCas(custody, [bad], nodeProcessRunner)
        expect(
          r.fold(
            (e) => e,
            () => "",
          ),
        ).toMatch(/^CA "home":/)
        expect(spawnSync("ls", [join(dir, "run")], { encoding: "utf8" }).stdout).not.toMatch(/k-/)
      } finally {
        await custody.shutdown()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
