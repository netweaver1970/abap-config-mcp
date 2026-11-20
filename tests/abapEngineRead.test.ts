import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "events"

// No SAP: https answers as the engine.
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

import { refFromUrl, urlOf, GOVERNED_ABAP_HANDLERS as H } from "../src/tools/abapEngineRead"
import { getAbapEngineSource } from "../src/abap/zcl_mcp_abap_engine"
import { getEngineSource } from "../src/abap/zcl_mcp_cust_engine"

const ok = (data: unknown, messages: string[] = []) => ({ STATUS: "ok", VERSION: "x", MESSAGES: messages, DATA_JSON: JSON.stringify(data) })
const out = (r: { content: { text: string }[] }) => r.content[0].text

beforeEach(() => { engine.requests = []; engine.reply = () => ok([]) })

describe("ADT URLs in governed mode", () => {
  it("turns ADT URLs into type and name, and back", () => {
    expect(refFromUrl("/sap/bc/adt/oo/classes/zcl_order/source/main")).toEqual({ type: "CLAS", name: "ZCL_ORDER", part: "main" })
    expect(refFromUrl("/sap/bc/adt/oo/classes/zcl_order/includes/testclasses")).toEqual({ type: "CLAS", name: "ZCL_ORDER", part: "testclasses" })
    expect(refFromUrl("/sap/bc/adt/functions/groups/sdtx/fmodules/rfc_read_table")).toEqual({ type: "FUNC", name: "RFC_READ_TABLE", group: "SDTX" })
    expect(refFromUrl("/sap/bc/adt/programs/programs/%2fns%2frep")).toEqual({ type: "PROG", name: "/NS/REP" })
    expect(refFromUrl("/sap/bc/adt/ddic/tables/t001w")).toEqual({ type: "TABL", name: "T001W" })
    expect(refFromUrl("/sap/bc/adt/somethingelse/x")).toBeUndefined()
    for (const [t, n] of [["CLAS", "ZCL_A"], ["PROG", "/NS/REP"], ["INTF", "ZIF_A"], ["FUGR", "ZFG"], ["TABL", "T001W"]]) {
      expect(refFromUrl(urlOf(t, n))).toMatchObject({ type: t, name: n })
    }
  })
})

describe("the governed ABAP read handlers call the engine", () => {
  it("source: abap_source with type, name and class part; returns the lines", async () => {
    engine.reply = () => ok({ TYPE: "CLAS", NAME: "ZCL_A", PART: "main", PROGRAM: "ZCL_A=====CP", LINES: ["class zcl_a definition.", "endclass."] })
    const r = await H.get_abap_object_lines({ url: "/sap/bc/adt/oo/classes/zcl_a/source/main" })
    expect(engine.requests[0]).toMatchObject({ operation: "abap_source", object_type: "CLAS", name: "ZCL_A", include: "main" })
    expect(out(r)).toBe("class zcl_a definition.\nendclass.")
  })

  it("grep numbers the matching lines", async () => {
    engine.reply = () => ok({ TYPE: "PROG", NAME: "ZR", PART: "main", PROGRAM: "ZR", LINES: ["REPORT zr.", "SELECT * FROM mara.", "WRITE 1."] })
    const r = await H.search_abap_object_lines({ url: "/sap/bc/adt/programs/programs/zr", pattern: "select .* from" })
    expect(out(r)).toContain("    2: SELECT * FROM mara.")
    expect(out(r)).not.toContain("WRITE")
  })

  it("search passes the pattern and the bare type, and gives ADT URLs", async () => {
    engine.reply = () => ok([{ TYPE: "CLAS", NAME: "ZCL_A", PACKAGE: "ZPKG", AUTHOR: "U", DESCRIPTION: "A class" }])
    const r = await H.search_abap_objects({ query: "ZCL*", objectType: "CLAS/OC" })
    expect(engine.requests[0]).toMatchObject({ operation: "abap_search", pattern: "ZCL*", object_type: "CLAS" })
    expect(out(r)).toContain("/sap/bc/adt/oo/classes/zcl_a")
  })

  it("where-used lists the using objects with method and URL", async () => {
    engine.reply = () => ok([{ INCLUDE: "ZCL_B=====CM001", MAIN_TYPE: "CLAS", MAIN_NAME: "ZCL_B", METHOD: "RUN", KIND: "type reference" }])
    const r = await H.where_used({ url: "/sap/bc/adt/oo/classes/zcl_a" })
    expect(out(r)).toContain("CLAS  ZCL_B → RUN")
    expect(out(r)).toContain("/sap/bc/adt/oo/classes/zcl_b")
  })

  it("syntax check sends the source and reports the error line", async () => {
    engine.reply = () => ok({ PROGRAM: "ZR", CHECKED: "the source you supplied", OK: false, MESSAGE: "Field \"X\" is unknown.", INCLUDE: "ZR", LINE: 2, WORD: "X" })
    const r = await H.syntax_check({ url: "/sap/bc/adt/programs/programs/zr/source/main", source: "REPORT zr.\nWRITE x." })
    expect(engine.requests[0]).toMatchObject({ operation: "abap_syntax", object_type: "PROG", name: "ZR", source: "REPORT zr.\nWRITE x." })
    expect(out(r)).toContain("❌ ZR:2: Field \"X\" is unknown.")
  })

  it("an engine without the ABAP part says how to install it", async () => {
    engine.reply = () => ({ STATUS: "error", VERSION: "0.10.3", MESSAGES: ["Unknown operation: 'abap_source'"] })
    const r = await H.get_abap_object_lines({ url: "/sap/bc/adt/programs/programs/zr" })
    expect(out(r)).toMatch(/v0\.10\.3\) has no read-only ABAP part yet/)
  })

  it("a URL of something it cannot read is refused without an engine call", async () => {
    const r = await H.get_abap_object_info({ url: "/sap/bc/adt/bopf/businessobjects/x" })
    expect(r.isError).toBe(true)
    expect(engine.requests).toHaveLength(0)
  })
})

describe("the ABAP class", () => {
  it("dispatches every operation the handlers and the gateway use", () => {
    const src = getAbapEngineSource()
    for (const op of ["abap_search", "abap_info", "abap_source", "abap_where_used", "abap_versions", "abap_package",
      "abap_text_elements", "abap_inactive", "abap_tables", "abap_syntax", "abap_dumps"]) expect(src).toContain(`WHEN '${op}'.`)
  })

  it("is read-only: no database or repository write statement", () => {
    const code = getAbapEngineSource().split("\n").filter(l => !/^\s*["*]/.test(l)).join("\n")
    expect(code).not.toMatch(/\b(INSERT REPORT|INSERT TEXTPOOL|UPDATE\s+\w+\s+SET|INSERT\s+\w+\s+FROM|MODIFY\s+\w+\s+FROM\s+(TABLE\s+)?@|DELETE\s+FROM\s+\w+|COMMIT WORK)\b/i)
    expect(code).toMatch(/AUTHORITY-CHECK OBJECT 'S_DEVELOP'/)
  })

  it("the main engine hands abap_* (not abap_memory) to it", () => {
    const src = getEngineSource()
    expect(src).toContain("CALL METHOD ('ZCL_MCP_ABAP_ENGINE')=>('HANDLE')")
    expect(src).toMatch(/<> 'abap_memory'/)
  })
})
