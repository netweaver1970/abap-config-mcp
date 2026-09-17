import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, forceReconnect, listConnections, resolveConnectionId } from "../connections"

export async function handleConnectedSystems() {
  const conns = listConnections()
  const lines = conns.map(c =>
    `- ${c.id}: ${c.url} (user: ${c.username}, client: ${c.client ?? "default"})`
  )
  return {
    content: [{ type: "text" as const, text: `Available SAP systems:\n${lines.join("\n")}` }]
  }
}

export async function handleSearchAbapObjects(args: {
  query: string
  objectType?: string
  maxResults?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const results = await client.searchObject(args.query, args.objectType, args.maxResults ?? 50)

  if (!results || results.length === 0) {
    return { content: [{ type: "text" as const, text: `No objects found matching "${args.query}"` }] }
  }

  const lines = results.map(r =>
    `${r["adtcore:type"].padEnd(12)} ${r["adtcore:name"].padEnd(40)} ${r["adtcore:description"] ?? ""}\n  URL: ${r["adtcore:uri"]}`
  )

  return {
    content: [{
      type: "text" as const,
      text: `Found ${results.length} object(s) matching "${args.query}":\n\n${lines.join("\n\n")}`
    }]
  }
}

export async function handleGetAbapObjectInfo(args: {
  url: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const obj = await client.objectStructure(args.url)
  const meta = obj.metaData

  const info: string[] = [
    `Name:        ${meta["adtcore:name"] ?? "N/A"}`,
    `Type:        ${meta["adtcore:type"] ?? "N/A"}`,
    `Description: ${meta["adtcore:description"] ?? "N/A"}`,
    `Responsible: ${meta["adtcore:responsible"] ?? "N/A"}`,
    `Language:    ${meta["adtcore:language"] ?? "N/A"}`,
    `Version:     ${meta["adtcore:version"] ?? "N/A"}`,
    `URL:         ${obj.objectUrl}`,
  ]

  if ("includes" in obj && Array.isArray(obj.includes)) {
    info.push(`\nIncludes (${obj.includes.length}):`)
    for (const inc of obj.includes) {
      info.push(`  - ${inc["adtcore:name"] ?? inc["class:includeType"] ?? "?"} (${inc["adtcore:type"] ?? "?"})`)
    }
  }

  return { content: [{ type: "text" as const, text: info.join("\n") }] }
}

export async function handleAdtDiscovery(args: { connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const features = await client.adtDiscovery()

  const lines = features.map(f => {
    const collections = f.collection.map(c => c.title ?? c.href).filter(Boolean)
    return `• ${f.title}${collections.length ? `\n    ${collections.join("\n    ")}` : ""}`
  })
  return {
    content: [{ type: "text" as const, text: `ADT services (${features.length}):\n${lines.join("\n")}` }]
  }
}

export async function handleForceRelogin(args: { connectionId?: string }) {
  const id = resolveConnectionId(args.connectionId)
  await forceReconnect(args.connectionId)
  return {
    content: [{ type: "text" as const, text: `Re-login complete for ${id} — fresh ADT session established.` }]
  }
}

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "connected_systems",
    {
      title: "Connected Systems",
      description: "List all configured SAP ABAP systems available for connection",
      inputSchema: {}
    },
    handleConnectedSystems
  )

  server.registerTool(
    "search_abap_objects",
    {
      title: "Search ABAP Objects",
      description: "Search for ABAP development objects (programs, classes, function modules, tables, etc.) by name or pattern",
      inputSchema: {
        query: z.string().describe("Search query - name or wildcard pattern (e.g. Z_MY_PROG*, *_ORDER*)"),
        objectType: z.string().optional().describe("ABAP object type filter: PROG, CLAS, FUGR, TABL, DTEL, DOMA, INTF, TRAN, etc."),
        maxResults: z.number().optional().describe("Max results (default 50)"),
        connectionId: z.string().optional().describe("SAP system connection ID (uses first if omitted)")
      }
    },
    handleSearchAbapObjects
  )

  server.registerTool(
    "get_abap_object_info",
    {
      title: "Get ABAP Object Info",
      description: "Get detailed information about an ABAP object: type, package, responsible, includes, and structure",
      inputSchema: {
        url: z.string().describe("ADT URL of the object (e.g. /sap/bc/adt/programs/programs/Z_MY_PROG)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleGetAbapObjectInfo
  )

  server.registerTool(
    "force_relogin",
    {
      title: "Force Re-login",
      description:
        "Drop this conversation's SAP ADT session and log in again. Use when ADT calls keep failing with " +
        "HTTP 400 (degraded stateful session) and the automatic retry has not recovered it. Releases this " +
        "conversation's locks only — every conversation has its own SAP session.",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID (uses first if omitted)")
      }
    },
    handleForceRelogin
  )

  server.registerTool(
    "adt_discovery",
    {
      title: "ADT Discovery",
      description: "Discover available ADT features and services on the connected SAP system",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAdtDiscovery
  )
}
