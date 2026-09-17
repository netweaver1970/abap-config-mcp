import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleWriteAbapObjectSource,
  handleLockAbapObject,
  handleUnlockAbapObject,
  handleCreateAbapObject,
  handleDeleteAbapObject,
} from "../src/tools/write"

// Mock only the side-effecting pieces; the pure error classifiers
// (isEditingError, editingConflictHint) stay real.
vi.mock("../src/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connections")>()
  return {
    ...actual,
    ensureConnected: vi.fn(),
    getHeldLock: vi.fn(),
    trackLock: vi.fn(),
    forgetLock: vi.fn(),
    dropSessionLocks: vi.fn(),
    log: vi.fn(),
  }
})
import { ensureConnected, trackLock, forgetLock, dropSessionLocks } from "../src/connections"

vi.mock("../src/tools/transportSql", () => ({
  lookupRequest: vi.fn(async (_conn: string | undefined, trkorr: string) => ({ trkorr, fn: "K", status: "D", owner: "DEV", text: "Test request" })),
  listOpenRequests: vi.fn(async () => []),
}))
import * as os from "os"
import * as path from "path"
process.env.ABAP_MCP_TRANSPORT_MEMORY = path.join(os.tmpdir(), `abap-mcp-write-test-${process.pid}.json`)

const mockClient = {
  lock: vi.fn(),
  unLock: vi.fn(),
  setObjectSource: vi.fn(),
  createObject: vi.fn(),
  deleteObject: vi.fn(),
  transportInfo: vi.fn(),
  createTransport: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  // Default: local / non-transportable package → governed transport selection
  // resolves to "no transport needed" and the handlers proceed unprompted.
  mockClient.transportInfo.mockResolvedValue({ RECORDING: "", DEVCLASS: "$TMP" })
  mockClient.lock.mockResolvedValue({ LOCK_HANDLE: "LOCK_ABC123" })
  mockClient.unLock.mockResolvedValue(undefined)
  mockClient.setObjectSource.mockResolvedValue(undefined)
  mockClient.createObject.mockResolvedValue(undefined)
  mockClient.deleteObject.mockResolvedValue(undefined)
})

// ─── write_abap_object_source ─────────────────────────────────────────────────

describe("write_abap_object_source", () => {
  it("locks, writes, and returns lock handle in response", async () => {
    const result = await handleWriteAbapObjectSource({
      url: "/sap/bc/adt/programs/ZPROG",
      source: "REPORT zprog.",
    })
    expect(mockClient.lock).toHaveBeenCalledWith("/sap/bc/adt/programs/ZPROG")
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(
      "/sap/bc/adt/programs/ZPROG/source/main",
      "REPORT zprog.",
      "LOCK_ABC123",
      undefined
    )
    // Released after the write by default.
    expect(mockClient.unLock).toHaveBeenCalledWith("/sap/bc/adt/programs/ZPROG", "LOCK_ABC123")
    expect(forgetLock).toHaveBeenCalledWith(undefined, "/sap/bc/adt/programs/ZPROG")
    expect(result.content[0].text).toContain("Unlocked")
    expect(result.content[0].text).toContain("✅")
  })

  it("reuses a lock this conversation already holds and leaves it held", async () => {
    const { getHeldLock } = await import("../src/connections")
    vi.mocked(getHeldLock).mockReturnValueOnce("HELD_BEFORE")
    const result = await handleWriteAbapObjectSource({ url: "/sap/bc/adt/programs/ZPROG", source: "REPORT zprog." })
    expect(mockClient.lock).not.toHaveBeenCalled()
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(expect.any(String), expect.any(String), "HELD_BEFORE", undefined)
    expect(mockClient.unLock).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain("locked before this write")
  })

  it("keeps the lock when asked", async () => {
    const result = await handleWriteAbapObjectSource({ url: "/sap/bc/adt/programs/ZPROG", source: "REPORT zprog.", keepLock: true })
    expect(mockClient.unLock).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain("LOCK_ABC123")
  })

  it("registers the lock handle in the lock registry after a successful write", async () => {
    await handleWriteAbapObjectSource({ url: "/sap/bc/adt/programs/ZPROG", source: "REPORT zprog." })
    expect(trackLock).toHaveBeenCalledWith(undefined, "/sap/bc/adt/programs/ZPROG", "LOCK_ABC123")
  })

  it("uses explicit sourceUrl when provided", async () => {
    await handleWriteAbapObjectSource({
      url: "/sap/bc/adt/programs/ZPROG",
      sourceUrl: "/sap/bc/adt/programs/ZPROG/source/custom",
      source: "REPORT zprog.",
    })
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(
      "/sap/bc/adt/programs/ZPROG/source/custom",
      expect.any(String), expect.any(String), undefined
    )
  })

  it("passes transport number through", async () => {
    mockClient.transportInfo.mockResolvedValue({ RECORDING: "X", DEVCLASS: "ZDEV", TRANSPORTS: [] })
    await handleWriteAbapObjectSource({
      url: "/sap/bc/adt/programs/ZPROG",
      source: "REPORT zprog.",
      transport: "CARX000123",
    })
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "CARX000123"
    )
  })

  it("unlocks, clears registry, and rethrows when write fails", async () => {
    mockClient.setObjectSource.mockRejectedValue(new Error("write failed"))
    await expect(handleWriteAbapObjectSource({ url: "/url", source: "x" })).rejects.toThrow("write failed")
    expect(mockClient.unLock).toHaveBeenCalledWith("/url", "LOCK_ABC123")
    expect(forgetLock).toHaveBeenCalledWith(undefined, "/url")
  })
})

// ─── lock_abap_object ─────────────────────────────────────────────────────────

describe("lock_abap_object", () => {
  it("returns the lock handle", async () => {
    const result = await handleLockAbapObject({ url: "/sap/bc/adt/programs/ZPROG" })
    expect(result.content[0].text).toContain("LOCK_ABC123")
    expect(result.content[0].text).toContain("🔒")
  })

  it("registers the lock in the lock registry", async () => {
    await handleLockAbapObject({ url: "/sap/bc/adt/programs/ZPROG" })
    expect(trackLock).toHaveBeenCalledWith(undefined, "/sap/bc/adt/programs/ZPROG", "LOCK_ABC123")
  })
})

// ─── unlock_abap_object ───────────────────────────────────────────────────────

describe("unlock_abap_object", () => {
  it("calls unLock, clears registry, and confirms", async () => {
    const result = await handleUnlockAbapObject({ url: "/url", lockHandle: "LOCK_ABC123" })
    expect(mockClient.unLock).toHaveBeenCalledWith("/url", "LOCK_ABC123")
    expect(forgetLock).toHaveBeenCalledWith(undefined, "/url")
    expect(result.content[0].text).toContain("🔓")
    expect(result.content[0].text).toContain("/url")
  })
})

// ─── create_abap_object ───────────────────────────────────────────────────────

describe("create_abap_object", () => {
  it("normalises the bare object-type prefix to the full creatable typeId", async () => {
    mockClient.transportInfo.mockResolvedValue({ RECORDING: "X", DEVCLASS: "ZDEV", TRANSPORTS: [] })
    const result = await handleCreateAbapObject({
      objectType: "PROG", // bare prefix → must be normalised to PROG/P
      name: "ZPROG_NEW",
      description: "My new program",
      packageName: "ZDEV",
      transport: "CARX000123",
    })
    expect(mockClient.createObject).toHaveBeenCalledWith(
      "PROG/P", "ZPROG_NEW", "ZDEV", "My new program",
      "/sap/bc/adt/packages/ZDEV", undefined, "CARX000123"
    )
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("ZPROG_NEW")
    expect(result.content[0].text).toContain("CARX000123")
  })

  it("drops the session after create to release the implicit author lock", async () => {
    // createObject registers an implicit author edit-lock that client.lock() cannot
    // re-enter via the API. Dropping the session releases it so a subsequent
    // write_abap_object_source can acquire a fresh lock instead of failing with
    // "already being edited". (Verified live in the write integration suite.)
    await handleCreateAbapObject({
      objectType: "PROG", name: "ZPROG", description: "desc", packageName: "ZDEV",
    })
    expect(dropSessionLocks).toHaveBeenCalled()
  })

  it("uses provided parentPath instead of default", async () => {
    await handleCreateAbapObject({
      objectType: "PROG", name: "ZPROG", description: "desc",
      packageName: "ZDEV", parentPath: "/custom/path",
    })
    expect(mockClient.createObject).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String),
      expect.any(String), "/custom/path", undefined, undefined
    )
  })
})

// ─── delete_abap_object ───────────────────────────────────────────────────────

describe("delete_abap_object", () => {
  it("locks, deletes, unlocks, and clears registry", async () => {
    const result = await handleDeleteAbapObject({ url: "/sap/bc/adt/programs/ZPROG" })
    expect(mockClient.lock).toHaveBeenCalledWith("/sap/bc/adt/programs/ZPROG")
    expect(mockClient.deleteObject).toHaveBeenCalledWith("/sap/bc/adt/programs/ZPROG", "LOCK_ABC123", undefined)
    // ADT DELETE does not auto-release the enqueue — must unlock explicitly
    expect(mockClient.unLock).toHaveBeenCalledWith("/sap/bc/adt/programs/ZPROG", "LOCK_ABC123")
    expect(forgetLock).toHaveBeenCalledWith(undefined, "/sap/bc/adt/programs/ZPROG")
    expect(result.content[0].text).toContain("🗑️")
  })

  it("unlocks, clears registry, and rethrows when delete fails", async () => {
    mockClient.deleteObject.mockRejectedValue(new Error("delete failed"))
    await expect(handleDeleteAbapObject({ url: "/url" })).rejects.toThrow("delete failed")
    expect(mockClient.unLock).toHaveBeenCalledWith("/url", "LOCK_ABC123")
    expect(forgetLock).toHaveBeenCalledWith(undefined, "/url")
  })
})

// ─── empty RECORDING on a real package ───────────────────────────────────────
//
// ADT answered RECORDING = '' for a class in a transportable package (S4,
// 2026-09-18). Treating that as "local, no transport" made ADT fall back to the
// user's default request, which SAP then refused with "Object LIMU CPRI ... is
// already locked in request ...". Only a package that really is local is
// allowed to skip the transport.
describe("transport when ADT reports no recording", () => {
  it("still records a real package on the request the object is locked in", async () => {
    mockClient.transportInfo.mockResolvedValue({
      RECORDING: "", DEVCLASS: "ZBETRM", TRANSPORTS: [],
      LOCKS: { HEADER: { TRKORR: "A4HK900196" }, TASKS: [{ TRKORR: "A4HK900197", AS4USER: "DEV" }] },
    })
    await handleWriteAbapObjectSource({ url: "/sap/bc/adt/oo/classes/zcl_x", source: "CLASS zcl_x DEFINITION." })
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(
      "/sap/bc/adt/oo/classes/zcl_x/source/main", "CLASS zcl_x DEFINITION.", "LOCK_ABC123", "A4HK900196")
  })

  it("passes the request, not a task of it, when a task is named", async () => {
    mockClient.transportInfo.mockResolvedValue({
      RECORDING: "X", DEVCLASS: "ZBETRM", TRANSPORTS: [],
      LOCKS: { HEADER: { TRKORR: "A4HK900196" }, TASKS: [{ TRKORR: "A4HK900197", AS4USER: "DEV" }] },
    })
    await handleWriteAbapObjectSource({
      url: "/sap/bc/adt/oo/classes/zcl_x", source: "CLASS zcl_x DEFINITION.", transport: "A4HK900197" })
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(
      "/sap/bc/adt/oo/classes/zcl_x/source/main", "CLASS zcl_x DEFINITION.", "LOCK_ABC123", "A4HK900196")
  })

  it("skips the transport for a package that really is local", async () => {
    mockClient.transportInfo.mockResolvedValue({ RECORDING: "", DEVCLASS: "$TMP" })
    await handleWriteAbapObjectSource({ url: "/sap/bc/adt/programs/ZTMP", source: "REPORT ztmp." })
    expect(mockClient.setObjectSource).toHaveBeenCalledWith(
      "/sap/bc/adt/programs/ZTMP/source/main", "REPORT ztmp.", "LOCK_ABC123", undefined)
  })

  it("creates on the request that was named, not on a generated one", async () => {
    // With RECORDING = '' treated as local, createObject was called without a
    // request and ADT answered by generating one ("Generated Request for Change
    // Recording"), scattering new objects over requests nobody asked for.
    mockClient.transportInfo.mockResolvedValue({ RECORDING: "", DEVCLASS: "ZBETRM", TRANSPORTS: [] })
    await handleCreateAbapObject({
      objectType: "CLAS", name: "ZCL_X", description: "x",
      packageName: "ZBETRM", transport: "A4HK900196" })
    const corrNr = mockClient.createObject.mock.calls[0][6]
    expect(corrNr).toBe("A4HK900196")
  })
})
