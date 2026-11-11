import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  ensureConnected: vi.fn(async () => ({})),
  getConnectionConfig: vi.fn(() => ({ id: "S4", username: "GEERT", client: "250" })),
  log: vi.fn(),
}))

// A tiny fake of the SAP tables the planner reads. Understands the statements
// transportMove.ts writes: SELECT … FROM T WHERE a = 'x' AND b IN ('y', …) AND c LIKE 'z%' [OR …].
const { db, answerSql } = vi.hoisted(() => {
  const db: Record<string, Array<Record<string, string>>> = {}
  const likeRe = (p: string) => new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$")
  const cond = (row: Record<string, string>, part: string) => {
    for (const m of part.matchAll(/(\w+) IN \(([^)]*)\)/g)) {
      const vals = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map(v => v[1].replace(/''/g, "'"))
      if (!vals.includes((row[m[1]] ?? "").trimEnd())) return false
    }
    for (const m of part.matchAll(/(\w+) = '((?:[^']|'')*)'/g)) if ((row[m[1]] ?? "").trimEnd() !== m[2].replace(/''/g, "'").trimEnd()) return false
    for (const m of part.matchAll(/(\w+) LIKE '((?:[^']|'')*)'/g)) if (!likeRe(m[2]).test(row[m[1]] ?? "")) return false
    return true
  }
  const answerSql = async (_c: unknown, sql: string) => {
    const m = /FROM (\w+)(?: WHERE (.*))?$/.exec(sql)!
    const rows = (db[m[1]] ?? []).filter(r => !m[2] || m[2].split(" OR ").some(p => cond(r, p)))
    const names = rows.length ? Object.keys(rows[0]) : ["X"]
    return { columns: names.map(name => ({ name })), values: rows }
  }
  return { db, answerSql }
})
vi.mock("../src/tools/customizing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/customizing")>()),
  runSql: vi.fn(answerSql),
}))
vi.mock("../src/tools/customizingEngine", () => ({
  callEngine: vi.fn(async () => ({ STATUS: "ok", MESSAGES: ["A1T → B1T: 3 entries pass SAP's test move."] })),
  ensureEngineClass: vi.fn(async () => ({ changed: false, action: "" })),
}))

import { callEngine } from "../src/tools/customizingEngine"
import {
  family, parseSpec, matchesSpec, partsOf, belongsTo, mainOfInclude, isCustomerName, chunkIn,
  releaseAdvice, handleTransportMove, type Entry,
} from "../src/tools/transportMove"

const e = (trkorr: string, pgmid: string, object: string, objName: string): Entry => ({ trkorr, pgmid, object, objName })
const req = (TRKORR: string, TRFUNCTION: string, STRKORR = "", AS4USER = "GEERT", TRSTATUS = "D", TARSYSTEM = "QAS") =>
  ({ TRKORR, TRFUNCTION, TRSTATUS, STRKORR, AS4USER, TARSYSTEM })
const e071 = (TRKORR: string, PGMID: string, OBJECT: string, OBJ_NAME: string) => ({ TRKORR, PGMID, OBJECT, OBJ_NAME, LOCKFLAG: "X" })

beforeEach(() => {
  vi.mocked(callEngine).mockClear()
  for (const k of Object.keys(db)) delete db[k]
  db.E070 = [
    req("A1", "K"), req("A1T", "S", "A1"),            // source request + my task
    req("B1", "K"), req("B1T", "S", "B1"),            // target request + my task
    req("W1", "W"), req("REL", "K", "", "GEERT", "R"),
    req("OTH", "K", "", "COLLEAGUE"), req("OTHT", "S", "OTH", "COLLEAGUE"),
    req("C2", "K"),
  ]
  db.E070C = [{ TRKORR: "A1", CLIENT: "250" }, { TRKORR: "B1", CLIENT: "250" }, { TRKORR: "C2", CLIENT: "100" }]
  db.E07T = [{ TRKORR: "A1", AS4TEXT: "source" }, { TRKORR: "B1", AS4TEXT: "target" }]
  db.E071 = [
    e071("A1T", "R3TR", "CLAS", "ZCL_A"),
    e071("A1T", "LIMU", "METH", "ZCL_A                         RUN"),
    e071("A1T", "LIMU", "CPUB", "ZCL_A"),
    e071("A1T", "R3TR", "CLAS", "ZCL_B"),
    e071("A1T", "R3TR", "PROG", "ZREPORT"),
    e071("OTHT", "R3TR", "TABL", "ZTAB"),
  ]
  // ZCL_A uses ZCL_B (stays on the source) and ZTAB (on a colleague's request); ZREPORT (stays) uses ZCL_A.
  db.WBCROSSGT = [
    { OTYPE: "TY", NAME: "ZCL_B", INCLUDE: "ZCL_A=========================CM001" },
    { OTYPE: "TY", NAME: "ZTAB", INCLUDE: "ZCL_A=========================CM001" },
    { OTYPE: "TY", NAME: "CL_ABAP_TYPEDESCR", INCLUDE: "ZCL_A=========================CM001" },
    { OTYPE: "ME", NAME: "ZCL_A\\ME:RUN", INCLUDE: "ZREPORT" },
  ]
})

describe("transport_move — helpers", () => {
  it("groups request and task types into families", () => {
    expect(family("K")).toBe("workbench"); expect(family("S")).toBe("workbench")
    expect(family("W")).toBe("customizing"); expect(family("Q")).toBe("customizing")
    expect(family("T")).toBe("type T")
  })

  it("parses the three spec forms and wildcards", () => {
    const a = e("T", "R3TR", "CLAS", "ZCL_FOO_BAR")
    expect(matchesSpec(a, parseSpec("R3TR CLAS ZCL_FOO_BAR"))).toBe(true)
    expect(matchesSpec(a, parseSpec("clas zcl_foo_bar"))).toBe(true)
    expect(matchesSpec(a, parseSpec("ZCL_FOO*"))).toBe(true)
    expect(matchesSpec(a, parseSpec("PROG ZCL_FOO_BAR"))).toBe(false)
    expect(matchesSpec(a, parseSpec("ZCL_FOO"))).toBe(false)
  })

  it("finds an object's parts and nothing that only shares a prefix", () => {
    const cls = e("T", "R3TR", "CLAS", "ZCL_A")
    const all = [cls, e("T", "LIMU", "METH", "ZCL_A                         RUN"), e("T", "LIMU", "CINC", "ZCL_A=========================CCIMP"),
      e("T", "LIMU", "METH", "ZCL_AB                        RUN")]
    expect(partsOf(cls, all).map(p => p.objName)).toEqual(["ZCL_A                         RUN", "ZCL_A=========================CCIMP"])
    expect(belongsTo("ZCL_AB", "ZCL_A")).toBe(false)
  })

  it("finds a function group's modules and includes", () => {
    const fg = e("T", "R3TR", "FUGR", "ZFG")
    const all = [fg, e("T", "LIMU", "FUNC", "Z_DO_IT"), e("T", "LIMU", "REPS", "LZFGU01"), e("T", "LIMU", "REPS", "SAPLZFG"),
      e("T", "LIMU", "FUNC", "Z_OTHER"), e("T", "LIMU", "REPS", "LZFG2U01")]
    expect(partsOf(fg, all, new Set(["Z_DO_IT"])).map(p => p.objName)).toEqual(["Z_DO_IT", "LZFGU01", "SAPLZFG"])
  })

  it("maps an include to its object", () => {
    expect(mainOfInclude("ZCL_A=========================CM001")).toEqual({ object: "CLAS", name: "ZCL_A" })
    expect(mainOfInclude("ZIF_A=========================IU")).toEqual({ object: "INTF", name: "ZIF_A" })
    expect(mainOfInclude("SAPLZFG")).toEqual({ object: "FUGR", name: "ZFG" })
    expect(mainOfInclude("LZFGU01")).toEqual({ object: "FUGR", name: "ZFG" })
    expect(mainOfInclude("ZREPORT")).toEqual({ object: "PROG", name: "ZREPORT" })
    expect(isCustomerName("CL_ABAP_TYPEDESCR")).toBe(false)
    expect(isCustomerName("/ABC/CL_X")).toBe(true)
  })

  it("keeps IN-lists under ADT's line limit", () => {
    const vals = Array.from({ length: 30 }, (_, i) => `ZCL_A_FAIRLY_LONG_CLASS_NAME_${i}`)
    for (const chunk of chunkIn(vals, 60)) expect(60 + chunk.reduce((n, v) => n + v.length + 4, 0)).toBeLessThanOrEqual(240)
  })

  it("turns dependencies into a release order", () => {
    const hit = (name: string, request: string) => ({ name, request, task: request, owner: "X", staysOnSource: false })
    const advice = releaseAdvice({ outgoing: [{ moved: "ZCL_A", uses: hit("ZTAB", "OTH") }], incoming: [{ moved: "ZCL_A", usedBy: hit("ZREPORT", "A1") }] }, "B1", "A1")
    expect(advice[0]).toContain("Release OTH before or together with B1")
    expect(advice[1]).toContain("Release B1 before or together with A1 (the source)")
  })
})

describe("transport_move — planning", () => {
  it("moves a class with its parts into my task on the target, and reports what it depends on", async () => {
    const text = (await handleTransportMove({ from: "A1", to: "B1", objects: ["ZCL_A"] })).content[0].text
    expect(text).toContain("dry run")
    expect(text).toContain("LIMU METH ZCL_A")
    expect(text).toContain("your task B1T")
    expect(text).toContain("ZCL_A uses ZCL_B, which is on A1 (stays on the source)")
    expect(text).toContain("ZCL_A uses ZTAB, which is on OTH")
    expect(text).toContain("ZREPORT on A1 (stays on the source)")
    expect(text).not.toContain("CL_ABAP_TYPEDESCR")
    expect(text).toContain("Release OTH before or together with B1")
    const body = vi.mocked(callEngine).mock.calls[0][1]
    expect(body).toMatchObject({ operation: "transport_move", action: "OBJECTS", to_trkorr: "B1T", commit: "" })
    expect(JSON.parse(body.objects_json!)).toHaveLength(3)
  })

  it("moves a whole task when from is a task and no objects are named", async () => {
    await handleTransportMove({ from: "A1T", to: "B1T" })
    expect(vi.mocked(callEngine).mock.calls[0][1]).toMatchObject({ action: "TASK", from_trkorr: "A1T", to_trkorr: "B1" })
  })

  it("asks for objects when from is a request", async () => {
    const text = (await handleTransportMove({ from: "A1", to: "B1" })).content[0].text
    expect(text).toContain("no objects were named")
    expect(callEngine).not.toHaveBeenCalled()
  })

  it("stops before SAP on a released request, another kind or another client", async () => {
    for (const [to, why] of [["REL", "released"], ["W1", "customizing"], ["C2", "client 100"]] as const) {
      const text = (await handleTransportMove({ from: "A1", to, objects: ["ZCL_A"] })).content[0].text
      expect(text).toContain("cannot go ahead")
      expect(text).toContain(why)
    }
    expect(callEngine).not.toHaveBeenCalled()
  })

  it("stops on an object that is not on the source", async () => {
    const text = (await handleTransportMove({ from: "A1", to: "B1", objects: ["ZCL_NOPE"] })).content[0].text
    expect(text).toContain('"ZCL_NOPE" is not on A1')
    expect(callEngine).not.toHaveBeenCalled()
  })

  it("warns when a part moves without its object", async () => {
    const text = (await handleTransportMove({ from: "A1", to: "B1", objects: ["LIMU METH ZCL_A*"] })).content[0].text
    expect(text).toContain("the object is split over two requests")
  })

  it("leaves out an entry the target already holds", async () => {
    db.E071.push(e071("B1T", "LIMU", "CPUB", "ZCL_A"))
    const text = (await handleTransportMove({ from: "A1", to: "B1", objects: ["ZCL_A"] })).content[0].text
    expect(text).toContain("LIMU CPUB ZCL_A is already on B1")
    expect(JSON.parse(vi.mocked(callEngine).mock.calls[0][1].objects_json!)).toHaveLength(2)
  })
})
