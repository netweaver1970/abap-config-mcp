import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../src/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connections")>()
  return { ...actual, ensureConnected: vi.fn(), getHeldLock: vi.fn(), forgetLock: vi.fn(), trackLock: vi.fn(), log: vi.fn() }
})
import { ensureConnected, getHeldLock, isRequestError, isSessionDegradedError } from "../src/connections"
import { handleUnlockAbapObject } from "../src/tools/write"
import { readSource } from "../src/tools/source"
import { stillInactive, handleAbapActivateMultiple } from "../src/tools/activate"
import { handleRunUnitTests } from "../src/tools/quality"

const client: any = {
  unLock: vi.fn(), getObjectSource: vi.fn(), inactiveObjects: vi.fn(), activate: vi.fn(), unitTestRun: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(client)
})

describe("query errors are not session errors", () => {
  it("does not treat an SQL mistake answered with HTTP 400 as a degraded session", () => {
    for (const message of ['Unknown column name "TABCLASS".', '"LIKE" is not allowed here. ") " is expected.', "Cannot find 'OIJLOCTT'"]) {
      const err = Object.assign(new Error(message), { status: 400 })
      expect(isRequestError(err)).toBe(true)
      expect(isSessionDegradedError(err)).toBe(false)
    }
  })

  it("still treats a bare HTTP 400 as a degraded session", () => {
    expect(isSessionDegradedError(Object.assign(new Error("Bad Request"), { status: 400 }))).toBe(true)
  })
})

describe("unlock_abap_object", () => {
  it("uses the lock this server holds when no handle is given", async () => {
    vi.mocked(getHeldLock).mockReturnValue("HELD1")
    await handleUnlockAbapObject({ url: "/sap/bc/adt/programs/programs/z" })
    expect(client.unLock).toHaveBeenCalledWith("/sap/bc/adt/programs/programs/z", "HELD1")
  })

  it("explains what to do when there is no handle at all", async () => {
    vi.mocked(getHeldLock).mockReturnValue(undefined)
    const r = await handleUnlockAbapObject({ url: "/x" })
    expect(r.content[0].text).toContain("force_relogin")
    expect(client.unLock).not.toHaveBeenCalled()
  })
})

describe("readSource", () => {
  it("retries on /source/main when an object URL returns metadata", async () => {
    client.getObjectSource
      .mockResolvedValueOnce('<?xml version="1.0"?><fmodule:abapFunctionModule/>')
      .mockResolvedValueOnce("FUNCTION z.")
    expect(await readSource(client, "/sap/bc/adt/functions/groups/g/fmodules/z")).toBe("FUNCTION z.")
    expect(client.getObjectSource).toHaveBeenLastCalledWith("/sap/bc/adt/functions/groups/g/fmodules/z/source/main")
  })
})

describe("activation honesty", () => {
  it("finds what is still inactive under the object and its text elements", async () => {
    client.inactiveObjects.mockResolvedValue([
      { object: { "adtcore:name": "ZPROG", "adtcore:type": "PROG/PX", "adtcore:uri": "/sap/bc/adt/textelements/programs/zprog" } },
      { object: { "adtcore:name": "LZG_F01", "adtcore:type": "FUGR/I", "adtcore:uri": "/sap/bc/adt/functions/groups/zg/includes/lzg_f01" } },
      { object: { "adtcore:name": "OTHER", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/other" } },
    ])
    const prog = await stillInactive(client, ["/sap/bc/adt/programs/programs/zprog"], ["ZPROG"])
    expect(prog.map(o => o.type)).toEqual(["PROG/PX"])
    const group = await stillInactive(client, ["/sap/bc/adt/functions/groups/zg"], ["ZG"])
    expect(group.map(o => o.name)).toEqual(["LZG_F01"])
  })

  it("releases this server's own locks before a batch activation", async () => {
    vi.mocked(getHeldLock).mockImplementation((_c, url) => (url === "/a" ? "LH_A" : undefined))
    client.inactiveObjects.mockResolvedValue([])
    await handleAbapActivateMultiple({ urls: ["/a", "/b"] })
    expect(client.unLock).toHaveBeenCalledWith("/a", "LH_A")
    expect(client.unLock).toHaveBeenCalledTimes(1)
  })
})

describe("run_unit_tests", () => {
  it("runs every risk level and duration by default", async () => {
    client.unitTestRun.mockResolvedValue([])
    await handleRunUnitTests({ url: "/c" })
    expect(client.unitTestRun).toHaveBeenCalledWith("/c", { harmless: true, dangerous: true, critical: true, short: true, medium: true, long: true })
  })

  it("narrows when asked", async () => {
    client.unitTestRun.mockResolvedValue([])
    await handleRunUnitTests({ url: "/c", riskLevels: ["harmless"], durations: ["short"] })
    expect(client.unitTestRun).toHaveBeenCalledWith("/c", { harmless: true, dangerous: false, critical: false, short: true, medium: false, long: false })
  })
})
