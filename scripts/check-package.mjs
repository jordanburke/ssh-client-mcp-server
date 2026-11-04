#!/usr/bin/env node
// Checks the artifact npm would ship, not the manifest that describes it: pack the package, look
// inside the tarball, install it, and start it through npm's bin link over stdio.
// Usage: node scripts/check-package.mjs <package dir> [--tarball-out=<dir>] [server args...]
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const argv = process.argv.slice(2)
const dir = argv[0]
if (!dir) throw new Error("usage: check-package.mjs <package dir> [--tarball-out=<dir>] [server args...]")
const tarballOut = argv.find((a) => a.startsWith("--tarball-out="))?.split("=")[1]
const serverArgs = argv.slice(1).filter((a) => !a.startsWith("--tarball-out="))

const pkgDir = resolve(dir)
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
const distDir = join(pkgDir, "dist")
if (!existsSync(join(distDir, "index.js"))) throw new Error(`${pkgDir}/dist/index.js is missing: build first`)

const failures = []
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`)
  if (!ok) failures.push(message)
}

// --- every import in the built code is a node builtin or a declared runtime dependency
const packageOf = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")
const builtins = new Set(builtinModules)
const isBuiltin = (spec) => spec.startsWith("node:") || builtins.has(packageOf(spec))
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\s]+)["']/g
const imports = readdirSync(distDir)
  .filter((f) => f.endsWith(".js"))
  .flatMap((f) => [...readFileSync(join(distDir, f), "utf8").matchAll(IMPORT_RE)].map((m) => m[1]))
const external = [...new Set(imports)].filter((s) => !s.startsWith(".") && !isBuiltin(s))
const undeclared = external.filter((s) => !(packageOf(s) in (pkg.dependencies ?? {})))
check(external.length > 0, `found the built code's imports (${external.length} external)`)
check(
  undeclared.length === 0,
  `every built import is a runtime dependency${undeclared.length ? `: ${undeclared.join(", ")}` : ""}`,
)

// --- versions agree across the manifest and the registry file
const serverFile = join(pkgDir, "server.json")
if (existsSync(serverFile)) {
  const server = JSON.parse(readFileSync(serverFile, "utf8"))
  check(server.version === pkg.version, `server.json version ${server.version} matches package.json ${pkg.version}`)
  check(server.packages?.[0]?.version === pkg.version, "server.json packages[0].version matches package.json")
  check(pkg.mcpName === server.name, `package.json mcpName ${pkg.mcpName} matches server.json name ${server.name}`)
}
check(pkg.repository?.url?.includes("github.com/"), "package.json repository is set (npm provenance checks it)")

// --- the tarball
const work = mkdtempSync(join(tmpdir(), "check-package-"))
process.on("exit", () => rmSync(work, { recursive: true, force: true }))
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })

run("pnpm", ["pack", "--pack-destination", work], pkgDir)
const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"))
if (!tarball) throw new Error("pnpm pack produced no tarball")
const tarPath = join(work, tarball)
const files = run("tar", ["tzf", tarPath]).split("\n")
for (const want of ["package/package.json", "package/dist/index.js", "package/README.md", "package/LICENSE"])
  check(files.includes(want), `tarball holds ${want.replace("package/", "")}`)
const packed = JSON.parse(run("tar", ["xzOf", tarPath, "package/package.json"]))
check(!Object.keys(packed.dependencies ?? {}).includes("@ssh-mcp/core"), "@ssh-mcp/core is not a runtime dependency")
const specs = [...Object.values(packed.dependencies ?? {}), ...Object.values(packed.devDependencies ?? {})]
check(!specs.some((v) => v.startsWith("workspace:")), "the packed manifest has no workspace: versions")

// --- install it, then start it through the bin link, as npx and global installs do
const prefix = join(work, "prefix")
run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarPath], work)
const binName = Object.keys(pkg.bin)[0]
const home = join(work, "home")

const start = () =>
  new Promise((done, fail) => {
    const child = spawn(join(prefix, "bin", binName), serverArgs, {
      env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, "state") },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const state = { out: "", err: "", server: undefined, tools: undefined }
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`no answer in 30 s; a server that exits silently fails here. stderr: ${state.err}`))
    }, 30_000)
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stderr.on("data", (d) => (state.err += d))
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (state.tools === undefined) fail(new Error(`exited ${code} before listing tools. stderr: ${state.err}`))
    })
    child.stdout.on("data", (d) => {
      state.out += d
      const lines = state.out.split("\n")
      state.out = lines.pop()
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line)
        if (message.id === 1) {
          state.server = message.result?.serverInfo
          send({ jsonrpc: "2.0", method: "notifications/initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        }
        if (message.id === 2) {
          state.tools = message.result?.tools?.map((t) => t.name) ?? []
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "info", arguments: {} } })
        }
        if (message.id === 3) {
          clearTimeout(timer)
          child.kill()
          done({ server: state.server, tools: state.tools, info: message.result?.content?.[0]?.text })
        }
      }
    })
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-package", version: "1" } },
    })
  })

const started = await start()
check(started.server?.version === pkg.version, `server reports version ${started.server?.version}`)
check(started.tools.includes("exec"), `server lists its tools: ${started.tools.join(", ")}`)
if (process.env.CI && pkg.name === "ssh-fleet-mcp-server") {
  const commit = /"commit":\s*"([^"]+)"/.exec(started.info ?? "")?.[1] ?? ""
  check(commit !== "" && !commit.endsWith("-dirty"), `release build stamp is a clean commit: ${commit}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} packaging check(s) failed for ${pkg.name}`)
  process.exit(1)
}
if (tarballOut) {
  copyFileSync(tarPath, join(resolve(tarballOut), tarball))
  console.log(`wrote ${join(resolve(tarballOut), tarball)}`)
}
console.log(`\n${pkg.name}@${pkg.version}: the package installs and starts`)
process.exit(0)
