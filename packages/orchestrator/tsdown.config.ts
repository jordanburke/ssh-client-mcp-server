import { tsdown } from "ts-builds/tsdown"

export default {
  ...tsdown,
  entry: ["src/index.ts"],
  dts: { eager: true },
  deps: {
    ...tsdown.deps,
    alwaysBundle: ["@ssh-mcp/core"],
  },
}
