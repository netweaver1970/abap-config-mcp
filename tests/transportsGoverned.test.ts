import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"

// No SAP: any ADT client construction throws, and https answers as the engine.
const adtConstructed = vi.hoisted(() => ({ n: 0 }))
vi.mock("abap-adt-api", () => ({
  session_types: { stateful: "stateful" },
  createSSLConfig: () => ({}),
  ADTClient: class { constructor() { adtConstructed.n++; throw new Error("ADT client constructed") } },
}))
const engine = vi.hoisted(() => ({ reply: (_req: Record<string, unknown>) => ({}) as Record<string, unknown>, requests: [] as Record<string, unknown>[] }))
vi.mock("https", () => ({ default: { request: fakeRequest }, request: fakeRequest }))
function fakeRequest(_opts: unknown, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) {
  const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: (b: string) => void }
  req.setTimeout = () => {}
  req.end = (body: string) => {
    const parsed = JSON.parse(body) as Record<string, unknown>
    engine.requests.push(parsed)
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
    res.statusCode = 200
    res.headers = { "content-type": "application/json" }
    cb(res)
    res.emit("data", Buffer.from(JSON.stringify(engine.reply(parsed))))
    res.emit("end")
  }
  return req
}

import { resetServerModeForTests } from "../src/mode"
import { lookupRequest, listOpenRequests } from "../src/tools/transportSql"
import { handleListAllTransports, handleGetTransportForObject, adtUrlToObject } from "../src/tools/transports"
import { handleCustomizingApply } from "../src/tools/customizingEngine"
import { ENGINE_VERSION } from "../src/abap/zcl_mcp_cust_engine"

const ok = (data: unknown, messages: string[] = []) =>
  ({ STATUS: "ok", VERSION: ENGINE_VERSION, MESSAGES: messages, DATA_JSON: JSON.stringify(data) })

const W_REQ = { TRKORR: "A4HK900100", TRFUNCTION: "W", TRSTATUS: "D", AS4USER: "GEERT", AS4DATE: "2026-11-19", CLIENT: "250",
  TEXT: "Plants", TASKS: [{ TRKORR: "A4HK900101", AS4USER: "GEERT", TRFUNCTION: "Q", TRSTATUS: "D" }],
  OBJECTS: [{ PGMID: "R3TR", OBJECT: "VDAT", OBJ_NAME: "V_T001W" }] }

const DESCRIBE_T001W = { INPUT: "T001W", IS_VIEW: "X", VIEW: "V_T001W", ROOT_TABLE: "T001W", TABLES: ["T001W"],
  MAINT_OBJECT: "V_T001W", RECORD_OBJECT: "VDAT", TRANSPORT_OBJECT: "VDAT", TRANSPORT_NAME: "V_T001W",
  TABCLASS: "TRANSP", CONTFLAG: "C", CLIDEP: "X", CLIENT: "250", CCCORACTIV: "1", CCNOCLIIND: "" }

function engineFor(over: Partial<Record<string, (req: Record<string, unknown>) => Record<string, unknown>>> = {}) {
  return (req: Record<string, unknown>) => {
    const op = String(req.operation)
    if (over[op]) return over[op]!(req)
    if (op === "ping") return ok({})
    if (op === "ddic_describe") return ok(DESCRIBE_T001W)
    if (op === "transports") return ok(req.transport === "NOPE" ? [] : [W_REQ])
    if (op === "write") return { STATUS: "ok", VERSION: ENGINE_VERSION, DRY_RUN: req.commit ? "" : "X", ROWS_PLANNED: 1, ROWS_WRITTEN: req.commit ? 1 : 0, TRANSPORT: String(req.transport ?? ""), MESSAGES: [] }
    return { STATUS: "error", VERSION: ENGINE_VERSION, MESSAGES: [`Unknown operation: '${op}'`] }
  }
}

beforeEach(() => {
  process.env.ABAP_MCP_MODE = "governed"
  resetServerModeForTests()
  adtConstructed.n = 0
  engine.requests = []
  engine.reply = engineFor()
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => { delete process.env.ABAP_MCP_MODE; resetServerModeForTests(); vi.restoreAllMocks() })

describe("transport facts in governed mode", () => {
  it("looks a request up through the engine", async () => {
    expect(await lookupRequest("DEV", "a4hk900101")).toEqual({ trkorr: "A4HK900100", fn: "W", status: "D", owner: "GEERT", text: "Plants" })
    expect(engine.requests[0]).toMatchObject({ operation: "transports", transport: "a4hk900101" })
    expect(await lookupRequest("DEV", "NOPE")).toBeUndefined()
    expect(adtConstructed.n).toBe(0)
  })

  it("lists open requests of one kind, the owner's and those with the owner's task, in one client", async () => {
    expect(await listOpenRequests("DEV", "W", "geert", "250")).toEqual([{ trkorr: "A4HK900100", owner: "GEERT", text: "Plants" }])
    expect(engine.requests[0]).toMatchObject({ operation: "transports", trfunction: "W", statuses: "D", owner: "GEERT", owner_tasks: "X", client: "250" })
  })

  it("everyone's requests: no owner and no task lookup", async () => {
    await listOpenRequests("DEV", "W", undefined, "250")
    expect(engine.requests[0]).toMatchObject({ owner_tasks: "" })
    expect(engine.requests[0].owner).toBeUndefined()
  })

  it("an engine without the action says to update it", async () => {
    engine.reply = () => ({ STATUS: "error", VERSION: "0.9.37", MESSAGES: ["Unknown operation: 'transports'"] })
    await expect(lookupRequest("DEV", "X")).rejects.toThrow(/has no transports action.*Install it with abapGit/)
  })
})

describe("list_all_transports in governed mode", () => {
  it("shows requests with date, text and objects from one engine call", async () => {
    const r = await handleListAllTransports({ connectionId: "DEV" })
    const text = r.content[0].text
    expect(text).toContain("1 modifiable request(s), newest first:")
    expect(text).toContain("A4HK900100  Customizing  modifiable  2026-11-19  Plants")
    expect(text).toContain("      R3TR VDAT V_T001W")
    expect(engine.requests).toEqual([expect.objectContaining({ operation: "transports", statuses: "DL", with_objects: "X" })])
    expect(adtConstructed.n).toBe(0)
  })

  it("passes on the engine's cap note and asks for released statuses", async () => {
    engine.reply = engineFor({ transports: () => ok([W_REQ], ["First 500 requests, newest first; there are more."]) })
    const r = await handleListAllTransports({ status: "released", owner: "geert", withObjects: false, connectionId: "DEV" })
    expect(r.content[0].text).toContain("First 500 requests, newest first; there are more.")
    expect(engine.requests[0]).toMatchObject({ statuses: "RNO", owner: "GEERT", with_objects: "" })
  })
})

describe("get_transport_for_object in governed mode", () => {
  it("maps ADT URLs to TADIR objects", () => {
    expect(adtUrlToObject("/sap/bc/adt/oo/classes/zcl_order_api/source/main")).toEqual({ type: "CLAS", name: "ZCL_ORDER_API" })
    expect(adtUrlToObject("/sap/bc/adt/programs/programs/zreport")).toEqual({ type: "PROG", name: "ZREPORT" })
    expect(adtUrlToObject("/sap/bc/adt/ddic/ddl/sources/%2fdmo%2fi_travel")).toEqual({ type: "DDLS", name: "/DMO/I_TRAVEL" })
    expect(adtUrlToObject("/sap/bc/adt/functions/groups/zfg/fmodules/z_fm")).toEqual({ type: "FUGR", name: "ZFG" })
    expect(adtUrlToObject("/sap/bc/adt/somethingelse/x")).toBeUndefined()
  })

  it("reports package, recording, lock and the requests to the target", async () => {
    engine.reply = engineFor({ transport_info: () => ok({ PGMID: "R3TR", OBJ_TYPE: "CLAS", OBJ_NAME: "ZCL_X", EXISTS: "X",
      DEVCLASS: "ZPKG", CTEXT: "My package", TRANSPORT_LAYER: "ZA4H", TARGET: "QAS", RECORDS: "X",
      LOCK_REQUEST: "A4HK900200", LOCK_TASK: "A4HK900201", LOCK_USER: "GEERT",
      REQUESTS: [{ TRKORR: "A4HK900200", AS4USER: "GEERT", TEXT: "Order API", TRFUNCTION: "K", TRSTATUS: "D" }] }) })
    const r = await handleGetTransportForObject({ url: "/sap/bc/adt/oo/classes/zcl_x", connectionId: "DEV" })
    const text = r.content[0].text
    expect(engine.requests[0]).toEqual({ operation: "transport_info", pgmid: "R3TR", obj_type: "CLAS", obj_name: "ZCL_X" })
    expect(text).toContain("Package:    ZPKG — My package")
    expect(text).toContain("Recording:  yes — changes are recorded on a Workbench request to QAS (transport layer ZA4H)")
    expect(text).toContain("Locked in:  A4HK900200 (GEERT), task A4HK900201")
    expect(text).toContain("  A4HK900200  Order API  (GEERT)")
    expect(adtConstructed.n).toBe(0)
  })

  it("a local package needs no transport", async () => {
    engine.reply = engineFor({ transport_info: () => ok({ PGMID: "R3TR", OBJ_TYPE: "PROG", OBJ_NAME: "ZTMP", EXISTS: "X", DEVCLASS: "$TMP", RECORDS: "" }) })
    const r = await handleGetTransportForObject({ url: "/sap/bc/adt/programs/programs/ztmp", connectionId: "DEV" })
    expect(r.content[0].text).toContain("Recording:  none — local package, no transport needed")
    expect(r.content[0].text).not.toContain("Workbench requests")
  })

  it("an unmappable URL says what it can take, and calls nothing", async () => {
    const r = await handleGetTransportForObject({ url: "/sap/bc/adt/whatever/x", connectionId: "DEV" })
    expect(r.content[0].text).toMatch(/^Reading the transport information stopped: \/sap\/bc\/adt\/whatever\/x is not an ADT URL/)
    expect(engine.requests).toEqual([])
  })
})

describe("customizing_apply in governed mode", () => {
  const copy = { table: "T001W", keyField: "WERKS", sourceKey: "1000", targetKey: "2000", autoDeploy: false, connectionId: "DEV" }

  it("a dry run resolves the maintenance object through ddic_describe and writes nothing", async () => {
    const r = await handleCustomizingApply(copy)
    expect(r.content[0].text).toContain("maint object V_T001W → R3TR VDAT")
    const write = engine.requests.find(q => q.operation === "write")
    expect(write).toMatchObject({ view_name: "V_T001W", transport_object: "VDAT", commit: "" })
    expect(adtConstructed.n).toBe(0)
  })

  it("a commit without a transport, with two open requests, asks which one, listing them from the engine", async () => {
    engine.reply = engineFor({ transports: req => ok(req.transport ? [W_REQ] : [{ ...W_REQ, TRKORR: "A4HK900300", TEXT: "Sales" }, W_REQ]) })
    const r = await handleCustomizingApply({ ...copy, commit: true }, { sessionId: "s-offer" })
    expect(r.content[0].text).toContain("2 open Customizing requests")
    expect(r.content[0].text).toContain("A4HK900300")
    expect(r.content[0].text).toContain("A4HK900100")
    expect(engine.requests.some(q => q.operation === "write")).toBe(false)
    expect(engine.requests.find(q => q.operation === "transports")).toMatchObject({ trfunction: "W", statuses: "D", client: expect.any(String) })
  })

  it("a commit without a transport uses the only open Customizing request", async () => {
    const r = await handleCustomizingApply({ ...copy, commit: true }, { sessionId: "s-only" })
    expect(r.content[0].text).toContain("the only open Customizing request")
    expect(engine.requests.find(q => q.operation === "write")).toMatchObject({ commit: "X", transport: "A4HK900100" })
  })

  it("a commit on a named request checks it through the engine and records onto it", async () => {
    const r = await handleCustomizingApply({ ...copy, commit: true, transport: "A4HK900100" }, { sessionId: "s-named" })
    const write = engine.requests.find(q => q.operation === "write")
    expect(write).toMatchObject({ commit: "X", transport: "A4HK900100", view_name: "V_T001W" })
    expect(r.content[0].text).not.toMatch(/governed mode, which makes no ADT calls/)
    expect(adtConstructed.n).toBe(0)
  })

  it("a client that allows no changes stops the commit before anything is written", async () => {
    engine.reply = engineFor({ ddic_describe: () => ok({ ...DESCRIBE_T001W, CCCORACTIV: "2" }) })
    const r = await handleCustomizingApply({ ...copy, commit: true, transport: "A4HK900100" }, { sessionId: "s-scc4" })
    expect(r.content[0].text).toMatch(/allows no customizing changes \(SCC4/)
    expect(engine.requests.some(q => q.operation === "write")).toBe(false)
  })

  it("application data (delivery class A) needs no transport", async () => {
    engine.reply = engineFor({ ddic_describe: () => ok({ ...DESCRIBE_T001W, CONTFLAG: "A", MAINT_OBJECT: "", RECORD_OBJECT: "" }) })
    await handleCustomizingApply({ ...copy, commit: true, recordTransport: true }, { sessionId: "s-a" })
    expect(engine.requests.some(q => q.operation === "transports")).toBe(false)
  })

  it("a failed resolve stops the write instead of writing without the maintenance object", async () => {
    engine.reply = engineFor({ ddic_describe: () => ({ STATUS: "error", VERSION: ENGINE_VERSION,
      MESSAGES: ["Describing T001W stopped: you are not authorized to display T001W (S_TABU_DIS for group MCOR, or S_TABU_NAM for the table, activity 03). Ask for the authorization."] }) })
    await expect(handleCustomizingApply({ ...copy, commit: true, transport: "A4HK900100" }, { sessionId: "s-auth" }))
      .rejects.toThrow(/not authorized to display T001W/)
    expect(engine.requests.some(q => q.operation === "write")).toBe(false)
  })
})
