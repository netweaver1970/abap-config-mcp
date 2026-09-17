/**
 * Transport selection — one predictable rule for every write that records onto a
 * transport, workbench (CTS function 'K') and customizing ('W') alike.
 *
 *   1. A transport the caller names is used — after checking it exists, is still
 *      modifiable and is of the right kind. It becomes the transport of that piece
 *      of work.
 *   2. If SAP already ties the object to a request (it is locked into one), that
 *      request is used: SAP would refuse any other.
 *   3. A new request is created only when the caller explicitly asks for one.
 *   4. If this piece of work already has a transport and it is still open, it is
 *      used again, and the result says so. Naming another transport (rule 1)
 *      replaces it.
 *   5. Otherwise existing requests are preferred: exactly one open request → used;
 *      several → the caller is asked which; none → the caller is asked, with the
 *      option to create one.
 *
 * "A piece of work" is the caller's `workItem` (any short name — "HPM", a ticket
 * number). Without one it is the MCP session, so separate conversations never
 * share a transport by accident. The memory is kept per SAP connection in
 * ~/.abap-mcp/transport-memory.json, so it survives server restarts.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { log } from "../connections"

export type CtsFunction = "K" | "W"

export interface TransportCandidate {
  trkorr: string
  text: string
  owner?: string
}

export interface RequestInfo {
  trkorr: string       // the request (a task is resolved to its request)
  fn: string           // E070-TRFUNCTION of the request
  status: string       // E070-TRSTATUS: D modifiable, L locked, R/N released
  owner: string
  text: string
}

export interface SelectionInput {
  connectionId: string
  fn: CtsFunction
  /** Human label for the change, used in questions. */
  what: string
  supplied?: string
  workItem?: string
  sessionId?: string
  /** A request SAP already ties the object to (workbench lock). */
  forced?: string
  /** Open requests the change may record onto (already filtered to the right kind). */
  candidates: TransportCandidate[]
  /** Look up one request or task. Undefined when it does not exist. */
  lookup: (trkorr: string) => Promise<RequestInfo | undefined>
  /** Only when the caller asked for a new request. */
  create?: () => Promise<string>
}

export type Selection =
  | { kind: "use"; trkorr: string; note: string }
  | { kind: "ask"; text: string }

const FN_LABEL: Record<CtsFunction, string> = { K: "Workbench", W: "Customizing" }

// ─── memory ──────────────────────────────────────────────────────────────────

interface MemoryEntry { trkorr: string; at: string }
type Memory = Record<string, Record<string, Partial<Record<CtsFunction, MemoryEntry>>>>

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export function memoryPath(): string {
  return process.env.ABAP_MCP_TRANSPORT_MEMORY ?? path.join(os.homedir(), ".abap-mcp", "transport-memory.json")
}

function loadMemory(): Memory {
  try {
    return JSON.parse(fs.readFileSync(memoryPath(), "utf8")) as Memory
  } catch {
    return {}
  }
}

function saveMemory(mem: Memory): void {
  try {
    fs.mkdirSync(path.dirname(memoryPath()), { recursive: true })
    fs.writeFileSync(memoryPath(), JSON.stringify(mem, null, 2))
  } catch (err) {
    log("WARN", "Could not save transport memory — selection still works, it just will not be remembered", err)
  }
}

export function workKey(workItem?: string, sessionId?: string): string {
  if (workItem && workItem.trim()) return `work:${workItem.trim().toUpperCase()}`
  return sessionId ? `session:${sessionId}` : "session:default"
}

export function recallTransport(connectionId: string, fn: CtsFunction, key: string): string | undefined {
  return loadMemory()[connectionId]?.[key]?.[fn]?.trkorr
}

export function rememberTransport(connectionId: string, fn: CtsFunction, key: string, trkorr: string): void {
  if (!trkorr) return
  const mem = loadMemory()
  const now = Date.now()
  // Prune stale entries so the file does not grow with every session.
  for (const conn of Object.values(mem)) {
    for (const [k, byFn] of Object.entries(conn)) {
      for (const f of Object.keys(byFn) as CtsFunction[]) {
        if (now - Date.parse(byFn[f]!.at) > MAX_AGE_MS) delete byFn[f]
      }
      if (Object.keys(byFn).length === 0) delete conn[k]
    }
  }
  mem[connectionId] ??= {}
  mem[connectionId][key] ??= {}
  mem[connectionId][key][fn] = { trkorr, at: new Date(now).toISOString() }
  saveMemory(mem)
}

/** Every piece of work that currently has a transport on this connection. */
export function listRemembered(connectionId: string): Array<{ key: string; fn: CtsFunction; trkorr: string; at: string }> {
  const conn = loadMemory()[connectionId] ?? {}
  return Object.entries(conn).flatMap(([key, byFn]) =>
    (Object.entries(byFn) as Array<[CtsFunction, MemoryEntry]>).map(([fn, e]) => ({ key, fn, trkorr: e.trkorr, at: e.at })))
}

// ─── the rule ────────────────────────────────────────────────────────────────

function label(key: string): string {
  return key.startsWith("work:") ? `work item ${key.slice(5)}` : "this session"
}

function list(candidates: TransportCandidate[], mark?: string): string {
  return candidates
    .map(c => `   • ${c.trkorr}  ${c.text}${c.owner ? `  (${c.owner})` : ""}${c.trkorr === mark ? "   ← last used for this work" : ""}`)
    .join("\n")
}

export async function selectTransport(i: SelectionInput): Promise<Selection> {
  const key = workKey(i.workItem, i.sessionId)
  const kind = FN_LABEL[i.fn]
  const pin = i.workItem ? "" : `\n   (Pass workItem: "<name>" to keep one transport for a piece of work across sessions.)`

  // 1. Named by the caller.
  if (i.supplied) {
    const info = await i.lookup(i.supplied.toUpperCase())
    if (!info) {
      return { kind: "ask", text: `❌ Transport ${i.supplied} does not exist. Nothing was written.\n\n` + chooseText(i, key) }
    }
    if (info.status !== "D") {
      return { kind: "ask", text: `❌ Transport ${info.trkorr} is not modifiable (status ${info.status} — released or locked). Nothing was written.\n\n` + chooseText(i, key) }
    }
    if (info.fn !== i.fn) {
      return { kind: "ask", text:
        `❌ Transport ${info.trkorr} is a ${info.fn === "K" ? "Workbench" : info.fn === "W" ? "Customizing" : `type ${info.fn}`} request; ` +
        `${i.what} needs a ${kind} request. Nothing was written.\n\n` + chooseText(i, key) }
    }
    const previous = recallTransport(i.connectionId, i.fn, key)
    rememberTransport(i.connectionId, i.fn, key, info.trkorr)
    const switched = previous && previous !== info.trkorr ? ` (was ${previous} for ${label(key)})` : ""
    return { kind: "use", trkorr: info.trkorr, note: `Transport ${info.trkorr} — as given${switched}, now the transport for ${label(key)}.` }
  }

  // 2. SAP already ties the object to a request.
  if (i.forced) {
    rememberTransport(i.connectionId, i.fn, key, i.forced)
    return { kind: "use", trkorr: i.forced, note: `Transport ${i.forced} — the object is already locked into it.` }
  }

  // 3. A new request, when the caller explicitly asked for one.
  if (i.create) {
    const num = await i.create()
    rememberTransport(i.connectionId, i.fn, key, num)
    return { kind: "use", trkorr: num, note: `Transport ${num} — created as asked, now the transport for ${label(key)}.` }
  }

  // 4. The transport this piece of work already uses.
  const remembered = recallTransport(i.connectionId, i.fn, key)
  if (remembered) {
    const info = await i.lookup(remembered)
    if (info && info.status === "D" && info.fn === i.fn) {
      return { kind: "use", trkorr: remembered,
        note: `Transport ${remembered} — the one already used for ${label(key)}. Pass transport: to use another.${pin}` }
    }
  }

  // 5. Prefer existing requests.
  if (i.candidates.length === 1) {
    const only = i.candidates[0]
    rememberTransport(i.connectionId, i.fn, key, only.trkorr)
    return { kind: "use", trkorr: only.trkorr,
      note: `Transport ${only.trkorr} — the only open ${kind} request${only.text ? ` (${only.text})` : ""}, now the transport for ${label(key)}.${pin}` }
  }

  return { kind: "ask", text: chooseText(i, key, remembered) }
}

function chooseText(i: SelectionInput, key: string, remembered?: string): string {
  const kind = FN_LABEL[i.fn]
  const lines: string[] = []
  if (i.candidates.length > 1) {
    lines.push(`🚦 Which transport should ${i.what} go on? ${i.candidates.length} open ${kind} requests:`, "", list(i.candidates, remembered), "")
    lines.push(`Re-run with transport: "<number>"${i.workItem ? "" : ` — and workItem: "<name>" to use it for the rest of this piece of work`}.`)
  } else if (i.candidates.length === 1) {
    lines.push(`Open ${kind} request:`, "", list(i.candidates, remembered), "", `Re-run with transport: "${i.candidates[0].trkorr}", or name another.`)
  } else {
    lines.push(`🚦 There is no open ${kind} request for ${i.what}.`, "",
      `Re-run with createTransport: true to create one, or create it in SE09 / SolMan / Cloud ALM and re-run with transport: "<number>".`)
  }
  if (remembered) lines.push("", `(${remembered} was used for ${label(key)} but is no longer open.)`)
  return lines.join("\n")
}
