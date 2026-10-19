import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Left, Option, Right } from "functype"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import {
  type CaKeySource,
  checkOpenSsh,
  type Custody,
  mint,
  nextSerial,
  socketPathFor,
  startCaCustody,
} from "../src/ca.js"
import { type Child, childEnv, nodeProcessRunner, type ProcessRunner } from "../src/proc.js"

const OPENSSH = ["ssh", "ssh-keygen", "ssh-agent", "ssh-add"]
const hasOpenSsh = OPENSSH.every(
  (bin) => spawnSync(bin, bin === "ssh" ? ["-V"] : ["-?"], { stdio: "ignore" }).error === undefined,
)

const freshDir = (): string => mkdtempSync(join(tmpdir(), "ca-"))

const keygen = (dir: string, name: string, passphrase = ""): string => {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "", "-f", join(dir, name)])
  return readFileSync(join(dir, name), "utf8")
}

const source = (name: string, key: string): CaKeySource => ({ name, key: async () => Right<string, string>(key) })

const agentKeys = (sock: string) =>
  spawnSync("ssh-add", ["-l"], { env: { PATH: process.env.PATH ?? "", SSH_AUTH_SOCK: sock }, encoding: "utf8" })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("childEnv", () => {
  it("childEnv keeps only the allowlist", () => {
    const saved = { sock: process.env.SSH_AUTH_SOCK, display: process.env.DISPLAY }
    process.env.SSH_AUTH_SOCK = "/tmp/user-agent.sock"
    process.env.DISPLAY = ":0"
    try {
      const env = childEnv({ X: "1" })
      expect(env.SSH_AUTH_SOCK).toBeUndefined()
      expect(env.DISPLAY).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH)
      expect(env.X).toBe("1")
    } finally {
      process.env.SSH_AUTH_SOCK = saved.sock
      process.env.DISPLAY = saved.display
      if (saved.sock === undefined) delete process.env.SSH_AUTH_SOCK
      if (saved.display === undefined) delete process.env.DISPLAY
    }
  })
})

describe("checkOpenSsh (fake runner)", () => {
  it("checkOpenSsh names a missing binary", async () => {
    const proc: ProcessRunner = {
      run: (cmd) =>
        cmd === "ssh-add"
          ? Promise.reject(Object.assign(new Error("spawn ssh-add ENOENT"), { code: "ENOENT" }))
          : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      spawn: () => {
        throw new Error("not used")
      },
    }
    const r = await checkOpenSsh(proc)
    expect(
      r.fold(
        (e) => e,
        () => "",
      ),
    ).toContain("ssh-add")
  })
})

describe("startCaCustody (fake runner)", () => {
  it("ssh-add can't prompt, and only it gets the private agent", async () => {
    const dir = freshDir()
    const calls: Array<{ cmd: string; args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }> = []
    const loaded = { yes: false }
    const child: Child = {
      onExit: () => {},
      kill: () => {},
      stderr: () => "",
      exited: () => false,
      pid: () => undefined,
    }
    const proc: ProcessRunner = {
      run: async (cmd, args, opts) => {
        calls.push({ cmd, args, env: opts.env })
        if (cmd === "ssh-add" && args[0] === "-") loaded.yes = true
        if (cmd === "ssh-add" && args[0] === "-L")
          return loaded.yes
            ? { code: 0, stdout: "ssh-ed25519 AAAA test\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" }
        return { code: 0, stdout: "", stderr: "" }
      },
      spawn: (cmd, args) => {
        // Pretend the agent bound its socket.
        if (cmd === "ssh-agent") writeFileSync(args[args.length - 1] ?? join(dir, "agent.sock"), "")
        return child
      },
    }
    const r = await startCaCustody(join(dir, "run"), [source("home", "KEY")], proc)
    expect(r.isRight()).toBe(true)
    const addCall = calls.find((c) => c.cmd === "ssh-add" && c.args[0] === "-")
    expect(addCall?.env).toMatchObject({
      SSH_ASKPASS: "/bin/false",
      SSH_ASKPASS_REQUIRE: "force",
      SSH_AUTH_SOCK: join(dir, "run", "agent.sock"),
    })
    expect(addCall?.env.DISPLAY).toBeUndefined()
    expect(calls.filter((c) => c.cmd !== "ssh-add" && c.env.SSH_AUTH_SOCK !== undefined)).toEqual([])
    expect(r.map((c) => readFileSync(c.pubPath("home").orElse(""), "utf8")).orElse("")).toBe("ssh-ed25519 AAAA test\n")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe.skipIf(!hasOpenSsh)("CA custody (OpenSSH)", () => {
  const keys = { plain: "", plainPub: "", locked: "" }
  const opened: Custody[] = []

  beforeAll(() => {
    const dir = freshDir()
    keys.plain = keygen(dir, "ca")
    keys.plainPub = readFileSync(join(dir, "ca.pub"), "utf8")
    keys.locked = keygen(dir, "locked", "secret")
  })

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((c) => c.shutdown()))
  })

  const start = async (runtimeDir: string, cas: ReadonlyArray<CaKeySource>) => {
    const r = await startCaCustody(runtimeDir, cas, nodeProcessRunner)
    r.fold(
      () => undefined,
      (c) => {
        opened.push(c)
      },
    )
    return r
  }

  it("checkOpenSsh finds the binaries", async () => {
    expect((await checkOpenSsh(nodeProcessRunner)).isRight()).toBe(true)
  })

  it("custody loads a CA without writing its private key", async () => {
    const runtimeDir = join(freshDir(), "run")
    const custody = (await start(runtimeDir, [source("home", keys.plain)])).orThrow()
    const pub = custody.pubPath("home").orElse("")
    expect(readFileSync(pub, "utf8").split(" ").slice(0, 2)).toEqual(keys.plainPub.split(" ").slice(0, 2))
    const files = readdirSync(runtimeDir).filter((f) => statSync(join(runtimeDir, f)).isFile())
    expect(files.some((f) => readFileSync(join(runtimeDir, f), "utf8").includes("PRIVATE KEY"))).toBe(false)
    expect(agentKeys(custody.agentSock).stdout.trim().split("\n")).toHaveLength(1)
  })

  it("a key that won't load fails startup naming the CA", async () => {
    const started = Date.now()
    const r = await start(join(freshDir(), "run"), [source("home", keys.locked)])
    expect(
      r.fold(
        (e) => e,
        () => "",
      ),
    ).toMatch(/^CA "home":/)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it("a failing key source fails naming the CA", async () => {
    const failing: CaKeySource = { name: "home", key: async () => Left<string, string>("no such secret") }
    const message = (await start(join(freshDir(), "run"), [failing])).fold(
      (e) => e,
      () => "",
    )
    expect(message).toContain('CA "home"')
    expect(message).toContain("no such secret")
  })

  it("startup recovers from a stale runtime dir", async () => {
    const runtimeDir = join(freshDir(), "run")
    // First run "crashes": its agent stays up and its files stay behind.
    const first = await startCaCustody(runtimeDir, [source("home", keys.plain)], nodeProcessRunner)
    expect(first.isRight()).toBe(true)
    const firstPid = Number(readFileSync(join(runtimeDir, "agent.pid"), "utf8"))
    writeFileSync(join(runtimeDir, "m-0123456789ab.sock"), "")

    const second = await start(runtimeDir, [source("home", keys.plain)])
    expect(second.isRight()).toBe(true)
    expect(alive(firstPid)).toBe(false)
    expect(readdirSync(runtimeDir).filter((f) => f.startsWith("m-"))).toEqual([])
  })

  it("startup kills a stale master but nothing else", async () => {
    const runtimeDir = join(freshDir(), "run")
    mkdirSync(runtimeDir, { recursive: true })
    // An ssh that hangs waiting for a banner from its ProxyCommand: a stand-in for a master left by a crash.
    const master = spawn("ssh", ["-F", "/dev/null", "-o", "ProxyCommand=cat", "-o", "BatchMode=yes", "nowhere"], {
      stdio: "ignore",
    })
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" })
    try {
      writeFileSync(join(runtimeDir, "m-0123456789ab-aaaa.pid"), String(master.pid))
      writeFileSync(join(runtimeDir, "m-0123456789ab-bbbb.pid"), String(bystander.pid))
      await new Promise((r) => setTimeout(r, 200))
      expect((await start(runtimeDir, [source("home", keys.plain)])).isRight()).toBe(true)
      await new Promise((r) => setTimeout(r, 200))
      expect(alive(master.pid ?? 0)).toBe(false)
      expect(alive(bystander.pid ?? 0)).toBe(true)
      expect(readdirSync(runtimeDir).filter((f) => f.endsWith(".pid") && f.startsWith("m-"))).toEqual([])
    } finally {
      master.kill()
      bystander.kill()
    }
  })

  it("shutdown removes the runtime dir and stops the agent", async () => {
    const runtimeDir = join(freshDir(), "run")
    const custody = (await startCaCustody(runtimeDir, [source("home", keys.plain)], nodeProcessRunner)).orThrow()
    await custody.shutdown()
    expect(existsSync(runtimeDir)).toBe(false)
    expect(agentKeys(custody.agentSock).status).not.toBe(0)
  })
})

describe("nextSerial / socketPathFor", () => {
  it("serials strictly increase", () => {
    const ms = Date.now() + 10_000
    const serials = Array.from({ length: 2000 }, () => nextSerial(ms))
    expect(serials.every((v, i) => i === 0 || v > serials[i - 1])).toBe(true)
    expect(nextSerial(ms + 1) > serials[serials.length - 1]).toBe(true)
  })

  it("rejects a runtime dir whose socket paths are too long", () => {
    expect(socketPathFor("/" + "x".repeat(70), "unknown", "box-a").isLeft()).toBe(true)
    const ok = socketPathFor("/run/fleet", "unknown", "box-a")
    expect(ok.orElse("")).toMatch(/^\/run\/fleet\/m-[0-9a-f]{12}\.sock$/)
    expect(socketPathFor("/run/fleet", "claude", "box-a").orElse("")).not.toBe(ok.orElse(""))
  })
})

describe.skipIf(!hasOpenSsh)("minting (OpenSSH)", () => {
  const ctx = { custody: undefined as Custody | undefined }
  const request = { ca: "home", agent: "unknown", principal: "fleet", sourceAddress: Option.none<string>() }

  beforeAll(async () => {
    const dir = freshDir()
    const key = keygen(dir, "ca")
    ctx.custody = (await startCaCustody(join(dir, "run"), [source("home", key)], nodeProcessRunner)).orThrow()
  })

  afterAll(async () => {
    await ctx.custody?.shutdown()
  })

  const custody = (): Custody => {
    if (ctx.custody === undefined) throw new Error("custody not started")
    return ctx.custody
  }
  const describeCert = (certPath: string): string =>
    execFileSync("ssh-keygen", ["-L", "-f", certPath], { encoding: "utf8" })

  it("mints a certificate with the agent, principal, validity and options", async () => {
    const minted = (await mint(custody(), request, nodeProcessRunner)).orThrow()
    const text = describeCert(minted.certPath)
    expect(text).toContain('Key ID: "unknown"')
    expect(text).toContain(`Serial: ${minted.serial}`)
    const valid = /Valid: from (\S+) to (\S+)/.exec(text)
    const span = valid ? new Date(valid[2]).getTime() - new Date(valid[1]).getTime() : 0
    expect(span).toBe(15 * 60 * 1000)
    expect(text).toMatch(/Principals:\s*\n\s+fleet\n/)
    expect(text).toMatch(/Critical Options: \(none\)/)
    const extensions = text
      .slice(text.indexOf("Extensions:"))
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
    expect(extensions).toEqual(["permit-pty"])
    await minted.dispose()
  })

  it("source_address becomes a critical option", async () => {
    const minted = (
      await mint(custody(), { ...request, sourceAddress: Option("100.64.0.1/32") }, nodeProcessRunner)
    ).orThrow()
    expect(describeCert(minted.certPath)).toContain("source-address 100.64.0.1/32")
    await minted.dispose()
  })

  it("dispose deletes the key and certificate, twice safely", async () => {
    const minted = (await mint(custody(), request, nodeProcessRunner)).orThrow()
    await minted.dispose()
    await minted.dispose()
    expect(readdirSync(custody().runtimeDir).filter((f) => f.startsWith("k-"))).toEqual([])
  })

  it("signing with an unknown CA fails naming it", async () => {
    const r = await mint(custody(), { ...request, ca: "nope" }, nodeProcessRunner)
    expect(
      r.fold(
        (e) => e,
        () => "",
      ),
    ).toMatch(/^CA "nope":/)
    expect(readdirSync(custody().runtimeDir).filter((f) => f.startsWith("k-"))).toEqual([])
  })
})
