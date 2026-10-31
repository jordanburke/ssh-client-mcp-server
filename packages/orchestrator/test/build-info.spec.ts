import { describe, expect, it } from "vitest"

import { buildInfo } from "../src/build-info.js"

describe("buildInfo", () => {
  // tsdown replaces __FLEET_BUILD__ at build time; tests run the source, where it is undefined.
  it("is empty when the build stamp wasn't injected", () => {
    expect(buildInfo()).toEqual({})
  })
})
