import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../src/config", () => ({
  loadConfig: () => ({
    connections: [
      { id: "ADT1", url: "http://adt.example:8000", username: "U", password: "p", client: "100" },
      { id: "OLD", url: "http://old.example:8000", username: "U", password: "p", client: "200", language: "EN", protocol: "soap-rfc" },
      { id: "NOCLIENT", url: "http://old2.example:8000", username: "U", password: "p", protocol: "soap-rfc" },
    ],
  }),
}))

import { buildEnvelope, callRfc, parseResponse, resetSoapRfcState, setSoapTransport, SoapRfcError } from "../src/soapRfc/client"
import { parseXml, find, XmlNode } from "../src/soapRfc/xml"
import { maskLiterals, parseSimpleSelect, whereToOptions } from "../src/soapRfc/sql"
import { planChunks, readTable, FieldMeta } from "../src/soapRfc/readTable"
import { chooseReader, functionInclude, groupProgram, readSourceOver, resetSourceReaders, sourceTarget } from "../src/soapRfc/source"
import { SOAP_RFC_HANDLERS, withSoapRfcRouting } from "../src/tools/soapRfcRouting"
import { ensureConnected, newIsolatedClient } from "../src/connections"

// ─── A fake SAP behind /sap/bc/soap/rfc ───────────────────────────────────────

interface FakeTable {
  fields: Array<{ name: string; length: number; type?: string; text?: string }>
  keys: string[]
  rows: Record<string, string>[]
  /** the row order the database happens to use for a read of these fields */
  order?: (fieldNames: string[], rows: Record<string, string>[]) => Record<string, string>[]
}

let tables: Record<string, FakeTable> = {}
let programs: Record<string, string[]> = {}
let calls: Array<{ fm: string; body: XmlNode; path: string }> = []
let httpStatus: number | undefined
let httpBody: string | undefined
/** simulate a transport that strips leading blanks from DATA-WA */
let trimLeading = false

const fault = (fm: string, name: string) =>
  `<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body><soap-env:Fault>` +
  `<faultcode>soap-env:Client</faultcode><faultstring>${name}</faultstring><detail><rfc:${fm}.Exception xmlns:rfc="urn:sap-com:document:sap:rfc:functions">` +
  `<Name>${name}</Name></rfc:${fm}.Exception></detail></soap-env:Fault></soap-env:Body></soap-env:Envelope>`

const answer = (fm: string, inner: string) =>
  `<?xml version="1.0"?><soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>` +
  `<rfc:${fm}.Response xmlns:rfc="urn:sap-com:document:sap:rfc:functions">${inner}</rfc:${fm}.Response></soap-env:Body></soap-env:Envelope>`

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
const items = (rows: Record<string, string>[]) => rows.map(r => `<item>${Object.entries(r).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("")}</item>`).join("")

/** WHERE lines → predicate; understands F = 'v', F IN ('a', 'b'), F LIKE 'p%', joined by AND. */
function predicate(where: string): (r: Record<string, string>) => boolean {
  if (!where.trim()) return () => true
  const conds = where.split(/\s+AND\s+/i).map(c => {
    let m = /^\s*(\w+)\s*=\s*'([^']*)'\s*$/.exec(c)
    if (m) { const [, f, v] = m; return (r: Record<string, string>) => (r[f] ?? "") === v }
    m = /^\s*(\w+)\s+IN\s*\(([^)]*)\)\s*$/i.exec(c)
    if (m) { const f = m[1], vs = m[2].split(",").map(x => x.trim().replace(/^'|'$/g, "")); return (r: Record<string, string>) => vs.includes(r[f] ?? "") }
    m = /^\s*(\w+)\s+LIKE\s+'([^']*)%'\s*$/i.exec(c)
    if (m) {
      const [, f, p] = m
      const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\=/]/g, "\\$&").replace(/_/g, ".")); return (r: Record<string, string>) => re.test(r[f] ?? "")
    }
    throw new Error(`fake SAP cannot evaluate: ${c}`)
  })
  return r => conds.every(c => c(r))
}

function rfcReadTable(req: XmlNode): string {
  const fm = "RFC_READ_TABLE"
  const name = find(req, "QUERY_TABLE")!.text
  const t = tables[name]
  if (!t) return fault(fm, "TABLE_NOT_AVAILABLE")
  const wanted = (find(req, "FIELDS")?.children ?? []).map(i => find(i, "FIELDNAME")!.text)
  const fields = wanted.length ? wanted.map(n => t.fields.find(f => f.name === n)!) : t.fields
  if (fields.some(f => !f)) return fault(fm, "FIELD_NOT_VALID")
  const delim = find(req, "DELIMITER")?.text ?? ""
  let off = 0
  const meta = fields.map(f => { const m = { FIELDNAME: f.name, OFFSET: String(off).padStart(6, "0"), LENGTH: String(f.length).padStart(6, "0"), TYPE: f.type ?? "C", FIELDTEXT: f.text ?? "" }; off += f.length + delim.length; return m })
  if (find(req, "NO_DATA")?.text === "X") return answer(fm, `<DATA/><FIELDS>${items(meta)}</FIELDS><OPTIONS/>`)
  if (off - delim.length > 512) return fault(fm, "DATA_BUFFER_EXCEEDED")
  const where = (find(req, "OPTIONS")?.children ?? []).map(i => find(i, "TEXT")!.text).join(" ")
  const rowcount = parseInt(find(req, "ROWCOUNT")?.text ?? "0", 10)
  let rows = t.rows.filter(predicate(where))
  if (t.order) rows = t.order(fields.map(f => f.name), rows)
  if (rowcount > 0) rows = rows.slice(0, rowcount)
  const data = rows.map(r => {
    const wa = fields.map(f => (r[f.name] ?? "").padEnd(f.length)).join(delim).trimEnd()
    return { WA: trimLeading ? wa.trimStart() : wa }
  })
  return answer(fm, `<DATA>${items(data)}</DATA><FIELDS>${items(meta)}</FIELDS><OPTIONS/>`)
}

function respond(fm: string, req: XmlNode): string {
  if (fm === "RFC_READ_TABLE") return rfcReadTable(req)
  if (fm === "RFC_READ_REPORT") {
    const p = programs[find(req, "PROGRAM")!.text]
    return answer(fm, `<QTAB>${items((p ?? []).map(LINE => ({ LINE })))}</QTAB><SYSTEM>OLD</SYSTEM>`)
  }
  if (fm === "RPY_PROGRAM_READ") {
    const p = programs[find(req, "PROGRAM_NAME")!.text]
    if (!p) return fault(fm, "NOT_FOUND")
    return answer(fm, `<SOURCE_EXTENDED>${items(p.map(LINE => ({ LINE })))}</SOURCE_EXTENDED>`)
  }
  return fault(fm, "FU_NOT_FOUND")
}

beforeEach(() => {
  resetSoapRfcState()
  resetSourceReaders()
  calls = []
  httpStatus = undefined
  httpBody = undefined
  trimLeading = false
  programs = {}
  tables = {
    T000: { fields: [{ name: "MANDT", length: 3 }, { name: "MTEXT", length: 25 }], keys: ["MANDT"], rows: [{ MANDT: "000", MTEXT: "SAP AG" }, { MANDT: "200", MTEXT: "Quality <&> test" }] },
    TFDIR: { fields: [{ name: "FUNCNAME", length: 30 }, { name: "PNAME", length: 40 }, { name: "INCLUDE", length: 2, type: "N" }, { name: "FMODE", length: 1 }], keys: ["FUNCNAME"], rows: [] },
    FUPARAREF: { fields: [{ name: "FUNCNAME", length: 30 }, { name: "R3STATE", length: 1 }, { name: "PARAMETER", length: 30 }], keys: ["FUNCNAME", "R3STATE", "PARAMETER"], rows: [] },
    TRDIR: { fields: [{ name: "NAME", length: 40 }], keys: ["NAME"], rows: [] },
    DD03L: { fields: [{ name: "TABNAME", length: 30 }, { name: "FIELDNAME", length: 30 }, { name: "AS4LOCAL", length: 1 }, { name: "POSITION", length: 4, type: "N" }, { name: "KEYFLAG", length: 1 }], keys: [], rows: [] },
  }
  // DD03L mirrors the key fields of every fake table.
  for (const [tab, t] of Object.entries(tables)) t.keys.forEach((k, i) => tables.DD03L.rows.push({ TABNAME: tab, FIELDNAME: k, AS4LOCAL: "A", POSITION: String(i + 1).padStart(4, "0"), KEYFLAG: "X" }))
  setSoapTransport(async (_cfg, path, body) => {
    const env = parseXml(body)
    const req = find(env, "Body")!.children[0]
    calls.push({ fm: req.name, body: req, path })
    if (httpStatus) return { status: httpStatus, body: httpBody ?? "<html>no</html>" }
    const out = respond(req.name, req)
    return { status: out.includes("Fault>") ? 500 : 200, body: out }
  })
})

// ─── XML and envelopes ────────────────────────────────────────────────────────

describe("SOAP envelope and response", () => {
  it("builds an RFC envelope with escaped scalars and table rows", () => {
    const env = buildEnvelope("RFC_READ_TABLE", { QUERY_TABLE: "T000", OPTIONS: [{ TEXT: "MTEXT = 'A&B'" }], DATA: [] })
    expect(env).toContain(`xmlns:urn="urn:sap-com:document:sap:rfc:functions"`)
    expect(env).toContain("<urn:RFC_READ_TABLE><QUERY_TABLE>T000</QUERY_TABLE>")
    expect(env).toContain("<OPTIONS><item><TEXT>MTEXT = &apos;A&amp;B&apos;</TEXT></item></OPTIONS>")
    expect(env).toContain("<DATA/>")
    const back = parseXml(env)
    expect(find(back, "TEXT")!.text).toBe("MTEXT = 'A&B'")
  })

  it("keeps blanks in values and decodes entities", () => {
    const r = parseResponse("X", answer("X", `<DATA><item><WA>  a &lt;b&gt; &#65;  </WA></item></DATA><E>v</E>`))
    expect(r.table("DATA")).toEqual([{ WA: "  a <b> A  " }])
    expect(r.scalar("E")).toBe("v")
    expect(r.table("NONE")).toEqual([])
  })

  it("turns a SOAP fault into a SoapRfcError with SAP's exception name", () => {
    expect(() => parseResponse("RFC_READ_TABLE", fault("RFC_READ_TABLE", "TABLE_NOT_AVAILABLE"), 500))
      .toThrowError(expect.objectContaining({ code: "TABLE_NOT_AVAILABLE" }))
  })

  it("reads SAP's exception text from <Text> and <Message>", () => {
    const withText = fault("RFC_READ_TABLE", "TABLE_NOT_AVAILABLE").replace("</Name>", "</Name><Text>Table not available</Text><Message><ID>DA</ID><Number>300</Number></Message>")
    expect(() => parseResponse("RFC_READ_TABLE", withText, 500)).toThrow("RFC_READ_TABLE failed: TABLE_NOT_AVAILABLE (Table not available)")
    const withMessage = fault("RFC_READ_TABLE", "X").replace("</Name>", "</Name><Message><ID>DA</ID><Number>300</Number></Message>")
    expect(() => parseResponse("RFC_READ_TABLE", withMessage, 500)).toThrow("(DA 300)")
  })

  it("sends sap-client and sap-language on the SOAP RFC path, and leaves out a client that is not set", async () => {
    await callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000", NO_DATA: "X", FIELDS: [] })
    expect(calls[0].path).toBe("/sap/bc/soap/rfc?sap-client=200&sap-language=EN")
    await callRfc("NOCLIENT", "RFC_READ_TABLE", { QUERY_TABLE: "T000", NO_DATA: "X", FIELDS: [] })
    expect(calls[1].path).toBe("/sap/bc/soap/rfc")
  })
})

describe("logon protection", () => {
  it("stops calling a connection after one 401", async () => {
    httpStatus = 401
    await expect(callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000" })).rejects.toThrow(/HTTP 401/)
    httpStatus = undefined
    await expect(callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000" })).rejects.toThrow(/refused the logon/)
    expect(calls).toHaveLength(1)
  })

  it("queued calls after a 401 never reach SAP", async () => {
    httpStatus = 401
    const all = await Promise.allSettled([1, 2, 3].map(() => callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000" })))
    expect(all.every(r => r.status === "rejected")).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it("treats an answer that is not SOAP (a logon page) like a 401", async () => {
    httpStatus = 200
    httpBody = "<html><body><form>Logon</form></body></html>"
    await expect(callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000" })).rejects.toThrow(/not a SOAP answer.*Logon/)
    httpStatus = undefined
    await expect(callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000" })).rejects.toThrow(/No further calls/)
    expect(calls).toHaveLength(1)
  })

  it("names the function module when the connection drops, and does not latch", async () => {
    setSoapTransport(async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) })
    await expect(callRfc("OLD", "RFC_READ_TABLE", {})).rejects.toThrow("OLD: RFC_READ_TABLE got no answer: socket hang up (ECONNRESET)")
    await expect(callRfc("OLD", "RFC_READ_TABLE", {})).rejects.toThrow(/got no answer/)
  })

  it("does not latch on a 5xx error page (proxy, ICM, dump)", async () => {
    httpStatus = 503
    httpBody = "<html>Service unavailable</html>"
    await expect(callRfc("OLD", "X", {})).rejects.toThrow(/HTTP 503: Service unavailable/)
    httpStatus = undefined
    await expect(callRfc("OLD", "RFC_READ_TABLE", { QUERY_TABLE: "T000", NO_DATA: "X", FIELDS: [] })).resolves.toBeDefined()
    expect(calls).toHaveLength(2)
  })

  it("explains a 403 as an inactive SICF service, without latching", async () => {
    httpStatus = 403
    await expect(callRfc("OLD", "X", {})).rejects.toThrow(/not active in SICF/)
    await expect(callRfc("OLD", "X", {})).rejects.toThrow(/not active in SICF/)
    expect(calls).toHaveLength(2)
  })
})

// ─── WHERE clause and SELECT mapping ──────────────────────────────────────────

describe("whereToOptions", () => {
  it("keeps a short clause on one line", () => {
    expect(whereToOptions("MANDT = '200'")).toEqual(["MANDT = '200'"])
  })

  it("cuts a long clause into 72-character lines at blanks outside literals", () => {
    const where = "MATNR LIKE 'A B C%' AND " + Array.from({ length: 12 }, (_, i) => `F${i} = 'value ${i}'`).join(" AND ")
    const lines = whereToOptions(where)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(72)
    expect(lines.slice(1).every(l => l.startsWith(" "))).toBe(true)
    expect(lines.join("").replace(/\s+/g, " ")).toBe(where)
    expect(lines.some(l => l.includes("'A B C%'"))).toBe(true)   // literal kept whole
  })

  it("refuses a subquery in any WHERE clause", () => {
    expect(() => whereToOptions("MANDT IN ( SELECT MANDT FROM USR02 )")).toThrow(/subquery/)
    expect(whereToOptions("MTEXT = 'SELECT'")).toEqual(["MTEXT = 'SELECT'"])
  })

  it("refuses a literal longer than a line", () => {
    expect(() => whereToOptions(`F = '${"x".repeat(80)}'`)).toThrow(/72-character lines/)
  })

  it("masks literals, including escaped quotes", () => {
    expect(maskLiterals("A = 'it''s JOIN' AND B")).toBe("A = 'xxxxxxxxxx' AND B")
    expect(() => maskLiterals("A = 'open")).toThrow(/unclosed/)
  })
})

describe("parseSimpleSelect", () => {
  it("reads fields, table, WHERE and UP TO", () => {
    expect(parseSimpleSelect("SELECT matnr, mtart FROM mara WHERE mtart = 'FERT' UP TO 5 ROWS"))
      .toEqual({ table: "MARA", fields: ["MATNR", "MTART"], where: "mtart = 'FERT'", maxRows: 5 })
    expect(parseSimpleSelect("select * from t000 up to 3 rows where mandt = '200'."))
      .toEqual({ table: "T000", fields: "*", where: "mandt = '200'", maxRows: 3 })
    expect(parseSimpleSelect("SELECT SINGLE * FROM T000")).toEqual({ table: "T000", fields: "*", where: undefined, maxRows: 1 })
  })

  it("drops a table alias outside literals only", () => {
    expect(parseSimpleSelect("SELECT a~mandt FROM t000 AS a WHERE a~mtext = 'a~b'"))
      .toEqual({ table: "T000", fields: ["MANDT"], where: "mtext = 'a~b'", maxRows: undefined })
  })

  it("does not mistake keywords inside literals", () => {
    expect(parseSimpleSelect("SELECT * FROM T000 WHERE MTEXT = 'ORDER BY JOIN'").where).toBe("MTEXT = 'ORDER BY JOIN'")
  })

  it.each([
    ["SELECT * FROM A INNER JOIN B ON A~X = B~X", /joins/],
    ["SELECT * FROM T000 ORDER BY MANDT", /ORDER BY/],
    ["SELECT COUNT(*) FROM T000", /aggregates/],
    ["SELECT MANDT FROM T000 GROUP BY MANDT", /GROUP BY/],
    ["SELECT * FROM T000 WHERE MANDT IN ( SELECT MANDT FROM T001 )", /subquery/i],
    ["SELECT DISTINCT MANDT FROM T000", /DISTINCT/],
    ["SELECT * FROM T000 WHERE MANDT = @lv", /host variables/],
  ])("refuses %s", (sql, why) => {
    expect(() => parseSimpleSelect(sql)).toThrow(why)
  })
})

// ─── RFC_READ_TABLE reads ─────────────────────────────────────────────────────

const f = (name: string, length: number): FieldMeta => ({ name, length, offset: 0, type: "C", text: "" })

describe("planChunks", () => {
  it("packs fields into ≤512-wide groups that each carry the keys", () => {
    const keys = [f("K1", 10), f("K2", 20)]
    const chunks = planChunks([...keys, f("A", 300), f("B", 200), f("C", 100)], keys)!
    expect(chunks.map(c => c.map(x => x.name))).toEqual([["K1", "K2", "A"], ["K1", "K2", "B", "C"]])
    for (const c of chunks) expect(c.reduce((s, x) => s + x.length, 0)).toBeLessThanOrEqual(512)
  })

  it("counts one delimiter per field boundary", () => {
    const keys = [f("K", 10)]
    // 10 + 250 + 250 = 510, plus 2 delimiters = 512: fits exactly
    expect(planChunks([f("K", 10), f("A", 250), f("B", 250)], keys)).toHaveLength(1)
    expect(planChunks([f("K", 10), f("A", 250), f("B", 251)], keys)).toHaveLength(2)
  })

  it("gives up when a field cannot fit next to the keys", () => {
    expect(planChunks([f("K", 100), f("BIG", 500)], [f("K", 100)])).toBeUndefined()
  })
})

describe("readTable", () => {
  it("reads all fields of a narrow table in one call", async () => {
    const r = await readTable("OLD", "T000", { maxRows: 100 })
    expect(r.columns).toEqual(["MANDT", "MTEXT"])
    expect(r.rows).toEqual([{ MANDT: "000", MTEXT: "SAP AG" }, { MANDT: "200", MTEXT: "Quality <&> test" }])
    expect(calls.map(c => c.fm)).toEqual(["RFC_READ_TABLE", "RFC_READ_TABLE"])   // field list, then data
  })

  it("passes the WHERE clause as OPTIONS and maxRows as ROWCOUNT", async () => {
    const r = await readTable("OLD", "T000", { where: "MANDT = '200'", maxRows: 7 })
    expect(r.rows).toEqual([{ MANDT: "200", MTEXT: "Quality <&> test" }])
    const last = calls[calls.length - 1].body
    expect(find(last, "ROWCOUNT")!.text).toBe("7")
    expect(find(last, "DELIMITER")!.text).toBe("|")
    expect(find(find(last, "OPTIONS"), "TEXT")!.text).toBe("MANDT = '200'")
  })

  it("sends a long WHERE clause as several OPTIONS lines", async () => {
    const where = "MANDT IN ('000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '200')"
    const r = await readTable("OLD", "T000", { where, maxRows: 10 })
    expect(r.rows.map(x => x.MANDT)).toEqual(["000", "200"])
    const lines = find(calls[calls.length - 1].body, "OPTIONS")!.children.map(i => find(i, "TEXT")!.text)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(l => l.length <= 72)).toBe(true)
  })

  it("recovers rows whose leading blanks were trimmed in transit", async () => {
    tables.BLANK = { fields: [{ name: "A", length: 4 }, { name: "B", length: 6 }], keys: ["A"], rows: [{ A: "", B: "val" }, { A: "k", B: "w" }] }
    trimLeading = true
    const r = await readTable("OLD", "BLANK", { maxRows: 10 })
    expect(r.rows).toEqual([{ A: "", B: "val" }, { A: "k", B: "w" }])
  })

  it("splits a row wider than 512 characters and joins the parts on the key", async () => {
    tables.WIDE = {
      fields: [{ name: "MANDT", length: 3 }, { name: "ID", length: 10 }, { name: "A", length: 300 }, { name: "B", length: 300 }, { name: "C", length: 5 }],
      keys: ["MANDT", "ID"],
      rows: [{ MANDT: "200", ID: "1", A: "a1", B: "b1", C: "c1" }, { MANDT: "200", ID: "2", A: "a2", B: "b2", C: "c2" }],
    }
    tables.DD03L.rows.push(
      { TABNAME: "WIDE", FIELDNAME: "MANDT", AS4LOCAL: "A", POSITION: "0001", KEYFLAG: "X" },
      { TABNAME: "WIDE", FIELDNAME: "ID", AS4LOCAL: "A", POSITION: "0002", KEYFLAG: "X" })
    const r = await readTable("OLD", "WIDE", { maxRows: 10 })
    expect(r.rows).toEqual(tables.WIDE.rows)
    expect(r.notes.join(" ")).toMatch(/joined on the key \(MANDT, ID\)/)
    // every data call stayed within one 512-character row
    for (const c of calls.filter(c => find(c.body, "QUERY_TABLE")!.text === "WIDE" && !find(c.body, "NO_DATA"))) {
      const names = (find(c.body, "FIELDS")?.children ?? []).map(i => find(i, "FIELDNAME")!.text)
      expect(names.reduce((s, n) => s + tables.WIDE.fields.find(x => x.name === n)!.length, 0) + names.length - 1).toBeLessThanOrEqual(512)
    }
  })

  it("leaves out rows that not every part returned (row limit, no sort order), and says so", async () => {
    tables.WIDE2 = {
      fields: [{ name: "ID", length: 10 }, { name: "A", length: 300 }, { name: "B", length: 300 }],
      keys: ["ID"],
      rows: ["1", "2", "3"].map(ID => ({ ID, A: `a${ID}`, B: `b${ID}` })),
      // the part that reads B happens to get the rows in another order
      order: (names, rows) => names.includes("B") ? [...rows].reverse() : rows,
    }
    tables.DD03L.rows.push({ TABNAME: "WIDE2", FIELDNAME: "ID", AS4LOCAL: "A", POSITION: "0001", KEYFLAG: "X" })
    const r = await readTable("OLD", "WIDE2", { maxRows: 2 })
    // part 1 read IDs 1,2; part 2 read 3,2: only 2 is complete
    expect(r.rows).toEqual([{ ID: "2", A: "a2", B: "b2" }])
    expect(r.notes.join(" ")).toMatch(/incomplete: 1 row\(s\) were not returned by every part/)
  })

  it("refuses a wide read of a table without key fields instead of joining by row position", async () => {
    tables.WIDEVIEW = {
      fields: [{ name: "A", length: 300 }, { name: "B", length: 300 }],
      keys: [],
      rows: [{ A: "a1", B: "b1" }, { A: "a2", B: "b2" }],
    }
    await expect(readTable("OLD", "WIDEVIEW", { maxRows: 10 })).rejects.toThrow(/no key fields in DD03L.*Select fewer fields/)
    const r = await readTable("OLD", "WIDEVIEW", { fields: ["A"], maxRows: 10 })
    expect(r.rows).toEqual([{ A: "a1" }, { A: "a2" }])
  })

  it("leaves out string fields and names them", async () => {
    tables.STR = { fields: [{ name: "K", length: 3 }, { name: "S", length: 0, type: "g" }], keys: ["K"], rows: [{ K: "1" }] }
    const r = await readTable("OLD", "STR", { maxRows: 10 })
    expect(r.columns).toEqual(["K"])
    expect(r.notes[0]).toMatch(/S \(type g/)
  })

  it("names the fields a table has when an unknown one is asked for", async () => {
    await expect(readTable("OLD", "T000", { fields: ["NOPE"], maxRows: 1 })).rejects.toThrow(/no field NOPE.*MANDT, MTEXT/)
  })
})

// ─── Sources ──────────────────────────────────────────────────────────────────

describe("sourceTarget", () => {
  it.each([
    ["/sap/bc/adt/programs/programs/z_rep/source/main", { kind: "PROG", name: "Z_REP" }],
    ["/sap/bc/adt/programs/includes/zinc", { kind: "INCL", name: "ZINC" }],
    ["/sap/bc/adt/functions/groups/zgrp/fmodules/z_fm/source/main", { kind: "FUNC", name: "Z_FM" }],
    ["/sap/bc/adt/functions/groups/%2fns%2fgrp", { kind: "FUGR", name: "/NS/GRP" }],
    ["/sap/bc/adt/oo/classes/zcl_x/source/main", { kind: "CLAS", name: "ZCL_X" }],
    ["/sap/bc/adt/oo/classes/zcl_x/includes/implementations", { kind: "CLAS", name: "ZCL_X", classInclude: "CCIMP" }],
    ["/sap/bc/adt/oo/interfaces/zif_x/source/main", { kind: "INTF", name: "ZIF_X" }],
    ["FUNC:RFC_READ_TABLE", { kind: "FUNC", name: "RFC_READ_TABLE" }],
    ["prog:z_rep", { kind: "PROG", name: "Z_REP" }],
  ])("maps %s", (ref, target) => {
    expect(sourceTarget(ref)).toEqual(target)
  })

  it("refuses what it cannot place, and names with quotes", () => {
    expect(() => sourceTarget("/sap/bc/adt/ddic/tables/mara")).toThrow(/Cannot tell/)
    expect(() => sourceTarget("PROG:Z'X")).toThrow(/Invalid object name/)
  })
})

describe("function group names", () => {
  it("derives main programs and FM includes, also in a namespace", () => {
    expect(groupProgram("ZGRP")).toBe("SAPLZGRP")
    expect(groupProgram("/NS/GRP")).toBe("/NS/SAPLGRP")
    expect(functionInclude("SAPLSDTX", "01")).toBe("LSDTXU01")
    expect(functionInclude("/NS/SAPLGRP", "7")).toBe("/NS/LGRPU07")
  })
})

describe("chooseReader", () => {
  const tf = (n: string, mode = "R") => ({ FUNCNAME: n, FMODE: mode })
  it("prefers RPY_PROGRAM_READ with 255-character lines", () => {
    expect(chooseReader([tf("RPY_PROGRAM_READ"), tf("RFC_READ_REPORT")], ["PROGRAM_NAME", "SOURCE_EXTENDED", "WITH_LOWERCASE"]))
      .toEqual({ fm: "RPY_PROGRAM_READ", table: "SOURCE_EXTENDED", lineWidth: 255, flags: ["WITH_LOWERCASE"] })
  })
  it("falls back to RFC_READ_REPORT, and never uses an FM that is not remote-enabled", () => {
    expect(chooseReader([tf("RPY_PROGRAM_READ", " "), tf("RFC_READ_REPORT")], ["PROGRAM_NAME", "SOURCE_EXTENDED"])!.fm).toBe("RFC_READ_REPORT")
    expect(chooseReader([tf("RPY_PROGRAM_READ", " ")], ["PROGRAM_NAME", "SOURCE_EXTENDED"])).toBeUndefined()
  })
})

describe("readSourceOver", () => {
  it("probes once, then reads a function module through its include", async () => {
    tables.TFDIR.rows.push(
      { FUNCNAME: "RFC_READ_REPORT", PNAME: "SAPLSUTL", INCLUDE: "01", FMODE: "R" },
      { FUNCNAME: "Z_FM", PNAME: "SAPLZGRP", INCLUDE: "03", FMODE: " " })
    programs.LZGRPU03 = ["FUNCTION z_fm.", "ENDFUNCTION."]
    const r = await readSourceOver("OLD", "OLD", "/sap/bc/adt/functions/groups/zgrp/fmodules/z_fm")
    expect(r.source).toBe("FUNCTION z_fm.\nENDFUNCTION.")
    await readSourceOver("OLD", "OLD", "FUNC:Z_FM")
    // the TFDIR probe ran once, not per read
    const probes = calls.filter(c => find(c.body, "TEXT")?.text.includes("RPY_PROGRAM_READ"))
    expect(probes.length).toBe(1)
  })

  it("assembles a class from its pool, expanding its includes and methods", async () => {
    tables.TFDIR.rows.push({ FUNCNAME: "RPY_PROGRAM_READ", PNAME: "SAPLSIFP", INCLUDE: "01", FMODE: "R" })
    tables.FUPARAREF.rows.push(...["PROGRAM_NAME", "SOURCE_EXTENDED", "ONLY_SOURCE"].map(p => ({ FUNCNAME: "RPY_PROGRAM_READ", R3STATE: "A", PARAMETER: p })))
    const p = "ZCL_X".padEnd(30, "=")
    tables.TRDIR.rows.push(...["CP", "CU", "CO", "CI", "CM001", "CM002"].map(s => ({ NAME: p + s })), { NAME: "ZCLAX".padEnd(30, "=") + "CU" })
    programs[p + "CP"] = ["class-pool .", `include ${p}cu.`, `include ${p}co.`, `include ${p}ci.`, "endclass.", "class zcl_x implementation.", "include methods.", "endclass."]
    programs[p + "CU"] = ["class zcl_x definition public.", "public section.", "methods a. methods b."]
    programs[p + "CO"] = ["protected section."]
    programs[p + "CI"] = ["private section."]
    programs[p + "CM001"] = ["method a.", "endmethod."]
    programs[p + "CM002"] = ["method b.", "endmethod."]
    const r = await readSourceOver("OLD", "OLD", "CLAS:ZCL_X")
    expect(r.source.split("\n").filter(l => !l.startsWith("*\" ----"))).toEqual([
      "class-pool .", "class zcl_x definition public.", "public section.", "methods a. methods b.",
      "protected section.", "private section.", "endclass.", "class zcl_x implementation.",
      "method a.", "endmethod.", "method b.", "endmethod.", "endclass.",
    ])
    const rpy = calls.find(c => c.fm === "RPY_PROGRAM_READ")!.body
    expect(find(rpy, "ONLY_SOURCE")!.text).toBe("X")
    expect(find(rpy, "WITH_LOWERCASE")).toBeUndefined()   // not in this release's interface: not sent
  })

  it("expands a namespaced class pool, includes with a trailing comment, and skips includes it does not have", async () => {
    tables.TFDIR.rows.push({ FUNCNAME: "RFC_READ_REPORT", PNAME: "SAPLSUTL", INCLUDE: "01", FMODE: "R" })
    const p = "/NS/CL_Y".padEnd(30, "=")
    tables.TRDIR.rows.push(...["CP", "CU", "CM001"].map(x => ({ NAME: p + x })))
    programs[p + "CP"] = ["class-pool .", `INCLUDE ${p}CU.  " public section`, `include ${p}ccau.`, "class /ns/cl_y implementation.", "include methods.", "endclass."]
    programs[p + "CU"] = ["class /ns/cl_y definition public. endclass."]
    programs[p + "CM001"] = ["method m.", "endmethod."]
    const r = await readSourceOver("OLD", "OLD", "/sap/bc/adt/oo/classes/%2Fns%2Fcl_y/source/main")
    const lines = r.source.split("\n")
    expect(lines).toContain("class /ns/cl_y definition public. endclass.")
    expect(lines).toContain(`include ${p}ccau.`)   // no such include: left as it is
    expect(lines).toContain("method m.")
    expect(calls.filter(c => c.fm === "RFC_READ_REPORT").map(c => find(c.body, "PROGRAM")!.text)).toEqual([p + "CP", p + "CU", p + "CM001"])
  })

  it("warns that RFC_READ_REPORT may cut lines at 72", async () => {
    tables.TFDIR.rows.push({ FUNCNAME: "RFC_READ_REPORT", PNAME: "SAPLSUTL", INCLUDE: "01", FMODE: "R" })
    programs.ZLONG = ["x".repeat(72)]
    const r = await readSourceOver("OLD", "OLD", "PROG:ZLONG")
    expect(r.notes[0]).toMatch(/72 characters/)
  })
})

// ─── Tool routing ─────────────────────────────────────────────────────────────

describe("SOAP RFC routing", () => {
  it("passes ADT connections to the tool's own handler, arguments untouched", async () => {
    const own = vi.fn(async () => "adt")
    const args = { sql: "SELECT * FROM T000", connectionId: "ADT1" }
    expect(await withSoapRfcRouting("execute_data_query", own)(args, { sessionId: "s" })).toBe("adt")
    expect(own).toHaveBeenCalledWith(args, { sessionId: "s" })
    expect(calls).toHaveLength(0)
  })

  it("lets an unknown connection reach the tool's own handler (which reports it as before)", async () => {
    const own = vi.fn(async () => "own")
    expect(await withSoapRfcRouting("read_table_contents", own)({ tableName: "T000", connectionId: "NOPE" })).toBe("own")
  })

  it("runs a SOAP RFC connection's call on the SOAP handler", async () => {
    const own = vi.fn()
    const r = await withSoapRfcRouting("read_table_contents", own)({ tableName: "t000", whereClause: "MANDT = '200'", connectionId: "OLD" }) as any
    expect(own).not.toHaveBeenCalled()
    expect(r.content[0].text).toContain("Quality <&> test")
    expect(r.content[0].text).toContain("(1 row(s))")
  })

  it("refuses a write or ADT-only tool on a SOAP RFC connection without calling SAP", async () => {
    const own = vi.fn()
    const r = await withSoapRfcRouting("write_abap_object_source", own)({ connectionId: "OLD" }) as any
    expect(own).not.toHaveBeenCalled()
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not supported on OLD.*read_table_contents/)
    expect(calls).toHaveLength(0)
  })

  it("execute_data_query maps a simple SELECT and blocks DML", async () => {
    const q = SOAP_RFC_HANDLERS.execute_data_query
    const r = await q({ sql: "SELECT MTEXT FROM T000 WHERE MANDT = '000'", connectionId: "OLD" })
    expect(r.content[0].text).toContain("SAP AG")
    await expect(q({ sql: "DELETE FROM T000", connectionId: "OLD" })).rejects.toThrow(/blocked/)
    await expect(q({ sql: "SELECT * FROM T000 ORDER BY MANDT", connectionId: "OLD" })).rejects.toThrow(/ORDER BY/)
  })

  it("execute_data_query takes the smaller of UP TO and maxRows and says when it stopped", async () => {
    const r = await SOAP_RFC_HANDLERS.execute_data_query({ sql: "SELECT * FROM T000 UP TO 5 ROWS", maxRows: 1, connectionId: "OLD" })
    expect(r.content[0].text).toContain("(1 row(s))")
    expect(r.content[0].text).toMatch(/Stopped at 1 row/)
  })

  it("read_table_contents refuses a subquery in whereClause", async () => {
    await expect(SOAP_RFC_HANDLERS.read_table_contents({ tableName: "T000", whereClause: "MANDT IN ( SELECT MANDT FROM USR02 )", connectionId: "OLD" }))
      .rejects.toThrow(/subquery/)
    expect(calls).toHaveLength(0)
  })

  it("describe_database_table lists fields with key marks", async () => {
    const r = await SOAP_RFC_HANDLERS.describe_database_table({ tableName: "T000", connectionId: "OLD" })
    expect(r.content[0].text).toMatch(/🔑 MANDT/)
    expect(r.content[0].text).toContain("Key fields: MANDT")
  })
})

describe("ADT layer on a SOAP RFC connection", () => {
  it("refuses to build an ADT session, so nothing tries to log on through ADT", async () => {
    await expect(ensureConnected("OLD")).rejects.toThrow(/SOAP RFC connection/)
    await expect(newIsolatedClient("OLD", 1000)).rejects.toThrow(/SOAP RFC connection/)
  })
})

it("SoapRfcError carries the HTTP status", () => {
  expect(new SoapRfcError("m", "C", 401).status).toBe(401)
})
