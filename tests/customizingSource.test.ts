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
import { customizingSource, toResolvedMaint, toTableMeta, toRowsResult, type DdicDescription } from "../src/tools/customizingSource"
import { handleCustomizingDescribe, handleCustomizingRead, handleCustomizingDiff, handleCustomizingPlanChange } from "../src/tools/customizing"
import { ENGINE_VERSION } from "../src/abap/zcl_mcp_cust_engine"

const V_T001W: DdicDescription = {
  INPUT: "V_T001W", IS_VIEW: "X", VIEW: "V_T001W", ROOT_TABLE: "T001W", TEXT_TABLE: "T002",
  TABLES: ["T001W", "T005", "T002"], FUNC_GROUP: "0ORG", MAINT_TYPE: "2", MAINT_TCODE: "SM30",
  IMG_ACTIVITY: "SIMG_X", IMG_ACTIVITY_TEXT: "Define plants", AUTH_GROUP: "MCOR", OBJECT_TYPE: "V",
  CLUSTER: "", DEVCLASS: "WO", SWITCH_ID: "", MAINT_OBJECT: "V_T001W", RECORD_OBJECT: "VDAT",
  TRANSPORT_OBJECT: "VDAT", TRANSPORT_NAME: "V_T001W", TABCLASS: "TRANSP", CONTFLAG: "C", CLIDEP: "X",
  MAINFLAG: "X", DDTEXT: "Plants/Branches",
  FIELDS: [
    { FIELDNAME: "MANDT", KEYFLAG: "X", DATATYPE: "CLNT", LENG: "000003", CHECKTABLE: "T000", CHECKFIELD: "MANDT", DDTEXT: "Client" },
    { FIELDNAME: "WERKS", KEYFLAG: "X", DATATYPE: "CHAR", LENG: "000004", DDTEXT: "Plant" },
    { FIELDNAME: "LAND1", KEYFLAG: "", DATATYPE: "CHAR", LENG: "000003", CHECKTABLE: "T005", CHECKFIELD: "LAND1", DDTEXT: "Country" },
  ],
  CLIENT: "100", CCCATEGORY: "C", CCCORACTIV: "1", CCNOCLIIND: "",
}

const ok = (data: unknown, messages: string[] = []) =>
  ({ STATUS: "ok", VERSION: ENGINE_VERSION, MESSAGES: messages, DATA_JSON: JSON.stringify(data) })

function rowsFor(werks: string) {
  return werks === "1000"
    ? [{ MANDT: "100", WERKS: "1000", NAME1: "Main" }, { MANDT: "100", WERKS: "1000", NAME1: "Second" }]
    : [{ MANDT: "100", WERKS: werks, NAME1: "Main" }]
}

beforeEach(() => {
  process.env.ABAP_MCP_MODE = "governed"
  resetServerModeForTests()
  adtConstructed.n = 0
  engine.requests = []
  engine.reply = req => {
    if (req.operation === "ddic_describe") return ok(V_T001W)
    if (req.operation === "read") {
      return ok({ COLUMNS: ["MANDT", "WERKS", "NAME1"], ROWS: rowsFor(String(req.source_key ?? "")), MORE: false })
    }
    return { STATUS: "error", VERSION: ENGINE_VERSION, MESSAGES: [`Unknown operation: '${req.operation}'`] }
  }
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => { delete process.env.ABAP_MCP_MODE; resetServerModeForTests(); vi.restoreAllMocks() })

describe("mapping the engine's answers", () => {
  it("ddic_describe becomes the resolver's shape", () => {
    const m = toResolvedMaint(V_T001W)
    expect(m).toMatchObject({
      input: "V_T001W", isView: true, view: "V_T001W", rootTable: "T001W", textTable: "T002",
      tables: ["T001W", "T005", "T002"], funcGroup: "0ORG", maintType: "2", authGroup: "MCOR",
      maintObject: "V_T001W", recordObject: "VDAT", transport: { object: "VDAT", name: "V_T001W" },
    })
    expect(m.cluster).toBeUndefined()      // empty strings read as absent
  })

  it("a plain table without maintenance records nothing and transports as TABU", () => {
    const m = toResolvedMaint({ INPUT: "ZT", ROOT_TABLE: "ZT", IS_VIEW: "", MAINT_OBJECT: "", RECORD_OBJECT: "", TRANSPORT_OBJECT: "TABU", TRANSPORT_NAME: "ZT" })
    expect(m).toMatchObject({ isView: false, tables: ["ZT"], maintObject: "", recordObject: undefined, transport: { object: "TABU", name: "ZT" } })
  })

  it("the root-table part lists foreign keys on key fields only", () => {
    const t = toTableMeta(V_T001W)
    expect(t.dd02).toMatchObject({ TABNAME: "T001W", CONTFLAG: "C", CLIDEP: "X", DDTEXT: "Plants/Branches" })
    expect(t.fields.map(f => f.FIELDNAME)).toEqual(["MANDT", "WERKS", "LAND1"])
    expect(t.foreignKeys).toEqual([{ TABNAME: "T001W", FIELDNAME: "MANDT", CHECKTABLE: "T000", CHECKFIELD: "MANDT" }])
    expect(t.authGroup).toBe("MCOR")
  })

  it("read's rows keep the DDIC column order, even with no rows", () => {
    const r = toRowsResult(JSON.stringify({ COLUMNS: ["A", "B"], ROWS: [], MORE: false }))
    expect(r.result.columns?.map(c => c.name)).toEqual(["A", "B"])
    expect(r.result.values).toEqual([])
    const n = toRowsResult(JSON.stringify({ COLUMNS: ["A", "B"], ROWS: [{ B: 2, A: 1 }], MORE: true }), ["cut"])
    expect(n.result.values).toEqual([{ A: "1", B: "2" }])
    expect(n.more).toBe(true)
    expect(n.notes).toEqual(["cut"])
  })
})

describe("the governed source", () => {
  it("describes once per name and reuses it for the root table's metadata", async () => {
    const src = customizingSource("DEV")
    expect(src.kind).toBe("engine")
    await src.resolve("v_t001w")
    await src.tableMeta("T001W", "E")
    expect(engine.requests).toEqual([{ operation: "ddic_describe", table: "V_T001W", language: "E" }])
  })

  it("sends a read with the filter and the row cap", async () => {
    await customizingSource("DEV").readTable("t001w", { field: "werks", value: "1000" }, 50)
    expect(engine.requests[0]).toEqual({ operation: "read", table: "T001W", max_rows: 50, key_field: "WERKS", source_key: "1000" })
  })

  it("passes the engine's refusal on as the error", async () => {
    engine.reply = () => ({ STATUS: "error", VERSION: ENGINE_VERSION,
      MESSAGES: ["Reading MARA stopped: it has delivery class 'A', and this read covers customizing only (delivery class C, G or E)."] })
    await expect(customizingSource("DEV").readTable("MARA", undefined, 10)).rejects.toThrow(/delivery class 'A'/)
  })

  it("an engine without the action says to update it, by abapGit or transport", async () => {
    engine.reply = () => ({ STATUS: "error", VERSION: "0.9.36", MESSAGES: ["Unknown operation: 'ddic_describe'"] })
    await expect(customizingSource("DEV").resolve("T001W")).rejects.toThrow(
      /Describing T001W stopped: the engine on this system \(v0\.9\.36\) has no ddic_describe action.*Install it with abapGit/)
  })

  it("direct mode keeps the ADT source", async () => {
    delete process.env.ABAP_MCP_MODE
    resetServerModeForTests()
    const src = customizingSource("DEV")
    expect(src.kind).toBe("adt")
    expect(engine.requests).toEqual([])
  })
})

describe("the tools in governed mode", () => {
  it("customizing_describe shows the view, the field texts and the foreign keys", async () => {
    const r = await handleCustomizingDescribe({ objectName: "V_T001W", connectionId: "DEV" })
    const text = r.content[0].text
    expect(text).toContain("Maintenance view:   V_T001W  (SM30)")
    expect(text).toContain("Transport object:   R3TR VDAT V_T001W")
    expect(text).toContain("Auth group (TDDAT): MCOR")
    expect(text).toMatch(/WERKS\s+🔑\s+CHAR\s+000004 Plant/)
    expect(text).toContain("MANDT                → T000.MANDT")
    expect(engine.requests).toHaveLength(1)
    expect(adtConstructed.n).toBe(0)
  })

  it("customizing_read reads the root table through the engine", async () => {
    const r = await handleCustomizingRead({ objectName: "V_T001W", keyField: "WERKS", keyValue: "1000", connectionId: "DEV" })
    expect(r.content[0].text).toContain("Customizing: T001W  WHERE WERKS = '1000'")
    expect(r.content[0].text).toContain("(2 row(s))")
    expect(engine.requests[1]).toMatchObject({ operation: "read", table: "T001W", key_field: "WERKS", source_key: "1000", max_rows: 100 })
  })

  it("customizing_read passes on the engine's row-cap note", async () => {
    engine.reply = req => req.operation === "ddic_describe" ? ok(V_T001W)
      : ok({ COLUMNS: ["WERKS"], ROWS: [{ WERKS: "1000" }], MORE: true }, ["First 1 rows of T001W; there are more."])
    const r = await handleCustomizingRead({ objectName: "T001W", maxRows: 1, connectionId: "DEV" })
    expect(r.content[0].text).toContain("First 1 rows of T001W; there are more.")
  })

  it("customizing_diff compares the two engine reads", async () => {
    const r = await handleCustomizingDiff({ objectName: "T001W", keyField: "WERKS", sourceKey: "1000", targetKey: "2000", connectionId: "DEV" })
    expect(r.content[0].text).toContain("Source rows: 2   Target rows: 1")
    expect(r.content[0].text).toContain("1 row(s) missing from target")
    expect(adtConstructed.n).toBe(0)
  })

  it("customizing_diff says when a side was cut at the row cap", async () => {
    engine.reply = req => req.operation === "ddic_describe" ? ok(V_T001W)
      : ok({ COLUMNS: ["WERKS"], ROWS: [], MORE: req.source_key === "1000" })
    const r = await handleCustomizingDiff({ objectName: "T001W", keyField: "WERKS", sourceKey: "1000", targetKey: "2000", connectionId: "DEV" })
    expect(r.content[0].text).toContain("The source side was cut at 500 rows")
  })

  it("customizing_plan_change takes the delivery class from ddic_describe", async () => {
    const r = await handleCustomizingPlanChange({ objectName: "V_T001W", keyField: "WERKS", sourceKey: "1000", targetKey: "2000", connectionId: "DEV" })
    const text = r.content[0].text
    expect(text).toContain("Delivery class: C ✅ transportable customizing")
    expect(text).toContain("Transport:  R3TR VDAT V_T001W")
    expect(text).toContain("Rows to insert: 1")
    expect(engine.requests.filter(q => q.operation === "ddic_describe")).toHaveLength(1)
    expect(adtConstructed.n).toBe(0)
  })
})

import { handleImgSearch } from "../src/tools/customizing"

describe("img_search in governed mode", () => {
  it("searches through the engine only, with the namespace applied afterwards", async () => {
    engine.reply = req => req.operation === "img_search"
      ? ok([{ ACTIVITY: "/POSDW/IMG_TASK", TEXT: "Define tasks", OBJECTTYPE: "C", OBJECTNAME: "/POSDW/VC_TASK", TCODE: "SM34" },
            { ACTIVITY: "SIMG_TASKS", TEXT: "Tasks elsewhere", OBJECTTYPE: "V", OBJECTNAME: "V_TASK", TCODE: "SM30" }])
      : ok({})
    const r = await handleImgSearch({ keyword: "task", namespace: "/POSDW/", connectionId: "DEV" })
    expect(r.content[0].text).toContain("/POSDW/IMG_TASK")
    expect(r.content[0].text).not.toContain("SIMG_TASKS")
    expect(engine.requests.map(q => q.operation)).toEqual(["img_search"])
    expect(adtConstructed.n).toBe(0)
  })

  it("needs a keyword, and says why", async () => {
    const r = await handleImgSearch({ keyword: "  ", connectionId: "DEV" })
    expect(r.content[0].text).toMatch(/^Searching the IMG stopped: no keyword was given/)
    expect(engine.requests).toEqual([])
  })

  it("an engine that does not answer gives the reason, with no ADT fallback", async () => {
    engine.reply = () => ({ STATUS: "error", VERSION: "0.0.1", MESSAGES: ["Unknown operation: 'img_search'"] })
    const r = await handleImgSearch({ keyword: "plant", connectionId: "DEV" })
    expect(r.content[0].text).toMatch(/the engine's img_search did not answer, and in governed mode there is no fallback through ADT/)
    expect(r.content[0].text).toContain("Install it with abapGit")
    expect(adtConstructed.n).toBe(0)
  })
})
