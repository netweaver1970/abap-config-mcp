import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { TransportRequest, TransportTask, TransportObject } from "abap-adt-api"
import { ensureConnected, getConnectionConfig, sapMessageNumber } from "../connections"
import { runSql, tableRows, col } from "./customizing"
import { listRemembered } from "./transportSelection"
import { requestTexts } from "./transportSql"
import { resolveConnectionId } from "../connections"

// Listings read the CTS tables (E070 / E07T / E071). ADT's transport listing
// filters by a search configuration and returned nothing on S4 for a user with
// two open requests, so it is not used for "what is open".

const FN_NAME: Record<string, string> = { K: "Workbench", W: "Customizing", T: "Transport of copies", C: "Relocation", S: "Task", Q: "Customizing task", R: "Repair" }
const STATUS_NAME: Record<string, string> = { D: "modifiable", L: "modifiable, protected", O: "release started", R: "released", N: "released (with import protection)" }

function day(value: string): string {
  const raw = /^(\d{4})(\d{2})(\d{2})$/.exec(value)   // DATS as SAP sends it
  if (raw) return `${raw[1]}-${raw[2]}-${raw[3]}`
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

interface RequestRow { trkorr: string; fn: string; status: string; owner: string; text: string; date: string }

async function listRequests(connectionId: string | undefined, statuses: string[], owner?: string): Promise<RequestRow[]> {
  const client = await ensureConnected(connectionId)
  const st = statuses.map(x => `'${x}'`).join(", ")
  const ownerFilter = owner ? ` AND AS4USER = '${owner.toUpperCase().replace(/'/g, "''")}'` : ""
  const rows = tableRows(await runSql(client,
    `SELECT TRKORR, TRFUNCTION, TRSTATUS, AS4USER, AS4DATE FROM E070 ` +
    `WHERE STRKORR = '' AND TRSTATUS IN (${st}) AND TRFUNCTION IN ('K', 'W', 'T', 'C')${ownerFilter} ` +
    `ORDER BY TRKORR DESCENDING`, 500))
  const texts = await requestTexts(connectionId, rows.map(r => col(r, "TRKORR")))
  return rows.map(r => ({ trkorr: col(r, "TRKORR"), fn: col(r, "TRFUNCTION"), status: col(r, "TRSTATUS"),
    owner: col(r, "AS4USER"), date: day(col(r, "AS4DATE")), text: texts.get(col(r, "TRKORR")) ?? "" }))
}

async function objectsOf(connectionId: string | undefined, trkorrs: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!trkorrs.length) return out
  const client = await ensureConnected(connectionId)
  for (let i = 0; i < trkorrs.length; i += 8) {
    const chunk = trkorrs.slice(i, i + 8).map(t => `'${t}'`).join(", ")
    const direct = tableRows(await runSql(client,
      `SELECT TRKORR, PGMID, OBJECT, OBJ_NAME FROM E071 WHERE TRKORR IN (${chunk})`, 2000))
    const viaTasks = tableRows(await runSql(client,
      `SELECT h~STRKORR, o~PGMID, o~OBJECT, o~OBJ_NAME FROM E070 AS h INNER JOIN E071 AS o ON o~TRKORR = h~TRKORR WHERE h~STRKORR IN (${chunk})`, 2000))
    for (const r of direct) out.set(col(r, "TRKORR"), [...(out.get(col(r, "TRKORR")) ?? []), `${col(r, "PGMID")} ${col(r, "OBJECT")} ${col(r, "OBJ_NAME")}`])
    for (const r of viaTasks) out.set(col(r, "STRKORR"), [...(out.get(col(r, "STRKORR")) ?? []), `${col(r, "PGMID")} ${col(r, "OBJECT")} ${col(r, "OBJ_NAME")}`])
  }
  for (const [k, v] of out) out.set(k, [...new Set(v)])
  return out
}

function workItemsFor(connectionId: string | undefined, trkorr: string): string {
  const keys = listRemembered(resolveConnectionId(connectionId)).filter(r => r.trkorr === trkorr).map(r => r.key.startsWith("work:") ? r.key.slice(5) : "a session")
  return keys.length ? `   ← transport for ${[...new Set(keys)].join(", ")}` : ""
}

export function formatRequest(r: TransportRequest): string {
  return `${r["tm:number"]} | ${r["tm:status"]} | ${r["tm:owner"].padEnd(12)} | ${r["tm:desc"]}`
}

function formatObject(o: TransportObject): string {
  return `    ${o["tm:pgmid"].padEnd(6)} ${o["tm:type"].padEnd(8)} ${o["tm:name"].padEnd(40)} ${o["tm:obj_info"] ?? ""}`.trimEnd()
}

function formatTaskBlock(task: TransportTask, indent = "  "): string {
  const header = `${indent}Task ${task["tm:number"]} | ${task["tm:owner"].padEnd(12)} | ${task["tm:desc"]}`
  if (task.objects.length === 0) return header + "\n" + indent + "  (no objects)"
  const objLines = task.objects.map(o => indent + "  " + formatObject(o).trimStart())
  return [header, ...objLines].join("\n")
}

function formatRequestDetail(r: TransportRequest): string {
  const lines: string[] = [
    `Transport: ${r["tm:number"]}`,
    `Owner:     ${r["tm:owner"]}`,
    `Status:    ${r["tm:status"]}`,
    `Description: ${r["tm:desc"]}`,
  ]

  const allObjects = [
    ...r.objects,
    ...(r.tasks ?? []).flatMap(t => t.objects),
  ]
  lines.push(`\nTotal objects: ${allObjects.length}`)

  if (r.objects.length > 0) {
    lines.push("\nDirect objects:")
    r.objects.forEach(o => lines.push(formatObject(o)))
  }

  if (r.tasks && r.tasks.length > 0) {
    lines.push(`\nTasks (${r.tasks.length}):`)
    r.tasks.forEach(t => lines.push(formatTaskBlock(t)))
  }

  return lines.join("\n")
}

export async function handleManageTransportRequests(args: {
  action: "list" | "create" | "details" | "release" | "delete" | "change_owner"
  username?: string
  newOwner?: string
  transportNumber?: string
  objectUrl?: string
  description?: string
  packageName?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)

  switch (args.action) {
    case "list": {
      const user = (args.username ?? getConnectionConfig(args.connectionId).username).toUpperCase()
      const rows = await listRequests(args.connectionId, ["D", "L"], user)
      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No open transport requests for ${user}.` }] }
      }
      const lines = rows.map(r => `  ${r.trkorr}  ${(FN_NAME[r.fn] ?? r.fn).padEnd(11)}  ${r.text}${workItemsFor(args.connectionId, r.trkorr)}`)
      return { content: [{ type: "text" as const, text: `Open requests for ${user} (${rows.length}), newest first:\n${lines.join("\n")}` }] }
    }

    case "details": {
      if (!args.transportNumber) return { content: [{ type: "text" as const, text: "transportNumber required" }] }
      const details = await client.transportDetails(args.transportNumber)
      return { content: [{ type: "text" as const, text: formatRequestDetail(details) }] }
    }

    case "create": {
      if (!args.objectUrl || !args.description || !args.packageName) {
        return { content: [{ type: "text" as const, text: "objectUrl, description, and packageName are required for create" }] }
      }
      const num = await client.createTransport(args.objectUrl, args.description, args.packageName)
      return {
        content: [{
          type: "text" as const,
          text: `✅ Transport created: ${num}\nDescription: ${args.description}\nPackage: ${args.packageName}`,
        }]
      }
    }

    case "release": {
      if (!args.transportNumber) return { content: [{ type: "text" as const, text: "transportNumber required" }] }
      const reports = await client.transportRelease(args.transportNumber)
      const success = reports.every(r => r["chkrun:status"] === "released")
      const messages = reports.flatMap(r => r.messages.map(m => `  ${m["chkrun:type"]}: ${m["chkrun:shortText"]}`))
      return {
        content: [{
          type: "text" as const,
          text: success
            ? `✅ Transport ${args.transportNumber} released.\n${messages.join("\n")}`
            : `❌ Transport release failed.\n${messages.join("\n")}`,
        }]
      }
    }

    case "delete": {
      if (!args.transportNumber) return { content: [{ type: "text" as const, text: "transportNumber required" }] }
      try {
        await client.transportDelete(args.transportNumber)
      } catch (err) {
        const msg = String((err as Error)?.message ?? err)
        // TR861: request/task contains locked objects (keyed on the number, any logon language).
        if (sapMessageNumber(err) !== "TR861" && !/contains locked objects/i.test(msg)) throw err
        return { content: [{ type: "text" as const, text:
          `❌ Deleting transport ${args.transportNumber} stopped: SAP still holds object locks on it ("${msg}").\n` +
          `An object created or changed on a request stays locked to it — also after the object itself is deleted.\n` +
          `To delete the request: in SE09/SE01 open it and run Utilities → Unlock objects (or remove the object entries), then delete it again. ` +
          `Or leave it: an open request with only deleted objects on it does no harm.` }] }
      }
      return { content: [{ type: "text" as const, text: `✅ Transport ${args.transportNumber} deleted.` }] }
    }

    case "change_owner": {
      if (!args.transportNumber || !args.newOwner) {
        return { content: [{ type: "text" as const, text: "transportNumber and newOwner are required for change_owner" }] }
      }
      const resp = await client.transportSetOwner(args.transportNumber, args.newOwner)
      return {
        content: [{
          type: "text" as const,
          text: `✅ Transport ${resp["tm:number"]} owner changed to ${resp["tm:targetuser"]}.`,
        }]
      }
    }
  }
}

export async function handleListAllTransports(args: {
  status?: "modifiable" | "released" | "all"
  owner?: string
  withObjects?: boolean
  connectionId?: string
}) {
  const status = args.status ?? "modifiable"
  const statuses = status === "modifiable" ? ["D", "L"] : status === "released" ? ["R", "N", "O"] : ["D", "L", "O", "R", "N"]
  const rows = await listRequests(args.connectionId, statuses, args.owner)
  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: `No ${status} transport requests${args.owner ? ` for ${args.owner.toUpperCase()}` : ""}.` }] }
  }
  const objects = args.withObjects === false ? new Map<string, string[]>() : await objectsOf(args.connectionId, rows.slice(0, 100).map(r => r.trkorr))
  const byOwner = new Map<string, RequestRow[]>()
  for (const r of rows) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r])
  const sections = [...byOwner.entries()].map(([owner, reqs]) =>
    `── ${owner} (${reqs.length}) ──\n` + reqs.map(r => {
      const objs = objects.get(r.trkorr)
      const objText = args.withObjects === false ? "" : objs?.length ? "\n" + objs.slice(0, 50).map(o => `      ${o}`).join("\n") + (objs.length > 50 ? `\n      … ${objs.length - 50} more` : "") : "\n      (no objects)"
      return `  ${r.trkorr}  ${(FN_NAME[r.fn] ?? r.fn).padEnd(11)}  ${STATUS_NAME[r.status] ?? r.status}  ${r.date}  ${r.text}${workItemsFor(args.connectionId, r.trkorr)}${objText}`
    }).join("\n"))
  const cut = rows.length > 100 && args.withObjects !== false ? `\n\n(Objects shown for the newest 100 requests.)` : ""
  return { content: [{ type: "text" as const, text: `${rows.length} ${status} request(s), newest first:\n\n${sections.join("\n\n")}${cut}` }] }
}

export async function handleGetTransportForObject(args: {
  url: string
  packageName?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const info = await client.transportInfo(args.url, args.packageName)
  const local = (!info.RECORDING || info.RECORDING.trim() === "") && (info.DEVCLASS ?? "").trim().startsWith("$")
  const lock = info.LOCKS?.HEADER?.TRKORR
  const allowed = (info.TRANSPORTS ?? []).map(h => `  ${h.TRKORR}  ${h.AS4TEXT ?? ""}${h.AS4USER ? `  (${h.AS4USER})` : ""}`)

  const lines = [
    `Object:     ${info.PGMID} ${info.OBJECT} ${info.OBJECTNAME}`,
    `Package:    ${info.DEVCLASS || "(none)"}${info.CTEXT ? ` — ${info.CTEXT}` : ""}`,
    `Operation:  ${info.OPERATION}`,
    `Recording:  ${local ? "none — local package, no transport needed"
      : info.RECORDING?.trim() ? "yes — changes are recorded on a Workbench request" : "not reported by ADT (treated as recorded)"}`,
    lock ? `Locked in:  ${lock}${info.LOCKS?.HEADER?.AS4USER ? ` (${info.LOCKS.HEADER.AS4USER})` : ""} — SAP records every change to this object there until it is released`
         : `Locked in:  no request yet`,
    info.EXISTING_REQ_ONLY === "X" ? `Only an existing request can be used (no new one).` : "",
    allowed.length ? `Requests the transport layer allows:\n${allowed.join("\n")}` : "",
  ].filter(Boolean)

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export function registerTransportTools(server: McpServer): void {
  server.registerTool(
    "manage_transport_requests",
    {
      title: "Manage Transport Requests",
      description:
        "Work with one transport request at a time through action: list (a user's open requests), details (header, tasks and objects of a request), create, release, delete, change_owner. " +
        "release exports the request and cannot be undone; delete fails while SAP still holds object locks on it; create and change_owner change the CTS. " +
        "Use list_all_transports to see other users' requests, get_transport_for_object for the request an object needs, and transport_move to move objects between requests. Needs CTS authorization (S_TRANSPRT).",
      inputSchema: {
        action: z.enum(["list", "create", "details", "release", "delete", "change_owner"])
          .describe("list needs no transport number; details, release, delete and change_owner need transportNumber; create needs objectUrl, description and packageName; change_owner also needs newOwner"),
        username: z.string().optional()
          .describe("list only: whose open requests to show (default: the connected user)"),
        newOwner: z.string().optional()
          .describe("change_owner only: SAP user who becomes the owner"),
        transportNumber: z.string().optional()
          .describe("Request number for details, release, delete and change_owner (e.g. DEVK900123)"),
        objectUrl: z.string().optional()
          .describe("create only: ADT URL of an object (e.g. /sap/bc/adt/programs/programs/ZREPORT) that the new request is created for"),
        description: z.string().optional()
          .describe("create only: short text of the new request"),
        packageName: z.string().optional()
          .describe("create only: package of that object (e.g. ZORDER_API)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleManageTransportRequests
  )

  server.registerTool(
    "list_all_transports",
    {
      title: "List All Transports",
      description:
        "List transport requests of all users (or one owner), grouped by owner and newest first: number, kind, status, date, description, the piece of work it is remembered for, and optionally its objects including its tasks' objects. " +
        "Reads the CTS tables E070, E07T and E071 with SQL through ADT, so it needs table read authorization (S_TABU_DIS). " +
        "Use manage_transport_requests with list for one user's open requests and details for a single request. Read-only; at most 500 requests, objects for the newest 100.",
      inputSchema: {
        status: z.enum(["modifiable", "released", "all"]).optional()
          .describe("Which transports to show: modifiable (default, open/unreleased), released, or all"),
        owner: z.string().optional().describe("Only this SAP user's requests (e.g. DEVELOPER1); default: all users"),
        withObjects: z.boolean().optional().describe("List the objects in each request (default true; newest 100 requests)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleListAllTransports
  )

  server.registerTool(
    "get_transport_for_object",
    {
      title: "Get Transport Info for Object",
      description: "Report how a change to an ABAP object is transported: its package, whether recording is needed (a local $ package needs none), the request it is already locked into, and the open requests the transport layer allows. Use it before write_abap_object_source or delete_abap_object to pick a transport; list_all_transports shows open requests generally. Read-only; takes no lock and creates no request.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object (e.g. /sap/bc/adt/programs/programs/ZREPORT)"),
        packageName: z.string().optional().describe("Package of the object (e.g. ZORDER_API); optional, passed to ADT together with the URL"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleGetTransportForObject
  )
}
