/**
 * Phase 0 Customizing tools — read/analyse/plan only, zero ABAP deployment.
 *
 * All data is fetched via existing ADT query endpoints (runQuery / tableContents).
 * Nothing is written to the system in this phase.
 *
 * Tools:
 *   img_search           — find IMG activities and their config objects by keyword
 *   customizing_describe — describe a config object: table set, key fields, auth, transport
 *   customizing_read     — read current customizing data for an object + optional org key filter
 *   customizing_diff     — compare configuration between two org-unit key values
 *   customizing_plan_change — preview the rows that would be created to duplicate config
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, forceReconnect, log } from "../connections"
import { formatQueryResult } from "./data"
import { imgIndexRead, imgSearchViaEngine, type ImgIndexHit, type ImgSearchHit } from "./customizingEngine"
import type { ADTClient, QueryResult } from "abap-adt-api"

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// runQuery, but resilient to the ADT Data-Preview endpoint's intermittent /
// session-wide HTTP 400 degradation: on failure, force a clean reconnect and
// retry (up to 2 extra attempts).  This is what makes the ~10-query resolver
// reliable instead of silently falling back to a wrong answer.
export async function runSql(client: ADTClient, sql: string, maxRows = 200): Promise<QueryResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const c = attempt === 0 ? client : await forceReconnect()
      // Run freestyle SQL on the STATELESS clone, not the long-lived stateful
      // session.  ADT's Data Preview (CL_ADT_DP_OPEN_SQL_HANDLER) does a
      // GENERATE SUBROUTINE POOL per query; ABAP caps those at 36 per internal
      // session.  In the stateful session they accumulate until the 37th query
      // dumps with CX_SY_GENERATE_SUBPOOL_FULL.  Stateless = fresh roll area per
      // request → the subpools are rolled out each call and never pile up.
      return await c.statelessClone.runQuery(sql, maxRows)
    } catch (err) {
      lastErr = err
      if (attempt < 2) { log("DEBUG", `runSql retry ${attempt + 1} after error`, err); await sleep(200) }
    }
  }
  throw lastErr
}

export function tableRows(result: QueryResult): Record<string, string>[] {
  const cols = result.columns?.map(c => c.name) ?? []
  return (result.values ?? []).map((row: Record<string, unknown>) =>
    Object.fromEntries(cols.map(c => [c, String(row[c] ?? "").trim()]))
  )
}

export function col(row: Record<string, string>, ...names: string[]): string {
  for (const n of names) if (row[n] !== undefined) return row[n]
  return ""
}

const EMPTY: QueryResult = { columns: [], values: [] } as unknown as QueryResult
const sql1 = (client: ADTClient, s: string) =>
  runSql(client, s, 200).then(tableRows).catch(() => [] as Record<string, string>[])

// ─── maintenance-object resolver ───────────────────────────────────────────────
//
// Given a name that may be a maintenance VIEW, a base TABLE, or an IMG activity's
// object, resolve the full customizing maintenance object using the *real* DDIC
// schema (verified against the live system):
//
//   DD25L   view header        VIEWNAME, AGGTYPE ('V'=view 'C'=cluster), ROOTTAB
//   DD26S   view base tables    VIEWNAME, TABNAME, TABPOS   (base + text + …)
//   TVDIR   maintenance dir     TABNAME(=view), AREA(=fgrp), TYPE(1/2), BASTAB(flag)
//   TDDAT   table auth group    TABNAME, CCLASS
//   DD02L   table delivery cls  TABNAME, CONTFLAG, CLIDEP, MAINFLAG
//   DD03L   field LANG type     identifies the text table (SPRAS key)
//   CUS_ACTOBJ  IMG activity    ACT_ID, OBJECTTYPE('V'/'S'/'C'), OBJECTNAME, TCODE
//
// The transport object is R3TR VDAT <view> when maintained through a view (the
// SM30/SPRO path, spanning base + text table), else R3TR TABU <table>.
export interface ResolvedMaint {
  input: string
  isView: boolean
  view?: string
  rootTable: string
  textTable?: string
  tables: string[]            // full ordered table set (base + text + …)
  funcGroup?: string          // TVDIR AREA
  maintType?: string          // TVDIR TYPE (1 one-step / 2 two-step)
  maintTcode?: string         // CUS_ACTOBJ TCODE (SM30 / SM34 / …)
  imgActivity?: string        // CUS_ACTOBJ ACT_ID
  imgActivityText?: string    // CUS_IMGACT TEXT — the SPRO activity title (the "area")
  authGroup?: string          // TDDAT CCLASS of the root table
  objectType?: string         // CUS_ACTOBJ OBJECTTYPE: V view / S table / C cluster / T txn / D dummy
  cluster?: string            // VCLSTRUC: the view cluster this view belongs to (if any) — NOT the
                               // non-termination trigger (see switchId); kept for messaging only.
  devclass?: string           // TVDIR DEVCLASS: the maintenance object's own package
  switchId?: string           // SFW_PACKAGE SWITCH_ID for devclass, if that package is switch-gated
                               // at all — regardless of the switch's current on/off/standby state.
                               // THIS is the debugger-verified trigger for a headless commit
                               // effectively never terminating on a cold view in that package.
  // maintObject = what VIEW_MAINTENANCE_SINGLE_ENTRY is driven on (a maintenance
  // view for VDAT, or the table itself for single-table TABU maintenance).
  // "" ⇒ no generated SM30/SM34 maintenance → only a direct (untransported) write is possible.
  maintObject: string
  // recordObject = the transport object the headless write actually records.
  // For a cluster member we drive the member view, so it records VDAT (not CDAT).
  recordObject?: "VDAT" | "TABU"
  // transport = the *official* transport object as SAP/SPRO classifies it
  // (cluster→CDAT, view→VDAT, single table→TABU).
  transport: { object: "VDAT" | "TABU" | "CDAT"; name: string }
}

export async function resolveMaint(client: ADTClient, name: string): Promise<ResolvedMaint> {
  const obj = name.toUpperCase().replace(/'/g, "''")

  let view: string | undefined
  let rootTable = obj
  let tabRows: Record<string, string>[] = []
  let singleTable = false       // table that is its own SM30 maintenance object (TVDIR BASTAB='X')

  // 1. Is the input itself a maintenance view?
  const dd25 = await sql1(client, `SELECT VIEWNAME, AGGTYPE, ROOTTAB FROM DD25L WHERE VIEWNAME = '${obj}'`)
  if (dd25[0]) {
    view      = obj
    rootTable = col(dd25[0], "ROOTTAB") || obj
    tabRows   = await sql1(client, `SELECT TABNAME, TABPOS FROM DD26S WHERE VIEWNAME = '${obj}' ORDER BY TABPOS`)
  } else {
    // 2. Input is a config table — find the maintenance view(s) ROOTED on it.
    //    NB: filtering DD26S by TABNAME is wrong — a base table is also a check/text
    //    table in many unrelated views (for /POSDW/PROF that's 37), which both
    //    overflows the 255-char IN-list and picks the wrong view. DD25L.ROOTTAB
    //    gives only the views whose *root* is this table (the real maintenance views).
    const rooted = await sql1(client, `SELECT VIEWNAME FROM DD25L WHERE ROOTTAB = '${obj}' AND AGGTYPE = 'V'`)
    const cand = [...new Set(rooted.map(r => col(r, "VIEWNAME")))]
      .filter(v => v && v !== obj)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))   // canonical = shortest name
    if (cand.length) {
      const inList = cand.slice(0, 12).map(v => `'${v}'`).join(",")   // cap: stay under 255 chars
      const tv = await sql1(client, `SELECT TABNAME FROM TVDIR WHERE TABNAME IN (${inList})`)
      const maintViews = new Set(tv.map(r => col(r, "TABNAME")))
      view = cand.find(v => maintViews.has(v))   // shortest-named view that has a maintenance dialog
      if (view) {
        const dd25v = await sql1(client, `SELECT ROOTTAB FROM DD25L WHERE VIEWNAME = '${view}'`)
        rootTable = col(dd25v[0] ?? {}, "ROOTTAB") || obj
        tabRows   = await sql1(client, `SELECT TABNAME, TABPOS FROM DD26S WHERE VIEWNAME = '${view}' ORDER BY TABPOS`)
      }
    }
    // 3. No view → is the table its own single-table maintenance object? TVDIR BASTAB='X'
    if (!view) {
      const selfTv = await sql1(client, `SELECT TABNAME, AREA, TYPE, BASTAB FROM TVDIR WHERE TABNAME = '${obj}'`)
      if (selfTv[0] && col(selfTv[0], "BASTAB") === "X") singleTable = true
    }
  }

  let tables = tabRows.map(r => col(r, "TABNAME")).filter(Boolean)
  if (tables.length === 0) tables = [rootTable]
  if (!rootTable) rootTable = tables[0]

  // Identify the text table: a member (≠ root) carrying a LANG-typed key (SPRAS)
  let textTable: string | undefined
  const nonRoot = tables.filter(t => t !== rootTable)
  if (nonRoot.length) {
    const inList = nonRoot.map(t => `'${t}'`).join(",")
    const langFields = await sql1(client,
      `SELECT TABNAME FROM DD03L WHERE TABNAME IN (${inList}) AND DATATYPE = 'LANG' AND AS4LOCAL = 'A'`)
    textTable = langFields.map(r => col(r, "TABNAME")).find(Boolean)
  }

  // TVDIR (function group / maint type / package) of the maintenance object
  const maintName = view ?? (singleTable ? obj : "")
  let funcGroup: string | undefined, maintType: string | undefined, devclass: string | undefined
  if (maintName) {
    const tvdir = await sql1(client, `SELECT AREA, TYPE, DEVCLASS FROM TVDIR WHERE TABNAME = '${maintName}'`)
    funcGroup = col(tvdir[0] ?? {}, "AREA") || undefined
    maintType = col(tvdir[0] ?? {}, "TYPE") || undefined
    devclass  = col(tvdir[0] ?? {}, "DEVCLASS") || undefined
  }

  // Switch Framework gating of that package (SFW_PACKAGE): the DEBUGGER-VERIFIED
  // trigger (docs/audit-2026-07-07-transport-handling.md, wp_detail live WP
  // tracing) for a headless VIEW_MAINTENANCE_SINGLE_ENTRY commit effectively
  // never terminating — 12h+ for 4 rows into V_TOIJRMOT, a PLAIN view, not a
  // cluster member. The runtime grinds per-DDIC-object through Switch Framework
  // evaluation (CL_ABAP_SWITCH) plus first-load module-pool generation on a
  // view that has never been touched via SM30/SM34 on this box, plus the ST-PI
  // TMWFLOW CTS hook. Confirmed a second time 2026-09-03 (same module sequence)
  // on V_OIJNOM_ST03, package OIJ, switch OIJ_TSW — which is ALSO a view-cluster
  // member, but clustering is not the trigger: /POSDW/GPAP (2026-06-10) is a
  // cluster member in a non-switch-gated package and wrote in seconds. Package
  // switch-gating is the property that actually discriminates the two outcomes.
  let switchId: string | undefined
  if (devclass) {
    const sfw = await sql1(client, `SELECT SWITCH_ID FROM SFW_PACKAGE WHERE DEVCLASS = '${devclass}'`)
    switchId = col(sfw[0] ?? {}, "SWITCH_ID") || undefined
  }

  // View-cluster membership (VCLSTRUC): does a cluster maintain this view?
  let cluster: string | undefined
  if (view) {
    const vcl = await sql1(client, `SELECT VCLNAME FROM VCLSTRUC WHERE OBJECT = '${view}'`)
    cluster = col(vcl[0] ?? {}, "VCLNAME") || undefined
  }

  // IMG activity wiring (CUS_ACTOBJ) — object type V/S/C/T/D, IMG activity, tcode.
  // Use || (not ??): maintName is "" (empty, not null) when the table has no
  // maintenance view, and must fall through to rootTable — otherwise the lookup
  // runs on '' and objectType comes back undefined ("object type ?" in errors).
  const actName = cluster || maintName || rootTable
  const actObj = await sql1(client,
    `SELECT ACT_ID, OBJECTTYPE, OBJECTNAME, TCODE FROM CUS_ACTOBJ WHERE OBJECTNAME = '${actName}'`)
  const imgActivity = col(actObj[0] ?? {}, "ACT_ID") || undefined
  const objectType  = col(actObj[0] ?? {}, "OBJECTTYPE") || undefined
  const maintTcode  = col(actObj[0] ?? {}, "TCODE") || undefined

  // IMG activity title (CUS_IMGACT) — the SPRO area name this config lives under
  let imgActivityText: string | undefined
  if (imgActivity) {
    const it = await sql1(client, `SELECT TEXT FROM CUS_IMGACT WHERE SPRAS = 'E' AND ACTIVITY = '${imgActivity.replace(/'/g, "''")}'`)
    imgActivityText = col(it[0] ?? {}, "TEXT") || undefined
  }

  // Auth group of the root table (TDDAT)
  const tddat = await sql1(client, `SELECT CCLASS FROM TDDAT WHERE TABNAME = '${rootTable}'`)
  const authGroup = col(tddat[0] ?? {}, "CCLASS") || undefined

  // What the headless write drives + records, vs the official transport object.
  const maintObject  = view ?? (singleTable ? obj : "")
  const recordObject: "VDAT" | "TABU" | undefined =
    view ? "VDAT" : singleTable ? "TABU" : undefined
  const transport: ResolvedMaint["transport"] =
    cluster ? { object: "CDAT", name: cluster }
    : view  ? { object: "VDAT", name: view }
    :         { object: "TABU", name: rootTable }

  return {
    input: obj,
    isView: !!view,
    view,
    rootTable,
    textTable,
    tables,
    funcGroup,
    maintType,
    maintTcode,
    imgActivity,
    imgActivityText,
    authGroup,
    objectType,
    cluster,
    devclass,
    switchId,
    maintObject,
    recordObject,
    transport,
  }
}

// ─── img_search ───────────────────────────────────────────────────────────────

export async function handleImgSearch(args: {
  keyword: string
  namespace?: string         // activity-ID prefix to scope by, e.g. "/POSDW/" (POS DTA)
  inScopeOnly?: boolean      // keep only activities in the client's activated scope (CUS_IMGACH_SCOPE)
  language?: string
  maxResults?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)

  // Preferred: the in-system engine's img_search op — a full CUS_IMGACT scan with
  // a server-side LIKE over title AND activity id. No 200-row alphabetical window,
  // and it finds component-acronym hits (TSW → SIMG_OIJ_TSW_*). Falls through to
  // the STREE index / raw ADT paths when the engine is unreachable or too old.
  if (args.keyword.trim()) {
    try {
      const viaEngine = await imgSearchViaEngine(args.connectionId, {
        keyword: args.keyword.trim(), language: args.language, maxRows: args.maxResults,
      })
      if (viaEngine) {
        const out = formatImgSearchHits(args.keyword, viaEngine, args.namespace)
        return { content: [{ type: "text" as const, text: out }] }
      }
    } catch (err) {
      log("DEBUG", "img_search: engine op unavailable, trying index/raw", err)
    }
  }

  // Next: the STREE/SHI text search index when one exists (built by
  // RS_SHI10_TEXTINDEX_UPDATE). It covers the whole IMG in one cluster read and
  // gives breadcrumb-aware hits. Fall back to the raw CUS_IMGACT tables when no
  // index is present — always reporting which source answered.
  if (args.keyword.trim()) {
    try {
      const viaIndex = await imgSearchViaIndex(client, args)
      if (viaIndex) return { content: [{ type: "text" as const, text: viaIndex }] }
    } catch (err) {
      log("DEBUG", "img_search: index path failed, falling back to raw IMG tables", err)
    }
  }
  return imgSearchRaw(client, args)
}

// Index-backed search: resolve the indexed IMG tree(s) from the TTREESRCH
// directory (∩ TTREE TYPE='IMG'), then call the engine's img_index_read op per
// tree. Returns a formatted block, or null when no index exists (→ caller falls
// back to the raw tables).
async function imgSearchViaIndex(
  client: ADTClient,
  args: { keyword: string; language?: string; maxResults?: number; connectionId?: string },
): Promise<string | null> {
  const lang = (args.language ?? "E").toUpperCase().slice(0, 1)
  const max  = args.maxResults ?? 200
  const kw   = args.keyword.trim()

  // Which trees have a generated text index? TTREESRCH is small (one row per
  // indexed tree+language), so drive from it and confirm each is an IMG tree
  // with a targeted TTREE lookup — there are far too many IMG trees to scan.
  const genRows = tableRows(await runSql(client,
    `SELECT TREE_ID, SPRAS, GEN_DATE FROM TTREESRCH ORDER BY GEN_DATE DESCENDING`, 100))
  if (genRows.length === 0) return null

  const genByTree = new Map<string, string>()   // tree_id → gen_date (newest first wins)
  for (const r of genRows) {
    const id = col(r, "TREE_ID")
    if (!genByTree.has(id)) genByTree.set(id, col(r, "GEN_DATE"))
  }
  // Keep the IN-list under this system's 255-char literal cap (~7 × 32-char ids)
  const ids = [...genByTree.keys()].slice(0, 6)
  const inList = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(",")
  const imgRows = tableRows(await runSql(client,
    `SELECT ID FROM TTREE WHERE TYPE = 'IMG' AND ID IN (${inList})`, 50))
  const imgIds = new Set(imgRows.map(r => col(r, "ID")))

  const trees = ids
    .filter(id => imgIds.has(id))
    .map(id => ({ id, gen: genByTree.get(id)! }))
  if (trees.length === 0) return null

  const hits: (ImgIndexHit & { _tree: string; _gen: string })[] = []
  const sources: string[] = []
  for (const t of trees.slice(0, 3)) {
    const res = await imgIndexRead(args.connectionId, {
      structureId: t.id, language: lang, keyword: kw, maxRows: max,
    })
    if (res.status === "no_index") continue
    sources.push(`STREE index ${t.id} @${t.gen}`)
    for (const h of res.hits) hits.push({ ...h, _tree: t.id, _gen: t.gen })
    if (hits.length >= max) break
  }
  if (sources.length === 0) return null   // engine couldn't read any index → fall back

  if (hits.length === 0) {
    return `No IMG nodes matching "${args.keyword}".\n` +
           `source: ${sources.join("; ")} (index used, vs. raw IMG tables)`
  }

  const lines: string[] = [
    `IMG nodes matching "${args.keyword}" (${hits.length}) — via search index:`,
    "",
  ]
  for (const h of hits.slice(0, max)) {
    const path = h.PATH || h.TEXT
    const ext  = h.EXTENSION ? `   [${h.EXTENSION}]` : ""
    lines.push(`• ${path}${ext}`)
  }
  lines.push(
    "",
    `source: ${sources.join("; ")}  (index used — vs. raw IMG tables)`,
    `Use customizing_describe <object> for the table set + transport object.`,
  )
  return lines.join("\n")
}

// Format engine img_search hits into the same table layout as the raw path.
function formatImgSearchHits(
  keyword: string,
  res: { hits: ImgSearchHit[]; messages: string[]; capped: boolean },
  namespace?: string,
): string {
  const typeLabel: Record<string, string> = {
    V: "view→VDAT", S: "table→TABU", C: "cluster→CDAT", T: "txn", D: "doc",
  }
  let hits = res.hits
  if (namespace) {
    const ns = namespace.toUpperCase()
    hits = hits.filter(h => (h.ACTIVITY ?? "").toUpperCase().startsWith(ns))
  }
  const src = `source: in-system engine img_search (full CUS_IMGACT scan — title + activity id)`
  if (hits.length === 0) {
    return `No IMG activities matching "${keyword}"${namespace ? ` in ${namespace}` : ""}.\n${src}`
  }
  const scope = namespace ? ` in ${namespace}` : ""
  const lines: string[] = [
    `IMG activities${scope} matching "${keyword}" (${hits.length}):`,
    "",
    `${"IMG activity".padEnd(22)} ${"Title".padEnd(45)} ${"Type".padEnd(12)} ${"Object".padEnd(24)} Tcode`,
    "-".repeat(120),
  ]
  for (const h of hits) {
    const act   = (h.ACTIVITY ?? "").padEnd(22)
    const title = (h.TEXT ?? "").slice(0, 45).padEnd(45)
    const t     = h.OBJECTTYPE ?? ""
    const type  = (typeLabel[t] ?? t).padEnd(12)
    const obj   = (h.OBJECTNAME ?? "").padEnd(24)
    const tc    = h.TCODE ?? ""
    lines.push(`${act} ${title} ${type} ${obj} ${tc}`)
  }
  lines.push("", `Use customizing_describe <object> for the table set, key fields, and transport object.`, src)
  if (res.capped) lines.push(`⚠️  ${res.messages.find(m => /capped/i.test(m)) ?? "result capped — raise maxResults"}`)
  return lines.join("\n")
}

// Raw fallback: search the CUS_IMGACT / CUS_ACTOBJ tables directly. Used when no
// STREE search index is present (or the engine isn't reachable).
async function imgSearchRaw(client: ADTClient, args: {
  keyword: string
  namespace?: string
  inScopeOnly?: boolean
  language?: string
  maxResults?: number
  connectionId?: string
}) {
  const lang = (args.language ?? "E").toUpperCase()
  const max  = args.maxResults ?? 200
  const kw   = args.keyword.trim().toUpperCase()

  // The IMG index is CUS_IMGACT (SPRAS, ACTIVITY, TEXT = the SPRO activity title).
  // Joined to CUS_ACTOBJ it yields the maintenance object + type + tcode, across
  // ALL packages — the authoritative discovery entry point.
  //   CUS_IMGACT  IMG activity title   SPRAS, ACTIVITY, TEXT
  //   CUS_ACTOBJ  activity → object    ACT_ID, OBJECTTYPE (V/S/C/T/D), OBJECTNAME, TCODE
  //
  // This system's SQL endpoint REJECTS `LIKE` (even an indexed prefix → HTTP 400),
  // so keyword matching is done MCP-side. We bound the scan with a key RANGE on
  // ACTIVITY (range comparisons DO work): scoped to `namespace` if given, else a
  // best-effort scan of the first `max` activities. Always pass a namespace for a
  // targeted search (e.g. "/POSDW/" for POS DTA).
  const ns = (args.namespace ?? "").toUpperCase().replace(/'/g, "''")
  let where = `a~SPRAS = '${lang}'`
  if (ns) {
    // [ns, ns+'~') — '~' (0x7E) sorts after letters/digits, covering the namespace
    where += ` AND a~ACTIVITY >= '${ns}' AND a~ACTIVITY < '${ns}~'`
  }
  const sql =
    `SELECT a~ACTIVITY, a~TEXT, o~OBJECTTYPE, o~OBJECTNAME, o~TCODE ` +
    `FROM CUS_IMGACT AS a ` +
    `INNER JOIN CUS_ACTOBJ AS o ON o~ACT_ID = a~ACTIVITY ` +
    `WHERE ${where} ORDER BY a~ACTIVITY`

  let scanned: Record<string, string>[] = []
  try { scanned = tableRows(await runSql(client, sql, max)) }
  catch { /* CUS_IMGACT/CUS_ACTOBJ not query-accessible on this system */ }

  // Keyword filter MCP-side (case-insensitive substring). Match the activity id,
  // object name and tcode too — not just the title — so component-acronym searches
  // (e.g. "TSW" → SIMG_OIJ_TSW_*, whose functional titles never say "TSW") hit.
  let rows = kw
    ? scanned.filter(r =>
        col(r, "TEXT").toUpperCase().includes(kw) ||
        col(r, "ACTIVITY").toUpperCase().includes(kw) ||
        col(r, "OBJECTNAME").toUpperCase().includes(kw) ||
        col(r, "TCODE").toUpperCase().includes(kw))
    : scanned

  // F3: this path fetches only the first `max` activities (ordered by ACTIVITY)
  // then filters MCP-side — so without a namespace the scan window may not reach
  // the keyword's activities at all. Flag a truncated scan honestly.
  const truncated = !ns && scanned.length >= max

  // Optional: restrict to activities in the client's activated scope.
  // CUS_IMGACH_SCOPE is client-dependent and is empty on systems where scoping
  // isn't activated (e.g. CAR) — there it would drop everything, so we only
  // apply the filter when the scope table actually has rows for this namespace.
  let scopeNote = ""
  if (args.inScopeOnly && ns) {
    const scopeRows = await sql1(client,
      `SELECT ACTIVITY FROM CUS_IMGACH_SCOPE WHERE ACTIVITY >= '${ns}' AND ACTIVITY < '${ns}~'`)
    if (scopeRows.length > 0) {
      const inScope = new Set(scopeRows.map(r => col(r, "ACTIVITY")))
      rows = rows.filter(r => inScope.has(col(r, "ACTIVITY")))
    } else {
      scopeNote = `\n(inScopeOnly ignored — no scoping data in CUS_IMGACH_SCOPE for ${args.namespace})`
    }
  }

  if (rows.length === 0) {
    const hint = ns
      ? `No IMG activities in ${args.namespace} matching "${args.keyword}".`
      : `No matches in the first ${max} activities scanned. This ADT path can only ` +
        `scan a bounded window (deploy the engine for a full server-side search), so ` +
        `pass a namespace (e.g. namespace: "/POSDW/") to scope the search, or raise maxResults.`
    return { content: [{ type: "text" as const, text: hint }] }
  }

  const typeLabel: Record<string, string> = {
    V: "view→VDAT", S: "table→TABU", C: "cluster→CDAT", T: "txn", D: "doc",
  }
  const scope = ns ? ` in ${args.namespace}` : ""
  const lines: string[] = [
    `IMG activities${scope} matching "${args.keyword}" (${rows.length}):`,
    "",
    `${"IMG activity".padEnd(22)} ${"Title".padEnd(45)} ${"Type".padEnd(12)} ${"Object".padEnd(24)} Tcode`,
    "-".repeat(120),
  ]
  for (const r of rows) {
    const act   = col(r, "ACTIVITY").padEnd(22)
    const title = col(r, "TEXT").slice(0, 45).padEnd(45)
    const t     = col(r, "OBJECTTYPE")
    const type  = (typeLabel[t] ?? t).padEnd(12)
    const obj   = col(r, "OBJECTNAME").padEnd(24)
    const tc    = col(r, "TCODE")
    lines.push(`${act} ${title} ${type} ${obj} ${tc}`)
  }
  lines.push("", `Use customizing_describe <object> to see the table set, key fields, and transport object.`)
  lines.push(`source: CUS_IMGACT raw IMG tables (no STREE search index)`)
  if (truncated) {
    lines.push(
      `⚠️  PARTIAL SCAN — only the first ${max} activities (ordered by ID) were read, so ` +
      `matches outside that window are missing. Pass a namespace to scope, raise maxResults, ` +
      `or deploy the engine (img_search does a full server-side scan).`,
    )
  }
  if (scopeNote) lines.push(scopeNote.trim())

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_describe ─────────────────────────────────────────────────────

export async function handleCustomizingDescribe(args: {
  objectName: string        // view name (TVDIR) or table name (DD02L)
  language?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const lang = (args.language ?? "E").toUpperCase()
  const obj  = args.objectName.toUpperCase().replace(/'/g, "''")

  // 1. Resolve the full maintenance object (view ↔ base + text table set, IMG, transport)
  const maint = await resolveMaint(client, obj)
  const baseTable = maint.rootTable

  // 3. Table metadata: flags live in DD02L, the description in DD02T (NOT DD02T for both).
  const dd02lRows = tableRows(await runSql(client,
    `SELECT TABNAME, TABCLASS, CONTFLAG, CLIDEP, MAINFLAG FROM DD02L WHERE TABNAME = '${baseTable}'`, 1
  ).catch(() => ({ columns: [], values: [] })))
  const dd02tRows = tableRows(await runSql(client,
    `SELECT TABNAME, DDTEXT FROM DD02T WHERE TABNAME = '${baseTable}' AND DDLANGUAGE = '${lang}' AND AS4LOCAL = 'A'`, 1
  ).catch(() => ({ columns: [], values: [] })))
  const dd02 = (dd02lRows[0] || dd02tRows[0])
    ? { ...(dd02lRows[0] ?? {}), ...(dd02tRows[0] ?? {}) }
    : undefined

  // 4. Field list with key flag — structure from DD03L (DD03T holds only the label)
  const dd03Sql =
    `SELECT FIELDNAME, KEYFLAG, ROLLNAME, DATATYPE, LENG, DECIMALS, POSITION ` +
    `FROM DD03L WHERE TABNAME = '${baseTable}' AND AS4LOCAL = 'A' ` +
    `AND FIELDNAME <> '.INCLUDE' ORDER BY POSITION`
  const fields = tableRows(await runSql(client, dd03Sql, 100).catch(() => ({ columns: [], values: [] })))

  // 5. TDDAT — authorization group for the table
  const tddatSql = `SELECT TABNAME, CCLASS FROM TDDAT WHERE TABNAME = '${baseTable}'`
  const tddatRows = tableRows(await runSql(client, tddatSql, 1).catch(() => ({ columns: [], values: [] })))
  const authGroup = (tddatRows[0] ? col(tddatRows[0], "CCLASS") : "") || maint.authGroup || ""

  // 6. View cluster membership comes from the resolver (VCLSTRUC OBJECT = view)
  const clusterName = maint.cluster

  // 7. Foreign key references for key fields (DD08L) — tells us org-unit fields
  const keyFields = fields.filter(f => col(f, "KEYFLAG") === "X").map(f => col(f, "FIELDNAME"))
  let fkRows: Record<string, string>[] = []
  if (keyFields.length > 0) {
    const fkIn = keyFields.map(f => `'${f}'`).join(",")
    const fkSql =
      `SELECT TABNAME, FIELDNAME, CHECKTABLE, CHECKFIELD, FRKEYNAME ` +
      `FROM DD08L WHERE TABNAME = '${baseTable}' AND FIELDNAME IN (${fkIn}) AND AS4LOCAL = 'A'`
    fkRows = tableRows(await runSql(client, fkSql, 20).catch(() => ({ columns: [], values: [] })))
  }

  // ── Format output ──────────────────────────────────────────────────────────

  const lines: string[] = [
    `Customizing object: ${obj}`,
    dd02 ? `Description:        ${col(dd02, "DDTEXT")}` : "",
    `Base table:         ${baseTable}`,
  ]

  if (maint.isView) {
    lines.push(
      `Maintenance view:   ${maint.view}  (${maint.maintTcode ?? "SM30"})`,
      `Table set:          ${maint.tables.join(" + ")}${maint.textTable ? `   (text table: ${maint.textTable})` : ""}`,
      `Function group:     ${maint.funcGroup ?? "?"}   Maint. type: ${maint.maintType === "2" ? "2 (two-step)" : maint.maintType ?? "?"}`,
    )
  }
  if (maint.imgActivity) {
    lines.push(`IMG activity:       ${maint.imgActivity}${maint.imgActivityText ? `  —  ${maint.imgActivityText}` : ""}`)
  }
  lines.push(
    `Transport object:   R3TR ${maint.transport.object} ${maint.transport.name}` +
      (maint.transport.object === "VDAT" ? "   (records the whole view: base + text table)" : ""),
  )
  if (dd02) {
    const cf = col(dd02, "CONTFLAG")
    const cfDesc: Record<string, string> = {
      C: "C — customizing (transport with workbench/cust. request)",
      G: "G — customizing (client-independent)",
      S: "S — system (SAP-managed, not transportable)",
      E: "E — system (client-independent)",
      W: "W — system (client-independent, industry solution)",
      A: "A — application data",
      L: "L — local / temporary",
    }
    lines.push(`Delivery class:     ${cfDesc[cf] ?? cf}`)
    lines.push(`Client-dependent:   ${col(dd02, "CLIDEP") === "X" ? "yes (MANDT key field)" : "no"}`)
  }
  lines.push(`Auth group (TDDAT): ${authGroup || "(none — S_TABU_DIS with &NC& or check TVDIR CCLASS)"}`)

  if (clusterName) {
    lines.push(`View cluster:       ${clusterName} (SM34 → R3TR CDAT; engine writes the member view → VDAT)`)
  }

  if (fields.length > 0) {
    lines.push("", `Fields (${fields.length}):`)
    lines.push(`  ${"Field".padEnd(30)} ${"Key"} ${"Type".padEnd(8)} ${"Len".padEnd(5)} Description`)
    lines.push(`  ${"-".repeat(80)}`)
    for (const f of fields) {
      const key  = col(f, "KEYFLAG") === "X" ? "🔑 " : "   "
      const name = col(f, "FIELDNAME").padEnd(30)
      const dt   = col(f, "DATATYPE").padEnd(8)
      const len  = col(f, "LENG").padEnd(5)
      const desc = col(f, "DDTEXT")
      lines.push(`  ${name} ${key} ${dt} ${len} ${desc}`)
    }
  }

  if (fkRows.length > 0) {
    lines.push("", "Foreign keys on key fields (org-unit candidates):")
    for (const fk of fkRows) {
      lines.push(`  ${col(fk, "FIELDNAME").padEnd(20)} → ${col(fk, "CHECKTABLE")}.${col(fk, "CHECKFIELD")}`)
    }
  }

  lines.push(
    "",
    `Next steps:`,
    `  customizing_read   objectName: ${obj}  — read current config rows`,
    `  customizing_diff   objectName: ${obj}  sourceKey: <val>  targetKey: <val>  keyField: <field>  — compare two org units`,
  )

  return { content: [{ type: "text" as const, text: lines.filter(l => l !== null).join("\n") }] }
}

// ─── customizing_read ─────────────────────────────────────────────────────────

export async function handleCustomizingRead(args: {
  objectName: string
  keyField?: string
  keyValue?: string
  maxRows?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const table  = args.objectName.toUpperCase().replace(/'/g, "''")
  const max    = args.maxRows ?? 100

  // Resolve underlying base table if a view was passed
  const baseTable = (await resolveMaint(client, table)).rootTable

  let whereClause: string | undefined
  if (args.keyField && args.keyValue !== undefined) {
    const kf = args.keyField.toUpperCase().replace(/'/g, "''")
    const kv = args.keyValue.replace(/'/g, "''")
    whereClause = `${kf} = '${kv}'`
  }

  let result: Awaited<ReturnType<typeof client.tableContents>>
  try {
    result = await client.tableContents(baseTable, max, false, whereClause)
  } catch (err) {
    // Fall back to runQuery if tableContents WITH whereClause fails (SICF not active)
    if (whereClause) {
      const sql = `SELECT * FROM ${baseTable} WHERE ${whereClause}`
      result = await client.statelessClone.runQuery(sql, max) as any
    } else {
      throw err
    }
  }

  const text = formatQueryResult(result)
  const header = whereClause
    ? `Customizing: ${baseTable}  WHERE ${whereClause}\n\n`
    : `Customizing: ${baseTable}  (first ${max} rows)\n\n`

  return { content: [{ type: "text" as const, text: header + text }] }
}

// ─── customizing_diff ─────────────────────────────────────────────────────────

export async function handleCustomizingDiff(args: {
  objectName: string
  keyField: string           // e.g. WERKS, BUKRS, VKORG
  sourceKey: string          // e.g. "1000"
  targetKey: string          // e.g. "2000"  (may not exist yet)
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const table  = args.objectName.toUpperCase().replace(/'/g, "''")
  const kf     = args.keyField.toUpperCase().replace(/'/g, "''")
  const src    = args.sourceKey.replace(/'/g, "''")
  const tgt    = args.targetKey.replace(/'/g, "''")

  // Resolve base table
  const baseTable = (await resolveMaint(client, table)).rootTable

  // Fetch both sides in parallel
  const srcSql = `SELECT * FROM ${baseTable} WHERE ${kf} = '${src}'`
  const tgtSql = `SELECT * FROM ${baseTable} WHERE ${kf} = '${tgt}'`

  const [srcResult, tgtResult] = await Promise.all([
    client.statelessClone.runQuery(srcSql, 500),
    client.statelessClone.runQuery(tgtSql, 500),
  ])

  const srcRows = tableRows(srcResult)
  const tgtRows = tableRows(tgtResult)

  // Build a key fingerprint excluding the org-unit field itself and MANDT
  const allFields = srcResult.columns?.map(c => c.name) ?? []
  const nonOrgFields = allFields.filter(f => f !== kf && f !== "MANDT")

  function rowKey(row: Record<string, string>): string {
    return nonOrgFields.map(f => row[f] ?? "").join("|")
  }

  const srcIndex = new Map(srcRows.map(r => [rowKey(r), r]))
  const tgtIndex = new Map(tgtRows.map(r => [rowKey(r), r]))

  const onlyInSrc = srcRows.filter(r => !tgtIndex.has(rowKey(r)))
  const onlyInTgt = tgtRows.filter(r => !srcIndex.has(rowKey(r)))
  const inBoth    = srcRows.filter(r =>  tgtIndex.has(rowKey(r)))

  const lines: string[] = [
    `Customizing diff: ${baseTable}  (${kf}: ${src} → ${tgt})`,
    `Source rows: ${srcRows.length}   Target rows: ${tgtRows.length}`,
    "",
  ]

  if (onlyInSrc.length === 0 && onlyInTgt.length === 0) {
    lines.push(`✅ Configuration is identical (${inBoth.length} matching rows).`)
  } else {
    if (onlyInSrc.length > 0) {
      lines.push(`⬇  In SOURCE (${src}) only — ${onlyInSrc.length} row(s) missing from target:`)
      lines.push(formatQueryResult({ ...srcResult, values: onlyInSrc as any }))
    }
    if (onlyInTgt.length > 0) {
      lines.push(`⬆  In TARGET (${tgt}) only — ${onlyInTgt.length} row(s) not in source:`)
      lines.push(formatQueryResult({ ...tgtResult, values: onlyInTgt as any }))
    }
    if (inBoth.length > 0) {
      lines.push(`✅ ${inBoth.length} row(s) present in both (not shown).`)
    }
    lines.push(
      "",
      `To duplicate missing rows use:`,
      `  customizing_plan_change  objectName: ${args.objectName}  keyField: ${kf}  sourceKey: ${src}  targetKey: ${tgt}`,
    )
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_plan_change ──────────────────────────────────────────────────

export async function handleCustomizingPlanChange(args: {
  objectName: string
  keyField: string
  sourceKey: string
  targetKey: string
  onlyMissing?: boolean      // default true — only rows absent from target
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const table  = args.objectName.toUpperCase().replace(/'/g, "''")
  const kf     = args.keyField.toUpperCase().replace(/'/g, "''")
  const src    = args.sourceKey.replace(/'/g, "''")
  const tgt    = args.targetKey.replace(/'/g, "''")
  const onlyMissing = args.onlyMissing !== false  // default true

  // Resolve the full maintenance object (view ↔ base/text tables, transport object)
  const maint = await resolveMaint(client, table)
  const baseTable = maint.rootTable

  // Delivery class — warn if not transportable customizing.  C/G = customizing,
  // E = control table (SAP + customer key areas) — also transported via the view.
  const dd02Rows = tableRows(await runSql(client,
    `SELECT CONTFLAG, MAINFLAG FROM DD02L WHERE TABNAME = '${baseTable}'`, 1
  ).catch(() => ({ columns: [], values: [] })))
  const contflag = dd02Rows[0] ? col(dd02Rows[0], "CONTFLAG") : "?"
  const isCust = ["C", "G", "E"].includes(contflag)
  const maintAllowed = (dd02Rows[0] ? col(dd02Rows[0], "MAINFLAG") === "X" : true) || maint.isView

  const srcSql = `SELECT * FROM ${baseTable} WHERE ${kf} = '${src}'`
  const tgtSql = `SELECT * FROM ${baseTable} WHERE ${kf} = '${tgt}'`
  const [srcResult, tgtResult] = await Promise.all([
    client.statelessClone.runQuery(srcSql, 500),
    client.statelessClone.runQuery(tgtSql, 500),
  ])

  const srcRows = tableRows(srcResult)
  const tgtRows = tableRows(tgtResult)

  const allFields = srcResult.columns?.map(c => c.name) ?? []
  const nonOrgFields = allFields.filter(f => f !== kf && f !== "MANDT")
  function rowKey(r: Record<string, string>) { return nonOrgFields.map(f => r[f] ?? "").join("|") }

  const tgtIndex = new Map(tgtRows.map(r => [rowKey(r), r]))
  const toInsert = onlyMissing
    ? srcRows.filter(r => !tgtIndex.has(rowKey(r)))
    : srcRows

  // Remap the org-unit key field in each planned row
  const plannedRows = toInsert.map(r => ({ ...r, [kf]: tgt }))

  const lines: string[] = [
    `📋 Change plan (DRY RUN — nothing written)`,
    `   Table:      ${baseTable}`,
    maint.isView
      ? `   Maint. view: ${maint.view}  →  ${maint.tables.join(" + ")}${maint.textTable ? `  (text: ${maint.textTable})` : ""}`
      : `   Maint.:     direct table (no view)`,
    `   Transport:  R3TR ${maint.transport.object} ${maint.transport.name}`,
    `   Key field:  ${kf}  ${src} → ${tgt}`,
    `   Rows to insert: ${plannedRows.length}`,
    `   Only missing:   ${onlyMissing ? "yes" : "no (full copy)"}`,
    `   Delivery class: ${contflag}${isCust ? " ✅ transportable customizing" : " ⚠️  not a customizing table — write requires extra care"}`,
    `   Maintenance:    ${maintAllowed ? "allowed via SM30/SPRO" : "⚠️  maintenance flag off (current settings / read-only)"}`,
    "",
  ]

  if (plannedRows.length === 0) {
    lines.push(`✅ No rows to insert — target ${tgt} already has all ${srcRows.length} source rows.`)
  } else {
    lines.push(`Rows that will be INSERT-ed for ${kf} = '${tgt}':`)
    lines.push(formatQueryResult({ ...srcResult, values: plannedRows as any }))
    lines.push("")
    lines.push(`⚠️  This is a read-only preview.  To write, use customizing_apply, which runs`)
    lines.push(`   VIEW_MAINTENANCE_SINGLE_ENTRY on ${maint.isView ? maint.view : baseTable} inside SAP — the SM30 runtime — to ensure:`)
    lines.push(`     • SM30 maintenance events (FORM routines, time-dependency)`)
    lines.push(`     • Foreign key / domain value checks`)
    lines.push(`     • Change document recording`)
    lines.push(`     • Transport recording as R3TR ${maint.transport.object} ${maint.transport.name}${maint.textTable ? ` (incl. ${maint.textTable})` : ""}`)
    lines.push(`     • S_TABU_DIS / S_TABU_CLI authorization check (VIEW_AUTHORITY_CHECK)`)
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── registration ─────────────────────────────────────────────────────────────

export function registerCustomizingTools(server: McpServer): void {
  server.registerTool(
    "img_search",
    {
      title: "Search IMG / SPRO Activities",
      description:
        "Search the SAP Implementation Guide (IMG / SPRO) for customizing activities by keyword, " +
        "using the IMG index (CUS_IMGACT activity titles) joined to the maintenance object. " +
        "Returns activity IDs, SPRO titles, maintenance objects, and their pattern " +
        "(V=view→VDAT, S=table→TABU, C=cluster→CDAT, T=transaction, D=doc). " +
        "Pass `namespace` to scope (e.g. '/POSDW/' for POS DTA) — recommended, and required for " +
        "free-text matching on this system since its SQL endpoint blocks LIKE scans.",
      inputSchema: {
        keyword:     z.string().describe("Title keyword, matched case-insensitively (e.g. 'tender', 'profile', 'tax type')"),
        namespace:   z.string().optional().describe("Activity-ID prefix to scope the search, e.g. '/POSDW/' (POS DTA). Strongly recommended."),
        inScopeOnly: z.boolean().optional().describe("Keep only activities in the client's activated scope (CUS_IMGACH_SCOPE). Ignored when no scoping data exists."),
        language:    z.string().optional().describe("Language key (default: E)"),
        maxResults:  z.number().optional().describe("Max activities scanned within the scope (default: 200)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleImgSearch
  )

  server.registerTool(
    "customizing_describe",
    {
      title: "Describe Customizing Object",
      description:
        "Describe a SAP customizing view or table: underlying base table, all fields with key markers, " +
        "delivery class (transport behaviour), authorization group (S_TABU_DIS), " +
        "maintenance program, and foreign-key references on key fields (org-unit candidates). " +
        "Use after img_search to understand the structure before reading or changing config.",
      inputSchema: {
        objectName:  z.string().describe("Maintenance view or table name (e.g. V_T001W, T001W, V_T001, TVKO)"),
        language:    z.string().optional().describe("Language key for descriptions (default: E)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingDescribe
  )

  server.registerTool(
    "customizing_read",
    {
      title: "Read Customizing Data",
      description:
        "Read current customizing rows for a SAP table or maintenance view. " +
        "Optionally filter by a single key field value (e.g. plant, company code, sales org). " +
        "The result shows the live configuration — use customizing_diff to compare two org units.",
      inputSchema: {
        objectName:  z.string().describe("Maintenance view or table name (e.g. V_T001W, T001, TVKO)"),
        keyField:    z.string().optional().describe("Key field to filter on (e.g. WERKS, BUKRS, VKORG)"),
        keyValue:    z.string().optional().describe("Value to filter for (e.g. '1000', 'DE01')"),
        maxRows:     z.number().optional().describe("Maximum rows to return (default: 100)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingRead
  )

  server.registerTool(
    "customizing_diff",
    {
      title: "Compare Customizing Between Two Org Units",
      description:
        "Compare customizing configuration for a table/view between two org-unit key values " +
        "(e.g. plant 1000 vs plant 2000, or company code DE01 vs AT01). " +
        "Shows rows present in source but missing from target, and vice versa. " +
        "Use customizing_plan_change to generate the insert plan for the missing rows.",
      inputSchema: {
        objectName:  z.string().describe("Maintenance view or table name"),
        keyField:    z.string().describe("Org-unit key field (e.g. WERKS, BUKRS, VKORG, LGNUM)"),
        sourceKey:   z.string().describe("Source org-unit value (reference, e.g. '1000')"),
        targetKey:   z.string().describe("Target org-unit value (e.g. '2000')"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingDiff
  )

  server.registerTool(
    "customizing_plan_change",
    {
      title: "Plan Customizing Change (Dry Run)",
      description:
        "Preview the rows that would be inserted to duplicate customizing from one org-unit key " +
        "to another (e.g. copy plant 1000 config to new plant 2000). " +
        "DRY RUN ONLY — nothing is written. Shows delivery class, maintenance flags, and the exact " +
        "row set that a Phase-1 Z_CUST_WRITE call would INSERT. " +
        "Review the plan carefully before wiring up the write layer.",
      inputSchema: {
        objectName:  z.string().describe("Maintenance view or table name"),
        keyField:    z.string().describe("Org-unit key field (e.g. WERKS, BUKRS, VKORG)"),
        sourceKey:   z.string().describe("Source org-unit value (reference config)"),
        targetKey:   z.string().describe("New org-unit value to create config for"),
        onlyMissing: z.boolean().optional().describe("Only plan rows absent from target (default: true). Set false to plan a full overwrite."),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingPlanChange
  )
}
