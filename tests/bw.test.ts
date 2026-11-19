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
import { handleBwCapabilities, handleBwList, handleBwRead, handleBwWhereUsed, handleBwCreate, handleBwChange, handleBwDelete } from "../src/tools/bw"

const ok = (data: unknown, messages: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ STATUS: "ok", VERSION: "x", MESSAGES: messages, DATA_JSON: JSON.stringify(data), ...extra })

const CAPS = { LINE: "BW75", SAP_BW: "757", TRANSPORT: "X", WHERE_USED: "X", BW_CLIENT: "600", IN_BW_CLIENT: "X", TYPES: [
  { TLOGO: "IOBJ", TLOGOTAB: "RSDIOBJ", OPS: [{ OP: "list", STATUS: "available" }, { OP: "create", STATUS: "available", API: "BAPI_IOBJ_CREATE" }] },
  { TLOGO: "ADSO", TLOGOTAB: "RSOADSO", OPS: [{ OP: "list", STATUS: "available" }, { OP: "create", STATUS: "not_built" }] },
] }

beforeEach(() => {
  // BW tools are the same in both modes; run them governed to prove no ADT is touched.
  process.env.ABAP_MCP_MODE = "governed"
  resetServerModeForTests()
  adtConstructed.n = 0
  engine.requests = []
  engine.reply = req => {
    switch (req.operation) {
      case "bw_capabilities": return ok(CAPS)
      case "bw_list": return ok([{ NAME: "ZCUST", TEXT: "Customer" }, { NAME: "ZCUST2" }])
      case "bw_read": return ok({ TLOGO: "IOBJ", NAME: String(req.name), OBJVERS: "A", VERSIONS: ["A"], PACKAGE: String(req.name).startsWith("ZT") ? "ZBW" : "$TMP", TABLE: "RSDIOBJ",
        ROWS: [{ IOBJNM: req.name }], DETAIL: { DETAILS: { INFOOBJECT: req.name, TYPE: "CHA", TEXTLONG: "Customer", INTLEN: "000010" }, COMPOUNDS: [], ATTRIBUTES: [{ ATTRINM: "ZREGION" }] } })
      case "bw_where_used": return ok({ USED_BY: [{ TLOGO: "ADSO", OBJNM: "ZSALES", TLOGO_DEP: "IOBJ", OBJNM_DEP: "ZCUST", ASC_TYPE: "001" }], USES: [] })
      case "transports": return ok([{ TRKORR: "CARK900010", TRFUNCTION: "K", TRSTATUS: "D", AS4USER: "GEERT", TEXT: "BW model" },
                                    { TRKORR: "CARK900012", TRFUNCTION: "K", TRSTATUS: "D", AS4USER: "GEERT", TEXT: "Other" }])
      default: return ok({}, [`${req.operation} done`], { DRY_RUN: req.commit ? "" : "X" })
    }
  }
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => { delete process.env.ABAP_MCP_MODE; resetServerModeForTests(); vi.restoreAllMocks() })

describe("BW reading", () => {
  it("bw_capabilities names the line, the BW client and the types that can be written", async () => {
    const t = (await handleBwCapabilities({ connectionId: "DEV" })).content[0].text
    expect(t).toContain("BW on this system: BW 7.5 line (SAP_BW 757)")
    expect(t).toContain("BW client: 600 (this connection's client: writes possible)")
    expect(t).toContain("IOBJ  (RSDIOBJ)")
    expect(t).not.toContain("ADSO  (RSOADSO)")          // no write operation yet: only in the summary line
    expect(t).toContain("All types: IOBJ ADSO")
    expect(adtConstructed.n).toBe(0)
  })

  it("bw_capabilities says when BW is not set up", async () => {
    engine.reply = () => ok({ ...CAPS, BW_CLIENT: "", IN_BW_CLIENT: "" })
    const t = (await handleBwCapabilities({ connectionId: "DEV" })).content[0].text
    expect(t).toContain("BW client: none — BW is not set up on this system")
  })

  it("bw_list sends the type, pattern, version and cap, and shows the texts", async () => {
    const t = (await handleBwList({ type: "iobj", pattern: "Z*", connectionId: "DEV" })).content[0].text
    expect(engine.requests[0]).toMatchObject({ operation: "bw_list", tlogo: "iobj", pattern: "Z*", objvers: "A", max_rows: 200 })
    expect(t).toContain("IOBJ objects matching \"Z*\" (version A): 2")
    expect(t).toMatch(/ZCUST\s+Customer/)
  })

  it("bw_read shows the InfoObject definition from BW's read API", async () => {
    const t = (await handleBwRead({ type: "IOBJ", name: "ZCUST", connectionId: "DEV" })).content[0].text
    expect(t).toContain("IOBJ ZCUST  (version A; versions on the system: A)")
    expect(t).toMatch(/TEXTLONG\s+Customer/)
    expect(t).toContain("Attributes (1):")
  })

  it("bw_where_used lists users and used objects", async () => {
    const t = (await handleBwWhereUsed({ type: "IOBJ", name: "ZCUST", connectionId: "DEV" })).content[0].text
    expect(t).toContain("IOBJ ZCUST is used by 1 object(s):\n  ADSO ZSALES")
  })

  it("an engine without the BW part says so", async () => {
    engine.reply = () => ({ STATUS: "error", VERSION: "0.9.42", MESSAGES: ["Unknown operation: 'bw_list'"] })
    const t = (await handleBwList({ type: "IOBJ", connectionId: "DEV" })).content[0].text
    expect(t).toMatch(/has no BW part yet/)
  })
})

describe("BW writing", () => {
  const def = { details: { TYPE: "CHA", DATATP: "CHAR", INTLEN: 10, textlong: "Customer" } }

  it("a local package needs no transport and sends the definition with upper-case fields", async () => {
    const t = (await handleBwCreate({ type: "IOBJ", name: "ZCUST", definition: def, connectionId: "DEV" })).content[0].text
    expect(t).toContain("📋 DRY RUN — nothing written")
    const req = engine.requests.find(r => r.operation === "bw_create")!
    expect(req).toMatchObject({ package: "$TMP", commit: "", activate: "X" })
    expect(JSON.parse(String(req.details_json))).toEqual({ TYPE: "CHA", DATATP: "CHAR", INTLEN: 10, TEXTLONG: "Customer" })
    expect(engine.requests.some(r => r.operation === "transports")).toBe(false)
  })

  it("a transportable package with several open Workbench requests asks which one, and writes nothing", async () => {
    const t = (await handleBwCreate({ type: "IOBJ", name: "ZCUST", definition: def, package: "ZBW", commit: true, connectionId: "DEV" }, { sessionId: "bw1" })).content[0].text
    expect(t).toContain("2 open Workbench requests")
    expect(engine.requests.find(r => r.operation === "transports")).toMatchObject({ trfunction: "K", statuses: "D" })
    expect(engine.requests.some(r => r.operation === "bw_create")).toBe(false)
  })

  it("a named request is checked and passed on", async () => {
    engine.reply = req => req.operation === "transports" ? ok([{ TRKORR: "CARK900010", TRFUNCTION: "K", TRSTATUS: "D", AS4USER: "GEERT", TEXT: "BW model" }])
      : ok({}, ["created"], { DRY_RUN: "" })
    await handleBwCreate({ type: "IOBJ", name: "ZCUST", definition: def, package: "ZBW", transport: "CARK900010", commit: true, connectionId: "DEV" }, { sessionId: "bw2" })
    expect(engine.requests.find(r => r.operation === "bw_create")).toMatchObject({ transport: "CARK900010", package: "ZBW", commit: "X" })
  })

  it("bw_change takes the package from the object and sends the field changes", async () => {
    await handleBwChange({ type: "IOBJ", name: "ZCUST", values: { textlong: "New", intlen: 12 }, connectionId: "DEV" })
    const req = engine.requests.find(r => r.operation === "bw_change")!
    expect(JSON.parse(String(req.values_json))).toEqual([{ FIELD: "TEXTLONG", VALUE: "New" }, { FIELD: "INTLEN", VALUE: "12" }])
    expect(engine.requests[0]).toMatchObject({ operation: "bw_read", name: "ZCUST" })
  })

  it("bw_change on an object in a transportable package offers the requests when none is named", async () => {
    const t = (await handleBwChange({ type: "IOBJ", name: "ZTCUST", values: { TEXTLONG: "x" }, commit: true, connectionId: "DEV" }, { sessionId: "bw3" })).content[0].text
    expect(t).toContain("2 open Workbench requests")
    expect(engine.requests.some(r => r.operation === "bw_change")).toBe(false)
  })

  it("bw_delete is a dry run unless commit is true", async () => {
    await handleBwDelete({ type: "IOBJ", name: "ZCUST", connectionId: "DEV" })
    expect(engine.requests[0]).toMatchObject({ operation: "bw_delete", commit: "" })
    expect(adtConstructed.n).toBe(0)
  })
})
