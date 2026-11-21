/**
 * Read-only ABAP in governed mode: the ABAP read tools answered by the engine's class
 * ZCL_MCP_ABAP_ENGINE (operations abap_*) instead of ADT, as the signed-in SAP user.
 *
 * The tools keep their parameters, so an agent calls them the same way in both modes: the ADT URLs
 * they take are turned into an object type and name here, and the answers carry ADT-style URLs again
 * so one tool's output feeds the next. Writing, activating and deleting code stay with SAP's ADT MCP
 * server in governed mode.
 */
import { callEngine, type EngineRequest, type EngineResponse } from "./customizingEngine"
import { engineFixHint } from "../mode"
import type { DdicDescription } from "./customizingSource"

type Args = Record<string, unknown> & { connectionId?: string }
type Result = { content: { type: "text"; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) })

// ─── ADT URL ⇄ object type and name ──────────────────────────────────────────

export interface AbapRef { type: string; name: string; part?: string; group?: string }

const dec = (s: string) => decodeURIComponent(s).toUpperCase()

/** An ADT object or source URL as type, name and (classes) part. Undefined when it is not one this mode reads. */
export function refFromUrl(url: string): AbapRef | undefined {
  const u = url.replace(/[?#].*$/, "").replace(/\/source\/main$/, "").replace(/\/+$/, "")
  let m: RegExpMatchArray | null
  if ((m = u.match(/\/oo\/classes\/([^/]+)(?:\/includes\/([^/]+))?$/i))) return { type: "CLAS", name: dec(m[1]), part: m[2]?.toLowerCase() ?? "main" }
  if ((m = u.match(/\/oo\/interfaces\/([^/]+)$/i))) return { type: "INTF", name: dec(m[1]) }
  if ((m = u.match(/\/programs\/programs\/([^/]+)$/i))) return { type: "PROG", name: dec(m[1]) }
  if ((m = u.match(/\/programs\/includes\/([^/]+)$/i))) return { type: "INCL", name: dec(m[1]) }
  if ((m = u.match(/\/functions\/groups\/([^/]+)\/fmodules\/([^/]+)$/i))) return { type: "FUNC", name: dec(m[2]), group: dec(m[1]) }
  if ((m = u.match(/\/functions\/groups\/([^/]+)\/includes\/([^/]+)$/i))) return { type: "INCL", name: dec(m[2]), group: dec(m[1]) }
  if ((m = u.match(/\/functions\/groups\/([^/]+)$/i))) return { type: "FUGR", name: dec(m[1]) }
  if ((m = u.match(/\/ddic\/(tables|structures)\/([^/]+)$/i))) return { type: "TABL", name: dec(m[2]) }
  if ((m = u.match(/\/ddic\/views\/([^/]+)$/i))) return { type: "VIEW", name: dec(m[1]) }
  if ((m = u.match(/\/ddic\/dataelements\/([^/]+)$/i))) return { type: "DTEL", name: dec(m[1]) }
  if ((m = u.match(/\/ddic\/domains\/([^/]+)$/i))) return { type: "DOMA", name: dec(m[1]) }
  if ((m = u.match(/\/ddic\/tabletypes\/([^/]+)$/i))) return { type: "TTYP", name: dec(m[1]) }
  if ((m = u.match(/\/messageclass\/([^/]+)$/i))) return { type: "MSAG", name: dec(m[1]) }
  if ((m = u.match(/\/packages\/([^/]+)$/i))) return { type: "DEVC", name: dec(m[1]) }
  if ((m = u.match(/object_type\/trant\/object_name\/([^/]+)$/i))) return { type: "TRAN", name: dec(m[1]) }
  return undefined
}

const enc = (s: string) => encodeURIComponent(s.toLowerCase())

/** The ADT URL of an object, as ADT itself names it (so the URL works in legacy-adt mode too). */
export function urlOf(type: string, name: string, group?: string): string {
  switch (type) {
    case "CLAS": return `/sap/bc/adt/oo/classes/${enc(name)}`
    case "INTF": return `/sap/bc/adt/oo/interfaces/${enc(name)}`
    case "PROG": return `/sap/bc/adt/programs/programs/${enc(name)}`
    case "INCL": return `/sap/bc/adt/programs/includes/${enc(name)}`
    case "FUGR": return `/sap/bc/adt/functions/groups/${enc(name)}`
    case "FUNC": return group ? `/sap/bc/adt/functions/groups/${enc(group)}/fmodules/${enc(name)}` : `(function module ${name})`
    case "TABL": return `/sap/bc/adt/ddic/tables/${enc(name)}`
    case "VIEW": return `/sap/bc/adt/ddic/views/${enc(name)}`
    case "DTEL": return `/sap/bc/adt/ddic/dataelements/${enc(name)}`
    case "DOMA": return `/sap/bc/adt/ddic/domains/${enc(name)}`
    case "TTYP": return `/sap/bc/adt/ddic/tabletypes/${enc(name)}`
    case "MSAG": return `/sap/bc/adt/messageclass/${enc(name)}`
    case "DEVC": return `/sap/bc/adt/packages/${enc(name)}`
    case "TRAN": return `/sap/bc/adt/vit/wb/object_type/trant/object_name/${enc(name)}`
    default: return `(${type} ${name})`
  }
}

/** The type part of an ADT type id (PROG/P → PROG) and a few ADT spellings. */
function bareType(t: unknown): string {
  const s = String(t ?? "").toUpperCase().split("/")[0]
  return s === "PROGRAM" ? "PROG" : s === "CLASS" ? "CLAS" : s
}

// ─── the engine call ─────────────────────────────────────────────────────────

/** One abap_* call; an engine without the ABAP part reads as the reason. */
export async function abapCall(connectionId: string | undefined, req: Record<string, unknown>): Promise<EngineResponse> {
  const r = await callEngine(connectionId, req as unknown as EngineRequest)
  if (r.STATUS !== "ok" && (r.MESSAGES ?? []).some(m => /Unknown operation: 'abap_/i.test(m))) {
    return { ...r, MESSAGES: [`The engine on this system (v${r.VERSION ?? "?"}) has no read-only ABAP part yet. ${engineFixHint()}.`] }
  }
  return r
}

/** DATA_JSON as T; the fallback when it is missing, unreadable, or not the fallback's shape (array or object). */
const data = <T>(r: EngineResponse, fallback: T): T => {
  let v: unknown
  try { v = JSON.parse(r.DATA_JSON || "") } catch { return fallback }
  if (v === null || typeof v !== "object" || Array.isArray(v) !== Array.isArray(fallback)) return fallback
  return v as T
}
const notes = (r: EngineResponse) => (r.MESSAGES ?? []).map(m => `Note: ${m}`)
const failed = (what: string, r: EngineResponse) => text([`${what} stopped:`, ...(r.MESSAGES ?? []).map(m => `  ${m}`)].join("\n"), true)
const unknownUrl = (url: unknown) => text(`In governed mode this tool reads programs, includes, classes, interfaces, function groups and modules ` +
  `and DDIC objects; "${String(url)}" is not one of their ADT URLs.`, true)

// ─── the tools ───────────────────────────────────────────────────────────────

interface Obj { TYPE: string; NAME: string; PACKAGE: string; AUTHOR: string; DESCRIPTION: string }

async function search(a: Args): Promise<Result> {
  const r = await abapCall(a.connectionId, { operation: "abap_search", pattern: String(a.query ?? ""),
    object_type: a.objectType ? bareType(a.objectType) : undefined, max_rows: a.maxResults ?? 50 })
  if (r.STATUS !== "ok") return failed("Searching objects", r)
  const hits = data<Obj[]>(r, [])
  if (!hits.length) return text([`No objects match "${a.query}".`, ...notes(r)].join("\n"))
  return text([`${hits.length} object(s) for "${a.query}":`, "",
    ...hits.map(h => `${h.TYPE.padEnd(5)} ${h.NAME.padEnd(32)} ${h.PACKAGE.padEnd(20)} ${h.DESCRIPTION}\n      ${urlOf(h.TYPE, h.NAME)}`),
    ...(notes(r).length ? ["", ...notes(r)] : [])].join("\n"))
}

interface Info { TYPE: string; NAME: string; PACKAGE: string; AUTHOR: string; CREATED_ON: string; CHANGED_BY: string; CHANGED_ON: string
  LANGUAGE: string; DESCRIPTION: string; SUBTYPE: string; OWNER_TYPE: string; OWNER_NAME: string; INACTIVE: boolean | string; PARTS: string[] }

async function info(a: Args): Promise<Result> {
  const ref = refFromUrl(String(a.url ?? ""))
  if (!ref) return unknownUrl(a.url)
  const r = await abapCall(a.connectionId, { operation: "abap_info", object_type: ref.type, name: ref.name })
  if (r.STATUS !== "ok") return failed(`Reading ${ref.type} ${ref.name}`, r)
  const i = data<Info>(r, {} as Info)
  const line = (k: string, v: unknown) => (v === undefined || v === "" || v === null ? [] : [`${k.padEnd(13)} ${v}`])
  return text([
    ...line("Name", i.NAME), ...line("Type", `${i.TYPE}${i.SUBTYPE ? ` (${i.SUBTYPE})` : ""}`), ...line("Description", i.DESCRIPTION),
    ...line("Package", i.PACKAGE), ...line("Author", i.AUTHOR), ...line("Created on", i.CREATED_ON),
    ...line("Changed by", i.CHANGED_BY), ...line("Changed on", i.CHANGED_ON), ...line("Language", i.LANGUAGE),
    ...(i.OWNER_TYPE ? line("Belongs to", `${i.OWNER_TYPE} ${i.OWNER_NAME}`) : []),
    ...line("Inactive", i.INACTIVE === true || i.INACTIVE === "X" ? "yes, an inactive version exists" : ""),
    ...line("URL", urlOf(ref.type, ref.name, ref.group ?? (i.OWNER_TYPE === "FUGR" ? i.OWNER_NAME : undefined))),
    ...(i.PARTS?.length ? ["", "Parts:", ...i.PARTS.map(p => `  ${p}`)] : []),
    ...(notes(r).length ? ["", ...notes(r)] : []),
  ].join("\n"))
}

interface Src { TYPE: string; NAME: string; PART: string; PROGRAM: string; LINES: string[] }

async function sourceOf(connectionId: string | undefined, url: string): Promise<{ ok: true; src: Src } | { ok: false; result: Result }> {
  const ref = refFromUrl(url)
  if (!ref) return { ok: false, result: unknownUrl(url) }
  const r = await abapCall(connectionId, { operation: "abap_source", object_type: ref.type, name: ref.name, include: ref.part })
  if (r.STATUS !== "ok") return { ok: false, result: failed(`Reading the source of ${ref.type} ${ref.name}`, r) }
  const src = data<Partial<Src>>(r, {})
  return { ok: true, src: { TYPE: ref.type, NAME: ref.name, PART: ref.part ?? "main", PROGRAM: "", ...src, LINES: Array.isArray(src.LINES) ? src.LINES : [] } }
}

async function source(a: Args): Promise<Result> {
  const s = await sourceOf(a.connectionId, String(a.url ?? ""))
  return s.ok ? text(s.src.LINES.join("\n")) : s.result
}

async function batch(a: Args): Promise<Result> {
  const urls = Array.isArray(a.urls) ? a.urls.map(String) : []
  const out: string[] = []
  for (const url of urls) {
    const s = await sourceOf(a.connectionId, url)
    out.push(`===== ${url} =====`, s.ok ? s.src.LINES.join("\n") : `ERROR: ${s.result.content[0].text}`, "")
  }
  return text(out.join("\n"))
}

async function grep(a: Args): Promise<Result> {
  let re: RegExp
  try { re = new RegExp(String(a.pattern ?? ""), "i") } catch (e) { return text(`Invalid regular expression: ${(e as Error).message}`, true) }
  const s = await sourceOf(a.connectionId, String(a.url ?? ""))
  if (!s.ok) return s.result
  const hits = s.src.LINES.map((l, i) => [i + 1, l] as const).filter(([, l]) => re.test(l))
  if (!hits.length) return text(`No line of ${s.src.NAME} matches /${a.pattern}/i (${s.src.LINES.length} lines searched).`)
  return text([`${hits.length} matching line(s) in ${s.src.NAME}${s.src.PART && s.src.PART !== "main" ? ` (${s.src.PART})` : ""}:`,
    ...hits.map(([n, l]) => `${String(n).padStart(5)}: ${l}`)].join("\n"))
}

interface Use { INCLUDE: string; MAIN_TYPE: string; MAIN_NAME: string; METHOD: string; KIND: string }

async function whereUsed(a: Args): Promise<Result> {
  const ref = refFromUrl(String(a.url ?? ""))
  if (!ref) return unknownUrl(a.url)
  const r = await abapCall(a.connectionId, { operation: "abap_where_used", object_type: ref.type, name: ref.name })
  if (r.STATUS !== "ok") return failed(`Where-used for ${ref.type} ${ref.name}`, r)
  const uses = data<Use[]>(r, [])
  const symbol = a.line !== undefined ? [`(line/column are not used in governed mode: this lists where the whole object is used.)`] : []
  if (!uses.length) return text([`No usages of ${ref.type} ${ref.name} found.`, ...symbol, ...notes(r)].join("\n"))
  return text([`${uses.length} place(s) using ${ref.type} ${ref.name}:`, "",
    ...uses.map(u => `${u.MAIN_TYPE.padEnd(5)} ${u.MAIN_NAME}${u.METHOD ? ` → ${u.METHOD}` : ""}   (${u.INCLUDE}, ${u.KIND})\n      ${urlOf(u.MAIN_TYPE, u.MAIN_NAME, u.MAIN_TYPE === "FUGR" ? u.MAIN_NAME : undefined)}`),
    "", ...symbol, ...notes(r)].join("\n"))
}

interface Ver { OBJTYPE: string; OBJNAME: string; VERSNO: string; DATE: string; TIME: string; AUTHOR: string; TRANSPORT: string }

async function versions(a: Args): Promise<Result> {
  const ref = refFromUrl(String(a.url ?? ""))
  if (!ref) return unknownUrl(a.url)
  const r = await abapCall(a.connectionId, { operation: "abap_versions", object_type: ref.type, name: ref.name })
  if (r.STATUS !== "ok") return failed(`Versions of ${ref.type} ${ref.name}`, r)
  const v = data<Ver[]>(r, [])
  if (!v.length) return text(`No versions of ${ref.type} ${ref.name} found.`)
  return text([`${v.length} version(s) of ${ref.type} ${ref.name}:`, "",
    ...v.map(x => `${x.VERSNO}  ${x.DATE} ${x.TIME}  ${x.AUTHOR.padEnd(12)} ${x.TRANSPORT.padEnd(10)} ${x.OBJTYPE} ${x.OBJNAME}`), "", ...notes(r)].join("\n"))
}

interface Pkg { PACKAGE: string; DESCRIPTION: string; PARENT: string; OBJECTS: Obj[]; MORE: number }

async function browsePackage(a: Args): Promise<Result> {
  const r = await abapCall(a.connectionId, { operation: "abap_package", package: String(a.packageName ?? ""),
    subpackages: a.includeSubPackages === true, max_rows: a.maxObjects ?? 500 })
  if (r.STATUS !== "ok") return failed(`Browsing package ${a.packageName}`, r)
  const out: string[] = []
  for (const p of data<Pkg[]>(r, [])) {
    out.push(`📦 ${p.PACKAGE}${p.DESCRIPTION ? ` — ${p.DESCRIPTION}` : ""}${p.PARENT ? `  (in ${p.PARENT})` : ""}`)
    const byType = new Map<string, Obj[]>()
    for (const o of p.OBJECTS ?? []) byType.set(o.TYPE, [...(byType.get(o.TYPE) ?? []), o])
    for (const [t, list] of byType) {
      out.push(`  ${t} (${list.length})`, ...list.map(o => `    ${o.NAME.padEnd(32)} ${o.DESCRIPTION}`))
    }
    if (!p.OBJECTS?.length) out.push("  (no objects)")
    if (p.MORE) out.push(`  … and ${p.MORE} more`)
    out.push("")
  }
  return text([...out, ...notes(r)].join("\n").trim())
}

interface TextEl { ID: string; KEY: string; ENTRY: string; LENGTH: number }

async function textElements(a: Args): Promise<Result> {
  const type = bareType(a.objectType)
  const r = await abapCall(a.connectionId, { operation: "abap_text_elements", object_type: type, name: String(a.objectName ?? "") })
  if (r.STATUS !== "ok") return failed(`Reading text elements of ${type} ${a.objectName}`, r)
  const els = data<TextEl[]>(r, [])
  const want = a.category as string | undefined
  const sel = els.filter(e => e.ID === "S"), sym = els.filter(e => e.ID === "I"), head = els.filter(e => ["H", "R", "T"].includes(e.ID))
  const out: string[] = [`Text elements of ${type} ${String(a.objectName).toUpperCase()}:`]
  if (!want || want === "selections") {
    out.push("", `Selection texts (${sel.length}):`, ...sel.map(e => {
      const ddic = e.ENTRY.startsWith("        D") || /^\s{8}D\s*$/.test(e.ENTRY)
      return `  ${e.KEY.padEnd(10)} ${ddic ? "(from the dictionary)" : e.ENTRY.slice(8).trim()}`
    }))
  }
  if (!want || want === "symbols") out.push("", `Text symbols (${sym.length}):`, ...sym.map(e => `  ${e.KEY.padEnd(4)} ${e.ENTRY}  (max ${e.LENGTH})`))
  if (!want || want === "headings") out.push("", `Title and headings (${head.length}):`, ...head.map(e => `  ${e.ID} ${e.KEY.padEnd(4)} ${e.ENTRY}`))
  return text([...out, "", ...notes(r)].join("\n").trim())
}

interface Inactive { USER: string; TYPE: string; NAME: string; DELETED: boolean | string }

async function inactive(a: Args): Promise<Result> {
  const r = await abapCall(a.connectionId, { operation: "abap_inactive" })
  if (r.STATUS !== "ok") return failed("Listing inactive objects", r)
  const list = data<Inactive[]>(r, [])
  if (!list.length) return text("No inactive objects in your worklist.")
  return text([`${list.length} inactive object(s) in your worklist:`, "",
    ...list.map(o => `${o.TYPE.padEnd(5)} ${o.NAME}${o.DELETED === true || o.DELETED === "X" ? "  (deletion pending)" : ""}`)].join("\n"))
}

interface Tab { NAME: string; KIND: string; PACKAGE: string; DESCRIPTION: string }

async function tables(a: Args): Promise<Result> {
  const kw = String(a.keyword ?? "").trim()
  // a name pattern (letters, digits, _ / and *) searches names; anything else, and a plain word, also the descriptions
  const looksLikeName = /^[A-Za-z0-9_/*]+$/.test(kw)
  const r = await abapCall(a.connectionId, { operation: "abap_tables",
    pattern: looksLikeName ? (kw.includes("*") ? kw : `${kw}*`) : undefined,
    keyword: kw.includes("*") ? undefined : kw.replace(/\*/g, ""), max_rows: a.maxResults ?? 50 })
  if (r.STATUS !== "ok") return failed(`Searching tables for "${kw}"`, r)
  const list = data<Tab[]>(r, [])
  if (!list.length) return text(`No tables or views found for "${kw}".`)
  return text([`${list.length} table(s)/view(s) for "${kw}":`, "",
    ...list.map(t => `${t.KIND.padEnd(7)} ${t.NAME.padEnd(30)} ${t.PACKAGE.padEnd(20)} ${t.DESCRIPTION}`)].join("\n"))
}

async function describeTable(a: Args): Promise<Result> {
  const table = String(a.tableName ?? "").toUpperCase()
  const r = await callEngine(a.connectionId, { operation: "ddic_describe", table, language: "E" } as EngineRequest)
  if (r.STATUS !== "ok") return failed(`Describing ${table}`, r)
  const d = data<DdicDescription>(r, {} as DdicDescription)
  const fields = d.FIELDS ?? []
  const keys = fields.filter(f => f.KEYFLAG === "X")
  return text([`Table: ${d.ROOT_TABLE || table}${d.DDTEXT ? ` — ${d.DDTEXT}` : ""}`,
    `Fields: ${fields.length} total, ${keys.length} key field(s)${d.TABCLASS ? `; class ${d.TABCLASS}` : ""}${d.CONTFLAG ? `, delivery class ${d.CONTFLAG}` : ""}`, "",
    `${"Field".padEnd(34)} ${"Type".padEnd(6)} ${"Length".padEnd(8)} Data element        Description`, "-".repeat(96),
    ...fields.map(f => `  ${f.KEYFLAG === "X" ? "🔑" : "  "} ${f.FIELDNAME.padEnd(30)} ${(f.DATATYPE ?? "").padEnd(6)} ${`(${Number(f.LENG ?? 0)}${Number(f.DECIMALS ?? 0) ? `,${Number(f.DECIMALS)}` : ""})`.padEnd(8)} ${(f.ROLLNAME ?? "").padEnd(19)} ${f.DDTEXT ?? ""}`),
    "", `Key fields: ${keys.map(k => k.FIELDNAME).join(", ") || "none"}`].join("\n"))
}

interface Syn { PROGRAM: string; CHECKED: string; OK: boolean | string; MESSAGE: string; INCLUDE: string; LINE: number; WORD: string }

async function syntax(a: Args): Promise<Result> {
  const ref = refFromUrl(String(a.url ?? ""))
  if (!ref) return unknownUrl(a.url)
  const r = await abapCall(a.connectionId, { operation: "abap_syntax", object_type: ref.type, name: ref.name, source: a.source })
  if (r.STATUS !== "ok") return failed(`Syntax check of ${ref.type} ${ref.name}`, r)
  const s = data<Syn>(r, {} as Syn)
  const ok = s.OK === true || s.OK === "X"
  return text([ok ? `✅ No syntax errors in ${ref.type} ${ref.name} (${s.CHECKED}, program ${s.PROGRAM}).`
    : `❌ ${s.INCLUDE || s.PROGRAM}:${s.LINE}: ${s.MESSAGE}${s.WORD ? `  (at "${s.WORD}")` : ""}\n   Checked ${s.CHECKED} of program ${s.PROGRAM}.`,
    ...notes(r)].join("\n"))
}

interface Dump { DATE: string; TIME: string; USER: string; CLIENT: string; HOST: string; ERROR: string; PROGRAM: string; INCLUDE: string; LINE: string }

async function dumps(a: Args): Promise<Result> {
  const r = await abapCall(a.connectionId, { operation: "abap_dumps", all_users: true, days: 7, max_rows: 100 })
  if (r.STATUS !== "ok") return failed("Listing dumps", r)
  let list = data<Dump[]>(r, [])
  const q = String(a.query ?? "").trim().toLowerCase()
  if (q) list = list.filter(d => Object.values(d).some(v => String(v).toLowerCase().includes(q)))
  if (!list.length) return text([`No dumps${q ? ` matching "${a.query}"` : ""} in the last 7 days.`, ...notes(r)].join("\n"))
  const d8 = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, t6 = (t: string) => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
  return text([`${list.length} dump(s):`, "",
    ...list.map(d => `${d8(d.DATE)} ${t6(d.TIME)}  ${d.ERROR.padEnd(30)} ${d.USER.padEnd(12)} client ${d.CLIENT}\n      ${d.PROGRAM}${d.INCLUDE && d.INCLUDE !== d.PROGRAM ? ` / ${d.INCLUDE}` : ""}${d.LINE ? ` line ${d.LINE}` : ""}`),
    "", ...notes(r)].join("\n"))
}

/** Governed-mode handlers, by the legacy tool name they stand in for. */
export const GOVERNED_ABAP_HANDLERS: Record<string, (a: Args) => Promise<Result>> = {
  search_abap_objects: search,
  get_abap_object_info: info,
  get_abap_object_lines: source,
  get_abap_batch_lines: batch,
  search_abap_object_lines: grep,
  where_used: whereUsed,
  version_history: versions,
  browse_package: browsePackage,
  get_text_elements: textElements,
  check_inactive_objects: inactive,
  search_database_tables: tables,
  describe_database_table: describeTable,
  syntax_check: syntax,
  analyze_dump: dumps,
}
