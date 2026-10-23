/**
 * Tool routing for SOAP RFC connections (connections.json protocol "soap-rfc"):
 * systems too old for ADT, read through /sap/bc/soap/rfc.
 *
 * A call whose connection is a SOAP RFC one goes to the handler below of the same
 * tool name, or is refused as not supported there. Every other call reaches the
 * tool's own handler untouched, so ADT connections behave exactly as before.
 * The routing sits inside the session-recovery wrapper (see tools/index.ts): a
 * SOAP RFC call never triggers an ADT reconnect.
 *
 * Read-only by construction: the handlers here only call RFC_READ_TABLE and the
 * program read FMs (soapRfc/readTable.ts, soapRfc/source.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { isSoapRfcConnection, resolveConnectionId } from "../connections"
import { keyFields, readTable, tableFields } from "../soapRfc/readTable"
import { readSourceOver } from "../soapRfc/source"
import { parseSimpleSelect } from "../soapRfc/sql"
import { formatQueryResult, validateSql } from "./data"
import type { QueryResult } from "abap-adt-api"

type AnyToolHandler = (...handlerArgs: unknown[]) => unknown
type Args = Record<string, unknown> & { connectionId?: string }
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) })

const TABLE_NAME = /^[A-Z0-9_/]{1,30}$/i

function tableText(r: { columns: string[]; rows: Record<string, string>[]; notes: string[] }, maxRows: number): string {
  const result = { columns: r.columns.map(name => ({ name })), values: r.rows } as unknown as QueryResult
  const notes = [...r.notes]
  if (maxRows > 0 && r.rows.length >= maxRows) notes.push(`Stopped at ${maxRows} row(s): there may be more.`)
  return formatQueryResult(result) + (notes.length ? `\n\n${notes.map(n => `Note: ${n}`).join("\n")}` : "")
}

async function soapExecuteDataQuery(a: Args): Promise<ToolResult> {
  const sql = String(a.sql ?? "")
  validateSql(sql)
  const q = parseSimpleSelect(sql)
  const limits = [q.maxRows, typeof a.maxRows === "number" ? a.maxRows : undefined].filter((n): n is number => typeof n === "number" && n > 0)
  const maxRows = limits.length ? Math.min(...limits) : 100
  const r = await readTable(a.connectionId, q.table, { fields: q.fields, where: q.where, maxRows })
  return text(tableText(r, maxRows))
}

async function soapReadTableContents(a: Args): Promise<ToolResult> {
  const table = String(a.tableName ?? "")
  if (!TABLE_NAME.test(table)) return text(`Invalid table name: ${table}`)
  const where = typeof a.whereClause === "string" ? a.whereClause.trim() : ""
  if (where) validateSql(`SELECT * FROM ${table} WHERE ${where}`)
  const maxRows = typeof a.maxRows === "number" && a.maxRows > 0 ? a.maxRows : 100
  const r = await readTable(a.connectionId, table.toUpperCase(), { fields: "*", where: where || undefined, maxRows })
  return text(tableText(r, maxRows))
}

async function soapDescribeTable(a: Args): Promise<ToolResult> {
  const table = String(a.tableName ?? "").toUpperCase()
  if (!TABLE_NAME.test(table)) return text(`Invalid table name: ${table}`)
  const fields = await tableFields(a.connectionId, table)
  const { keys, error } = await keyFields(a.connectionId, table)
  const keySet = new Set(keys)
  const lines = [
    `Table: ${table}`,
    `Fields: ${fields.length} total, ${keys.length} key field(s)`,
    "",
    `${"Field".padEnd(34)} ${"ABAP type".padEnd(10)} ${"Length".padEnd(8)} Description`,
    "-".repeat(80),
    ...fields.map(f => `  ${keySet.has(f.name) ? "🔑" : "  "} ${f.name.padEnd(30)} ${f.type.padEnd(10)} ${`(${f.length})`.padEnd(8)} ${f.text}`),
    "",
    keys.length ? `Key fields: ${keys.join(", ")}` : `Key fields: unknown${error ? ` (DD03L could not be read: ${error})` : " (none in DD03L — a view?)"}`,
    "",
    "(SOAP RFC connection: the fields as RFC_READ_TABLE reports them; types are ABAP internal types.)",
  ]
  return text(lines.join("\n"))
}

const sourceKey = (a: Args) => resolveConnectionId(a.connectionId)

async function soapGetObjectLines(a: Args): Promise<ToolResult> {
  const url = String(a.url ?? "")
  const r = await readSourceOver(a.connectionId, sourceKey(a), url)
  return { content: [{ type: "text", text: r.source || `No source found at: ${url}` }, ...r.notes.map(n => ({ type: "text" as const, text: `Note: ${n}` }))] }
}

async function soapSearchObjectLines(a: Args): Promise<ToolResult> {
  const url = String(a.url ?? "")
  const pattern = String(a.pattern ?? "")
  const regex = new RegExp(pattern, "i")
  const { source } = await readSourceOver(a.connectionId, sourceKey(a), url)
  if (!source) return text(`No source at: ${url}`)
  const matches = source.split("\n").map((t, i) => ({ line: i + 1, t })).filter(({ t }) => regex.test(t))
  if (!matches.length) return text(`No matches for "${pattern}" in ${url}`)
  return text(`Found ${matches.length} match(es) for "${pattern}":\n\n${matches.map(({ line, t }) => `${String(line).padStart(5)}: ${t}`).join("\n")}`)
}

async function soapGetBatchLines(a: Args): Promise<ToolResult> {
  const urls = Array.isArray(a.urls) ? a.urls.map(String) : []
  const parts: string[] = []
  // One at a time: SOAP RFC calls to a connection are queued anyway.
  for (const url of urls) {
    try {
      const r = await readSourceOver(a.connectionId, sourceKey(a), url)
      parts.push(`=== ${url} ===\n${r.source || "(empty)"}${r.notes.length ? `\n${r.notes.map(n => `Note: ${n}`).join("\n")}` : ""}`)
    } catch (err) {
      parts.push(`=== ERROR ===\n${String((err as Error)?.message ?? err)}`)
    }
  }
  return text(parts.join("\n\n"))
}

async function soapForceRelogin(a: Args): Promise<ToolResult> {
  return text(`${resolveConnectionId(a.connectionId)} is a SOAP RFC connection: every call logs on by itself and there is no session to renew.`)
}

/** What each tool does on a SOAP RFC connection. A tool not listed is refused there. */
export const SOAP_RFC_HANDLERS: Record<string, (a: Args) => Promise<ToolResult>> = {
  execute_data_query: soapExecuteDataQuery,
  read_table_contents: soapReadTableContents,
  describe_database_table: soapDescribeTable,
  get_abap_object_lines: soapGetObjectLines,
  search_abap_object_lines: soapSearchObjectLines,
  get_abap_batch_lines: soapGetBatchLines,
  force_relogin: soapForceRelogin,
}

/** Tools that never contact a SAP system: they run as they are, whatever the connection. */
const NO_SAP_CALL = new Set(["connected_systems"])

function unsupported(tool: string, id: string): ToolResult {
  return text(
    `${tool} is not supported on ${id}: it is a SOAP RFC connection (a system without ADT, read-only). ` +
    `Available there: ${Object.keys(SOAP_RFC_HANDLERS).filter(t => t !== "force_relogin").join(", ")}.`, true)
}

/** The SOAP RFC connection a call is for, or undefined when it is for an ADT one (or names an unknown connection). */
function soapConnectionOf(args: unknown): string | undefined {
  const c = (args as { connectionId?: unknown } | undefined)?.connectionId
  try {
    const id = resolveConnectionId(typeof c === "string" ? c : undefined)
    return isSoapRfcConnection(id) ? id : undefined
  } catch {
    return undefined   // the tool's own handler reports the bad connection as before
  }
}

export function withSoapRfcRouting<H extends AnyToolHandler>(toolName: string, handler: H): H {
  if (NO_SAP_CALL.has(toolName)) return handler
  const soap = SOAP_RFC_HANDLERS[toolName]
  const wrapped = (...handlerArgs: unknown[]) => {
    const id = soapConnectionOf(handlerArgs[0])
    if (id === undefined) return handler(...handlerArgs)
    return soap ? soap({ ...(handlerArgs[0] as Args), connectionId: id }) : unsupported(toolName, id)
  }
  return wrapped as unknown as H
}

export function wrapServerWithSoapRfcRouting(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyToolHandler).bind(target)
        return (name: string, config: unknown, handler: AnyToolHandler) =>
          original(name, config, withSoapRfcRouting(name, handler))
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyToolHandler).bind(target) : value
    }
  })
}
