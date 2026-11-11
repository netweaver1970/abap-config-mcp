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
      const dom = /DOMNAME = '(\w+)'/.exec(sql)![1]
      return res(keyed.filter(k => (k as any).DOMNAME === dom || !(k as any).DOMNAME), ["TABNAME", "FIELDNAME", "POSITION", "CONTFLAG"])
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

import { buildOrgScope, formatOrgScope, countRows, countSql, retestList, type ScopeTable } from "../src/tools/orgScope"

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
    expect(text).toMatch(/class A\) keyed on WERKS: 1 of 2 table\(s\) have source rows, e\.g\. MARC \(3\)/)
  })

  it("orders the probe customizing first, so the retest list survives a short budget", async () => {
    for (let i = 0; i < 100; i++) k(`ZAPP${i}`, "A")
    const s = await buildOrgScope(client, { domain: "WERKS", sourceKey: "1000", targetKey: "1010",
      copiedSet: [], deadline: Date.now() - 1 })
    expect(s.notCopied).toEqual([])                   // nothing counted: deadline already passed
    expect(s.notProbed.length).toBe(106)              // T001L, MDLW, T320, TEMPTY (none copied here) + 102 A
    expect(formatOrgScope(s).join("\n")).toMatch(/Time budget reached: 106 table\(s\) not counted \(4 customizing, 102 application\)/)
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
