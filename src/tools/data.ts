import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected } from "../connections"
import type { ADTClient, QueryResult } from "abap-adt-api"

const DANGEROUS_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|MERGE)\b/i

export function validateSql(sql: string): void {
  if (DANGEROUS_PATTERN.test(sql)) {
    throw new Error("Only SELECT queries are allowed. DML/DDL statements are blocked.")
  }
  if (!/^SELECT\s/i.test(sql.trim())) {
    throw new Error("Query must start with SELECT")
  }
}

// ADT's freestyle SQL endpoint breaks a statement line after 255 characters, so a
// long one-line statement failed with a grammar error naming whatever token sat at
// the cut ('"HA" is invalid here' for HAVING, '"INTO" …', '"TABLE" …': CAR,
// 2026-10-22). Longer lines are wrapped at whitespace outside string literals.
const SQL_LINE_MAX = 255
const SQL_WRAP_AT = 200

export function wrapSqlLines(sql: string): string {
  return sql.split("\n").map(line => {
    if (line.length <= SQL_LINE_MAX) return line
    // Split into words at whitespace that is not inside a '…' literal ('' is an escaped quote).
    const words: string[] = []
    let cur = "", inLit = false
    for (const ch of line) {
      if (ch === "'") inLit = !inLit
      if (!inLit && /\s/.test(ch)) { if (cur) words.push(cur); cur = ""; continue }
      cur += ch
    }
    if (cur) words.push(cur)
    const out: string[] = []
    let row = ""
    for (const w of words) {
      if (row && row.length + 1 + w.length > SQL_WRAP_AT) { out.push(row); row = w } else row = row ? `${row} ${w}` : w
    }
    if (row) out.push(row)
    return out.join("\n")
  }).join("\n")
}

/**
 * Run freestyle SQL: on the stateless clone (see handleExecuteDataQuery), long
 * lines wrapped, and the statement sent as text/plain. abap-adt-api posts it with
 * no content type, so it went out form-encoded and SAP read "%" as an escape:
 * LIKE '6%' failed with a bare HTTP 400 and '%25' matched nothing.
 */
export async function freestyleQuery(client: ADTClient, sql: string, maxRows: number): Promise<QueryResult> {
  return sqlClone(client).runQuery(wrapSqlLines(sql), maxRows, false)
}

/** The stateless clone, set to send SQL bodies (statements, WHERE clauses) as text/plain. */
function sqlClone(client: ADTClient): ADTClient {
  const clone = client.statelessClone
  // Set on every call: the clone's HTTP client is replaced when it logs in again.
  const http = (clone as unknown as { httpClient?: { commonHeaders?: Record<string, string> } }).httpClient
  if (http?.commonHeaders) http.commonHeaders["Content-Type"] = "text/plain"
  return clone
}

export function formatQueryResult(result: QueryResult): string {
  const columns = result.columns
  if (!columns || columns.length === 0) return "No columns in result"

  const colNames = columns.map(c => c.name)
  const colWidths = colNames.map(n => n.length)

  // Each row is an object keyed by column name, e.g. { MATNR: "...", MAKTX: "..." }
  const rowData: string[][] = (result.values ?? []).map((row: Record<string, unknown>) =>
    colNames.map((name, i) => {
      const val = String(row[name] ?? "")
      if (val.length > colWidths[i]) colWidths[i] = Math.min(val.length, 50)
      return val
    })
  )

  const header = colNames.map((n, i) => n.padEnd(colWidths[i])).join(" | ")
  const sep = colWidths.map(w => "-".repeat(w)).join("-+-")
  const rows = rowData.map(row =>
    row.map((cell, i) => cell.substring(0, 50).padEnd(colWidths[i])).join(" | ")
  )

  return `${header}\n${sep}\n${rows.join("\n")}\n\n(${rowData.length} row(s))`
}

export async function handleExecuteDataQuery(args: {
  sql: string
  maxRows?: number
  connectionId?: string
}) {
  validateSql(args.sql)
  const client = await ensureConnected(args.connectionId)
  // Stateless clone: ADT Data Preview generates a subroutine pool per query and
  // ABAP caps those at 36 per internal session.  Running on the long-lived
  // stateful session would accumulate them until a CX_SY_GENERATE_SUBPOOL_FULL
  // dump (CL_ADT_DP_OPEN_SQL_HANDLER); stateless rolls out each request's pool.
  // decode=false: values as SAP sends them.  abap-adt-api's decoder turns DATS
  // into JS Dates (and crashes on an empty one: "reading 'substr'") and NUMC /
  // DEC into floats (a 23-digit request TSN came back as 2.0261021213305e+22).
  const result = await freestyleQuery(client, args.sql, args.maxRows ?? 100)
  return { content: [{ type: "text" as const, text: formatQueryResult(result) }] }
}

export async function handleReadTableContents(args: {
  tableName: string
  maxRows?: number
  whereClause?: string
  connectionId?: string
}) {
  if (!/^[A-Z0-9_/]{1,120}$/i.test(args.tableName)) {
    return { content: [{ type: "text" as const, text: `Invalid table name: ${args.tableName}` }] }
  }
  const client = await ensureConnected(args.connectionId)
  // Stateless clone for the same reason as execute_data_query — keep read-only
  // table previews out of the long-lived stateful session (no subpool buildup).
  // A WHERE clause goes through freestyle SQL: the table preview endpoint refuses
  // a bare clause with "Only SELECT statement is allowed" (CAR, S4).
  let result: QueryResult
  if (args.whereClause?.trim()) {
    const sql = `SELECT * FROM ${args.tableName} WHERE ${args.whereClause}`
    validateSql(sql)
    result = await freestyleQuery(client, sql, args.maxRows ?? 100)
  } else {
    result = await sqlClone(client).tableContents(args.tableName, args.maxRows ?? 100, false)
  }
  return { content: [{ type: "text" as const, text: formatQueryResult(result) }] }
}

export function registerDataTools(server: McpServer): void {
  server.registerTool(
    "execute_data_query",
    {
      title: "Execute Data Query",
      description: "Execute a SELECT SQL query against SAP ABAP dictionary tables or CDS views. Read-only — DML statements are blocked.",
      inputSchema: {
        sql: z.string().describe("SQL SELECT statement (e.g. SELECT * FROM MARA WHERE MATNR LIKE 'Z%' UP TO 100 ROWS)"),
        maxRows: z.number().optional().describe("Maximum rows to return (default: 100)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleExecuteDataQuery
  )

  server.registerTool(
    "read_table_contents",
    {
      title: "Read Table Contents",
      description:
        "Read contents of an ABAP dictionary table or view by name. " +
        "The optional whereClause filter requires the ADT Data Preview service " +
        "(SICF node /sap/bc/adt/datapreview, SAP_BASIS ≥ 7.40 SP08) to be active. " +
        "If whereClause returns an error, use execute_data_query with a full " +
        "SELECT ... WHERE ... UP TO n ROWS statement instead — that uses a different " +
        "ADT endpoint and works on all supported SAP versions.",
      inputSchema: {
        tableName: z.string().describe("ABAP table or view name (e.g. MARA, EKPO, Z_MY_TABLE)"),
        maxRows: z.number().optional().describe("Maximum rows (default: 100)"),
        whereClause: z.string().optional().describe("Optional WHERE clause without the WHERE keyword (e.g. MATNR LIKE 'Z%'). Requires SICF /sap/bc/adt/datapreview to be active — use execute_data_query if this fails."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleReadTableContents
  )
}
