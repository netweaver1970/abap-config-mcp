import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { currentSessionId, logonLabel } from "../logon"
import { ensureConnected, forceReconnect, listConnections, resolveConnectionId } from "../connections"

export async function handleConnectedSystems() {
  const conns = listConnections()
  let def: string | undefined
  try { def = resolveConnectionId() } catch { /* misconfigured default: listed without a marker */ }
  const lines = conns.map(c =>
    `- ${c.id}: ${c.url} (${logonLabel(c, currentSessionId())}, client: ${c.client ?? "default"})` +
    `${c.protocol === "soap-rfc" ? " [SOAP RFC: no ADT, read-only — tables and sources only]" : ""}` +
    `${c.id === def ? " — default when connectionId is omitted" : ""}`
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
      description: "List the SAP systems this server is configured for: connection id, URL, user and client, with the default connection marked. Call this first when more than one system is configured, and pass the id as connectionId to any other tool. SOAP RFC connections are flagged as read-only (tables and sources only, no ADT). Only reads local configuration; does not contact SAP or log in.",
      inputSchema: {}
    },
    handleConnectedSystems
  )

  server.registerTool(
    "search_abap_objects",
    {
      title: "Search ABAP Objects",
      description: "Search ABAP repository objects by name or wildcard pattern and return type, name, description and ADT URL for each hit. Use it to find the URL that get_abap_object_lines, write_abap_object_source or where_used need; use browse_package to list a package instead, search_abap_object_lines to search inside source, and search_database_tables for tables by keyword. Read-only; at most maxResults hits (default 50).",
      inputSchema: {
        query: z.string().describe("Object name or pattern; * is the wildcard (e.g. ZCL_ORDER*, *_ORDER_*)"),
        objectType: z.string().optional().describe("Restrict to one ADT object type: PROG, CLAS, FUGR, TABL, DTEL, DOMA, INTF, TRAN, etc. Default: all types"),
        maxResults: z.number().optional().describe("Max results (default 50)"),
        connectionId: z.string().optional().describe("SAP system connection ID from connected_systems (default connection if omitted)")
      }
    },
    handleSearchAbapObjects
  )

  server.registerTool(
    "get_abap_object_info",
    {
      title: "Get ABAP Object Info",
      description: "Read an ABAP object's metadata from its ADT URL: name, type, description, responsible user, language, version and URL, plus its includes for objects that have them (e.g. classes). Does not return source code; use get_abap_object_lines for that and get_transport_for_object for transport and lock state. Read-only. Find the URL with search_abap_objects.",
      inputSchema: {
        url: z.string().describe("ADT object URL, without /source/main (e.g. /sap/bc/adt/programs/programs/ZREPORT, /sap/bc/adt/oo/classes/zcl_order_api)"),
        connectionId: z.string().optional().describe("SAP system connection ID (default connection if omitted)")
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
      description: "List the ADT services the SAP system exposes, each with its collection titles or hrefs, from the ADT discovery document. Use it to check whether a feature (for example a data preview or ATC endpoint) exists on this release before relying on a tool that needs it, or when a tool fails with 404. Read-only; takes no object input and returns a plain list, which can be long.",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID (default connection if omitted)")
      }
    },
    handleAdtDiscovery
  )
}
