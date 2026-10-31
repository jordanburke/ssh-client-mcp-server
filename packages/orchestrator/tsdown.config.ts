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
// "Dirty" means tracked changes in what this build bundles: this package and ../core.
const sha = git("rev-parse", "--short=12", "HEAD")
const dirty = git("status", "--porcelain", "--untracked-files=no", "--", ".", "../core") !== undefined

// CI checks out a detached HEAD, where `rev-parse --abbrev-ref` prints "HEAD"; fall back to the
// branch GitHub Actions names (the PR's source branch, else the pushed branch or tag).
const env = (name: string): string | undefined => process.env[name] || undefined
const branch = git("symbolic-ref", "-q", "--short", "HEAD") ?? env("GITHUB_HEAD_REF") ?? env("GITHUB_REF_NAME")

const stamp = {
  commit: sha && (dirty ? `${sha}-dirty` : sha),
  branch,
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
