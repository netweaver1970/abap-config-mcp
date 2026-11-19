/**
 * Transport facts read straight from the CTS tables (E070 / E07T).
 *
 * ADT's transport listing (/sap/bc/adt/cts/transportrequests) filters by a
 * search configuration and, on S4 (2026-09-17), returned nothing at all for a
 * user with two open requests. The tables are the authority.
 *
 * Direct mode reads them with SQL through ADT; governed mode asks the engine's
 * transports and transport_info actions, which read the same tables inside SAP
 * behind an S_TRANSPRT display check (docs/specs/001-two-constellations.md).
 */

import { ensureConnected } from "../connections"
import { isGoverned, GOVERNED_ENGINE_NOTE } from "../mode"
import { runSql, tableRows, col } from "./customizing"
import { callEngine, type EngineRequest } from "./customizingEngine"
import { ENGINE_VERSION } from "../abap/zcl_mcp_cust_engine"
import type { CtsFunction, RequestInfo, TransportCandidate } from "./transportSelection"

// ─── governed: the engine's transports / transport_info actions ──────────────

/** One request as the engine's transports action returns it (keys uppercase). */
export interface EngineTransport {
  TRKORR: string
  TRFUNCTION: string
  TRSTATUS: string
  AS4USER: string
  AS4DATE?: string
  TARSYSTEM?: string
  CLIENT?: string
  TEXT?: string
  TASKS?: { TRKORR: string; AS4USER: string; TRFUNCTION: string; TRSTATUS: string }[]
  OBJECTS?: { PGMID: string; OBJECT: string; OBJ_NAME: string }[]
  OBJECTS_MORE?: boolean | string
}

/** The engine's transport_info result. */
export interface EngineTransportInfo {
  PGMID: string
  OBJ_TYPE: string
  OBJ_NAME: string
  EXISTS?: boolean | string
  DEVCLASS?: string
  CTEXT?: string
  TRANSPORT_LAYER?: string
  TARGET?: string
  RECORDS?: boolean | string
  LOCK_REQUEST?: string
  LOCK_TASK?: string
  LOCK_USER?: string
  REQUESTS?: EngineTransport[]
}

const t = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim())
export const isFlag = (v: unknown) => v === true || t(v) === "X" || t(v) === "true"

async function engineCall(connectionId: string | undefined, req: EngineRequest, what: string): Promise<{ data: string; messages: string[] }> {
  const r = await callEngine(connectionId, req)
  if (r.STATUS === "ok") return { data: r.DATA_JSON || "", messages: r.MESSAGES ?? [] }
  const msgs = (r.MESSAGES ?? []).join(" ")
  if (/Unknown operation/i.test(msgs)) {
    throw new Error(`${what} stopped: the engine on this system (v${r.VERSION ?? "?"}) has no ${req.operation} action, ` +
      `which this server needs (engine v${ENGINE_VERSION}). Update the engine: ${GOVERNED_ENGINE_NOTE}. Then run customizing_engine_ping.`)
  }
  throw new Error(msgs || `${what} stopped: the engine answered ${r.STATUS ?? "without a status"}.`)
}

export interface EngineTransportQuery {
  transport?: string          // look up one request (a task gives its request)
  fn?: string                 // kinds, e.g. "W" or "KWTC"
  statuses?: string           // e.g. "D", "DL", "RNO"
  owner?: string
  ownerTasks?: boolean        // also requests in which owner has a task
  client?: string
  withObjects?: boolean
}

/** The engine's transports action. */
export async function engineTransports(connectionId: string | undefined, query: EngineTransportQuery): Promise<{ requests: EngineTransport[]; messages: string[] }> {
  const { data, messages } = await engineCall(connectionId, {
    operation: "transports",
    transport: query.transport,
    trfunction: query.fn,
    statuses: query.statuses,
    owner: query.owner?.toUpperCase(),
    owner_tasks: query.ownerTasks ? "X" : "",
    client: query.client,
    with_objects: query.withObjects ? "X" : "",
  }, query.transport ? `Looking up ${query.transport.toUpperCase()}` : "Listing transport requests")
  return { requests: JSON.parse(data || "[]") as EngineTransport[], messages }
}

/** The engine's transport_info action for one repository object (R3TR type name). */
export async function engineTransportInfo(connectionId: string | undefined, objType: string, objName: string): Promise<EngineTransportInfo> {
  const { data } = await engineCall(connectionId, {
    operation: "transport_info", pgmid: "R3TR", obj_type: objType.toUpperCase(), obj_name: objName.toUpperCase(),
  }, `Reading the transport information of R3TR ${objType.toUpperCase()} ${objName.toUpperCase()}`)
  return JSON.parse(data || "{}") as EngineTransportInfo
}

// ─── the facts the tools use ─────────────────────────────────────────────────

const q = (s: string) => s.toUpperCase().replace(/'/g, "''")

/** A request or task; a task resolves to its request. Undefined when it does not exist. */
export async function lookupRequest(connectionId: string | undefined, trkorr: string): Promise<RequestInfo | undefined> {
  if (isGoverned()) {
    const r = (await engineTransports(connectionId, { transport: trkorr })).requests[0]
    return r ? { trkorr: t(r.TRKORR), fn: t(r.TRFUNCTION), status: t(r.TRSTATUS), owner: t(r.AS4USER), text: t(r.TEXT) } : undefined
  }
  const client = await ensureConnected(connectionId)
  const rows = tableRows(await runSql(client,
    `SELECT TRKORR, TRFUNCTION, TRSTATUS, AS4USER, STRKORR FROM E070 WHERE TRKORR = '${q(trkorr)}'`, 1))
  if (!rows.length) return undefined
  const r = rows[0]
  const parent = col(r, "STRKORR")
  if (parent) return lookupRequest(connectionId, parent)
  const text = tableRows(await runSql(client,
    `SELECT AS4TEXT FROM E07T WHERE TRKORR = '${q(trkorr)}'`, 1))[0]
  return {
    trkorr: col(r, "TRKORR"),
    fn: col(r, "TRFUNCTION"),
    status: col(r, "TRSTATUS"),
    owner: col(r, "AS4USER"),
    text: text ? col(text, "AS4TEXT") : "",
  }
}

/** Texts of requests, in the logon language when there, else any. (ADT.s SQL has no LEFT OUTER JOIN, and a statement longer than 255 characters on one line fails, hence small chunks.) */
export async function requestTexts(connectionId: string | undefined, trkorrs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!trkorrs.length) return out
  const client = await ensureConnected(connectionId)
  for (let i = 0; i < trkorrs.length; i += 8) {
    const chunk = trkorrs.slice(i, i + 8).map(t => `'${q(t)}'`).join(", ")
    const rows = tableRows(await runSql(client, `SELECT TRKORR, LANGU, AS4TEXT FROM E07T WHERE TRKORR IN (${chunk})`, 500))
    for (const r of rows) {
      const k = col(r, "TRKORR")
      if (!out.has(k) || col(r, "LANGU") === "E") out.set(k, col(r, "AS4TEXT"))
    }
  }
  return out
}

/**
 * Open (modifiable) requests of one kind, newest first.
 * - owner: that user's requests, plus requests where that user owns a task (a
 *   lead's request the user works in). Omit for everyone's.
 * - client: only requests created in that client (E070C-CLIENT) — a request from
 *   another client cannot record this client's changes. Omit for all clients.
 */
export async function listOpenRequests(connectionId: string | undefined, fn: CtsFunction, owner?: string, client?: string): Promise<TransportCandidate[]> {
  if (isGoverned()) {
    const { requests } = await engineTransports(connectionId, { fn, statuses: "D", owner, ownerTasks: !!owner, client })
    return requests.map(r => ({ trkorr: t(r.TRKORR), owner: t(r.AS4USER), text: t(r.TEXT) }))
  }
  const adt = await ensureConnected(connectionId)
  const ownerFilter = owner ? ` AND AS4USER = '${q(owner)}'` : ""
  const rows = tableRows(await runSql(adt,
    `SELECT TRKORR, AS4USER FROM E070 WHERE STRKORR = '' AND TRSTATUS = 'D' AND TRFUNCTION = '${fn}'${ownerFilter} ` +
    `ORDER BY TRKORR DESCENDING`, 200))
  const found = new Map(rows.map(r => [col(r, "TRKORR"), col(r, "AS4USER")]))

  if (owner) {
    const viaTask = tableRows(await runSql(adt,
      `SELECT STRKORR FROM E070 WHERE AS4USER = '${q(owner)}' AND STRKORR <> '' AND TRSTATUS = 'D'`, 200))
    const parents = [...new Set(viaTask.map(r => col(r, "STRKORR")))].filter(t => !found.has(t))
    for (let i = 0; i < parents.length; i += 8) {
      const chunk = parents.slice(i, i + 8).map(t => `'${q(t)}'`).join(", ")
      for (const r of tableRows(await runSql(adt,
        `SELECT TRKORR, AS4USER FROM E070 WHERE TRKORR IN (${chunk}) AND TRSTATUS = 'D' AND TRFUNCTION = '${fn}'`, 50))) {
        found.set(col(r, "TRKORR"), col(r, "AS4USER"))
      }
    }
  }

  let trkorrs = [...found.keys()].sort().reverse()
  if (client && trkorrs.length) {
    const other = new Set<string>()
    for (let i = 0; i < trkorrs.length; i += 8) {
      const chunk = trkorrs.slice(i, i + 8).map(t => `'${q(t)}'`).join(", ")
      for (const r of tableRows(await runSql(adt, `SELECT TRKORR, CLIENT FROM E070C WHERE TRKORR IN (${chunk})`, 50))) {
        const c = col(r, "CLIENT")
        if (c && c !== client) other.add(col(r, "TRKORR"))
      }
    }
    trkorrs = trkorrs.filter(t => !other.has(t))
  }

  const texts = await requestTexts(connectionId, trkorrs)
  return trkorrs.map(t => ({ trkorr: t, owner: found.get(t), text: texts.get(t) ?? "" }))
}
