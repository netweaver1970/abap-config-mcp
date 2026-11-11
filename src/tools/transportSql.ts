/**
 * Transport facts read straight from the CTS tables (E070 / E07T).
 *
 * ADT's transport listing (/sap/bc/adt/cts/transportrequests) filters by a
 * search configuration and, on S4 (2026-09-17), returned nothing at all for a
 * user with two open requests. The tables are the authority.
 */

import { ensureConnected } from "../connections"
import { runSql, tableRows, col } from "./customizing"
import type { CtsFunction, RequestInfo, TransportCandidate } from "./transportSelection"

const q = (s: string) => s.toUpperCase().replace(/'/g, "''")

/** A request or task; a task resolves to its request. Undefined when it does not exist. */
export async function lookupRequest(connectionId: string | undefined, trkorr: string): Promise<RequestInfo | undefined> {
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
