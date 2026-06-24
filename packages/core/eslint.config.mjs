import baseConfig from "ts-builds/eslint-functype"

export default [
  ...baseConfig,
  {
    files: ["test/**/*.ts", "**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "functype/no-let": "off",
    },
  },
]
