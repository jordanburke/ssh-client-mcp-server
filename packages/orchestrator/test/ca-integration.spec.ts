// End to end: CA custody, minting, OpenSSH masters and per-agent pools against a real sshd that this
// test runs as the current user (no root, no edits to any real SSH config). It trusts a throwaway CA
// through TrustedUserCAKeys and AuthorizedPrincipalsFile, and accepts nothing else.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect as netConnect } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"

import { Option } from "functype"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { nodeProcessRunner, socketPathFor, startCaCustody } from "@ssh-mcp/core"

import { parseFleet } from "../src/fleet.js"
import { buildFleetRunner, caKeySource, type FleetRunner } from "../src/runners.js"

const sshd = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find((p) => existsSync(p)) ?? "sshd"
const present = (bin: string, args: ReadonlyArray<string>): boolean =>
  spawnSync(bin, [...args], { stdio: "ignore" }).error === undefined
const hasTools =
  present("ssh", ["-V"]) &&
  present("ssh-keygen", ["-?"]) &&
  present("ssh-agent", ["-?"]) &&
  present("ssh-add", ["-?"]) &&
  present(sshd, ["-?"])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.end()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })

const waitUntil = async (check: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

describe.skipIf(!hasTools)("CA mode end to end (self-hosted sshd)", () => {
  const user = userInfo().username
  const port = 20000 + Math.floor(Math.random() * 20000)
  const fx = {
    dir: "",
    runtimeDir: "",
    sshd: undefined as ChildProcess | undefined,
    log: "",
    runner: undefined as FleetRunner | undefined,
    agentPid: 0,
    reason: "",
  }

  beforeAll(async () => {
    fx.dir = mkdtempSync(join(tmpdir(), "ca-it-"))
    // Control sockets need a short path; TMPDIR can be long.
    fx.runtimeDir = join(mkdtempSync("/tmp/fleet-"), "run")
    const d = fx.dir
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(d, "host")])
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(d, "ca")])
    writeFileSync(join(d, "authorized_principals"), "fleet\n")
    writeFileSync(
      join(d, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(d, "host")}`,
        "PidFile none",
        "UsePAM no",
        "StrictModes no",
        "AuthorizedKeysFile none",
        `TrustedUserCAKeys ${join(d, "ca.pub")}`,
        `AuthorizedPrincipalsFile ${join(d, "authorized_principals")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "LogLevel VERBOSE",
        "",
      ].join("\n"),
    )
    const server = spawn(sshd, ["-D", "-e", "-f", join(d, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] })
    server.stderr?.on("data", (b: Buffer) => {
      fx.log += b.toString()
    })
    fx.sshd = server
    if (!(await waitUntil(() => portOpen(port), 5000))) {
      fx.reason = `sshd did not start: ${fx.log.trim()}`
      console.warn(`skipping CA end-to-end tests — ${fx.reason}`)
      return
    }

    const fleet = parseFleet(`
runtime_dir = "${fx.runtimeDir}"
known_hosts = "${join(d, "known_hosts")}"

[[cas]]
name = "it"
key_file = "${join(d, "ca")}"

[[hosts]]
name = "local"
host = "127.0.0.1"
port = ${port}
user = "${user}"
ca = "it"
`).orThrow()
    const custody = (await startCaCustody(fx.runtimeDir, fleet.cas.map(caKeySource), nodeProcessRunner)).orThrow()
    fx.agentPid = Number(readFileSync(join(fx.runtimeDir, "agent.pid"), "utf8"))
    fx.runner = (
      await buildFleetRunner(
        fleet,
        undefined,
        Option({ custody, proc: nodeProcessRunner, knownHosts: join(d, "known_hosts") }),
      )
    ).orThrow()
  })

  afterAll(async () => {
    await fx.runner?.shutdown()
    fx.sshd?.kill()
    rmSync(fx.dir, { recursive: true, force: true })
    if (fx.runtimeDir) rmSync(dirname(fx.runtimeDir), { recursive: true, force: true })
  })

  const runner = (skip: () => void): FleetRunner => {
    if (fx.runner === undefined) {
      skip()
      throw new Error(fx.reason)
    }
    return fx.runner
  }
  const logCount = (pattern: RegExp): number => (fx.log.match(new RegExp(pattern, "g")) ?? []).length

  it("exec runs over a certificate", async (ctx) => {
    const r = await runner(() => ctx.skip()).exec("local", "whoami", "unknown")
    expect(r.stdout.trim()).toBe(user)
    expect(r.code).toBe(0)
    expect(fx.log).toContain('Accepted certificate ID "unknown"')
  })

  it("exit codes come through", async (ctx) => {
    expect((await runner(() => ctx.skip()).exec("local", "exit 7", "unknown")).code).toBe(7)
  })

  it("a second agent gets its own certificate", async (ctx) => {
    await runner(() => ctx.skip()).exec("local", "true", "claude")
    expect(fx.log).toContain('Accepted certificate ID "claude"')
  })

  it("a stopped master's socket does not fall back", async (ctx) => {
    runner(() => ctx.skip())
    const sock = socketPathFor(fx.runtimeDir, "unknown", "local").orThrow()
    const target = ["-p", String(port), `${user}@127.0.0.1`]
    spawnSync("ssh", ["-F", "/dev/null", "-S", sock, "-O", "stop", ...target])
    expect(await waitUntil(() => !existsSync(sock), 5000)).toBe(true)
    const before = logCount(/Accepted |Failed publickey/)
    // The exact exec command the factory uses, with the user's full environment (their agent too).
    const direct = spawnSync(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-S",
        sock,
        "-o",
        "ControlMaster=no",
        "-o",
        "ProxyCommand=false",
        "-o",
        "BatchMode=yes",
        ...target,
        "--",
        "true",
      ],
      { env: process.env, timeout: 10_000 },
    )
    expect(direct.status).not.toBe(0)
    await sleep(300)
    expect(logCount(/Accepted |Failed publickey/)).toBe(before)
  })

  it("shutdown leaves nothing behind", async (ctx) => {
    await runner(() => ctx.skip()).shutdown()
    expect(existsSync(fx.runtimeDir)).toBe(false)
    expect(
      await waitUntil(() => {
        try {
          process.kill(fx.agentPid, 0)
          return false
        } catch {
          return true
        }
      }, 3000),
    ).toBe(true)
    fx.runner = undefined
  })
})
