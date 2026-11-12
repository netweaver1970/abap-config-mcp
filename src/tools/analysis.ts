import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected } from "../connections"

export async function handleWhereUsed(args: {
  url: string
  line?: number
  column?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const refs = await client.usageReferences(args.url, args.line, args.column)

  if (!refs || refs.length === 0) {
    return { content: [{ type: "text" as const, text: `No usages found for: ${args.url}` }] }
  }

  try {
    const groups = await client.usageReferenceSnippets(refs)
    const lines: string[] = []
    for (const group of groups) {
      for (const snip of group.snippets) {
        const line = snip.uri.start?.line ?? 0
        lines.push(`${snip.uri.uri}:${line}\n  ${snip.content.trim()}`)
      }
    }
    if (lines.length > 0) {
      return {
        content: [{
          type: "text" as const,
          text: `Found ${lines.length} usage location(s):\n\n${lines.join("\n\n")}`
        }]
      }
    }
  } catch {
    // Fall through to the plain reference list below.
  }

  const refLines = refs.map(r =>
    `${r["adtcore:name"]}${r["adtcore:type"] ? ` (${r["adtcore:type"]})` : ""} — ${r.uri}`
  )
  return {
    content: [{
      type: "text" as const,
      text: `Found ${refs.length} usage reference(s):\n${refLines.join("\n")}`
    }]
  }
}

export async function handleVersionHistory(args: { url: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const revisions = await client.revisions(args.url)

  if (!revisions || revisions.length === 0) {
    return { content: [{ type: "text" as const, text: `No version history found for: ${args.url}` }] }
  }

  const lines = revisions.map(r =>
    `${r.version} | ${r.date} | ${r.author.padEnd(12)} | ${r.versionTitle ?? ""}`
  )

  return {
    content: [{
      type: "text" as const,
      text: `Version history (${revisions.length} revision(s)):\n${lines.join("\n")}`
    }]
  }
}

export async function handleAnalyzeDump(args: { query?: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const feed = await client.dumps(args.query)
  const dumps = feed.dumps ?? []

  if (dumps.length === 0) {
    return { content: [{ type: "text" as const, text: "No runtime dumps found." }] }
  }

  const lines = dumps.map(d => {
    const category = d.categories?.[0]?.term ?? d.type
    return `• [${category}] ${d.text}\n    id: ${d.id}${d.author ? ` | user: ${d.author}` : ""}`
  })
  return {
    content: [{
      type: "text" as const,
      text: `Runtime dumps (${dumps.length}):\n\n${lines.join("\n")}`
    }]
  }
}

export async function handleCheckInactiveObjects(args: { connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const records = await client.inactiveObjects()

  if (!records || records.length === 0) {
    return { content: [{ type: "text" as const, text: "No inactive objects found." }] }
  }

  const lines = records
    .map(r => r.object)
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map(o => `${o["adtcore:type"].padEnd(12)} ${o["adtcore:name"]}\n  ${o["adtcore:uri"]}`)

  if (lines.length === 0) {
    return { content: [{ type: "text" as const, text: "No inactive objects found." }] }
  }

  return {
    content: [{
      type: "text" as const,
      text: `${lines.length} inactive object(s):\n${lines.join("\n")}`
    }]
  }
}

export function registerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "where_used",
    {
      title: "Where Used",
      description: "List where an ABAP object, or a symbol inside it, is used (the where-used list). Returns each usage as a location with a source snippet when SAP provides snippets, otherwise as name, type and URL. For symbol-level search pass line and column of the symbol in the object's source. Use search_abap_object_lines to search text inside one object instead. Read-only.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object (e.g. /sap/bc/adt/oo/classes/zcl_order_api) or, for a symbol, its source URL ending in /source/main"),
        line: z.number().optional().describe("Line of the symbol in the source; give together with column for a symbol-level search, omit for the whole object"),
        column: z.number().optional().describe("Column of the symbol in that line; give together with line"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleWhereUsed
  )

  server.registerTool(
    "version_history",
    {
      title: "Version History",
      description: "List the stored revisions of an ABAP object, one line per revision: version id, date, author and version title. Lists metadata only, not the source of each version. Use it to see who changed an object and when; use get_transport_for_object for its current transport. Read-only. Returns a no-history message for objects without revisions.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object (e.g. /sap/bc/adt/programs/programs/ZREPORT)"),
        connectionId: z.string().optional().describe("SAP system connection ID (default connection if omitted)")
      }
    },
    handleVersionHistory
  )

  server.registerTool(
    "analyze_dump",
    {
      title: "Analyze Runtime Dump",
      description: "List ABAP runtime dumps (the short dumps shown in ST22) from the SAP system: category, short text, dump id and user. Lists them only; it does not return the dump text or stack. Use it to find a failing run after abap_run_class or run_unit_tests, then open the dump in ST22. Read-only; the optional query narrows the feed.",
      inputSchema: {
        query: z.string().optional().describe("Free-text filter passed to the ADT dump feed; omit to list the dumps ADT returns by default"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAnalyzeDump
  )

  server.registerTool(
    "check_inactive_objects",
    {
      title: "Check Inactive Objects",
      description: "List ABAP objects with an inactive version (saved but not activated): type, name and ADT URL, for the connected user's inactive worklist. Use it after write_abap_object_source to find what still needs activating, then pass the URLs to abap_activate or abap_activate_multiple. Read-only; takes no object input.",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleCheckInactiveObjects
  )
}
