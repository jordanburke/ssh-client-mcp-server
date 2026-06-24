import baseConfig from "ts-builds/eslint-functype"

export default [
  ...baseConfig,
  {
    files: ["test/**/*.ts", "**/*.spec.ts", "**/*.test.ts"],
    rules: {
      // Test-scope mutable fixtures (tmpdir paths populated in beforeAll) are
      // the idiomatic vitest pattern; no-let is overly strict for that.
      "functype/no-let": "off",
    },
  },
]
