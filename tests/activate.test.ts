import { describe, it, expect, vi, beforeEach } from "vitest"
import { formatActivationResult, handleAbapActivate, handleAbapActivateMultiple } from "../src/tools/activate"
import type { ActivationResult } from "abap-adt-api"

vi.mock("../src/connections", () => ({
  ensureConnected: vi.fn(),
  getHeldLock: vi.fn(),
  forgetLock: vi.fn(),
  trackLock: vi.fn(),
  log: vi.fn(),
  isEditingError: vi.fn(),
  editingConflictHint: vi.fn((err: unknown) => String((err as Error).message)),
}))
import { ensureConnected, getHeldLock, forgetLock, isEditingError } from "../src/connections"

const mockClient = {
  objectStructure: vi.fn(),
  activate: vi.fn(),
  inactiveObjects: vi.fn(),
  unLock: vi.fn(),
}

const mockStructure = {
  metaData: { "adtcore:name": "ZPROG", "adtcore:type": "PROG/P" },
  objectUrl: "/sap/bc/adt/programs/programs/ZPROG",
}

const successResult: ActivationResult = { success: true, messages: [], inactive: [] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  vi.mocked(getHeldLock).mockReturnValue(undefined)
  vi.mocked(isEditingError).mockReturnValue(false)
  mockClient.objectStructure.mockResolvedValue(mockStructure)
  mockClient.activate.mockResolvedValue(successResult)
  mockClient.unLock.mockResolvedValue(undefined)
  mockClient.inactiveObjects.mockResolvedValue([])
})

// ─── formatActivationResult ───────────────────────────────────────────────────

describe("formatActivationResult", () => {
  it("returns success message", () => {
    const text = formatActivationResult({ success: true, messages: [], inactive: [] })
    expect(text).toContain("✅")
  })

  it("includes messages on success", () => {
    const text = formatActivationResult({
      success: true,
      messages: [{ type: "W", shortText: "syntax warning", objDescr: "ZPROG", line: 5 }],
      inactive: []
    })
    expect(text).toContain("syntax warning")
    expect(text).toContain("line 5")
  })

  it("returns failure message with inactive objects", () => {
    const text = formatActivationResult({
      success: false,
      messages: [{ type: "E", shortText: "syntax error", line: 10 }],
      inactive: [{ object: { "adtcore:name": "ZPROG", "adtcore:uri": "/uri", "adtcore:type": "PROG/P", "adtcore:parentUri": "/" } }]
    } as any)
    expect(text).toContain("❌")
    expect(text).toContain("syntax error")
    expect(text).toContain("ZPROG")
  })
})

// ─── abap_activate ────────────────────────────────────────────────────────────

describe("abap_activate", () => {
  it("resolves object structure then activates", async () => {
    const result = await handleAbapActivate({ url: "/sap/bc/adt/programs/programs/ZPROG" })
    expect(mockClient.objectStructure).toHaveBeenCalledWith("/sap/bc/adt/programs/programs/ZPROG")
    expect(mockClient.activate).toHaveBeenCalledWith("ZPROG", mockStructure.objectUrl, undefined, false)
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("ZPROG")
  })

  it("passes preaudit flag", async () => {
    await handleAbapActivate({ url: "/sap/bc/adt/programs/programs/ZPROG", preaudit: true })
    expect(mockClient.activate).toHaveBeenCalledWith("ZPROG", mockStructure.objectUrl, undefined, true)
  })

  it("auto-unlocks a held lock before activating", async () => {
    vi.mocked(getHeldLock).mockReturnValue("HELD_HANDLE_AA95")
    await handleAbapActivate({ url: "/sap/bc/adt/programs/programs/ZPROG" })
    expect(mockClient.unLock).toHaveBeenCalledWith("/sap/bc/adt/programs/programs/ZPROG", "HELD_HANDLE_AA95")
    expect(forgetLock).toHaveBeenCalledWith(undefined, "/sap/bc/adt/programs/programs/ZPROG")
    expect(mockClient.activate).toHaveBeenCalled()
  })

  it("still activates even if the auto-unlock call fails", async () => {
    vi.mocked(getHeldLock).mockReturnValue("STALE_HANDLE")
    mockClient.unLock.mockRejectedValue(new Error("already unlocked"))
    const result = await handleAbapActivate({ url: "/sap/bc/adt/programs/programs/ZPROG" })
    expect(mockClient.activate).toHaveBeenCalled()
    expect(result.content[0].text).toContain("✅")
  })

  it("does not call unLock when no lock is held", async () => {
    vi.mocked(getHeldLock).mockReturnValue(undefined)
    await handleAbapActivate({ url: "/sap/bc/adt/programs/programs/ZPROG" })
    expect(mockClient.unLock).not.toHaveBeenCalled()
  })
})

// ─── abap_activate_multiple ───────────────────────────────────────────────────

describe("abap_activate_multiple", () => {
  it("activates objects found in the inactive worklist", async () => {
    mockClient.inactiveObjects.mockResolvedValue([{
      object: { "adtcore:name": "ZPROG", "adtcore:uri": "/uri/ZPROG", "adtcore:type": "PROG/P", "adtcore:parentUri": "/" }
    }])
    mockClient.activate.mockResolvedValue(successResult)

    const result = await handleAbapActivateMultiple({ urls: ["/uri/ZPROG"] })
    expect(mockClient.activate).toHaveBeenCalled()
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("ZPROG")
  })

  it("does not report a failed activation as activated", async () => {
    mockClient.inactiveObjects.mockResolvedValue([{
      object: { "adtcore:name": "ZCL_X", "adtcore:uri": "/uri/ZCL_X", "adtcore:type": "CLAS/OC", "adtcore:parentUri": "/" }
    }])
    mockClient.activate.mockResolvedValue({ success: false, messages: [{ type: "E", shortText: "A RETURNING parameter must be fully typed." }], inactive: [] })
    const text = (await handleAbapActivateMultiple({ urls: ["/uri/ZCL_X"] })).content[0].text
    expect(text).toContain("Activation failed")
    expect(text).toContain("Not activated: ZCL_X")
    expect(text).not.toMatch(/^Activated:/m)
  })

  it("returns not-found message when none of the urls match the inactive list", async () => {
    mockClient.inactiveObjects.mockResolvedValue([])
    const result = await handleAbapActivateMultiple({ urls: ["/uri/ZPROG"] })
    expect(result.content[0].text).toContain("None of the requested objects are currently inactive")
    expect(mockClient.activate).not.toHaveBeenCalled()
  })
})
