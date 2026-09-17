import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  formatRequest,
  handleManageTransportRequests,
  handleListAllTransports,
  handleGetTransportForObject,
} from "../src/tools/transports"
import type { TransportRequest } from "abap-adt-api"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn(), log: vi.fn(),
  getConnectionConfig: vi.fn(() => ({ id: "S4", username: "GEERT" })),
  resolveConnectionId: vi.fn(() => "S4"),
}))

// SQL answers keyed by a fragment of the statement.
const sqlAnswers: Array<[RegExp, Array<Record<string, string>>]> = []
vi.mock("../src/tools/customizing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/customizing")>()
  return {
    ...actual,
    runSql: vi.fn(async (_c: unknown, sql: string) => {
      const hit = sqlAnswers.find(([re]) => re.test(sql))
      const rows = hit ? hit[1] : []
      const columns = rows.length ? Object.keys(rows[0]).map(name => ({ name })) : [{ name: "X" }]
      return { columns, values: rows }
    }),
  }
})
import * as os from "os"
import * as path from "path"
process.env.ABAP_MCP_TRANSPORT_MEMORY = path.join(os.tmpdir(), `abap-mcp-transports-test-${process.pid}.json`)
import { ensureConnected } from "../src/connections"

const mockClient = {
  username: "BASIS",
  userTransports: vi.fn(),
  transportDetails: vi.fn(),
  createTransport: vi.fn(),
  transportRelease: vi.fn(),
  transportDelete: vi.fn(),
  transportSetOwner: vi.fn(),
  transportInfo: vi.fn(),
  systemUsers: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  mockClient.transportDelete.mockResolvedValue(undefined)
})

// ─── formatRequest ────────────────────────────────────────────────────────────

describe("formatRequest", () => {
  it("formats transport fields", () => {
    const r = {
      "tm:number": "CARX000123",
      "tm:status": "D",
      "tm:owner": "BASIS",
      "tm:desc": "My transport",
    } as unknown as TransportRequest
    const text = formatRequest(r)
    expect(text).toContain("CARX000123")
    expect(text).toContain("D")
    expect(text).toContain("BASIS")
    expect(text).toContain("My transport")
  })
})

// ─── manage_transport_requests: list ─────────────────────────────────────────

describe("manage_transport_requests list", () => {
  beforeEach(() => { sqlAnswers.length = 0 })

  it("lists the user's open requests from E070, newest first", async () => {
    sqlAnswers.push([/FROM E070 WHERE STRKORR/, [
      { TRKORR: "A4HK900202", TRFUNCTION: "W", TRSTATUS: "D", AS4USER: "GEERT", AS4DATE: "20260824", AS4TEXT: "ZBETRM customizing" },
      { TRKORR: "A4HK900196", TRFUNCTION: "K", TRSTATUS: "D", AS4USER: "GEERT", AS4DATE: "20260821", AS4TEXT: "ZBETRM workbench" },
    ]])
    const r = await handleManageTransportRequests({ action: "list" })
    const text = r.content[0].text
    expect(text).toContain("Open requests for GEERT (2)")
    expect(text).toContain("A4HK900202  Customizing")
    expect(text).toContain("A4HK900196  Workbench")
  })

  it("says so when the user has no open request", async () => {
    const r = await handleManageTransportRequests({ action: "list", username: "nobody" })
    expect(r.content[0].text).toContain("No open transport requests for NOBODY")
  })
})

describe("manage_transport_requests details", () => {
  const detailTransport = {
    "tm:number": "CARX000010",
    "tm:status": "D",
    "tm:owner": "DEVUSER",
    "tm:desc": "Fix for order report",
    "tm:uri": "/uri/CARX000010",
    links: [],
    objects: [
      { "tm:pgmid": "R3TR", "tm:type": "PROG", "tm:name": "ZPROG_A", "tm:dummy_uri": "", "tm:obj_info": "Program" }
    ],
    tasks: [
      {
        "tm:number": "CARX000011",
        "tm:owner": "DEVUSER",
        "tm:desc": "Task 1",
        "tm:status": "D",
        "tm:uri": "",
        links: [],
        objects: [
          { "tm:pgmid": "R3TR", "tm:type": "CLAS", "tm:name": "ZCL_ORDER", "tm:dummy_uri": "", "tm:obj_info": "Class" }
        ]
      }
    ]
  } as unknown as TransportRequest

  it("shows owner, status, description, and objects", async () => {
    mockClient.transportDetails.mockResolvedValue(detailTransport)
    const result = await handleManageTransportRequests({ action: "details", transportNumber: "CARX000010" })
    const text = result.content[0].text
    expect(text).toContain("CARX000010")
    expect(text).toContain("DEVUSER")
    expect(text).toContain("Fix for order report")
    expect(text).toContain("ZPROG_A")
    expect(text).toContain("ZCL_ORDER")
  })

  it("shows total object count across all tasks", async () => {
    mockClient.transportDetails.mockResolvedValue(detailTransport)
    const result = await handleManageTransportRequests({ action: "details", transportNumber: "CARX000010" })
    expect(result.content[0].text).toContain("Total objects: 2")
  })

  it("returns error when transportNumber is missing", async () => {
    const result = await handleManageTransportRequests({ action: "details" })
    expect(result.content[0].text).toContain("transportNumber required")
  })
})

// ─── manage_transport_requests: create ───────────────────────────────────────

describe("manage_transport_requests create", () => {
  it("creates a transport and returns its number", async () => {
    mockClient.createTransport.mockResolvedValue("CARX000099")
    const result = await handleManageTransportRequests({
      action: "create",
      objectUrl: "/url",
      description: "My fix",
      packageName: "ZDEV",
    })
    expect(result.content[0].text).toContain("CARX000099")
    expect(result.content[0].text).toContain("My fix")
    expect(result.content[0].text).toContain("ZDEV")
  })

  it("returns error when required fields are missing", async () => {
    const result = await handleManageTransportRequests({ action: "create" })
    expect(result.content[0].text).toContain("required")
    expect(mockClient.createTransport).not.toHaveBeenCalled()
  })
})

// ─── manage_transport_requests: release ──────────────────────────────────────

describe("manage_transport_requests release", () => {
  it("reports success when all checks pass", async () => {
    mockClient.transportRelease.mockResolvedValue([{
      "chkrun:status": "released",
      messages: [{ "chkrun:type": "S", "chkrun:shortText": "Released OK" }]
    }])
    const result = await handleManageTransportRequests({ action: "release", transportNumber: "CARX000001" })
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("Released OK")
  })

  it("reports failure when status is not released", async () => {
    mockClient.transportRelease.mockResolvedValue([{
      "chkrun:status": "abortrelapifail",
      messages: [{ "chkrun:type": "E", "chkrun:shortText": "Objects locked" }]
    }])
    const result = await handleManageTransportRequests({ action: "release", transportNumber: "CARX000001" })
    expect(result.content[0].text).toContain("❌")
    expect(result.content[0].text).toContain("Objects locked")
  })

  it("returns error message when number is missing", async () => {
    const result = await handleManageTransportRequests({ action: "release" })
    expect(result.content[0].text).toContain("transportNumber required")
  })
})

// ─── manage_transport_requests: delete ───────────────────────────────────────

describe("manage_transport_requests delete", () => {
  it("deletes transport and confirms", async () => {
    const result = await handleManageTransportRequests({ action: "delete", transportNumber: "CARX000055" })
    expect(mockClient.transportDelete).toHaveBeenCalledWith("CARX000055")
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("CARX000055")
    expect(result.content[0].text).toContain("deleted")
  })

  it("returns error when transportNumber is missing", async () => {
    const result = await handleManageTransportRequests({ action: "delete" })
    expect(result.content[0].text).toContain("transportNumber required")
    expect(mockClient.transportDelete).not.toHaveBeenCalled()
  })
})

// ─── manage_transport_requests: change_owner ─────────────────────────────────

describe("manage_transport_requests change_owner", () => {
  it("changes owner and confirms", async () => {
    mockClient.transportSetOwner.mockResolvedValue({
      "tm:number": "CARX000055",
      "tm:targetuser": "NEWUSER",
    })
    const result = await handleManageTransportRequests({
      action: "change_owner",
      transportNumber: "CARX000055",
      newOwner: "NEWUSER",
    })
    expect(mockClient.transportSetOwner).toHaveBeenCalledWith("CARX000055", "NEWUSER")
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("CARX000055")
    expect(result.content[0].text).toContain("NEWUSER")
  })

  it("returns error when required fields are missing", async () => {
    const result = await handleManageTransportRequests({ action: "change_owner", transportNumber: "CARX000055" })
    expect(result.content[0].text).toContain("required")
    expect(mockClient.transportSetOwner).not.toHaveBeenCalled()
  })
})

// ─── list_all_transports ──────────────────────────────────────────────────────

describe("list_all_transports", () => {
  beforeEach(() => { sqlAnswers.length = 0 })

  it("groups requests by owner and lists objects, including those in tasks", async () => {
    sqlAnswers.push([/FROM E070 WHERE STRKORR/, [
      { TRKORR: "A4HK900202", TRFUNCTION: "W", TRSTATUS: "D", AS4USER: "GEERT", AS4DATE: "20260824", AS4TEXT: "ZBETRM customizing" },
      { TRKORR: "A4HK900300", TRFUNCTION: "K", TRSTATUS: "D", AS4USER: "OTHER", AS4DATE: "20260901", AS4TEXT: "Other work" },
    ]])
    sqlAnswers.push([/FROM E071 WHERE TRKORR IN/, [{ TRKORR: "A4HK900300", PGMID: "R3TR", OBJECT: "PROG", OBJ_NAME: "ZPROG" }]])
    sqlAnswers.push([/INNER JOIN E071/, [{ STRKORR: "A4HK900202", PGMID: "R3TR", OBJECT: "VDAT", OBJ_NAME: "V_OIB01" }]])
    const r = await handleListAllTransports({})
    const text = r.content[0].text
    expect(text).toContain("── GEERT (1) ──")
    expect(text).toContain("── OTHER (1) ──")
    expect(text).toContain("R3TR VDAT V_OIB01")
    expect(text).toContain("R3TR PROG ZPROG")
  })

  it("says so when nothing matches", async () => {
    const r = await handleListAllTransports({ status: "released" })
    expect(r.content[0].text).toContain("No released transport requests")
  })

  it("can skip the objects", async () => {
    sqlAnswers.push([/FROM E070 WHERE STRKORR/, [
      { TRKORR: "A4HK900202", TRFUNCTION: "W", TRSTATUS: "D", AS4USER: "GEERT", AS4DATE: "20260824", AS4TEXT: "ZBETRM customizing" },
    ]])
    const r = await handleListAllTransports({ withObjects: false })
    expect(r.content[0].text).not.toContain("(no objects)")
  })
})

describe("get_transport_for_object", () => {
  it("returns transport info fields", async () => {
    mockClient.transportInfo.mockResolvedValue({
      PGMID: "R3TR",
      OBJECT: "PROG",
      OBJECTNAME: "ZPROG",
      DEVCLASS: "ZDEV",
      OPERATION: "I",
      CTEXT: "Workbench request"
    })
    const result = await handleGetTransportForObject({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("R3TR")
    expect(text).toContain("ZPROG")
    expect(text).toContain("ZDEV")
    expect(text).toContain("Workbench request")
  })
})
