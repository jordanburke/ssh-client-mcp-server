import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Option } from "functype"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { effectiveUser, parseArgv, type ResolveAuthOptions, resolveAuth, validateConfig } from "../src/config.js"

const auth = (overrides: Partial<ResolveAuthOptions> = {}): ResolveAuthOptions => ({
  password: Option.none<string>(),
  keyPath: Option.none<string>(),
  keyEnvVar: Option.none<string>(),
  useAgent: false,
  ...overrides,
})

describe("parseArgv", () => {
  it("parses --key=value pairs", () => {
    expect(parseArgv(["--host=1.2.3.4", "--port=22", "--user=root"])).toEqual({
      host: "1.2.3.4",
      port: "22",
      user: "root",
    })
  })

  it("returns empty for no args", () => {
    expect(parseArgv([])).toEqual({})
  })

  it("ignores malformed args", () => {
    expect(parseArgv(["--host=a", "notaflag", "--bare", "-x=1"])).toEqual({ host: "a" })
  })

  it("preserves values with '=' in them", () => {
    expect(parseArgv(["--password=p=ass=word"])).toEqual({ password: "p=ass=word" })
  })
})

describe("validateConfig", () => {
  it("accepts a complete config", () => {
    const result = validateConfig({ host: "box", user: "root" })
    expect(result.isRight()).toBe(true)
  })

  it("uses OS user fallback when --user is omitted", () => {
    // In any normal dev/CI environment Platform.userInfo() returns Some(...)
    const result = validateConfig({ host: "box" })
    expect(result.isRight()).toBe(true)
  })

  it("rejects missing --host", () => {
    const result = validateConfig({ user: "root" })
    expect(result.isLeft()).toBe(true)
    if (result.isLeft()) {
      expect(result.value).toContain("Missing required --host")
    }
  })

  it("rejects non-numeric --port", () => {
    const result = validateConfig({ host: "box", user: "root", port: "abc" })
    expect(result.isLeft()).toBe(true)
    if (result.isLeft()) {
      expect(result.value).toContain("Invalid --port")
    }
  })

  it("accumulates multiple errors", () => {
    const result = validateConfig({ port: "notanumber" })
    expect(result.isLeft()).toBe(true)
    if (result.isLeft()) {
      expect(result.value).toContain("Missing required --host")
      expect(result.value).toContain("Invalid --port")
    }
  })
})

describe("effectiveUser", () => {
  it("returns argv.user when provided", () => {
    const result = effectiveUser({ user: "alice" })
    expect(result.isSome()).toBe(true)
    if (result.isSome()) expect(result.value).toBe("alice")
  })

  it("falls back to OS user when argv.user is absent", () => {
    // Platform.userInfo() returns Some(...) in normal test environments.
    const result = effectiveUser({})
    expect(result.isSome()).toBe(true)
  })
})

describe("resolveAuth", () => {
  let tmpDir: string
  let keyFile: string
  const keyContents = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n"

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ssh-mcp-test-"))
    keyFile = join(tmpDir, "id_test")
    await writeFile(keyFile, keyContents)
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns password auth when password is present", async () => {
    const result = await resolveAuth(auth({ password: Option("hunter2") }))
    expect(result.isRight()).toBe(true)
    if (result.isRight()) expect(result.value).toEqual({ password: "hunter2" })
  })

  it("prefers password over key when both are present", async () => {
    const result = await resolveAuth(auth({ password: Option("hunter2"), keyPath: Option(keyFile) }))
    expect(result.isRight()).toBe(true)
    if (result.isRight()) expect(result.value).toEqual({ password: "hunter2" })
  })

  it("reads a key file from an absolute path", async () => {
    const result = await resolveAuth(auth({ keyPath: Option(keyFile) }))
    expect(result.isRight()).toBe(true)
    if (result.isRight()) expect(result.value).toEqual({ privateKey: keyContents })
  })

  it("expands $HOME in the key path", async () => {
    const prior = process.env.SSH_MCP_TEST_KEY_DIR
    process.env.SSH_MCP_TEST_KEY_DIR = tmpDir
    try {
      const result = await resolveAuth(auth({ keyPath: Option("$SSH_MCP_TEST_KEY_DIR/id_test") }))
      expect(result.isRight()).toBe(true)
      if (result.isRight()) expect(result.value).toEqual({ privateKey: keyContents })
    } finally {
      if (prior === undefined) delete process.env.SSH_MCP_TEST_KEY_DIR
      else process.env.SSH_MCP_TEST_KEY_DIR = prior
    }
  })

  it("returns Left on unresolved env var in key path", async () => {
    const result = await resolveAuth(auth({ keyPath: Option("$DEFINITELY_NOT_SET/key") }))
    expect(result.isLeft()).toBe(true)
    if (result.isLeft()) expect(result.value).toContain("Invalid SSH key path")
  })

  it("returns Left on missing key file", async () => {
    const result = await resolveAuth(auth({ keyPath: Option(join(tmpDir, "nonexistent")) }))
    expect(result.isLeft()).toBe(true)
    if (result.isLeft()) expect(result.value).toContain("Failed to read SSH key")
  })

  it("returns empty config when no auth mode is selected", async () => {
    const result = await resolveAuth(auth())
    expect(result.isRight()).toBe(true)
    if (result.isRight()) expect(result.value).toEqual({})
  })

  it("reads private key from named env var when --key-env is set", async () => {
    const prior = process.env.SSH_MCP_TEST_INLINE_KEY
    process.env.SSH_MCP_TEST_INLINE_KEY = keyContents
    try {
      const result = await resolveAuth(auth({ keyEnvVar: Option("SSH_MCP_TEST_INLINE_KEY") }))
      expect(result.isRight()).toBe(true)
      if (result.isRight()) expect(result.value).toEqual({ privateKey: keyContents })
    } finally {
      if (prior === undefined) delete process.env.SSH_MCP_TEST_INLINE_KEY
      else process.env.SSH_MCP_TEST_INLINE_KEY = prior
    }
  })

  it("returns Left when --key-env names an unset env var", async () => {
    delete process.env.SSH_MCP_DEFINITELY_UNSET
    const result = await resolveAuth(auth({ keyEnvVar: Option("SSH_MCP_DEFINITELY_UNSET") }))
    expect(result.isLeft()).toBe(true)
    if (result.isLeft()) expect(result.value).toContain("SSH_MCP_DEFINITELY_UNSET")
  })

  it("uses ssh-agent socket when --agent is set and SSH_AUTH_SOCK is present", async () => {
    const prior = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock"
    try {
      const result = await resolveAuth(auth({ useAgent: true }))
      expect(result.isRight()).toBe(true)
      if (result.isRight()) expect(result.value).toEqual({ agent: "/tmp/fake-agent.sock" })
    } finally {
      if (prior === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = prior
    }
  })

  it("returns Left when --agent is set but SSH_AUTH_SOCK is missing", async () => {
    const prior = process.env.SSH_AUTH_SOCK
    delete process.env.SSH_AUTH_SOCK
    try {
      const result = await resolveAuth(auth({ useAgent: true }))
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) expect(result.value).toContain("SSH_AUTH_SOCK")
    } finally {
      if (prior !== undefined) process.env.SSH_AUTH_SOCK = prior
    }
  })

  it("prefers --key over --key-env and --agent", async () => {
    const prior = process.env.SSH_MCP_TEST_INLINE_KEY
    const priorSock = process.env.SSH_AUTH_SOCK
    process.env.SSH_MCP_TEST_INLINE_KEY = "from-env"
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock"
    try {
      const result = await resolveAuth(
        auth({
          keyPath: Option(keyFile),
          keyEnvVar: Option("SSH_MCP_TEST_INLINE_KEY"),
          useAgent: true,
        }),
      )
      expect(result.isRight()).toBe(true)
      if (result.isRight()) expect(result.value).toEqual({ privateKey: keyContents })
    } finally {
      if (prior === undefined) delete process.env.SSH_MCP_TEST_INLINE_KEY
      else process.env.SSH_MCP_TEST_INLINE_KEY = prior
      if (priorSock === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = priorSock
    }
  })

  it("prefers --key-env over --agent", async () => {
    const prior = process.env.SSH_MCP_TEST_INLINE_KEY
    const priorSock = process.env.SSH_AUTH_SOCK
    process.env.SSH_MCP_TEST_INLINE_KEY = keyContents
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock"
    try {
      const result = await resolveAuth(auth({ keyEnvVar: Option("SSH_MCP_TEST_INLINE_KEY"), useAgent: true }))
      expect(result.isRight()).toBe(true)
      if (result.isRight()) expect(result.value).toEqual({ privateKey: keyContents })
    } finally {
      if (prior === undefined) delete process.env.SSH_MCP_TEST_INLINE_KEY
      else process.env.SSH_MCP_TEST_INLINE_KEY = prior
      if (priorSock === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = priorSock
    }
  })
})
