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

export async function handleSyntaxCheck(args: {
  url: string
  mainUrl: string
  source: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const results = await client.syntaxCheck(args.url, args.mainUrl, args.source)

  if (!results || results.length === 0) {
    return { content: [{ type: "text" as const, text: "✅ No syntax errors found." }] }
  }

  const lines = results.map(r =>
    `Line ${r.line}:${r.offset ?? 0} [${r.severity}] ${r.text}`
  )
  return {
    content: [{
      type: "text" as const,
      text: `Syntax check results (${results.length} message(s)):\n${lines.join("\n")}`
    }]
  }
}

export function registerSourceTools(server: McpServer): void {
  server.registerTool(
    "get_abap_object_lines",
    {
      title: "Get ABAP Object Source",
      description: "Read the full source code of an ABAP object (program, class, function module, include, etc.)",
      inputSchema: {
        url: z.string().describe("ADT source URL (e.g. /sap/bc/adt/programs/programs/Z_MY_PROG/source/main)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleGetAbapObjectLines
  )

  server.registerTool(
    "search_abap_object_lines",
    {
      title: "Search ABAP Object Source Lines",
      description: "Search for a pattern within the source of an ABAP object, returning matching lines with line numbers",
      inputSchema: {
        url: z.string().describe("ADT source URL of the object"),
        pattern: z.string().describe("Search pattern (case-insensitive substring or regex)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleSearchAbapObjectLines
  )

  server.registerTool(
    "get_abap_batch_lines",
    {
      title: "Get ABAP Batch Source",
      description: "Read source code of multiple ABAP objects at once",
      inputSchema: {
        urls: z.array(z.string()).describe("Array of ADT source URLs to fetch"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleGetAbapBatchLines
  )

  server.registerTool(
    "syntax_check",
    {
      title: "ABAP Syntax Check",
      description: "Check syntax of ABAP source code against the server without saving",
      inputSchema: {
        url: z.string().describe("ADT source URL of the object"),
        mainUrl: z.string().describe("ADT URL of the main object (same as url for standalone programs)"),
        source: z.string().describe("ABAP source code to check"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleSyntaxCheck
  )
}
