import { execFileSync } from "node:child_process"

import { tsdown } from "ts-builds/tsdown"

// The commit and branch this build came from, or undefined outside a git checkout.
const git = (...args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
  } catch {
    return undefined
  }
}

// The short commit, plus "-dirty" when the tree has uncommitted changes. Not `git describe`: the
// repo's tags (v1.5.1, …) are the connector's versions, not this server's.
const sha = git("rev-parse", "--short=12", "HEAD")
const dirty = git("status", "--porcelain") !== undefined

const stamp = {
  commit: sha && (dirty ? `${sha}-dirty` : sha),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  date: new Date().toISOString(),
}

export default {
  ...tsdown,
  entry: ["src/index.ts"],
  dts: { eager: true },
  define: { __FLEET_BUILD__: JSON.stringify(stamp) },
  deps: {
    ...tsdown.deps,
    alwaysBundle: ["@ssh-mcp/core"],
  },
}
