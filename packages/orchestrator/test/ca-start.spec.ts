import { type Custody, nodeProcessRunner } from "@ssh-mcp/core"
import { Left, Option, Right } from "functype"
import { describe, expect, it } from "vitest"

import { caPublicKeys, type CaStartDeps, startCa } from "../src/ca-start.js"
import { type Fleet, parseFleet } from "../src/fleet.js"
import { type CaWiring } from "../src/runners.js"

const fleetOf = (toml: string): Fleet => parseFleet(toml).orThrow()

const oneCa = (extra = ""): Fleet =>
  fleetOf(`
runtime_dir = "/run/fleet"
known_hosts = "/state/known_hosts"
${extra}
[[cas]]
name = "home"
key_file = "/keys/ca-home"
`)

const fakeCustody = (calls: string[], runtimeDir = "/run/fleet"): Custody => ({
  runtimeDir,
  agentSock: `${runtimeDir}/agent.sock`,
  pubPath: (ca) => Option(`${runtimeDir}/ca-${ca}.pub`),
  shutdown: async () => {
    calls.push("shutdown")
  },
})

// Records each step in order; each can be made to fail.
const recordingDeps = (over: Partial<CaStartDeps> = {}) => {
  const calls: string[] = []
  const logs: string[] = []
  const deps: CaStartDeps = {
    proc: nodeProcessRunner,
    checkOpenSsh: async () => {
      calls.push("openssh")
      return Right<string, void>(undefined)
    },
    ensureKeyFiles: async (cas) => {
      calls.push("keys")
      return Right<string, ReadonlyArray<string>>(cas.map((c) => c.name))
    },
    makeDir: (dir) => {
      calls.push(`mkdir ${dir}`)
    },
    startCustody: async (runtimeDir) => {
      calls.push(`custody ${runtimeDir}`)
      return Right<string, Custody>(fakeCustody(calls, runtimeDir))
    },
    selfTest: async () => {
      calls.push("selftest")
      return Right<string, void>(undefined)
    },
    log: (line) => logs.push(line),
    ...over,
  }
  return { deps, calls, logs }
}

describe("startCa", () => {
  it("does nothing without a CA", async () => {
    const { deps, calls } = recordingDeps()
    const r = (await startCa(fleetOf(""), "serve", deps)).orThrow()
    expect(r.wiring.isNone()).toBe(true)
    expect(calls).toEqual([])
  })

  it("serve creates missing keys, then starts custody and self-tests", async () => {
    const { deps, calls, logs } = recordingDeps()
    const r = (await startCa(oneCa(), "serve", deps)).orThrow()
    expect(calls).toEqual(["openssh", "keys", "mkdir /state", "custody /run/fleet", "selftest"])
    expect(r.created).toEqual(["home"])
    expect(logs).toEqual(['created CA "home" key at /keys/ca-home; add its line to each host (see fleet_setup)'])
    expect(r.wiring.map((w) => w.knownHosts).orElse("")).toBe("/state/known_hosts")
  })

  it("check creates no key and uses its own runtime dir", async () => {
    const { deps, calls } = recordingDeps()
    const r = (await startCa(oneCa(), "check", deps)).orThrow()
    expect(calls).not.toContain("keys")
    expect(calls).toContain("custody /run/fleet-check")
    expect(r.created).toEqual([])
  })

  it("a runtime dir too long for a socket fails before any key is created", async () => {
    const { deps, calls } = recordingDeps()
    const long = `/run/${"d".repeat(120)}`
    const r = await startCa({ ...oneCa(), runtimeDir: Option(long) }, "serve", deps)
    expect(r.isLeft()).toBe(true)
    expect(calls).toEqual(["openssh"])
  })

  it("a missing OpenSSH stops startup first", async () => {
    const { deps, calls } = recordingDeps({ checkOpenSsh: async () => Left<string, void>("ssh-keygen not found") })
    const r = await startCa(oneCa(), "serve", deps)
    expect(r.isLeft() && r.value).toBe("ssh-keygen not found")
    expect(calls).toEqual([])
  })

  it("a failed self-test stops the agent it started", async () => {
    const { deps, calls } = recordingDeps({
      selfTest: async () => Left<string, void>('CA "home": signing failed'),
    })
    const r = await startCa(oneCa(), "serve", deps)
    expect(r.isLeft() && r.value).toBe('CA "home": signing failed')
    expect(calls.at(-1)).toBe("shutdown")
  })
})

describe("caPublicKeys", () => {
  const cas = oneCa().cas
  const wiringWith = (custody: Custody): Option<CaWiring> =>
    Option<CaWiring>({ custody, proc: nodeProcessRunner, knownHosts: "/state/known_hosts" })

  it("is empty with no CA custody", () => {
    expect(caPublicKeys(cas, Option.none<CaWiring>()).orThrow().size).toBe(0)
  })

  it("reads each CA's public key from custody, trimmed", () => {
    const keys = caPublicKeys(cas, wiringWith(fakeCustody([])), (path) => `ssh-ed25519 AAAA ${path}\n`).orThrow()
    expect(keys.get("home").orElse("")).toBe("ssh-ed25519 AAAA /run/fleet/ca-home.pub")
  })

  it("a public key that can't be read stops startup", () => {
    const r = caPublicKeys(cas, wiringWith(fakeCustody([])), () => {
      throw new Error("EACCES: permission denied")
    })
    expect(r.isLeft() && r.value).toBe('CA "home": cannot read /run/fleet/ca-home.pub: EACCES: permission denied')
  })

  it("a CA custody doesn't hold stops startup", () => {
    const r = caPublicKeys(cas, wiringWith({ ...fakeCustody([]), pubPath: () => Option.none<string>() }))
    expect(r.isLeft() && r.value).toBe('CA "home": custody has no public key for it')
  })
})
