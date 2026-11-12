import { describe, it, expect } from "vitest"
import { TOOL_HINTS, hintsFor } from "../src/tools/toolAnnotations"
import { TOOL_TIERS } from "../src/tools/riskTiers"

describe("tool annotations", () => {
  it("covers every tool that has a risk tier, and nothing else", () => {
    expect(Object.keys(TOOL_HINTS).sort()).toEqual(Object.keys(TOOL_TIERS).sort())
  })

  it("never marks a tool read-only above tier 0, except reads that sit in a write tier", () => {
    // These only read. customizing_plan_change is tier 1 as the planning half of a write;
    // the debugger's stack and variable views are tier 2 with the rest of the debugger.
    const readOnlyAboveTier0 = new Set(["customizing_plan_change", "abap_debug_stack", "abap_debug_variable"])
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      if (tier > 0 && !readOnlyAboveTier0.has(name)) expect(TOOL_HINTS[name].readOnlyHint, name).toBe(false)
    }
  })

  it("never marks a tool with autoDeploy read-only (it can install the engine class)", () => {
    for (const name of ["transport_move", "org_copy", "customizing_apply", "customizing_create", "retail_listing", "customizing_selftest"]) {
      expect(TOOL_HINTS[name].readOnlyHint, name).toBe(false)
    }
  })

  it("gives an unknown tool the most cautious hints", () => {
    expect(hintsFor("not_a_tool")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
  })

  it("marks every tool as talking to an outside system", () => {
    for (const name of Object.keys(TOOL_HINTS)) expect(hintsFor(name).openWorldHint).toBe(true)
  })
})
