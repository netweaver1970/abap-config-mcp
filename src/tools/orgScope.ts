/**
 * Retest scope of an org-unit copy (org_copy).
 *
 * The entity copier (EC01/EC02/…) copies a fixed set of dependent tables. The
 * trouble after a copy is rarely in that set: it is in the tables keyed on the
 * same org unit that the copier does NOT touch. The new plant looks complete in
 * SPRO, and the first goods movement or pricing run fails on a missing entry.
 *
 * This module lists, for an org-key domain (WERKS, BUKRS, VKORG, …):
 *   copied      — the copier's own tables, with source / target row counts
 *   notCopied   — customizing tables (delivery class C, G, E) with a key field
 *                 on the domain that the copier leaves alone; those where the
 *                 SOURCE has rows and the TARGET has none are the retest list
 *   application — application / master-data tables (class A) keyed on the
 *                 domain where the source has rows: created by business
 *                 processes, not copied, summarised only
 *
 * The same report run after the copy (source vs. the now-existing target) is
 * the diff: every count is read from the live tables.
 *
 * Bounded: one DDIC query finds the candidates, then each statement counts up to
 * BATCH tables in a UNION ALL, PARALLEL statements at a time, until the deadline.
 * A statement that fails is split in halves until the table that breaks it is
 * found and marked unreadable.
 */

import type { ADTClient } from "abap-adt-api"
import { runSql, tableRows, col } from "./customizing"
import { log } from "../connections"

export const CUST_CLASSES = ["C", "G", "E"]
const BATCH = 40
const PARALLEL = 4
const MAX_CANDIDATES = 5000

export interface ScopeTable {
  tab: string
  field?: string           // key field on the org domain (absent: copier table not keyed on it)
  cls?: string             // DD02L-CONTFLAG
  text?: string
  src?: number             // rows for the source key (undefined: not counted)
  tgt?: number             // rows for the target key
  unreadable?: boolean
}

export interface OrgScope {
  domain: string
  sourceKey: string
  targetKey: string
  copied: ScopeTable[]
  notCopied: ScopeTable[]     // C/G/E outside the copier's set, counted
  application: ScopeTable[]   // A, counted
  notProbed: ScopeTable[]     // ran out of time before these were counted
  candidates: number          // tables keyed on the domain (client-dependent, transparent)
  truncated: boolean          // more candidates than MAX_CANDIDATES
}

const q = (s: string) => s.replace(/'/g, "''")
const isName = (s: string) => /^[A-Z0-9_/]+$/.test(s)

/** Tables (client-dependent, transparent, active) with a KEY field on the domain. First such field per table. */
export async function findKeyedTables(client: ADTClient, domain: string): Promise<{ tables: ScopeTable[]; truncated: boolean }> {
  const sql =
    `SELECT a~TABNAME, a~FIELDNAME, a~POSITION, b~CONTFLAG FROM DD03L AS a` +
    ` INNER JOIN DD02L AS b ON b~TABNAME = a~TABNAME AND b~AS4LOCAL = a~AS4LOCAL AND b~AS4VERS = a~AS4VERS` +
    ` WHERE a~DOMNAME = '${q(domain)}' AND a~KEYFLAG = 'X' AND a~AS4LOCAL = 'A'` +
    ` AND b~TABCLASS = 'TRANSP' AND b~CLIDEP = 'X' AND b~CONTFLAG IN ('C','G','E','A')` +
    ` ORDER BY a~TABNAME, a~POSITION`
  const rows = tableRows(await runSql(client, sql, MAX_CANDIDATES))
  const byTab = new Map<string, ScopeTable>()
  for (const r of rows) {
    const tab = col(r, "TABNAME"), field = col(r, "FIELDNAME")
    if (!tab || !field || byTab.has(tab) || !isName(tab) || !isName(field)) continue
    byTab.set(tab, { tab, field, cls: col(r, "CONTFLAG") })
  }
  return { tables: [...byTab.values()], truncated: rows.length >= MAX_CANDIDATES }
}

/** One statement counting source and target rows for each table. */
export function countSql(tables: ScopeTable[], sourceKey: string, targetKey: string): string {
  const keys = [...new Set([sourceKey, targetKey].filter(Boolean))].map(k => `'${q(k)}'`).join(",")
  return tables.map(t =>
    `SELECT '${t.tab}' AS T, ${t.field} AS K, COUNT(*) AS N FROM ${t.tab}` +
    ` WHERE ${t.field} IN (${keys}) GROUP BY ${t.field}`).join("\nUNION ALL ")
}

/**
 * Count source / target rows for every table (in place). Tables not reached
 * before the deadline keep src undefined. Returns nothing; read the tables.
 */
export async function countRows(client: ADTClient, tables: ScopeTable[], sourceKey: string, targetKey: string,
                                 deadline: number, batch = BATCH, parallel = PARALLEL): Promise<void> {
  const queue: ScopeTable[][] = []
  for (let i = 0; i < tables.length; i += batch) queue.push(tables.slice(i, i + batch))

  const run = async (group: ScopeTable[]): Promise<void> => {
    if (Date.now() >= deadline) return
    try {
      const rows = tableRows(await runSql(client, countSql(group, sourceKey, targetKey), group.length * 2 + 10))
      for (const t of group) { t.src = 0; t.tgt = 0 }
      const byTab = new Map(group.map(t => [t.tab, t]))
      for (const r of rows) {
        const t = byTab.get(col(r, "T"))
        if (!t) continue
        const k = col(r, "K"), n = Number(col(r, "N")) || 0
        if (k === sourceKey.trim()) t.src = n
        if (k === targetKey.trim()) t.tgt = n
      }
    } catch (err) {
      if (group.length === 1) {
        group[0].unreadable = true
        log("DEBUG", `org scope: ${group[0].tab} unreadable`, err)
        return
      }
      const half = Math.ceil(group.length / 2)
      await run(group.slice(0, half))
      await run(group.slice(half))
    }
  }

  const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) await run(g)
  })
  await Promise.all(workers)
}

/** DD02T short texts, IN lists chunked by 8. Best effort. */
export async function tableTexts(client: ADTClient, tables: ScopeTable[]): Promise<void> {
  const need = tables.filter(t => !t.text)
  const chunks: ScopeTable[][] = []
  for (let i = 0; i < need.length; i += 8) chunks.push(need.slice(i, i + 8))
  await Promise.all(chunks.map(async ch => {
    try {
      const rows = tableRows(await runSql(client,
        `SELECT TABNAME, DDTEXT FROM DD02T WHERE DDLANGUAGE = 'E' AND AS4LOCAL = 'A'` +
        ` AND TABNAME IN (${ch.map(t => `'${t.tab}'`).join(",")})`, 20))
      for (const r of rows) {
        const t = ch.find(x => x.tab === col(r, "TABNAME"))
        if (t) t.text = col(r, "DDTEXT")
      }
    } catch { /* texts are decoration */ }
  }))
}

/** Build the three-section scope. copiedSet = the copier's dependent tables (engine dry run). */
export async function buildOrgScope(client: ADTClient, args: {
  domain: string; sourceKey: string; targetKey: string
  copiedSet: Array<{ tab: string; text?: string }>
  deadline: number
}): Promise<OrgScope> {
  const { domain, sourceKey, targetKey, deadline } = args
  const { tables, truncated } = await findKeyedTables(client, domain)
  const keyed = new Map(tables.map(t => [t.tab, t]))
  const copiedNames = new Set(args.copiedSet.map(c => c.tab.toUpperCase()))

  const copied: ScopeTable[] = args.copiedSet.map(c => {
    const k = keyed.get(c.tab.toUpperCase())
    return k ? { ...k, text: c.text || undefined } : { tab: c.tab.toUpperCase(), text: c.text || undefined }
  })
  const rest = tables.filter(t => !copiedNames.has(t.tab))
  const cust = rest.filter(t => CUST_CLASSES.includes(t.cls ?? ""))
  const app = rest.filter(t => t.cls === "A")

  // Priority under the deadline: customizing first (the retest list), then the
  // copier's own tables, then application data (a summary only).
  await countRows(client, [...cust, ...copied.filter(c => c.field), ...app], sourceKey, targetKey, deadline)

  const counted = (t: ScopeTable) => t.src !== undefined || t.unreadable
  const scope: OrgScope = {
    domain, sourceKey, targetKey, copied,
    notCopied: cust.filter(counted),
    application: app.filter(counted),
    notProbed: [...cust, ...app].filter(t => !counted(t)),
    candidates: tables.length,
    truncated,
  }
  // Texts only for what gets listed by name.
  const listed = [
    ...retestList(scope).slice(0, LIST_RETEST),
    ...scope.notCopied.filter(t => (t.src ?? 0) > 0 && (t.tgt ?? 0) > 0).slice(0, LIST_BOTH),
  ]
  if (Date.now() < deadline) await tableTexts(client, listed)
  return scope
}

const LIST_RETEST = 40
const LIST_BOTH = 15
const LIST_COPIED = 40
const LIST_APP = 8

/** Not copied, source has rows, target has none — most rows first. */
export function retestList(s: OrgScope): ScopeTable[] {
  return s.notCopied.filter(t => (t.src ?? 0) > 0 && (t.tgt ?? 0) === 0)
    .sort((a, b) => (b.src ?? 0) - (a.src ?? 0) || a.tab.localeCompare(b.tab))
}

const n = (v?: number) => v === undefined ? "–" : String(v)
const row = (t: ScopeTable) =>
  `     ${t.tab.padEnd(18)} ${(t.field ?? "").padEnd(12)} ${n(t.src).padStart(6)} → ${n(t.tgt).padEnd(6)} ${t.text ?? ""}`.trimEnd()

export function formatOrgScope(s: OrgScope): string[] {
  const out: string[] = ["", `   ═══ Retest scope: ${s.domain} ${s.sourceKey} → ${s.targetKey}  (rows: source → target, read live) ═══`]

  // 1 — copied
  const cop = [...s.copied].sort((a, b) => (b.src ?? -1) - (a.src ?? -1) || a.tab.localeCompare(b.tab))
  const skipped = s.copied.filter(t => (t.src ?? 0) > 0 && t.tgt === 0)
  out.push("", `   ✅ Copied by the entity copier — ${s.copied.length} table(s)` +
    (s.copied.length > LIST_COPIED ? ` (first ${LIST_COPIED}, most source rows first)` : "") + ":")
  for (const t of cop.slice(0, LIST_COPIED)) out.push(row(t))
  if (s.copied.some(t => !t.field)) out.push(`     (– : not keyed directly on ${s.domain}, not counted)`)
  if (skipped.length) out.push(`     Source rows, none for the target: ${skipped.length} — ${names(skipped)} ` +
    `(expected before the copy; after it, check these).`)

  // 2 — not copied
  const retest = retestList(s)
  const both = s.notCopied.filter(t => (t.src ?? 0) > 0 && (t.tgt ?? 0) > 0)
  const tgtOnly = s.notCopied.filter(t => (t.src ?? 0) === 0 && (t.tgt ?? 0) > 0)
  const empty = s.notCopied.filter(t => (t.src ?? 0) === 0 && (t.tgt ?? 0) === 0 && !t.unreadable)
  const unreadable = s.notCopied.filter(t => t.unreadable)
  out.push("", `   ⚠️  Not copied — check these: ${s.notCopied.length} customizing table(s) (class C/G/E) ` +
    `keyed on ${s.domain} outside the copier's set`)
  out.push(`     RETEST FIRST — source has rows, target has none: ${retest.length}` +
    (retest.length > LIST_RETEST ? ` (first ${LIST_RETEST})` : ""))
  for (const t of retest.slice(0, LIST_RETEST)) out.push(row(t))
  if (both.length) {
    out.push(`     Both have rows (compare with customizing_diff): ${both.length}`)
    for (const t of both.slice(0, LIST_BOTH)) out.push(row(t))
    if (both.length > LIST_BOTH) out.push(`     … ${both.length - LIST_BOTH} more`)
  }
  if (tgtOnly.length) out.push(`     Target only: ${tgtOnly.length} — ${names(tgtOnly)}`)
  out.push(`     Source has no rows (nothing to carry over): ${empty.length}`)
  if (unreadable.length) out.push(`     Could not be read: ${unreadable.length} — ${names(unreadable)}`)

  // 3 — application
  const appSrc = s.application.filter(t => (t.src ?? 0) > 0).sort((a, b) => (b.src ?? 0) - (a.src ?? 0))
  out.push("", `   ℹ️  Not customizing — application / master data (class A) keyed on ${s.domain}: ` +
    `${appSrc.length} of ${s.application.length} table(s) have source rows` +
    (appSrc.some(t => (t.tgt ?? 0) > 0) ? ` (target has rows in ${appSrc.filter(t => (t.tgt ?? 0) > 0).length})` : "") +
    (appSrc.length ? `, e.g. ${appSrc.slice(0, LIST_APP).map(t => `${t.tab} (${t.src})`).join(", ")}` : ""))
  out.push(`     Created by business processes (material extension, postings, …), not copied by design.`)

  if (s.notProbed.length) {
    const c = s.notProbed.filter(t => CUST_CLASSES.includes(t.cls ?? "")).length
    out.push("", `   ⏱  Time budget reached: ${s.notProbed.length} table(s) not counted ` +
      `(${c} customizing, ${s.notProbed.length - c} application). Re-run for the rest, or check them with execute_data_query.`)
  }
  if (s.truncated) out.push(`   (More than ${MAX_CANDIDATES} key fields on ${s.domain}; the list was cut there.)`)
  return out
}

const names = (ts: ScopeTable[], max = 10) =>
  ts.slice(0, max).map(t => t.tab).join(", ") + (ts.length > max ? `, … ${ts.length - max} more` : "")
