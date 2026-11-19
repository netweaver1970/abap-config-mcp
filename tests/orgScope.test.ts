import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  log: vi.fn(),
}))

// A fake of the tables the scope probe reads: the DD03L⋈DD02L candidate query,
// the UNION ALL count statements, and DD02T texts.
const { db, keyed, broken, statements, answerSql } = vi.hoisted(() => {
  const db: Record<string, Array<Record<string, string>>> = {}
  const keyed: Array<{ TABNAME: string; FIELDNAME: string; POSITION: string; CONTFLAG: string }> = []
  const broken = new Set<string>()
  const statements: string[] = []
  const res = (rows: Array<Record<string, string>>, cols: string[]) =>
    ({ columns: cols.map(name => ({ name })), values: rows })
  const answerSql = async (_c: unknown, sql: string) => {
    statements.push(sql)
    if (sql.includes("FROM DD03L")) {
      const classes = [.../CONTFLAG IN \(([^)]*)\)/.exec(sql)![1].matchAll(/'(\w)'/g)].map(m => m[1])
      return res(keyed.filter(k => classes.includes(k.CONTFLAG)), ["TABNAME", "FIELDNAME", "POSITION", "CONTFLAG"])
    }
    if (sql.includes("FROM DD02T")) {
      const names = [...sql.matchAll(/'([A-Z0-9_/]+)'/g)].map(m => m[1])
      return res(names.filter(n => n !== "E" && n !== "A").map(n => ({ TABNAME: n, DDTEXT: `${n} text` })), ["TABNAME", "DDTEXT"])
    }
    const out: Array<Record<string, string>> = []
    for (const part of sql.split("\nUNION ALL ")) {
      const m = /^SELECT '([^']+)' AS T, (\w+) AS K, COUNT\(\*\) AS N FROM (\S+) WHERE \w+ IN \(([^)]*)\) GROUP BY \w+$/.exec(part)
      if (!m) throw new Error(`unparsed: ${part}`)
      const [, t, field, tab, inList] = m
      if (broken.has(tab)) throw Object.assign(new Error(`${tab} unknown`), { status: 400 })
      const keys = [...inList.matchAll(/'([^']*)'/g)].map(v => v[1])
      for (const k of keys) {
        const n = (db[tab] ?? []).filter(r => r[field] === k).length
        if (n) out.push({ T: t, K: k, N: String(n) })
      }
    }
    return res(out, ["T", "K", "N"])
  }
  return { db, keyed, broken, statements, answerSql }
})
vi.mock("../src/tools/customizing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/customizing")>()),
  runSql: vi.fn(answerSql),
}))

import { buildOrgScope, buildOrgScopeViaEngine, formatOrgScope, countRows, countSql, retestList, type ScopeTable } from "../src/tools/orgScope"

const client = {} as never
const k = (TABNAME: string, CONTFLAG: string, FIELDNAME = "WERKS") => keyed.push({ TABNAME, FIELDNAME, POSITION: "0002", CONTFLAG })
const rows = (tab: string, field: string, ...keys: string[]) => { db[tab] = keys.map(v => ({ [field]: v })) }
const far = () => Date.now() + 60_000

beforeEach(() => {
  for (const x of Object.keys(db)) delete db[x]
  keyed.length = 0
  broken.clear()
  statements.length = 0
})

describe("countSql", () => {
  it("counts source and target per table in one UNION ALL, escaping quotes", () => {
    const sql = countSql([{ tab: "T001W", field: "WERKS" }, { tab: "/ABC/T1", field: "PLANT" }], "10'0", "1010")
    expect(sql.split("\nUNION ALL ")).toHaveLength(2)
    expect(sql).toContain("FROM /ABC/T1 WHERE PLANT IN ('10''0','1010') GROUP BY PLANT")
  })
  it("keeps every line under 255 characters", () => {
    const sql = countSql([{ tab: "/ABCDEFGH/LONG_TABLE_NAM", field: "A_VERY_LONG_FIELD_NAME_HERE_X" }], "1000", "1010")
    for (const line of sql.split("\n")) expect(line.length).toBeLessThan(255)
  })
})

describe("buildOrgScope", () => {
  beforeEach(() => {
    k("T001L", "C")                    // copied by the copier
    k("MDLW", "C")                     // not copied, source has rows → retest
    k("T320", "G")                     // not copied, both have rows
    k("TEMPTY", "E")                   // not copied, nothing for source
    k("MARC", "A")                     // application data
    k("MARD", "A")
    rows("T001L", "WERKS", "1000", "1000", "1010")
    rows("MDLW", "WERKS", "1000")
    rows("T320", "WERKS", "1000", "1010", "1010")
    rows("MARC", "WERKS", "1000", "1000", "1000")
  })

  it("splits copied / not copied / application and ranks the retest list", async () => {
    const s = await buildOrgScope(client, { domain: "WERKS", sourceKey: "1000", targetKey: "1010",
      copiedSet: [{ tab: "T001L", text: "Storage Locations" }, { tab: "TVKWZ" }], deadline: far() })
    expect(s.copied.map(t => [t.tab, t.src, t.tgt])).toEqual([["T001L", 2, 1], ["TVKWZ", undefined, undefined]])
    expect(s.notCopied.map(t => t.tab).sort()).toEqual(["MDLW", "T320", "TEMPTY"])
    expect(retestList(s).map(t => t.tab)).toEqual(["MDLW"])
    expect(s.application.find(t => t.tab === "MARC")!.src).toBe(3)
    expect(s.notProbed).toEqual([])

    const text = formatOrgScope(s).join("\n")
    expect(text).toMatch(/Copied by the entity copier — 2 table/)
    expect(text).toMatch(/Not copied — check these: 3 customizing table/)
    expect(text).toMatch(/RETEST FIRST — source has rows, target has none: 1\n\s+MDLW\s+WERKS\s+1 → 0\s+MDLW text/)
    expect(text).toMatch(/Both have rows .*: 1\n\s+T320/)
    expect(text).toMatch(/Source has no rows .*: 1/)
    expect(text).toMatch(/class A\) keyed on WERKS: 1 of 2 counted table\(s\) have source rows, e\.g\. MARC \(3\)/)
  })

  it("reads customizing and application candidates separately, so neither cuts the other off", async () => {
    await buildOrgScope(client, { domain: "WERKS", sourceKey: "1000", targetKey: "1010", copiedSet: [], deadline: far() })
    const dd = statements.filter(x => x.includes("FROM DD03L"))
    expect(dd).toHaveLength(2)
    expect(dd.some(x => x.includes("CONTFLAG IN ('C','G','E')"))).toBe(true)
    expect(dd.some(x => x.includes("CONTFLAG IN ('A')"))).toBe(true)
  })

  it("only: application counts the application part and shows only that section", async () => {
    const s = await buildOrgScope(client, { domain: "WERKS", sourceKey: "1000", targetKey: "1010",
      copiedSet: [{ tab: "T001L" }], deadline: far(), only: "application" })
    expect(s.application.find(t => t.tab === "MARC")!.src).toBe(3)
    expect(s.notCopied).toEqual([])
    const text = formatOrgScope(s).join("\n")
    expect(text).not.toMatch(/Not copied — check these/)
    expect(text).not.toMatch(/Time budget/)
    expect(text).toMatch(/Not customizing/)
  })

  it("orders the probe customizing first, so the retest list survives a short budget", async () => {
    for (let i = 0; i < 100; i++) k(`ZAPP${i}`, "A")
    const s = await buildOrgScope(client, { domain: "WERKS", sourceKey: "1000", targetKey: "1010",
      copiedSet: [], deadline: Date.now() - 1 })
    expect(s.notCopied).toEqual([])                   // nothing counted: deadline already passed
    expect(s.notProbed.length).toBe(106)              // T001L, MDLW, T320, TEMPTY (none copied here) + 102 A
    expect(formatOrgScope(s).join("\n")).toMatch(/Time budget reached, not counted: 4 customizing, 102 application table\(s\)\. Re-run with retestScope: "customizing"/)
    const first = statements.find(x => x.includes("UNION") || x.includes("COUNT"))
    expect(first).toBeUndefined()
  })

  it("batches the counts: a hundred tables take a handful of statements", async () => {
    for (let i = 0; i < 100; i++) k(`ZC${String(i).padStart(3, "0")}`, "C")
    await buildOrgScope(client, { domain: "WERKS", sourceKey: "1000", targetKey: "1010", copiedSet: [], deadline: far() })
    const counts = statements.filter(x => x.includes("COUNT(*)"))
    expect(counts.length).toBeLessThanOrEqual(4)      // 106 tables / 40 per statement
  })
})

describe("countRows", () => {
  it("isolates a table that breaks its statement and still counts the rest", async () => {
    const ts: ScopeTable[] = ["A1", "A2", "BAD", "A4", "A5"].map(tab => ({ tab, field: "WERKS" }))
    rows("A2", "WERKS", "1000")
    broken.add("BAD")
    await countRows(client, ts, "1000", "1010", far(), 5, 1)
    expect(ts.find(t => t.tab === "BAD")!.unreadable).toBe(true)
    expect(ts.filter(t => t.tab !== "BAD").every(t => t.src !== undefined)).toBe(true)
    expect(ts.find(t => t.tab === "A2")!.src).toBe(1)
  })

  it("counts nothing after the deadline", async () => {
    const ts: ScopeTable[] = [{ tab: "A1", field: "WERKS" }]
    await countRows(client, ts, "1000", "1010", Date.now() - 1)
    expect(ts[0].src).toBeUndefined()
    expect(statements).toEqual([])
  })
})

describe("buildOrgScopeViaEngine (governed mode)", () => {
  const T = (tab: string, cls: string, counted: boolean, src = 0, tgt = 0, extra: Record<string, unknown> = {}) =>
    ({ TAB: tab, FIELD: "WERKS", CLS: cls, COUNTED: counted ? "X" : "", SRC: src, TGT: tgt, ...extra })
  const engineAnswer = (tables: unknown[], truncated = false) => async () =>
    ({ STATUS: "ok", VERSION: "x", DATA_JSON: JSON.stringify({ DOMAIN: "WERKS", CANDIDATES: tables.length, TRUNCATED: truncated ? "X" : "", TABLES: tables }) })
  const args = (over: Partial<Parameters<typeof buildOrgScopeViaEngine>[1]> = {}) => ({
    domain: "WERKS", sourceKey: "1000", targetKey: "2000", deadline: Date.now() + 20_000,
    copiedSet: [{ tab: "T001W", text: "Plants" }, { tab: "T001K" }], ...over })

  it("sends the copier's tables, the part to count and a budget below the deadline", async () => {
    const calls: Array<{ req: Record<string, unknown>; timeout: number }> = []
    await buildOrgScopeViaEngine(async (req, timeout) => { calls.push({ req: req as never, timeout }); return { STATUS: "ok", DATA_JSON: "{}" } },
      args({ only: "customizing" }))
    const { req, timeout } = calls[0]
    expect(req).toMatchObject({ operation: "retest_scope", org_unit: "WERKS", source_key: "1000", target_key: "2000", only: "customizing" })
    expect(JSON.parse(String(req.tables_json))).toEqual(["T001W", "T001K"])
    expect(Number(req.budget_ms)).toBeGreaterThan(10_000)
    expect(Number(req.budget_ms)).toBeLessThan(20_000)
    expect(timeout).toBeGreaterThan(Number(req.budget_ms))
  })

  it("sorts the engine's counts into copied, not copied, application and not reached", async () => {
    const scope = await buildOrgScopeViaEngine(engineAnswer([
      T("T001W", "C", true, 1, 1),                 // copier's own
      T("T024E", "C", true, 3, 0, { TEXT: "Purchasing orgs" }),   // retest
      T("TVKWZ", "C", true, 2, 2),                 // both
      T("ZNOAUTH", "C", true, 0, 0, { UNREADABLE: "X", NOAUTH: "X" }),
      T("MARC", "A", true, 50, 0),                 // application
      T("MBEW", "A", false),                       // not reached
    ]), args())
    expect(scope.copied.map(t => [t.tab, t.src, t.tgt, t.text])).toEqual([["T001W", 1, 1, "Plants"], ["T001K", undefined, undefined, undefined]])
    expect(retestList(scope).map(t => [t.tab, t.src, t.text])).toEqual([["T024E", 3, "Purchasing orgs"]])
    expect(scope.notCopied.map(t => t.tab)).toEqual(["T024E", "TVKWZ", "ZNOAUTH"])
    expect(scope.application.map(t => t.tab)).toEqual(["MARC"])
    expect(scope.notProbed.map(t => t.tab)).toEqual(["MBEW"])
    const text = formatOrgScope(scope).join("\n")
    expect(text).toContain("RETEST FIRST — source has rows, target has none: 1")
    expect(text).toContain("Could not be read: 1 — ZNOAUTH (1 of them: you are not authorized to display them")
    expect(text).toContain("Time budget reached, not counted: 1 application table(s)")
  })

  it("an engine without the action says to update it", async () => {
    await expect(buildOrgScopeViaEngine(async () => ({ STATUS: "error", VERSION: "0.9.38", MESSAGES: ["Unknown operation: 'retest_scope'"] }), args()))
      .rejects.toThrow(/has no retest_scope action.*Install it with abapGit/)
  })
})

describe("buildOrgScopeViaEngine — one table at a time", () => {
  it("says the optional class is missing when the engine counted serially and ran out of time", async () => {
    const tables = [
      ...Array.from({ length: 9 }, (_, i) => ({ TAB: `ZC${i}`, FIELD: "WERKS", CLS: "C", COUNTED: "X", SRC: 0, TGT: 0 })),
      { TAB: "MARC", FIELD: "WERKS", CLS: "A", COUNTED: "" },
    ]
    const call = async () => ({ STATUS: "ok", DATA_JSON: JSON.stringify({ COUNTED: 9, BATCHED: "", TABLES: tables }) })
    const scope = await buildOrgScopeViaEngine(call, { domain: "WERKS", sourceKey: "1", targetKey: "2", deadline: Date.now() + 20_000, copiedSet: [] })
    expect(scope.serial).toBe(true)
    expect(formatOrgScope(scope).join("\n")).toContain("the optional class ZCL_MCP_SCOPE_BATCH, which counts eight at a time on SAP_BASIS 7.50 and later, is not installed")
  })

  it("says nothing when it counted in batches", async () => {
    const call = async () => ({ STATUS: "ok", DATA_JSON: JSON.stringify({ COUNTED: 9, BATCHED: "X", TABLES: [{ TAB: "MARC", FIELD: "WERKS", CLS: "A", COUNTED: "" }] }) })
    const scope = await buildOrgScopeViaEngine(call, { domain: "WERKS", sourceKey: "1", targetKey: "2", deadline: Date.now() + 20_000, copiedSet: [] })
    expect(formatOrgScope(scope).join("\n")).not.toContain("ZCL_MCP_SCOPE_BATCH")
  })
})
