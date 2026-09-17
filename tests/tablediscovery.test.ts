import { describe, it, expect, vi, beforeEach } from "vitest"
import { handleSearchTables, handleDescribeTable } from "../src/tools/tablediscovery"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn(), log: vi.fn(),
}))
const sqlRows: Array<[RegExp, Array<Record<string, string>>]> = []
vi.mock("../src/tools/customizing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/customizing")>()),
  runSql: vi.fn(async (_c: unknown, sql: string) => {
    const rows = sqlRows.find(([re]) => re.test(sql))?.[1] ?? []
    return { columns: rows.length ? Object.keys(rows[0]).map(name => ({ name })) : [{ name: "X" }], values: rows }
  }),
}))
import { ensureConnected } from "../src/connections"

const mockClient = {
  searchObject: vi.fn(),
  tableContents: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
})

// ─── search_database_tables ───────────────────────────────────────────────────

describe("search_database_tables", () => {
  const tableHits = [
    { "adtcore:name": "WLK1", "adtcore:description": "Article listing header", "adtcore:type": "TABL", "adtcore:packageName": "WRF_LISTING", "adtcore:uri": "/uri/WLK1" },
    { "adtcore:name": "WLK2", "adtcore:description": "Article listing items",  "adtcore:type": "TABL", "adtcore:packageName": "WRF_LISTING", "adtcore:uri": "/uri/WLK2" },
  ]
  const viewHits = [
    { "adtcore:name": "VWLK1", "adtcore:description": "Article listing view", "adtcore:type": "VIEW", "adtcore:packageName": "WRF_LISTING", "adtcore:uri": "/uri/VWLK1" },
  ]

  beforeEach(() => {
    mockClient.searchObject
      .mockResolvedValueOnce(tableHits)   // TABL call
      .mockResolvedValueOnce(viewHits)    // VIEW call
  })

  it("searches both TABL and VIEW object types", async () => {
    await handleSearchTables({ keyword: "article listing" })
    expect(mockClient.searchObject).toHaveBeenCalledWith("article listing", "TABL", expect.any(Number))
    expect(mockClient.searchObject).toHaveBeenCalledWith("article listing", "VIEW", expect.any(Number))
  })

  it("returns table names and descriptions", async () => {
    const result = await handleSearchTables({ keyword: "article listing" })
    const text = result.content[0].text
    expect(text).toContain("WLK1")
    expect(text).toContain("Article listing header")
    expect(text).toContain("WLK2")
    expect(text).toContain("VWLK1")
  })

  it("shows TABLE vs VIEW kind", async () => {
    const result = await handleSearchTables({ keyword: "article listing" })
    const text = result.content[0].text
    expect(text).toContain("TABLE")
    expect(text).toContain("VIEW")
  })

  it("shows package name in results", async () => {
    const result = await handleSearchTables({ keyword: "article listing" })
    expect(result.content[0].text).toContain("WRF_LISTING")
  })

  it("shows result count", async () => {
    const result = await handleSearchTables({ keyword: "article listing" })
    expect(result.content[0].text).toContain("3 result(s)")
  })

  it("includes hint to use describe_database_table and query tools", async () => {
    const result = await handleSearchTables({ keyword: "article listing" })
    expect(result.content[0].text).toContain("describe_database_table")
    expect(result.content[0].text).toContain("read_table_contents")
  })

  it("returns not-found message when no results", async () => {
    mockClient.searchObject.mockReset()
    mockClient.searchObject.mockResolvedValue([])
    const result = await handleSearchTables({ keyword: "nonexistent thing" })
    expect(result.content[0].text).toContain("No tables or views found")
    expect(result.content[0].text).toContain("nonexistent thing")
  })

  it("passes maxResults through to searchObject", async () => {
    mockClient.searchObject.mockReset()
    mockClient.searchObject.mockResolvedValue([])
    await handleSearchTables({ keyword: "test", maxResults: 10 })
    expect(mockClient.searchObject).toHaveBeenCalledWith("test", "TABL", 10)
    expect(mockClient.searchObject).toHaveBeenCalledWith("test", "VIEW", 10)
  })
})

// ─── describe_database_table ──────────────────────────────────────────────────

describe("describe_database_table", () => {
  const columns = [
    { name: "MANDT",  colType: "CLNT", length: 3,  description: "Client",          keyAttribute: true,  isKeyFigure: false, type: "C" as any },
    { name: "MATNR",  colType: "CHAR", length: 18, description: "Material number", keyAttribute: true,  isKeyFigure: false, type: "C" as any },
    { name: "MAKTX",  colType: "CHAR", length: 40, description: "Material desc",   keyAttribute: false, isKeyFigure: false, type: "C" as any },
    { name: "LAEDA",  colType: "DATS", length: 8,  description: "Last changed",    keyAttribute: false, isKeyFigure: false, type: "D" as any },
  ]

  beforeEach(() => {
    mockClient.tableContents.mockResolvedValue({ columns, values: [] })
  })

  it("fetches table structure with 0 rows", async () => {
    await handleDescribeTable({ tableName: "MAKT" })
    expect(mockClient.tableContents).toHaveBeenCalledWith("MAKT", 0)
  })

  it("shows field names, types, lengths, and descriptions", async () => {
    const result = await handleDescribeTable({ tableName: "MAKT" })
    const text = result.content[0].text
    expect(text).toContain("MANDT")
    expect(text).toContain("MATNR")
    expect(text).toContain("MAKTX")
    expect(text).toContain("LAEDA")
    expect(text).toContain("Material number")
    expect(text).toContain("Last changed")
    expect(text).toContain("DATS")
  })

  it("marks key fields with key indicator", async () => {
    const result = await handleDescribeTable({ tableName: "MAKT" })
    const text = result.content[0].text
    expect(text).toContain("🔑")
    expect(text).toContain("Key fields: MANDT, MATNR")
  })

  it("shows field count and key field count", async () => {
    const result = await handleDescribeTable({ tableName: "MAKT" })
    expect(result.content[0].text).toContain("4 total")
    expect(result.content[0].text).toContain("2 key field(s)")
  })

  it("includes example query hint", async () => {
    const result = await handleDescribeTable({ tableName: "MAKT" })
    expect(result.content[0].text).toContain("read_table_contents")
    expect(result.content[0].text).toContain("MAKT")
  })

  it("rejects invalid table names", async () => {
    const result = await handleDescribeTable({ tableName: "'; DROP TABLE--" })
    expect(result.content[0].text).toContain("Invalid table name")
    expect(mockClient.tableContents).not.toHaveBeenCalled()
  })

  it("says the object is not in the dictionary when there is no metadata anywhere", async () => {
    sqlRows.length = 0
    mockClient.tableContents.mockResolvedValue({ columns: [], values: [] })
    const result = await handleDescribeTable({ tableName: "ZNOTEXIST" })
    expect(result.content[0].text).toContain("not in the data dictionary")
  })

  it("describes a structure from the dictionary when the data preview refuses it", async () => {
    sqlRows.length = 0
    sqlRows.push([/FROM DD02L/, [{ TABCLASS: "INTTAB", CONTFLAG: "" }]])
    sqlRows.push([/FROM DD02T/, [{ DDTEXT: "Output parameters" }]])
    sqlRows.push([/FROM DD03L/, [
      { FIELDNAME: "VCF1", POSITION: "1", KEYFLAG: "", DATATYPE: "FLTP", LENG: "000016", DECIMALS: "000016", ROLLNAME: "OIB_VCF1" },
    ]])
    sqlRows.push([/FROM DD04T/, [{ ROLLNAME: "OIB_VCF1", DDTEXT: "Volume correction factor" }]])
    mockClient.tableContents.mockRejectedValue(new Error("Error while processing authorization checks"))
    const text = (await handleDescribeTable({ tableName: "OIB_A02" })).content[0].text
    expect(text).toContain("Structure: OIB_A02 — Output parameters")
    expect(text).toContain("VCF1")
    expect(text).toContain("Volume correction factor")
    expect(text).toContain("holds no rows")
  })
})
