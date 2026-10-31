import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { type Option, Try } from "functype"

const real = (path: string): Option<string> => Try(() => realpathSync(path)).toOption()

// True when this module is the program being run, not one imported by a test. Compares real paths:
// npm and npx start a package's bin through a symlink in node_modules/.bin, so argv[1] is the link.
export const isEntryPoint = (argv1: Option<string>, moduleUrl: string): boolean => {
  const self = real(fileURLToPath(moduleUrl))
  return argv1.flatMap(real).exists((script) => self.contains(script))
}
