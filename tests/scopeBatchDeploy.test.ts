import { describe, it, expect, vi, beforeEach } from "vitest"

// The SAP side, faked: which objects exist, the SAP_BASIS release, and what activation says.
const sap = vi.hoisted(() => ({
  existing: new Set<string>(),
  release: "816",
  activationFails: new Set<string>(),
  written: [] as string[],
  created: [] as string[],
}))

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  ensureConnected: vi.fn(async () => ({
    getObjectSource: async (url: string) => {
      const base = url.replace(/\/source\/main$/, "")
      if (!sap.existing.has(base)) throw new Error("not found")
      return base.endsWith("zcl_mcp_cust_engine") ? `CONSTANTS c_version TYPE string VALUE '${ENGINE_VERSION_FOR_FAKE.v}'.` : "source"
    },
  })),
  log: vi.fn(),
}))
const ENGINE_VERSION_FOR_FAKE = vi.hoisted(() => ({ v: "" }))
vi.mock("../src/tools/customizing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/customizing")>()),
  runSql: vi.fn(async (_c: unknown, sql: string) => sql.includes("FROM CVERS")
    ? { columns: [{ name: "RELEASE" }], values: [{ RELEASE: sap.release }] }
    : { columns: [], values: [] }),
}))
vi.mock("../src/tools/write", () => ({
  handleCreateAbapObject: vi.fn(async (a: { name: string }) => { sap.created.push(a.name); return { content: [{ type: "text", text: "ok" }] } }),
  handleWriteAbapObjectSource: vi.fn(async (a: { url: string }) => { sap.written.push(a.url); sap.existing.add(a.url); return { content: [{ type: "text", text: "ok" }] } }),
  handleDeleteAbapObject: vi.fn(),
}))
vi.mock("../src/tools/activate", () => ({
  handleAbapActivate: vi.fn(async (a: { url: string }) => ({ content: [{ type: "text",
    text: [...sap.activationFails].some(u => a.url.endsWith(u)) ? "❌ Activation failed — UNION is not supported" : "✅ activated" }] })),
}))

import { handleEngineBootstrap, ensureEngineClass } from "../src/tools/customizingEngine"
import { ENGINE_VERSION, ENGINE_CLASS_URL } from "../src/abap/zcl_mcp_cust_engine"
import { WRITER_REPORT_URL } from "../src/abap/zmcp_cust_write"
import { SCOPE_BATCH_CLASS_URL, basisSupportsScopeBatch, getScopeBatchSource } from "../src/abap/zcl_mcp_scope_batch"
import { getEngineSource } from "../src/abap/zcl_mcp_cust_engine"

beforeEach(() => {
  ENGINE_VERSION_FOR_FAKE.v = ENGINE_VERSION
  sap.existing = new Set([ENGINE_CLASS_URL, WRITER_REPORT_URL])
  sap.release = "816"
  sap.activationFails = new Set()
  sap.written = []
  sap.created = []
})

describe("the engine keeps its 7.40 floor", () => {
  it("the engine class has no UNION; the optional class has it", () => {
    expect(getEngineSource()).not.toMatch(/\bUNION\b(?! ALL of eight)/)
    expect(getEngineSource()).toContain("CALL METHOD ('ZCL_MCP_SCOPE_BATCH')=>('COUNT8')")
    expect(getScopeBatchSource()).toContain("UNION ALL SELECT")
  })

  it("reads the release the way CVERS stores it", () => {
    expect(basisSupportsScopeBatch("750")).toBe(true)
    expect(basisSupportsScopeBatch("816")).toBe(true)
    expect(basisSupportsScopeBatch("740")).toBe(false)
    expect(basisSupportsScopeBatch("702")).toBe(false)
    expect(basisSupportsScopeBatch(undefined)).toBe(false)
  })
})

describe("bootstrap installs the batch class on 7.50 and later only", () => {
  it("SAP_BASIS 816: creates and activates it", async () => {
    const r = await handleEngineBootstrap({ connectionId: "S4" })
    expect(sap.created).toContain("ZCL_MCP_SCOPE_BATCH")
    expect(sap.written).toContain(SCOPE_BATCH_CLASS_URL)
    expect(r.content[0].text).toContain("✅ ZCL_MCP_SCOPE_BATCH created and activated (optional, SAP_BASIS 816)")
  })

  it("SAP_BASIS 740: leaves it out and says the scope counts one table at a time", async () => {
    sap.release = "740"
    const r = await handleEngineBootstrap({ connectionId: "OLD" })
    expect(sap.written).not.toContain(SCOPE_BATCH_CLASS_URL)
    expect(r.content[0].text).toContain("ZCL_MCP_SCOPE_BATCH not installed: SAP_BASIS 740 is below 750")
    expect(r.content[0].text).not.toMatch(/❌/)
  })

  it("a failed activation of the optional class is a warning, not a failed bootstrap", async () => {
    sap.activationFails.add("zcl_mcp_scope_batch")
    const r = await handleEngineBootstrap({ connectionId: "S4B" })
    expect(r.content[0].text).toContain("⚠️  ZCL_MCP_SCOPE_BATCH did not activate, so the retest scope counts one table at a time")
    expect(r.content[0].text).toMatch(/Engine updated\./)
  })
})

describe("auto-deploy notices a missing batch class on 7.50+", () => {
  it("engine and report current, batch class missing on 816: deploys", async () => {
    const r = await ensureEngineClass("S4C")
    expect(r.changed).toBe(true)
    expect(sap.written).toContain(SCOPE_BATCH_CLASS_URL)
  })

  it("on 740 the missing class is expected, so nothing is deployed", async () => {
    sap.release = "740"
    const r = await ensureEngineClass("OLD2")
    expect(r).toEqual({ changed: false, action: "already current" })
    expect(sap.written).toEqual([])
  })
})
