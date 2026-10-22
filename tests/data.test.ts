import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  validateSql,
  formatQueryResult,
  handleExecuteDataQuery,
  handleReadTableContents,
} from "../src/tools/data"
import type { QueryResult } from "abap-adt-api"

vi.mock("../src/connections", () => ({ ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn() }))
import { ensureConnected } from "../src/connections"

// statelessClone points back at the mock so the read handlers (which run on the
// stateless clone to avoid ADT subpool buildup) hit the same spies.
const mockClient: any = { runQuery: vi.fn(), tableContents: vi.fn() }
mockClient.statelessClone = mockClient

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
})

// ─── validateSql ──────────────────────────────────────────────────────────────

describe("validateSql", () => {
  it("accepts SELECT statements", () => {
    expect(() => validateSql("SELECT * FROM MARA")).not.toThrow()
    expect(() => validateSql("  select matnr from mara")).not.toThrow()
  })

  it("blocks DML statements", () => {
    expect(() => validateSql("INSERT INTO MARA VALUES (1)")).toThrow("blocked")
    expect(() => validateSql("UPDATE MARA SET MATNR = 'X'")).toThrow("blocked")
    expect(() => validateSql("DELETE FROM MARA")).toThrow("blocked")
    expect(() => validateSql("DROP TABLE MARA")).toThrow("blocked")
    expect(() => validateSql("ALTER TABLE MARA ADD COL")).toThrow("blocked")
    expect(() => validateSql("TRUNCATE MARA")).toThrow("blocked")
  })

  it("blocks non-SELECT statements", () => {
    expect(() => validateSql("EXEC sp_foo")).toThrow()  // caught by DML pattern
    expect(() => validateSql("MARA")).toThrow("must start with SELECT")
    expect(() => validateSql("SHOW TABLES")).toThrow("must start with SELECT")
  })
})

// ─── formatQueryResult ────────────────────────────────────────────────────────

describe("formatQueryResult", () => {
  it("renders header, separator, and rows", () => {
    const result: QueryResult = {
      columns: [{ name: "MATNR" }, { name: "MAKTX" }],
      values: [{ MATNR: "100-100", MAKTX: "Screw" }]
    } as any
    const text = formatQueryResult(result)
    expect(text).toContain("MATNR")
    expect(text).toContain("MAKTX")
    expect(text).toContain("100-100")
    expect(text).toContain("Screw")
    expect(text).toContain("(1 row(s))")
  })

  it("handles empty result set", () => {
    const result: QueryResult = {
      columns: [{ name: "MATNR" }],
      values: []
    } as any
    const text = formatQueryResult(result)
    expect(text).toContain("(0 row(s))")
  })

  it("prints raw (undecoded) values as SAP sends them, a missing one as empty", () => {
    // runQuery(..., false): DATS stays YYYYMMDD, NUMC keeps all digits, and a
    // lone empty cell arrives as undefined (abap-adt-api drops it)
    const result: QueryResult = {
      columns: [{ name: "JOBNAME" }, { name: "ENDDATE" }, { name: "REQUEST_TSN" }],
      values: [{ JOBNAME: "ZJOB", ENDDATE: undefined, REQUEST_TSN: "20261022150733000006000" }]
    } as any
    const text = formatQueryResult(result)
    expect(text).toContain("20261022150733000006000")
    expect(text).not.toContain("undefined")
    expect(text).toContain("(1 row(s))")
  })

  it("returns error message when no columns", () => {
    const result: QueryResult = { columns: [], values: [] } as any
    expect(formatQueryResult(result)).toContain("No columns")
  })
})

// ─── execute_data_query ───────────────────────────────────────────────────────

describe("execute_data_query", () => {
  it("executes a valid SELECT and formats result", async () => {
    mockClient.runQuery.mockResolvedValue({
      columns: [{ name: "MATNR" }],
      values: [{ MATNR: "Z001" }]
    })
    const result = await handleExecuteDataQuery({ sql: "SELECT MATNR FROM MARA" })
    expect(mockClient.runQuery).toHaveBeenCalledWith("SELECT MATNR FROM MARA", 100, false)
    expect(result.content[0].text).toContain("Z001")
  })

  it("rejects DML without calling the SAP system", async () => {
    await expect(handleExecuteDataQuery({ sql: "DELETE FROM MARA" })).rejects.toThrow("blocked")
    expect(mockClient.runQuery).not.toHaveBeenCalled()
  })

  it("passes custom maxRows", async () => {
    mockClient.runQuery.mockResolvedValue({ columns: [{ name: "A" }], values: [] })
    await handleExecuteDataQuery({ sql: "SELECT A FROM T", maxRows: 5 })
    expect(mockClient.runQuery).toHaveBeenCalledWith(expect.any(String), 5, false)
  })
})

// ─── read_table_contents ──────────────────────────────────────────────────────

describe("read_table_contents", () => {
  it("reads a valid table name", async () => {
    mockClient.tableContents.mockResolvedValue({ columns: [{ name: "MATNR" }], values: [{ MATNR: "X" }] })
    const result = await handleReadTableContents({ tableName: "MARA" })
    expect(mockClient.tableContents).toHaveBeenCalledWith("MARA", 100, false)
    expect(result.content[0].text).toContain("X")
  })

  it("rejects invalid table names without calling SAP", async () => {
    const result = await handleReadTableContents({ tableName: "MARA; DROP TABLE MARA" })
    expect(result.content[0].text).toContain("Invalid table name")
    expect(mockClient.tableContents).not.toHaveBeenCalled()
  })

  it("runs a whereClause as a SELECT (the table preview refuses a bare clause)", async () => {
    mockClient.runQuery.mockResolvedValue({ columns: [{ name: "MATNR" }], values: [] })
    await handleReadTableContents({ tableName: "MARA", whereClause: "MATNR LIKE 'Z%'" })
    expect(mockClient.runQuery).toHaveBeenCalledWith("SELECT * FROM MARA WHERE MATNR LIKE 'Z%'", 100, false)
    expect(mockClient.tableContents).not.toHaveBeenCalled()
  })

  it("refuses a whereClause that is not a plain condition", async () => {
    await expect(handleReadTableContents({ tableName: "MARA", whereClause: "1 = 1; DELETE FROM mara" })).rejects.toThrow(/Only SELECT/)
    expect(mockClient.runQuery).not.toHaveBeenCalled()
  })
})

// ─── long statements ──────────────────────────────────────────────────────────

import { wrapSqlLines } from "../src/tools/data"

describe("wrapSqlLines", () => {
  it("leaves short statements alone", () => {
    expect(wrapSqlLines("SELECT * FROM t000")).toBe("SELECT * FROM t000")
  })

  it("wraps a line over 255 characters at whitespace, never inside a literal", () => {
    const lit = "'" + "a b ".repeat(30) + "it''s'"
    const sql = "SELECT mandt, COUNT(*) AS n FROM t000 WHERE " + Array(12).fill("mtext <> 'x y'").join(" AND ") + ` AND mtext <> ${lit} GROUP BY mandt HAVING COUNT(*) > 0`
    const out = wrapSqlLines(sql)
    expect(out.split("\n").every(l => l.length <= 255)).toBe(true)
    expect(out.replace(/\n/g, " ")).toBe(sql)
    expect(out).toContain(lit)
  })
})
