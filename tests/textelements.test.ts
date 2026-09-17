import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleGetTextElements, handleSetTextElements,
  parseTextBody, formatTextBody, mergeEntries, validateEntries,
} from "../src/tools/textelements"

vi.mock("../src/connections", () => ({
  ensureConnected: vi.fn(),
  dropSessionLocks: vi.fn(),
  isInvalidLockError: vi.fn(),
  isEditingError: vi.fn(),
  editingConflictHint: vi.fn((err: unknown) => String((err as Error).message)),
  log: vi.fn(),
}))
import { ensureConnected, isInvalidLockError, isEditingError } from "../src/connections"

vi.mock("../src/tools/activate", () => ({
  handleAbapActivate: vi.fn(async () => ({ content: [{ type: "text", text: "✅ Activation successful" }] })),
}))
import { handleAbapActivate } from "../src/tools/activate"

vi.mock("abap-adt-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("abap-adt-api")>()
  return {
    ...actual,
    ADTClient: class {
      static textElementsUrl(_type: string, name: string) {
        return `/sap/bc/adt/textelements/programs/${name.toLowerCase()}`
      }
    },
  }
})

const TEXT_URL = "/sap/bc/adt/textelements/programs/zprog"

// Bodies exactly as SAP returned them on S4 (2026-09-17), CRLF included.
const SAP_SELECTIONS =
  "P_BUKRS =Company code (own)\r\n\r\nP_FLAG  =A checkbox\r\n\r\n@DDICReference\r\nP_WERKS =Plant\r\n\r\n" +
  "@DDICReference\r\nS_MATNR =Material\r\n\r\nP_OTHER =?...\r\n"
const SAP_SYMBOLS = "@MaxLength:40\r\n001=Probe symbol one\r\n\r\n@MaxLength:20\r\n002=Second\r\n"
const SAP_HEADINGS = "listHeader=Probe list header\r\n\r\ncolumnHeader_1=Col one\r\ncolumnHeader_2=\r\ncolumnHeader_3=\r\ncolumnHeader_4=\r\n"

// ─── format ───────────────────────────────────────────────────────────────────

describe("parseTextBody", () => {
  it("reads the bare @DDICReference marker and skips unmaintained ?... texts", () => {
    expect(parseTextBody(SAP_SELECTIONS, "selections")).toEqual([
      { id: "P_BUKRS", text: "Company code (own)" },
      { id: "P_FLAG", text: "A checkbox" },
      { id: "P_WERKS", text: "Plant", dictionaryReference: true },
      { id: "S_MATNR", text: "Material", dictionaryReference: true },
    ])
  })

  it("reads each symbol's maximum length", () => {
    expect(parseTextBody(SAP_SYMBOLS, "symbols")).toEqual([
      { id: "001", text: "Probe symbol one", maxLength: 40 },
      { id: "002", text: "Second", maxLength: 20 },
    ])
  })

  it("normalises camel-cased heading ids and drops empty column headers", () => {
    expect(parseTextBody(SAP_HEADINGS, "headings")).toEqual([
      { id: "LISTHEADER", text: "Probe list header" },
      { id: "COLUMNHEADER_1", text: "Col one" },
    ])
  })
})

describe("formatTextBody", () => {
  it("writes a dictionary reference as a bare marker with an empty text", () => {
    expect(formatTextBody([
      { id: "p_bukrs", text: "Company code (own)" },
      { id: "P_WERKS", text: "ignored", dictionaryReference: true },
    ], "selections")).toBe(
      "P_BUKRS =Company code (own)\r\n\r\n@DDICReference\r\nP_WERKS =\r\n\r\n"
    )
  })

  it("puts a maximum length before every symbol, defaulting to the text length", () => {
    expect(formatTextBody([
      { id: "001", text: "Probe symbol one", maxLength: 40 },
      { id: "002", text: "Second" },
    ], "symbols")).toBe("@MaxLength:40\r\n001=Probe symbol one\r\n\r\n@MaxLength:6\r\n002=Second\r\n\r\n")
  })

  it("never writes a maximum length shorter than the text", () => {
    expect(formatTextBody([{ id: "001", text: "Twelve chars" , maxLength: 5 }], "symbols"))
      .toContain("@MaxLength:12\r\n")
  })

  it("writes headings as plain id=text lines", () => {
    expect(formatTextBody([{ id: "listheader", text: "Report" }], "headings")).toBe("LISTHEADER=Report\r\n")
  })

  it("round-trips what SAP returned", () => {
    const parsed = parseTextBody(SAP_SYMBOLS, "symbols")
    expect(parseTextBody(formatTextBody(parsed, "symbols"), "symbols")).toEqual(parsed)
  })
})

describe("mergeEntries", () => {
  it("updates by id case-insensitively, keeps the rest, removes on request", () => {
    const merged = mergeEntries(
      [{ id: "P_A", text: "A" }, { id: "P_B", text: "B" }, { id: "P_C", text: "C" }],
      [{ id: "p_b", text: "B2" }, { id: "P_D", text: "D" }],
      ["p_c"],
    )
    expect(merged).toEqual([{ id: "P_A", text: "A" }, { id: "P_B", text: "B2" }, { id: "P_D", text: "D" }])
  })
})

describe("validateEntries", () => {
  it("accepts a long dictionary-referenced selection, refuses a long own text", () => {
    expect(validateEntries([{ id: "P_X", text: "x".repeat(40), dictionaryReference: true }], "selections")).toEqual([])
    expect(validateEntries([{ id: "P_X", text: "x".repeat(31) }], "selections")[0]).toContain("maximum is 30")
  })

  it("refuses bad symbol ids and headings ids", () => {
    expect(validateEntries([{ id: "01", text: "x" }], "symbols")[0]).toContain("exactly 3")
    expect(validateEntries([{ id: "H", text: "x" }], "headings")[0]).toContain("LISTHEADER")
  })
})

// ─── handlers ─────────────────────────────────────────────────────────────────

const h = { request: vi.fn() }
const mockClient = { h, lock: vi.fn(), unLock: vi.fn() }

function answerGet(bodies: Record<string, string>) {
  h.request.mockImplementation(async (url: string, opts: any) => {
    if (opts?.method === "PUT") return { body: "" }
    const cat = url.split("/").pop() as string
    return { body: bodies[cat] ?? "" }
  })
}
const puts = () => h.request.mock.calls.filter(([, o]) => o?.method === "PUT")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  vi.mocked(isInvalidLockError).mockReturnValue(false)
  vi.mocked(isEditingError).mockReturnValue(false)
  mockClient.lock.mockResolvedValue({ LOCK_HANDLE: "LH_TEXT_001" })
  mockClient.unLock.mockResolvedValue(undefined)
  answerGet({ selections: SAP_SELECTIONS, symbols: SAP_SYMBOLS, headings: SAP_HEADINGS })
})

describe("get_text_elements", () => {
  it("shows dictionary references and maximum lengths", async () => {
    const r = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG" })
    const text = r.content[0].text
    expect(text).toContain("selections (4)")
    expect(text).toContain("P_WERKS")
    expect(text).toContain("[dictionary reference]")
    expect(text).toContain("(max 40)")
    expect(text).toContain("headings (2)")
  })

  it("treats a category that cannot be read as empty when reading all", async () => {
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith("/symbols")) throw Object.assign(new Error("boom"), { status: 500 })
      return { body: SAP_SELECTIONS }
    })
    const r = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG" })
    expect(r.content[0].text).toContain("No symbols text elements found")
  })
})

describe("set_text_elements — merge, format, lock", () => {
  it("merges into the existing texts, locks the text resource and always releases it", async () => {
    const r = await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "selections",
      elements: [{ id: "P_FLAG", text: "Changed" }, { id: "P_NEW", text: "", dictionaryReference: true }],
      transport: "A4HK900196",
    })
    expect(mockClient.lock).toHaveBeenCalledWith(TEXT_URL)
    const [[url, opts]] = puts()
    expect(url).toBe(`${TEXT_URL}/source/selections`)
    expect(opts.qs).toEqual({ lockHandle: "LH_TEXT_001", corrNr: "A4HK900196" })
    // Existing texts kept, the change applied, the new dictionary reference added.
    expect(opts.body).toContain("P_BUKRS =Company code (own)")
    expect(opts.body).toContain("P_FLAG  =Changed")
    expect(opts.body).toContain("@DDICReference\r\nP_WERKS =")
    expect(opts.body).toContain("@DDICReference\r\nP_NEW   =")
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "LH_TEXT_001")
    expect(r.content[0].text).toContain("merged")
  })

  it("activates the text-element resource after writing, unless told not to", async () => {
    await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "symbols", elements: [{ id: "001", text: "x" }],
    })
    expect(handleAbapActivate).toHaveBeenCalledWith({ url: TEXT_URL, connectionId: undefined })
    vi.mocked(handleAbapActivate).mockClear()
    const r = await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "symbols", elements: [{ id: "001", text: "x" }], activate: false,
    })
    expect(handleAbapActivate).not.toHaveBeenCalled()
    expect(r.content[0].text).toContain(TEXT_URL)
  })

  it("replace: true writes exactly the list", async () => {
    await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "symbols", replace: true,
      elements: [{ id: "010", text: "Only me" }],
    })
    expect(puts()[0][1].body).toBe("@MaxLength:7\r\n010=Only me\r\n\r\n")
  })

  it("remove deletes ids", async () => {
    await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "symbols", elements: [], remove: ["001"],
    })
    expect(puts()[0][1].body).toBe("@MaxLength:20\r\n002=Second\r\n\r\n")
  })

  it("refuses invalid input without locking", async () => {
    const r = await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "headings", elements: [{ id: "H", text: "x" }],
    })
    expect(r.content[0].text).toContain("Nothing written")
    expect(mockClient.lock).not.toHaveBeenCalled()
  })

  it("releases the lock and rethrows when the write fails", async () => {
    h.request.mockImplementation(async (_u: string, o: any) => {
      if (o?.method === "PUT") throw new Error("Text elements contain errors")
      return { body: "" }
    })
    await expect(handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "symbols", elements: [{ id: "001", text: "x" }],
    })).rejects.toThrow("Text elements contain errors")
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "LH_TEXT_001")
  })

  it("on a stale lock releases it, re-acquires and retries once", async () => {
    vi.mocked(isInvalidLockError).mockReturnValue(true)
    mockClient.lock
      .mockResolvedValueOnce({ LOCK_HANDLE: "STALE" })
      .mockResolvedValueOnce({ LOCK_HANDLE: "FRESH" })
    let failed = false
    h.request.mockImplementation(async (_u: string, o: any) => {
      if (o?.method === "PUT" && !failed) { failed = true; throw new Error("invalid lock handle") }
      return { body: "" }
    })
    const r = await handleSetTextElements({
      objectType: "PROG/P", objectName: "ZPROG", category: "symbols", elements: [{ id: "001", text: "x" }],
    })
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "STALE")
    expect(puts()[1][1].qs.lockHandle).toBe("FRESH")
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "FRESH")
    expect(r.content[0].text).toContain("✅")
  })
})
