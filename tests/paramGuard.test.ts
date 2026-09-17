import { describe, it, expect } from "vitest"
import { z } from "zod"
import { checkArgs, resolveAliases } from "../src/tools/paramGuard"

const createSchema = z.object({
  objectType: z.string(),
  name: z.string(),
  packageName: z.string(),
  transport: z.string().optional(),
  connectionId: z.string().optional(),
})

describe("paramGuard", () => {
  it("takes common aliases as the tool's own names", () => {
    const r = checkArgs("create_abap_object", createSchema, { objectType: "PROG/P", objectName: "ZX", package: "$TMP", connection: "S4" })
    expect(r).toEqual({ ok: true, args: { objectType: "PROG/P", name: "ZX", packageName: "$TMP", connectionId: "S4" } })
  })

  it("prefers the real name when both are given", () => {
    expect(resolveAliases(["name"], { name: "A", objectName: "B" }).args.name).toBe("A")
  })

  it("names a missing parameter and lists what the tool accepts", () => {
    const r = checkArgs("create_abap_object", createSchema, { objectType: "PROG/P", packageName: "$TMP" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('Missing required parameter "name" (string)')
      expect(r.message).toContain("• packageName (required) — string")
      expect(r.message).toContain("• transport — string")
    }
  })

  it("refuses an unknown parameter instead of dropping it, with a suggestion", () => {
    const r = checkArgs("create_abap_object", createSchema, { objectType: "PROG/P", name: "ZX", packageName: "$TMP", Transport: "A4HK900196" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('Unknown parameter "Transport" — did you mean "transport"?')
  })

  it("reports a wrong type in one sentence", () => {
    const r = checkArgs("create_abap_object", createSchema, { objectType: "PROG/P", name: 42, packageName: "$TMP" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('Parameter "name"')
  })
})
