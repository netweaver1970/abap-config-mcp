/**
 * transport_move — move object entries from one request/task to another, or
 * reassign a whole task to another request, with the checks a careful Basis
 * colleague would make first.
 *
 * Planning happens here, from the CTS tables (E070/E071/E070C) and the
 * where-used index (WBCROSSGT/CROSS): which entries move, which parts of an
 * object belong with it, whether source and target fit together, and what the
 * moved objects use or are used by on other open requests — which decides the
 * order the requests can be released in. Only the move itself runs in SAP,
 * through the engine, with SAP's own APIs: TR_MOVE_OBJECTS (with its test mode
 * on a dry run) and TR_REASSIGN_TASK.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, getConnectionConfig, log } from "../connections"
import { runSql, tableRows, col } from "./customizing"
import { callEngine, ensureEngineClass } from "./customizingEngine"
import { ENGINE_VERSION } from "../abap/zcl_mcp_cust_engine"

type Client = Awaited<ReturnType<typeof ensureConnected>>

export interface TrReq {
  trkorr: string
  fn: string        // E070-TRFUNCTION
  status: string    // E070-TRSTATUS
  parent: string    // E070-STRKORR ('' for a request)
  owner: string
  tarsystem: string
  client: string    // E070C-CLIENT (source client), '' when none recorded
  text: string
}

export interface Entry {
  trkorr: string
  pgmid: string
  object: string
  objName: string
  lockflag?: string
}

export interface Finding { level: "stop" | "warn" | "note"; text: string }

// ─── pure helpers (unit-tested) ─────────────────────────────────────────────

const OPEN = new Set(["D", "L"])

/** Which requests can hold the same objects: a task belongs to its request's family. */
export function family(fn: string): string {
  if (["K", "S", "R", "X"].includes(fn)) return "workbench"
  if (["W", "Q"].includes(fn)) return "customizing"
  return `type ${fn}`
}

const TASK_FOR: Record<string, string> = { workbench: "S", customizing: "Q" }

export interface Spec { pgmid?: string; object?: string; pattern: RegExp; raw: string }

/** "R3TR CLAS ZCL_X", "CLAS ZCL_X", "ZCL_X" or a wildcard "ZCL_FOO*". */
export function parseSpec(raw: string): Spec {
  const parts = raw.trim().toUpperCase().split(/\s+/)
  const name = parts[parts.length - 1]
  const esc = name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  const pattern = new RegExp(`^${esc}$`)
  if (parts.length >= 3) return { pgmid: parts[0], object: parts[1], pattern, raw }
  if (parts.length === 2) return { object: parts[0], pattern, raw }
  return { pattern, raw }
}

export function matchesSpec(e: Entry, s: Spec): boolean {
  if (s.pgmid && e.pgmid !== s.pgmid) return false
  if (s.object && e.object !== s.object) return false
  return s.pattern.test(e.objName.trimEnd())
}

const key = (e: Pick<Entry, "pgmid" | "object" | "objName">) => `${e.pgmid} ${e.object} ${e.objName.trimEnd()}`

/** Is `objName` one of `name`'s own entries: the name itself, or the name followed by padding (blanks or '='). */
export function belongsTo(objName: string, name: string): boolean {
  if (!objName.startsWith(name)) return false
  const next = objName[name.length]
  return next === undefined || next === " " || next === "="
}

/**
 * The LIMU entries that are parts of a named R3TR object (a class's methods and
 * sections, a program's source, a function group's modules and includes).
 * `groupFunctions` are the function modules of a function group (TFDIR).
 */
export function partsOf(parent: Entry, entries: Entry[], groupFunctions: Set<string> = new Set()): Entry[] {
  if (parent.pgmid !== "R3TR") return []
  const name = parent.objName.trimEnd()
  return entries.filter(e => {
    if (e.pgmid !== "LIMU") return false
    const n = e.objName.trimEnd()
    if (parent.object === "FUGR") {
      return (e.object === "FUNC" && groupFunctions.has(n)) ||
        (e.object === "REPS" && (n === `SAPL${name}` || belongsToGroup(n, name)))
    }
    return belongsTo(e.objName, name)
  })
}

/** An include of function group `fg`: "L" + group + three characters (LZFGU01, LZFGTOP). */
function belongsToGroup(include: string, fg: string): boolean {
  return include.startsWith(`L${fg}`) && include.length === fg.length + 4
}

/** The repository object an include belongs to. */
export function mainOfInclude(include: string): { object: string; name: string } {
  const inc = include.trimEnd()
  // Class and interface includes: the name padded with '=' to 30 characters, then CP, CU, CM001, IU, …
  if (inc.length > 30 && /^(CP|CU|CI|CO|CM|CC|CT|CS|IU|IP)/.test(inc.slice(30))) {
    return { object: /^(IU|IP)/.test(inc.slice(30)) ? "INTF" : "CLAS", name: inc.slice(0, 30).replace(/=+$/, "") }
  }
  if (inc.startsWith("SAPL")) return { object: "FUGR", name: inc.slice(4) }
  if (/^L[ZY/]/.test(inc) && inc.length > 4) return { object: "FUGR", name: inc.slice(1, -3) }
  return { object: "PROG", name: inc }
}

/** Customer names only: Z*, Y*, or a namespace /…/. */
export function isCustomerName(name: string): boolean {
  return /^[ZY]/.test(name) || /^\/[^/]+\//.test(name)
}

export interface DepHit { name: string; request: string; task: string; owner: string; staysOnSource: boolean }

export interface DepReport {
  outgoing: Array<{ moved: string; uses: DepHit }>   // moved object uses an object on another open request
  incoming: Array<{ moved: string; usedBy: DepHit }> // an object on another open request uses a moved object
  skipped?: string
}

/**
 * Release order from the dependencies: what must reach the next system before
 * the target, and what must wait for it.
 */
export function releaseAdvice(deps: DepReport, target: string, source: string): string[] {
  const before = new Map<string, Set<string>>()
  const after = new Map<string, Set<string>>()
  for (const d of deps.outgoing) {
    const r = d.uses.request
    if (!before.has(r)) before.set(r, new Set())
    before.get(r)!.add(`${d.moved} uses ${d.uses.name}`)
  }
  for (const d of deps.incoming) {
    const r = d.usedBy.request
    if (!after.has(r)) after.set(r, new Set())
    after.get(r)!.add(`${d.usedBy.name} uses ${d.moved}`)
  }
  const out: string[] = []
  for (const [r, why] of before) {
    out.push(`Release ${r}${r === source ? " (the source)" : ""} before or together with ${target}: ${[...why].join("; ")}.`)
  }
  for (const [r, why] of after) {
    out.push(`Release ${target} before or together with ${r}${r === source ? " (the source)" : ""}: ${[...why].join("; ")}.`)
  }
  return out
}

// ─── SQL helpers ─────────────────────────────────────────────────────────────

const q = (s: string) => s.replace(/'/g, "''")

/** IN-lists split so each statement stays well under ADT's 255-character line limit. */
export function chunkIn(values: string[], fixedLength: number, limit = 240): string[][] {
  const chunks: string[][] = []
  let cur: string[] = []
  let len = fixedLength
  for (const v of values) {
    const add = v.length + 4
    if (cur.length && len + add > limit) { chunks.push(cur); cur = []; len = fixedLength }
    cur.push(v); len += add
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

async function sqlIn(c: Client, head: string, column: string, values: string[], tail = "", maxRows = 500) {
  const rows: Array<Record<string, string>> = []
  const fixed = head.length + column.length + tail.length + 12
  for (const chunk of chunkIn([...new Set(values)], fixed)) {
    const list = chunk.map(v => `'${q(v)}'`).join(", ")
    rows.push(...tableRows(await runSql(c, `${head} ${column} IN (${list})${tail}`, maxRows)))
  }
  return rows
}

async function readRequests(c: Client, trkorrs: string[]): Promise<Map<string, TrReq>> {
  const out = new Map<string, TrReq>()
  const ids = [...new Set(trkorrs.map(t => t.toUpperCase()))]
  if (!ids.length) return out
  for (const r of await sqlIn(c, "SELECT TRKORR, TRFUNCTION, TRSTATUS, STRKORR, AS4USER, TARSYSTEM FROM E070 WHERE", "TRKORR", ids)) {
    out.set(col(r, "TRKORR"), { trkorr: col(r, "TRKORR"), fn: col(r, "TRFUNCTION"), status: col(r, "TRSTATUS"),
      parent: col(r, "STRKORR"), owner: col(r, "AS4USER"), tarsystem: col(r, "TARSYSTEM"), client: "", text: "" })
  }
  for (const r of await sqlIn(c, "SELECT TRKORR, CLIENT FROM E070C WHERE", "TRKORR", [...out.keys()])) {
    const req = out.get(col(r, "TRKORR")); if (req) req.client = col(r, "CLIENT")
  }
  for (const r of await sqlIn(c, "SELECT TRKORR, AS4TEXT FROM E07T WHERE", "TRKORR", [...out.keys()])) {
    const req = out.get(col(r, "TRKORR")); if (req && !req.text) req.text = col(r, "AS4TEXT")
  }
  return out
}

async function tasksOf(c: Client, request: string): Promise<TrReq[]> {
  const ids = tableRows(await runSql(c, `SELECT TRKORR FROM E070 WHERE STRKORR = '${q(request)}'`, 200)).map(r => col(r, "TRKORR"))
  return [...(await readRequests(c, ids)).values()]
}

async function entriesOf(c: Client, trkorrs: string[]): Promise<Entry[]> {
  return (await sqlIn(c, "SELECT TRKORR, PGMID, OBJECT, OBJ_NAME, LOCKFLAG FROM E071 WHERE", "TRKORR", trkorrs, "", 5000))
    .map(r => ({ trkorr: col(r, "TRKORR"), pgmid: col(r, "PGMID"), object: col(r, "OBJECT"),
      objName: col(r, "OBJ_NAME"), lockflag: col(r, "LOCKFLAG") }))
}

async function functionsOfGroup(c: Client, fg: string): Promise<Set<string>> {
  return new Set(tableRows(await runSql(c, `SELECT FUNCNAME FROM TFDIR WHERE PNAME = 'SAPL${q(fg)}'`, 500)).map(r => col(r, "FUNCNAME")))
}

/** Open requests (status D/L) holding R3TR entries of these names, resolved to their request. */
async function openHolders(c: Client, names: string[]): Promise<Map<string, Array<{ request: string; task: string; owner: string }>>> {
  const out = new Map<string, Array<{ request: string; task: string; owner: string }>>()
  if (!names.length) return out
  const rows = await sqlIn(c, "SELECT TRKORR, OBJ_NAME FROM E071 WHERE PGMID = 'R3TR' AND", "OBJ_NAME", names)
  const reqs = await readRequests(c, rows.map(r => col(r, "TRKORR")))
  const parents = await readRequests(c, [...reqs.values()].map(r => r.parent).filter(Boolean))
  for (const r of rows) {
    const t = reqs.get(col(r, "TRKORR"))
    if (!t || !OPEN.has(t.status)) continue
    const request = t.parent || t.trkorr
    const owner = (t.parent ? parents.get(t.parent)?.owner : t.owner) ?? t.owner
    const name = col(r, "OBJ_NAME").trimEnd()
    if (!out.has(name)) out.set(name, [])
    const list = out.get(name)!
    if (!list.some(h => h.request === request)) list.push({ request, task: t.trkorr, owner })
  }
  return out
}

const REPO = new Set(["CLAS", "INTF", "PROG", "FUGR"])
const DEP_CAP = 50

/**
 * What the moved objects use, and what uses them, among objects on open
 * requests other than the target. Covers ABAP code references (the where-used
 * index); DDIC structure (a table's data elements) is not followed.
 */
export async function analyseDependencies(
  c: Client, moved: Entry[], sourceEntries: Entry[], sourceRequest: string, targetRequest: string,
): Promise<DepReport> {
  const objs = new Map<string, string>()   // name → object type
  for (const e of moved) {
    if (e.pgmid === "R3TR" && REPO.has(e.object)) objs.set(e.objName.trimEnd(), e.object)
  }
  // A moved part (method, source) stands for its object.
  for (const e of moved.filter(m => m.pgmid === "LIMU")) {
    const owner = sourceEntries.find(s => s.pgmid === "R3TR" && REPO.has(s.object) && belongsTo(e.objName, s.objName.trimEnd()))
    if (owner) objs.set(owner.objName.trimEnd(), owner.object)
  }
  const report: DepReport = { outgoing: [], incoming: [] }
  if (!objs.size) return report
  if (objs.size > DEP_CAP) {
    report.skipped = `${objs.size} repository objects move — more than ${DEP_CAP}, so the dependency check was skipped.`
    return report
  }
  const movedNames = new Set(objs.keys())
  const movingKeys = new Set(moved.map(key))
  const staysOnSource = (name: string) =>
    sourceEntries.some(s => s.pgmid === "R3TR" && s.objName.trimEnd() === name && !movingKeys.has(key(s)))

  // Outgoing: what each moved object uses.
  const uses = new Map<string, Set<string>>()   // moved → used names
  for (const [name, type] of objs) {
    const where = type === "PROG" ? `INCLUDE = '${q(name)}'`
      : type === "FUGR" ? `INCLUDE LIKE 'L${q(name)}%'`
      : `INCLUDE LIKE '${q(name.padEnd(30, "="))}%'`
    const used = new Set<string>()
    for (const r of tableRows(await runSql(c, `SELECT NAME FROM WBCROSSGT WHERE ${where}`, 1000))) {
      used.add(col(r, "NAME").split("\\")[0].trimEnd())
    }
    const funcs = tableRows(await runSql(c, `SELECT NAME FROM CROSS WHERE TYPE = 'F' AND ${where}`, 500)).map(r => col(r, "NAME").trimEnd())
    if (type === "FUGR") {
      for (const r of tableRows(await runSql(c, `SELECT NAME FROM WBCROSSGT WHERE INCLUDE = 'SAPL${q(name)}'`, 500))) used.add(col(r, "NAME").split("\\")[0].trimEnd())
    }
    const customerFuncs = funcs.filter(isCustomerName)
    if (customerFuncs.length) {
      for (const r of await sqlIn(c, "SELECT FUNCNAME, PNAME FROM TFDIR WHERE", "FUNCNAME", customerFuncs)) {
        const pname = col(r, "PNAME")
        if (pname.startsWith("SAPL")) used.add(pname.slice(4))
      }
    }
    uses.set(name, new Set([...used].filter(u => isCustomerName(u) && u !== name && !movedNames.has(u))))
  }
  const holdersOut = await openHolders(c, [...new Set([...uses.values()].flatMap(s => [...s]))])
  for (const [moved, set] of uses) {
    for (const u of set) {
      for (const h of holdersOut.get(u) ?? []) {
        if (h.request === targetRequest) continue
        const onSource = h.request === sourceRequest
        if (onSource && !staysOnSource(u)) continue
        report.outgoing.push({ moved, uses: { name: u, ...h, staysOnSource: onSource } })
      }
    }
  }

  // Incoming: what uses each moved object.
  const usedBy = new Map<string, Set<string>>()
  for (const [name, type] of objs) {
    const users = new Set<string>()
    const rows = tableRows(await runSql(c, `SELECT INCLUDE FROM WBCROSSGT WHERE NAME = '${q(name)}' OR NAME LIKE '${q(name)}\\%'`, 1000))
    if (type === "FUGR") {
      const funcs = [...await functionsOfGroup(c, name)]
      if (funcs.length) rows.push(...await sqlIn(c, "SELECT INCLUDE FROM CROSS WHERE TYPE = 'F' AND", "NAME", funcs))
    }
    for (const r of rows) {
      const m = mainOfInclude(col(r, "INCLUDE"))
      if (isCustomerName(m.name) && m.name !== name && !movedNames.has(m.name)) users.add(m.name)
    }
    usedBy.set(name, users)
  }
  const holdersIn = await openHolders(c, [...new Set([...usedBy.values()].flatMap(s => [...s]))])
  for (const [moved, set] of usedBy) {
    for (const u of set) {
      for (const h of holdersIn.get(u) ?? []) {
        if (h.request === targetRequest) continue
        const onSource = h.request === sourceRequest
        if (onSource && !staysOnSource(u)) continue
        report.incoming.push({ moved, usedBy: { name: u, ...h, staysOnSource: onSource } })
      }
    }
  }
  return report
}

// ─── the tool ────────────────────────────────────────────────────────────────

export interface MoveArgs {
  from: string
  to: string
  objects?: string[]
  includeParts?: boolean
  commit?: boolean
  autoDeploy?: boolean
  connectionId?: string
}

const describeReq = (r: TrReq) => `${r.trkorr}${r.text ? ` "${r.text}"` : ""} (${r.parent ? "task" : "request"}, ${family(r.fn)}, ${r.owner}${r.status !== "D" ? `, status ${r.status}` : ""})`

export async function handleTransportMove(args: MoveArgs) {
  const c = await ensureConnected(args.connectionId)
  const me = (getConnectionConfig(args.connectionId).username ?? "").toUpperCase()
  const fromId = args.from.trim().toUpperCase()
  const toId = args.to.trim().toUpperCase()
  const findings: Finding[] = []
  const text = (lines: string[]) => ({ content: [{ type: "text" as const, text: lines.join("\n") }] })

  const base = await readRequests(c, [fromId, toId])
  const from = base.get(fromId), to = base.get(toId)
  if (!from || !to) {
    const missing = [!from && fromId, !to && toId].filter(Boolean).join(" and ")
    return text([`❌ Moving stopped: ${missing} does not exist in SAP. Nothing was moved.`,
      `Check the number in SE09 (a task number is fine too), then run again.`])
  }
  const parents = await readRequests(c, [from.parent, to.parent].filter(Boolean))
  const fromRequest = from.parent ? parents.get(from.parent)! : from
  const toRequest = to.parent ? parents.get(to.parent)! : to
  const mode: "OBJECTS" | "TASK" = args.objects?.length ? "OBJECTS" : from.parent ? "TASK" : "OBJECTS"
  if (!args.objects?.length && !from.parent) {
    return text([`❌ Moving stopped: ${fromId} is a request, and no objects were named. Nothing was moved.`,
      `Name the objects to move (objects: ["R3TR CLAS ZCL_X", "ZCL_FOO*"]), or pass one of its tasks as from to move that whole task.`])
  }

  // ── checks on source and target ──
  const lines: string[] = []
  lines.push(`From:   ${describeReq(from)}${from.parent ? `, in request ${fromRequest.trkorr}` : ""}`)
  lines.push(`To:     ${describeReq(to)}${to.parent ? `, in request ${toRequest.trkorr}` : ""}`)
  for (const [label, r] of [["source", from], ["source request", fromRequest], ["target", to], ["target request", toRequest]] as const) {
    if (!OPEN.has(r.status)) findings.push({ level: "stop", text: `The ${label} ${r.trkorr} is released (status ${r.status}); a released request cannot change. Pick an open one.` })
  }
  if (mode === "TASK" && fromRequest.trkorr === toRequest.trkorr) {
    findings.push({ level: "stop", text: `Task ${from.trkorr} already belongs to ${toRequest.trkorr}.` })
  }
  if (from.trkorr === to.trkorr) findings.push({ level: "stop", text: `Source and target are the same (${from.trkorr}).` })
  if (family(from.fn) !== family(to.fn) && !(from.fn === "X" || to.fn === "X")) {
    findings.push({ level: "stop", text: `${from.trkorr} is ${family(from.fn)} and ${to.trkorr} is ${family(to.fn)}: SAP keeps those apart ` +
      `(repository objects on Workbench requests, customizing on Customizing requests). Pick a target of the same kind.` })
  }
  if (fromRequest.client && toRequest.client && fromRequest.client !== toRequest.client) {
    findings.push({ level: "stop", text: `${fromRequest.trkorr} was created in client ${fromRequest.client} and ${toRequest.trkorr} in client ` +
      `${toRequest.client}; SAP refuses a move between clients. Use a target created in client ${fromRequest.client}.` })
  }
  if (fromRequest.tarsystem !== toRequest.tarsystem) {
    findings.push({ level: "warn", text: `The requests go to different systems (${fromRequest.tarsystem || "local"} → ${toRequest.tarsystem || "local"}). ` +
      `The moved objects will follow ${toRequest.trkorr}'s route${toRequest.tarsystem ? "" : " — local means they are not transported at all"}.` })
  }
  if (toRequest.owner && toRequest.owner !== me) findings.push({ level: "note", text: `${toRequest.trkorr} belongs to ${toRequest.owner}.` })

  // ── what moves ──
  let moving: Entry[] = []
  let target = to.trkorr
  let sourceEntries: Entry[] = []
  if (mode === "TASK") {
    if (to.parent) findings.push({ level: "note", text: `A task moves to a request: using ${toRequest.trkorr}, the request of ${to.trkorr}.` })
    target = toRequest.trkorr
    sourceEntries = await entriesOf(c, [from.trkorr])
    moving = sourceEntries
    lines.push(`Move:   the whole task ${from.trkorr} (${moving.length} entr${moving.length === 1 ? "y" : "ies"}) into request ${target}`)
  } else {
    const sourceIds = from.parent ? [from.trkorr] : [from.trkorr, ...(await tasksOf(c, from.trkorr)).map(t => t.trkorr)]
    sourceEntries = await entriesOf(c, sourceIds)
    const specs = (args.objects ?? []).map(parseSpec)
    const chosen = new Map<string, Entry>()
    for (const s of specs) {
      const hits = sourceEntries.filter(e => matchesSpec(e, s))
      if (!hits.length) findings.push({ level: "stop", text: `"${s.raw}" is not on ${from.trkorr}${from.parent ? "" : " or its tasks"}. Nothing was moved; check the name, or list the request (manage_transport_requests details).` })
      for (const h of hits) chosen.set(`${h.trkorr}|${key(h)}`, h)
    }
    if (args.includeParts !== false) {
      for (const e of [...chosen.values()].filter(x => x.pgmid === "R3TR")) {
        const funcs = e.object === "FUGR" ? await functionsOfGroup(c, e.objName.trimEnd()) : undefined
        for (const p of partsOf(e, sourceEntries, funcs)) {
          if (!chosen.has(`${p.trkorr}|${key(p)}`)) {
            chosen.set(`${p.trkorr}|${key(p)}`, p)
            findings.push({ level: "note", text: `${key(p)} moves along with ${key(e)} (part of it).` })
          }
        }
      }
    }
    moving = [...chosen.values()]
    // Split objects: a part moving while its object stays, or the object moving while parts stay.
    const movingKeys = new Set(moving.map(key))
    for (const e of moving.filter(m => m.pgmid === "LIMU")) {
      const owner = sourceEntries.find(s => s.pgmid === "R3TR" && belongsTo(e.objName, s.objName.trimEnd()))
      if (owner && !movingKeys.has(key(owner))) {
        findings.push({ level: "warn", text: `${key(e)} moves but ${key(owner)} stays on the source: the object is split over two requests. ` +
          `Move ${owner.objName.trimEnd()} too, unless the split is intended.` })
      }
    }
    if (args.includeParts === false) {
      for (const e of moving.filter(m => m.pgmid === "R3TR")) {
        const left = partsOf(e, sourceEntries).filter(p => !movingKeys.has(key(p)))
        if (left.length) findings.push({ level: "warn", text: `${key(e)} moves but ${left.length} of its parts stay (${left.slice(0, 3).map(key).join(", ")}${left.length > 3 ? ", …" : ""}).` })
      }
    }
    // Target: my own task in the target request, when there is one of the right kind.
    if (!to.parent) {
      const fam = family(toRequest.fn)
      const mine = (await tasksOf(c, toRequest.trkorr)).find(t => t.owner === me && OPEN.has(t.status) && t.fn === TASK_FOR[fam])
      if (mine) { target = mine.trkorr; findings.push({ level: "note", text: `Entries go into your task ${mine.trkorr} in ${toRequest.trkorr}.` }) }
    }
    // Already on the target: SAP would refuse the move (duplicate entry).
    const targetIds = [toRequest.trkorr, ...(await tasksOf(c, toRequest.trkorr)).map(t => t.trkorr)]
    const onTarget = new Set((await entriesOf(c, targetIds)).map(key))
    const dup = moving.filter(e => onTarget.has(key(e)))
    if (dup.length) {
      for (const d of dup) findings.push({ level: "note", text: `${key(d)} is already on ${toRequest.trkorr}; left where it is.` })
      moving = moving.filter(e => !onTarget.has(key(e)))
    }
    lines.push(`Move:   ${moving.length} entr${moving.length === 1 ? "y" : "ies"} into ${target}`)
    for (const e of moving.slice(0, 40)) lines.push(`          ${key(e)}${e.lockflag === "X" ? "  (locked — the lock moves with it)" : ""}${e.trkorr !== from.trkorr ? `  [from task ${e.trkorr}]` : ""}`)
    if (moving.length > 40) lines.push(`          … ${moving.length - 40} more`)
    if (!moving.length && !findings.some(f => f.level === "stop")) findings.push({ level: "stop", text: `Nothing left to move.` })
  }

  // ── dependencies and release order ──
  let deps: DepReport = { outgoing: [], incoming: [] }
  try {
    deps = await analyseDependencies(c, moving, sourceEntries, fromRequest.trkorr, toRequest.trkorr)
  } catch (err) {
    log("WARN", "transport_move dependency check failed", err)
    deps.skipped = `The dependency check could not run: ${String((err as Error)?.message ?? err)}.`
  }
  const depLines: string[] = []
  for (const d of deps.outgoing) depLines.push(`  ${d.moved} uses ${d.uses.name}, which is on ${d.uses.request}${d.uses.staysOnSource ? " (stays on the source)" : ""} (${d.uses.owner})`)
  for (const d of deps.incoming) depLines.push(`  ${d.usedBy.name} on ${d.usedBy.request}${d.usedBy.staysOnSource ? " (stays on the source)" : ""} (${d.usedBy.owner}) uses ${d.moved}`)

  const out: string[] = [
    findings.some(f => f.level === "stop") ? `❌ MOVE PLAN — cannot go ahead; nothing was moved`
      : args.commit ? `✏️  MOVE` : `📋 MOVE PLAN — dry run, nothing moved`,
    ...lines.map(l => `   ${l}`),
  ]
  const byLevel = (lvl: Finding["level"], head: string) => {
    const f = findings.filter(x => x.level === lvl)
    if (f.length) out.push("", head, ...f.map(x => `  • ${x.text}`))
  }
  byLevel("stop", "Stops:")
  byLevel("warn", "Warnings:")
  byLevel("note", "Notes:")
  out.push("", "Dependencies on other open requests (ABAP code references; DDIC structure not followed):")
  out.push(...(depLines.length ? depLines : [deps.skipped ? `  ${deps.skipped}` : "  none found (the where-used index can lag behind a fresh activation; SE80 → Utilities → Update Navigation Index refreshes it)"]))
  const advice = releaseAdvice(deps, toRequest.trkorr, fromRequest.trkorr)
  if (advice.length) out.push("", "Release order:", ...advice.map(a => `  • ${a}`))

  if (findings.some(f => f.level === "stop")) return text(out)

  // ── SAP: test move (dry run) or the move itself ──
  if (args.autoDeploy !== false) {
    try {
      const d = await ensureEngineClass(args.connectionId)
      if (d.changed) out.unshift(`(engine ${d.action} to v${ENGINE_VERSION})`)
    } catch (err) {
      log("WARN", "auto-deploy of engine class failed", err)
    }
  }
  let r
  try {
    r = await callEngine(args.connectionId, mode === "TASK"
      ? { operation: "transport_move", action: "TASK", from_trkorr: from.trkorr, to_trkorr: target, commit: args.commit ? "X" : "" }
      : { operation: "transport_move", action: "OBJECTS", to_trkorr: target, commit: args.commit ? "X" : "",
          objects_json: JSON.stringify(moving.map(e => ({ TRKORR: e.trkorr, PGMID: e.pgmid, OBJECT: e.object, OBJ_NAME: e.objName }))) })
  } catch (err) {
    out.push("", `❌ ${args.commit ? "The move" : "SAP's test move"} could not run: the engine call failed (${String((err as Error)?.message ?? err)}). Nothing was moved.`,
      `Run customizing_engine_ping to check the engine (transport_move needs v0.9.35 or later).`)
    return text(out)
  }
  out.push("", args.commit ? "SAP:" : "SAP test move:", ...(r.MESSAGES ?? []).map(m => `  ${m}`))
  if (r.STATUS !== "ok") {
    out.push(`❌ ${args.commit ? "Nothing was moved." : "SAP would refuse this move."} Fix what SAP names above and run again.`)
    return text(out)
  }
  if (!args.commit) {
    out.push("", `Run again with commit: true to move.`)
    return text(out)
  }

  // ── verify ──
  if (mode === "TASK") {
    const now = (await readRequests(c, [from.trkorr])).get(from.trkorr)
    out.push(now?.parent === target ? `✅ Verified: task ${from.trkorr} is now in ${target}.`
      : `⚠️ SAP reported success, but E070 shows task ${from.trkorr} under ${now?.parent || "(none)"}. Check SE09.`)
  } else {
    const atTarget = new Set((await entriesOf(c, [target])).map(key))
    const stillAtSource = new Set((await entriesOf(c, [...new Set(moving.map(e => e.trkorr))])).map(key))
    const missing = moving.filter(e => !atTarget.has(key(e)))
    const left = moving.filter(e => stillAtSource.has(key(e)))
    out.push(!missing.length && !left.length
      ? `✅ Verified in E071: all ${moving.length} entr${moving.length === 1 ? "y is" : "ies are"} on ${target} and gone from the source.`
      : `⚠️ SAP reported success, but E071 disagrees: ${missing.length} not on ${target}, ${left.length} still on the source. Check SE09.`)
  }
  return text(out)
}

export function registerTransportMoveTools(server: McpServer): void {
  server.registerTool(
    "transport_move",
    {
      title: "Move Transport Objects or Task",
      description:
        "Move object entries from one transport request/task to another, or reassign a whole task to another request — " +
        "with the checks a careful Basis colleague makes first. DRY RUN by default: shows the plan, runs SAP's own " +
        "test move (TR_MOVE_OBJECTS test mode), and reports what the moved objects use and are used by on other open " +
        "requests, with the release order that follows. commit: true moves and verifies in E071.\n\n" +
        "  objects given        → those entries move (\"R3TR CLAS ZCL_X\", \"CLAS ZCL_X\", \"ZCL_X\", \"ZCL_FOO*\"); " +
        "an object's parts (methods, sections, includes, function modules) move with it unless includeParts: false.\n" +
        "  no objects, from = a task → the whole task moves to the target request (TR_REASSIGN_TASK).\n\n" +
        "Stops before SAP is called when a request is released, the kinds differ (Workbench/Customizing), or the " +
        "clients differ; warns when the target goes to another system or an object would be split.",
      inputSchema: {
        from: z.string().describe("Source request or task"),
        to: z.string().describe("Target request (or a task in it)"),
        objects: z.array(z.string()).optional().describe("Entries to move: \"R3TR CLAS ZCL_X\", \"CLAS ZCL_X\", \"ZCL_X\" or a wildcard \"ZCL_FOO*\". Omit with a task as from to move the whole task."),
        includeParts: z.boolean().optional().describe("Move an object's parts with it (default true)"),
        commit: z.boolean().optional().describe("Actually move (default false = dry run with SAP's test move)"),
        autoDeploy: z.boolean().optional().describe("Deploy/update the in-system engine if needed (default true)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      },
    },
    async args => handleTransportMove(args as MoveArgs),
  )
}
