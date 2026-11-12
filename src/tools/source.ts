import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected } from "../connections"

/**
 * Read source; an object URL (no /source/...) returns ADT's metadata XML instead
 * of code, so retry on <url>/source/main when that happens.
 */
export async function readSource(client: Awaited<ReturnType<typeof ensureConnected>>, url: string): Promise<string> {
  const first = await client.getObjectSource(url)
  if (!/\/source\//.test(url) && /^\s*<\?xml/.test(String(first ?? ""))) {
    return client.getObjectSource(`${url.replace(/\/$/, "")}/source/main`)
  }
  return first
}

export async function handleGetAbapObjectLines(args: { url: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const source = await readSource(client, args.url)
  return {
    content: [{ type: "text" as const, text: source ?? `No source found at: ${args.url}` }]
  }
}

export async function handleSearchAbapObjectLines(args: {
  url: string
  pattern: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const source = await readSource(client, args.url)

  if (!source) return { content: [{ type: "text" as const, text: `No source at: ${args.url}` }] }

  const regex = new RegExp(args.pattern, "i")
  const matches = source.split("\n")
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text }) => regex.test(text))

  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: `No matches for "${args.pattern}" in ${args.url}` }] }
  }

  const result = matches.map(({ line, text }) => `${String(line).padStart(5)}: ${text}`).join("\n")
  return {
    content: [{
      type: "text" as const,
      text: `Found ${matches.length} match(es) for "${args.pattern}":\n\n${result}`
    }]
  }
}

export async function handleGetAbapBatchLines(args: { urls: string[]; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)

  const results = await Promise.allSettled(
    args.urls.map(async url => ({ url, source: await readSource(client, url) }))
  )

  const parts = results.map(r =>
    r.status === "fulfilled"
      ? `=== ${r.value.url} ===\n${r.value.source ?? "(empty)"}`
      : `=== ERROR ===\n${String((r as PromiseRejectedResult).reason)}`
  )

  return { content: [{ type: "text" as const, text: parts.join("\n\n") }] }
}

/**
 * The main URL a syntax check needs is the object itself (its URL without
 * /source/...) — verified on S4 for a function module, a function group include
 * and a class. A function group or its SAPL main program as main URL makes SAP
 * check the source in the wrong frame and report errors that are not there
 * ("FUNCTION cannot be used in the current environment", "REPORT/PROGRAM
 * statement is missing").
 */
export function syntaxMainUrl(url: string, mainUrl?: string): { mainUrl: string; note?: string } {
  const own = url.replace(/\/source\/[^/]*$/, "").replace(/\/$/, "")
  if (!mainUrl) return { mainUrl: own }
  const m = own.match(/^(\/sap\/bc\/adt\/functions\/groups\/[^/]+)\/(fmodules|includes)\/[^/]+$/)
  const given = mainUrl.replace(/\/source\/[^/]*$/, "").replace(/\/$/, "")
  if (m && (given === m[1] || given.startsWith(`${m[1]}/includes/sapl`))) {
    return { mainUrl: own, note: `(main URL ${mainUrl} replaced by the object's own URL — the group frame reports errors that are not there)` }
  }
  return { mainUrl }
}

export async function handleSyntaxCheck(args: {
  url: string
  mainUrl?: string
  source: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const main = syntaxMainUrl(args.url, args.mainUrl)
  const results = await client.syntaxCheck(args.url, main.mainUrl, args.source)
  const note = main.note ? `\n${main.note}` : ""

  if (!results || results.length === 0) {
    return { content: [{ type: "text" as const, text: `✅ No syntax errors found.${note}` }] }
  }

  const lines = results.map(r =>
    `Line ${r.line}:${r.offset ?? 0} [${r.severity}] ${r.text}`
  )
  return {
    content: [{
      type: "text" as const,
      text: `Syntax check results (${results.length} message(s)):\n${lines.join("\n")}${note}`
    }]
  }
}

export function registerSourceTools(server: McpServer): void {
  server.registerTool(
    "get_abap_object_lines",
    {
      title: "Get ABAP Object Source",
      description: "Return the full ABAP source text of one object (program, class, function module, include, ...). Give the object URL and /source/main is appended automatically if you omit it. Use search_abap_object_lines to find a pattern instead of reading everything, get_abap_batch_lines for several objects at once, and get_abap_object_info for metadata only. Read-only; returns the stored version as one string, with no line numbers.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object or its source (e.g. /sap/bc/adt/programs/programs/ZREPORT/source/main, /sap/bc/adt/oo/classes/zcl_order_api). Includes and function modules have their own URLs."),
        connectionId: z.string().optional().describe("SAP system connection ID (default connection if omitted)")
      }
    },
    handleGetAbapObjectLines
  )

  server.registerTool(
    "search_abap_object_lines",
    {
      title: "Search ABAP Object Source Lines",
      description: "Find lines in one object's source that match a case-insensitive regular expression and return them as numbered lines (line number, then text). Use it to locate a statement before editing or setting a breakpoint; use where_used for references across objects and get_abap_object_lines to read the whole source. Read-only; searches a single object per call and reads the full source first.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object or its source (e.g. /sap/bc/adt/programs/programs/ZREPORT/source/main)"),
        pattern: z.string().describe("Case-insensitive JavaScript regular expression; a plain word works as a substring (e.g. SELECT .* FROM MARA). An invalid expression fails the call."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleSearchAbapObjectLines
  )

  server.registerTool(
    "get_abap_batch_lines",
    {
      title: "Get ABAP Batch Source",
      description: "Return the source of several ABAP objects in one call, each under a header line with its URL. One failing URL is reported as an error entry and does not stop the others. Use get_abap_object_lines for a single object. Read-only; the combined text can be large, so batch only what you need.",
      inputSchema: {
        urls: z.array(z.string()).describe("ADT URLs of the objects or their sources, e.g. ['/sap/bc/adt/programs/programs/ZREPORT/source/main', '/sap/bc/adt/oo/classes/zcl_order_api']"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleGetAbapBatchLines
  )

  server.registerTool(
    "syntax_check",
    {
      title: "ABAP Syntax Check",
      description: "Run the SAP syntax check on source text you supply, in the context of an existing object, without saving or locking anything. Returns each message as line:column, severity and text, or a no-errors confirmation. Use it before write_abap_object_source; use run_atc_analysis for quality checks on the saved object. Read-only; the object must already exist.",
      inputSchema: {
        url: z.string().describe("ADT source URL of the object being checked (e.g. /sap/bc/adt/programs/programs/ZREPORT/source/main)"),
        mainUrl: z.string().optional().describe("ADT URL of the main object. Default and almost always right: the object itself (url without /source/main) — also for function modules, includes and classes."),
        source: z.string().describe("The complete ABAP source to check, as it would be saved (not a fragment)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleSyntaxCheck
  )
}
