import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

// @ssh-mcp/core is private and bundled into dist by tsdown (alwaysBundle). As a runtime dependency
// it would make `npm install` of the published package fail with a 404.
describe("package.json", () => {
  it("does not depend at runtime on the private, bundled @ssh-mcp/core", () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@ssh-mcp/core")
    expect(pkg.devDependencies?.["@ssh-mcp/core"]).toBe("workspace:*")
  })

  it("has no workspace: protocol in runtime dependencies", () => {
    expect(Object.values(pkg.dependencies ?? {}).filter((v) => v.startsWith("workspace:"))).toEqual([])
  })
})
