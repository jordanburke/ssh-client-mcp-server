// Which build is running, for somamcp's `info` tool. tsdown.config.ts replaces __FLEET_BUILD__ with
// the short commit (with -dirty for uncommitted changes), branch and build date. Unbuilt source (tests, tsx)
// has no stamp, so somamcp falls back to its SOMAMCP_BUILD_* environment variables.
export type BuildStamp = Readonly<{ commit?: string; branch?: string; date?: string }>

/** @interop tsdown's `define` replaces this identifier at build time; it is undefined in unbuilt source. */
declare const __FLEET_BUILD__: BuildStamp | undefined

export const buildInfo = (): BuildStamp => (typeof __FLEET_BUILD__ === "undefined" ? {} : __FLEET_BUILD__)
