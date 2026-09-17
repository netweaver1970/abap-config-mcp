import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleRunAtcAnalysis,
  handleRunUnitTests,
  handleCreateTestInclude,
} from "../src/tools/quality"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn(), log: vi.fn(),
}))
import { ensureConnected } from "../src/connections"

const mockClient = {
  createAtcRun: vi.fn(),
  atcWorklists: vi.fn(),
  unitTestRun: vi.fn(),
  unitTestEvaluation: vi.fn(),
  lock: vi.fn(),
  unLock: vi.fn(),
  createTestInclude: vi.fn(),
  transportInfo: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  mockClient.lock.mockResolvedValue({ LOCK_HANDLE: "LH1" })
  mockClient.unLock.mockResolvedValue(undefined)
  mockClient.transportInfo.mockResolvedValue({ RECORDING: "", DEVCLASS: "$TMP" })
})

// ─── run_atc_analysis ─────────────────────────────────────────────────────────

describe("run_atc_analysis", () => {
  it("returns clean message when no findings", async () => {
    mockClient.createAtcRun.mockResolvedValue({ id: "RUN1", timestamp: "", infos: [] })
    mockClient.atcWorklists.mockResolvedValue({ objects: [] })
    const result = await handleRunAtcAnalysis({ url: "/url" })
    expect(result.content[0].text).toContain("No ATC findings")
  })

  it("returns formatted findings", async () => {
    mockClient.createAtcRun.mockResolvedValue({ id: "RUN1", timestamp: "", infos: [] })
    mockClient.atcWorklists.mockResolvedValue({
      objects: [{
        name: "ZPROG",
        findings: [{
          priority: 1,
          checkId: "NAMING",
          checkTitle: "Naming Conventions",
          messageTitle: "Variable not prefixed",
          location: { range: { start: { line: 42 } } }
        }]
      }]
    })
    const result = await handleRunAtcAnalysis({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("[P1]")
    expect(text).toContain("NAMING")
    expect(text).toContain("Variable not prefixed")
    expect(text).toContain("line 42")
    expect(text).toContain("1 finding(s)")
  })

  it("uses DEFAULT variant when none specified", async () => {
    mockClient.createAtcRun.mockResolvedValue({ id: "R", timestamp: "", infos: [] })
    mockClient.atcWorklists.mockResolvedValue({ objects: [] })
    await handleRunAtcAnalysis({ url: "/url" })
    expect(mockClient.createAtcRun).toHaveBeenCalledWith("DEFAULT", "/url", 100)
  })
})

// ─── run_unit_tests ───────────────────────────────────────────────────────────

describe("run_unit_tests", () => {
  const cls = { "adtcore:name": "ZCL_TEST", "adtcore:uri": "/url" }

  it("returns no-test message when no classes found", async () => {
    mockClient.unitTestRun.mockResolvedValue([])
    const result = await handleRunUnitTests({ url: "/url" })
    expect(result.content[0].text).toContain("No unit test classes")
  })

  it("marks passing methods with checkmark", async () => {
    mockClient.unitTestRun.mockResolvedValue([cls])
    mockClient.unitTestEvaluation.mockResolvedValue([
      { "adtcore:name": "TEST_HAPPY_PATH", alerts: [] }
    ])
    const result = await handleRunUnitTests({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("1 passed, 0 failed")
    expect(text).toContain("✅")
    expect(text).toContain("TEST_HAPPY_PATH")
  })

  it("marks failing methods with cross and shows alert details", async () => {
    mockClient.unitTestRun.mockResolvedValue([cls])
    mockClient.unitTestEvaluation.mockResolvedValue([{
      "adtcore:name": "TEST_FAIL",
      alerts: [{ severity: "critical", kind: "failedAssertion", title: "Expected 1 but got 2", details: ["Expected: 1", "Actual: 2"] }]
    }])
    const result = await handleRunUnitTests({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("0 passed, 1 failed")
    expect(text).toContain("❌")
    expect(text).toContain("Expected 1 but got 2")
    expect(text).toContain("Expected: 1")
  })

  it("derives failures from the run result itself, even when evaluation returns empty alerts (S/4HANA 2025)", async () => {
    // Live repro: unitTestRun already reports the failed assertion, but
    // unitTestEvaluation comes back alert-free — must NOT report passed.
    mockClient.unitTestRun.mockResolvedValue([{
      ...cls,
      testmethods: [{
        "adtcore:name": "REGISTER_ENGINE_SERVICE",
        alerts: [{ severity: "critical", kind: "failedAssertion", title: "Unconditional fail", details: [] }]
      }]
    }])
    mockClient.unitTestEvaluation.mockResolvedValue([
      { "adtcore:name": "REGISTER_ENGINE_SERVICE", alerts: [] }
    ])
    const result = await handleRunUnitTests({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("0 passed, 1 failed")
    expect(text).toContain("❌")
    expect(text).toContain("Unconditional fail")
    // Run result had method details, so the unreliable evaluation must not be consulted
    expect(mockClient.unitTestEvaluation).not.toHaveBeenCalled()
  })

  it("counts passing methods from the run result without calling evaluation", async () => {
    mockClient.unitTestRun.mockResolvedValue([{
      ...cls,
      testmethods: [{ "adtcore:name": "TEST_OK", alerts: [] }]
    }])
    const result = await handleRunUnitTests({ url: "/url" })
    expect(result.content[0].text).toContain("1 passed, 0 failed")
    expect(mockClient.unitTestEvaluation).not.toHaveBeenCalled()
  })

  it("reports unknown (never passed) when both run result and evaluation lack method details", async () => {
    mockClient.unitTestRun.mockResolvedValue([{ ...cls, testmethods: [] }])
    mockClient.unitTestEvaluation.mockResolvedValue([])
    const result = await handleRunUnitTests({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("0 passed, 0 failed, 1 unknown")
    expect(text).toContain("❓")
    expect(text).toContain("UNKNOWN")
    expect(text).not.toContain("✅")
  })

  it("surfaces class-level alerts (e.g. setup failures) as failures", async () => {
    mockClient.unitTestRun.mockResolvedValue([{
      ...cls,
      alerts: [{ severity: "fatal", kind: "exception", title: "Error in setup", details: [] }],
      testmethods: []
    }])
    mockClient.unitTestEvaluation.mockResolvedValue([])
    const result = await handleRunUnitTests({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("0 passed, 1 failed")
    expect(text).toContain("Error in setup")
  })
})

// ─── create_test_include ──────────────────────────────────────────────────────

describe("create_test_include", () => {
  it("locks on the class URL but passes the class NAME to createTestInclude", async () => {
    mockClient.createTestInclude.mockResolvedValue(undefined)
    const result = await handleCreateTestInclude({ classUrl: "/sap/bc/adt/oo/classes/ZCL_TEST" })
    // Lock is correctly on the class object URL (include shares the class enqueue)
    expect(mockClient.lock).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/ZCL_TEST")
    // createTestInclude builds /oo/classes/<clas>/includes — it needs the NAME, not the URL
    expect(mockClient.createTestInclude).toHaveBeenCalledWith("ZCL_TEST", "LH1", undefined)
    expect(mockClient.unLock).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/ZCL_TEST", "LH1")
    expect(result.content[0].text).toContain("✅")
  })

  it("unlocks and rethrows when creation fails", async () => {
    mockClient.createTestInclude.mockRejectedValue(new Error("include exists"))
    await expect(handleCreateTestInclude({ classUrl: "/url" })).rejects.toThrow("include exists")
    expect(mockClient.unLock).toHaveBeenCalled()
  })
})
