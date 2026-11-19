import { describe, it, expect, vi, beforeEach } from "vitest"

// The SAP side, faked: which objects exist, the SAP_BASIS release, and what activation says.
const sap = vi.hoisted(() => ({
  existing: new Set<string>(),
  release: "816",
  activationFails: new Set<string>(),
  written: [] as string[],
  created: [] as string[],
  testSources: [] as string[],
  failTests: false,
  lastWrite: "",
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
  handleWriteAbapObjectSource: vi.fn(async (a: { url: string; sourceUrl?: string; source: string }) => {
    const target = a.sourceUrl ?? a.url
    sap.written.push(target); sap.existing.add(a.url); sap.existing.add(target); sap.lastWrite = target
    if (a.sourceUrl?.endsWith("/includes/testclasses")) sap.testSources.push(a.source)
    return { content: [{ type: "text", text: "ok" }] }
  }),
  handleDeleteAbapObject: vi.fn(),
}))
vi.mock("../src/tools/activate", () => ({
  handleAbapActivate: vi.fn(async (a: { url: string }) => ({ content: [{ type: "text",
    text: [...sap.activationFails].some(u => a.url.endsWith(u)) ||
      (sap.failTests && sap.lastWrite.endsWith("/includes/testclasses") && (sap.testSources.at(-1) ?? "").includes("FOR TESTING"))
      ? "❌ Activation failed — UNION is not supported" : "✅ activated" }] })),
}))
vi.mock("../src/tools/quality", () => ({
  handleCreateTestInclude: vi.fn(async () => { sap.created.push("TESTCLASSES"); return { content: [{ type: "text", text: "ok" }] } }),
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
  sap.testSources = []
  sap.failTests = false
  sap.lastWrite = ""
})

describe("bootstrap installs the engine's ABAP Unit tests", () => {
  it("creates the test include once and writes the tests into it", async () => {
    const r = await handleEngineBootstrap({ connectionId: "T1" })
    expect(sap.created).toContain("TESTCLASSES")
    expect(sap.testSources[0]).toContain("CLASS ltc_engine DEFINITION FINAL FOR TESTING")
    expect(r.content[0].text).toContain("✅ ABAP Unit tests installed")
  })

  it("tests that do not activate are emptied again and the engine stays installed", async () => {
    sap.failTests = true
    const r = await handleEngineBootstrap({ connectionId: "T2" })
    expect(sap.testSources).toHaveLength(2)
    expect(sap.testSources[1]).not.toContain("FOR TESTING")
    expect(r.content[0].text).toContain("⚠️  The engine's ABAP Unit tests did not activate on this system, so the test include was left empty")
    expect(r.content[0].text).toContain("✅ Report activated")
  })
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
