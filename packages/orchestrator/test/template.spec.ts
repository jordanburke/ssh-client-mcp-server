import { describe, expect, it } from "vitest"

import { parseFleet } from "../src/fleet.js"
import { FLEET_TEMPLATE } from "../src/template.js"

// "Remove the leading '# '": TOML lines lose it; prose lines ("## …") and bare "#" stay comments.
const uncomment = (block: string): string =>
  block
    .split("\n")
    .map((line) => (line.startsWith("# ") ? line.slice(2) : line))
    .join("\n")

const BLOCK = /^# --- example: .* ---\n([\s\S]*?)^# --- end ---$/gm

const blocks = (): string[] => [...FLEET_TEMPLATE.matchAll(BLOCK)].map((m) => m[1])

describe("FLEET_TEMPLATE", () => {
  it("the template parses to zero hosts", () => {
    const r = parseFleet(FLEET_TEMPLATE)
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.hosts).toEqual([])
  })

  it("every example block parses on its own", () => {
    const found = blocks()
    expect(found.length).toBeGreaterThanOrEqual(4)
    found.forEach((block) => {
      const r = parseFleet(uncomment(block))
      if (r.isLeft()) throw new Error(`${r.value}\n--- block ---\n${block}`)
    })
  })

  it("all example blocks parse together", () => {
    const r = parseFleet(FLEET_TEMPLATE.replace(BLOCK, (_, body: string) => uncomment(body)))
    if (r.isLeft()) throw new Error(r.value)
    expect(r.value.hosts.map((h) => h.name)).toEqual(["mini", "build", "nas"])
  })

  it("the template holds no inline secret fields", () => {
    expect(FLEET_TEMPLATE.split("\n").filter((l) => /^\s*#?\s*(password|private_key)\s*=/.test(l))).toEqual([])
  })
})
