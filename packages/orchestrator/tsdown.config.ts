import { tsdown } from "ts-builds/tsdown"

export default {
  ...tsdown,
  entry: ["src/index.ts"],
  deps: {
    ...tsdown.deps,
    alwaysBundle: ["@ssh-mcp/core"],
  },
}
