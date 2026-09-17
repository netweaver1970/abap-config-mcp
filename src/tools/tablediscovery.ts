import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected } from "../connections"
import { runSql, tableRows, col } from "./customizing"

/**
 * Field list from the data dictionary (DD02L / DD03L / DD04T). ADT's data preview
 * only works for tables and views it can select from; for a structure (INTTAB) it
 * answers "Error while processing authorization checks", which reads like a
 * permission problem and is not one.
 */
async function describeFromDictionary(connectionId: string | undefined, name: string): Promise<string | undefined> {
  const client = await ensureConnected(connectionId)
  const n = name.toUpperCase().replace(/'/g, "''")
  const head = tableRows(await runSql(client, `SELECT TABCLASS, CONTFLAG FROM DD02L WHERE TABNAME = '${n}' AND AS4LOCAL = 'A'`, 1))[0]
  if (!head) return undefined
  const text = tableRows(await runSql(client, `SELECT DDTEXT FROM DD02T WHERE TABNAME = '${n}' AND DDLANGUAGE = 'E' AND AS4LOCAL = 'A'`, 1))[0]
  const fields = tableRows(await runSql(client,
    `SELECT FIELDNAME, POSITION, KEYFLAG, DATATYPE, LENG, DECIMALS, ROLLNAME FROM DD03L WHERE TABNAME = '${n}' AND AS4LOCAL = 'A' ORDER BY POSITION`, 1000))
  const rolls = [...new Set(fields.map(f => col(f, "ROLLNAME")).filter(Boolean))]
  const rollText = new Map<string, string>()
  // ADT's SQL fails on a line over 255 characters: data element names run to 30, so 4 per query.
  for (let i = 0; i < rolls.length; i += 4) {
    const chunk = rolls.slice(i, i + 4).map(r => `'${r.replace(/'/g, "''")}'`).join(", ")
    for (const r of tableRows(await runSql(client, `SELECT ROLLNAME, DDTEXT FROM DD04T WHERE ROLLNAME IN (${chunk}) AND DDLANGUAGE = 'E' AND AS4LOCAL = 'A'`, 100))) {
      rollText.set(col(r, "ROLLNAME"), col(r, "DDTEXT"))
    }
  }
  const kind: Record<string, string> = { TRANSP: "transparent table", INTTAB: "structure", VIEW: "view", POOL: "pooled table", CLUSTER: "cluster table", APPEND: "append structure" }
  const tabclass = col(head, "TABCLASS")
  const keys = fields.filter(f => col(f, "KEYFLAG") === "X").map(f => col(f, "FIELDNAME"))
  const lines = [
    `${kind[tabclass] ? kind[tabclass][0].toUpperCase() + kind[tabclass].slice(1) : `Object (${tabclass})`}: ${name.toUpperCase()}${text ? ` — ${col(text, "DDTEXT")}` : ""}`,
    `Fields: ${fields.length} total${keys.length ? `, ${keys.length} key field(s)` : ""}  (from the data dictionary)`,
    "",
    `${"Field".padEnd(34)} ${"Type".padEnd(8)} ${"Length".padEnd(8)} ${"Data element".padEnd(22)} Description`,
    "-".repeat(100),
    ...fields.map(f => {
      const key = col(f, "KEYFLAG") === "X" ? "🔑" : "  "
      const dec = Number(col(f, "DECIMALS")) ? `,${Number(col(f, "DECIMALS"))}` : ""
      return `  ${key} ${col(f, "FIELDNAME").padEnd(30)} ${col(f, "DATATYPE").padEnd(8)} ${(`${Number(col(f, "LENG"))}${dec}`).padEnd(8)} ${col(f, "ROLLNAME").padEnd(22)} ${rollText.get(col(f, "ROLLNAME")) ?? ""}`
    }),
  ]
  if (keys.length) lines.push("", `Key fields: ${keys.join(", ")}`)
  if (tabclass === "INTTAB" || tabclass === "APPEND") lines.push("", "A structure holds no rows: there is nothing to read with read_table_contents.")
  return lines.join("\n")
}

export async function handleSearchTables(args: {
  keyword: string
  maxResults?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const max = args.maxResults ?? 50

  // Search for transparent tables (TABL) and views (VIEW) matching the keyword
  const [tables, views] = await Promise.all([
    client.searchObject(args.keyword, "TABL", max),
    client.searchObject(args.keyword, "VIEW", max),
  ])

  const all = [
    ...tables.map(r => ({ kind: "TABLE", name: r["adtcore:name"], desc: r["adtcore:description"] ?? "", pkg: r["adtcore:packageName"] ?? "" })),
    ...views.map(r => ({ kind: "VIEW",  name: r["adtcore:name"], desc: r["adtcore:description"] ?? "", pkg: r["adtcore:packageName"] ?? "" })),
  ].sort((a, b) => a.name.localeCompare(b.name))

  if (all.length === 0) {
    return { content: [{ type: "text" as const, text: `No tables or views found matching "${args.keyword}".` }] }
  }

  const rows = all.map(r =>
    `  ${r.kind.padEnd(5)}  ${r.name.padEnd(30)} ${r.pkg.padEnd(20)} ${r.desc}`
  )
  const header = `  ${"Type".padEnd(5)}  ${"Table/View".padEnd(30)} ${"Package".padEnd(20)} Description\n  ${"-".repeat(90)}`

  return {
    content: [{
      type: "text" as const,
      text: `Tables/views matching "${args.keyword}" (${all.length} result(s)):\n\n${header}\n${rows.join("\n")}\n\n` +
        `Use describe_database_table to see the fields of any table above, ` +
        `then read_table_contents or execute_data_query to query it.`,
    }]
  }
}

export async function handleDescribeTable(args: {
  tableName: string
  connectionId?: string
}) {
  if (!/^[A-Z0-9_/]{1,120}$/i.test(args.tableName)) {
    return { content: [{ type: "text" as const, text: `Invalid table name: ${args.tableName}` }] }
  }

  // The data dictionary first: it has the real key flags (the data preview reported
  // T000 with no key field) and data elements, and it also covers structures.
  try {
    const fromDictionaryFirst = await describeFromDictionary(args.connectionId, args.tableName)
    if (fromDictionaryFirst) return { content: [{ type: "text" as const, text: fromDictionaryFirst }] }
  } catch {
    /* fall back to the data preview below */
  }

  const client = await ensureConnected(args.connectionId)
  // Fetch 0 rows — we only want the column metadata
  let result: Awaited<ReturnType<typeof client.tableContents>> | undefined
  let previewError: string | undefined
  try {
    result = await client.tableContents(args.tableName, 0)
  } catch (err) {
    previewError = String((err as { message?: string })?.message ?? err)
  }
  const cols = result?.columns

  if (!cols || cols.length === 0) {
    // Structures and anything else the data preview cannot select from.
    let fromDictionary: string | undefined
    let dictionaryError: string | undefined
    try {
      fromDictionary = await describeFromDictionary(args.connectionId, args.tableName)
    } catch (e) {
      dictionaryError = String((e as Error)?.message ?? e)
    }
    if (fromDictionary) return { content: [{ type: "text" as const, text: fromDictionary }] }
    return { content: [{ type: "text" as const, text: dictionaryError
      ? `Cannot describe ${args.tableName.toUpperCase()}: reading the data dictionary failed (${dictionaryError}).` +
        (previewError ? `\n(ADT data preview said: ${previewError})` : "")
      : `${args.tableName.toUpperCase()} is not in the data dictionary (DD02L), so there is nothing to describe.` +
        (previewError ? `\n(ADT data preview said: ${previewError})` : "") }] }
  }

  const keyFields = cols.filter(c => c.keyAttribute)
  const dataFields = cols.filter(c => !c.keyAttribute)

  function fmtCol(c: NonNullable<typeof cols>[number]): string {
    const key = c.keyAttribute ? "🔑" : "  "
    const len = c.length > 0 ? `(${c.length})` : ""
    return `  ${key} ${c.name.padEnd(30)} ${c.colType.padEnd(10)} ${len.padEnd(8)} ${c.description}`
  }

  const lines = [
    `Table: ${args.tableName}`,
    `Fields: ${cols.length} total, ${keyFields.length} key field(s)`,
    "",
    `${"Field".padEnd(34)} ${"Type".padEnd(10)} ${"Length".padEnd(8)} Description`,
    "-".repeat(80),
    ...cols.map(fmtCol),
    "",
    `Key fields: ${keyFields.map(c => c.name).join(", ")}`,
    "",
    `Example query:`,
    `  read_table_contents  tableName: ${args.tableName}  maxRows: 10`,
  ]

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export function registerTableDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "search_database_tables",
    {
      title: "Search Database Tables",
      description:
        "Search for SAP database tables and views by description keyword. " +
        "Works for all installed tables — standard SAP, industry solutions (IS-Retail, IS-Automotive, IS-Mill, etc.), " +
        "and custom Z/Y tables. Use this when you know what data you want but not the technical table name. " +
        "Examples: 'article listing', 'vehicle order', 'warehouse transfer', 'purchase order header'.",
      inputSchema: {
        keyword: z.string().describe("Description keyword to search for (e.g. 'article listing', 'transport request', 'material valuation')"),
        maxResults: z.number().optional().describe("Maximum results per object type (default: 50)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleSearchTables
  )

  server.registerTool(
    "describe_database_table",
    {
      title: "Describe Database Table",
      description:
        "Show all field names, types, lengths, and descriptions for a SAP database table or view. " +
        "Key fields are marked with 🔑. Use this after search_database_tables to understand the structure " +
        "before querying, so you know which fields to filter or select.",
      inputSchema: {
        tableName: z.string().describe("SAP table or view name (e.g. MARA, WLK1, EKKO, Z_MY_TABLE)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleDescribeTable
  )
}
