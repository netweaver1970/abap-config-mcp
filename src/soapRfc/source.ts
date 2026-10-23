/**
 * ABAP source reads over SOAP RFC.
 *
 * Which read FM a system offers, and whether it is remote-enabled, differs by
 * release, so the first source read on a connection probes it: TFDIR (does the
 * FM exist, FMODE = 'R'?) and FUPARAREF (which parameters does it have?), both
 * through RFC_READ_TABLE. RPY_PROGRAM_READ with SOURCE_EXTENDED gives full
 * 255-character lines; RFC_READ_REPORT (on every release) and the plain SOURCE
 * table of RPY_PROGRAM_READ give 72-character lines.
 *
 * Objects are named by ADT URL (as on ADT connections) or TYPE:NAME. Programs and
 * includes are read as they are; a function module through its include (TFDIR
 * PNAME/INCLUDE); a class as its class pool with every include of the class
 * expanded in place; an interface through its IU include.
 */
import { callRfc, RfcRow } from "./client"
import { readTable } from "./readTable"

export type SourceKind = "PROG" | "INCL" | "FUNC" | "FUGR" | "CLAS" | "INTF"

export interface SourceTarget {
  kind: SourceKind
  name: string
  /** For a class: one local include (CCDEF, CCIMP, CCMAC, CCAU) instead of the whole class */
  classInclude?: string
}

const CLASS_PARTS: Record<string, string> = {
  definitions: "CCDEF", implementations: "CCIMP", macros: "CCMAC", testclasses: "CCAU",
}

const KINDS: Record<string, SourceKind> = {
  PROG: "PROG", REPS: "INCL", INCL: "INCL", FUNC: "FUNC", FUGR: "FUGR", CLAS: "CLAS", INTF: "INTF",
}

/** Map an ADT URL (/sap/bc/adt/…) or TYPE:NAME (PROG:Z_REPORT, FUNC:Z_FM, CLAS:ZCL_X, INCL:…, INTF:…, FUGR:…) to an object. */
export function sourceTarget(ref: string): SourceTarget {
  const t = parseTarget(ref)
  // The name goes into WHERE literals and FM parameters: repository names only.
  if (!/^[A-Z0-9_/]{1,40}$/.test(t.name)) throw new Error(`Invalid object name "${t.name}" in ${ref}.`)
  return t
}

function parseTarget(ref: string): SourceTarget {
  const s = ref.trim()
  const short = /^([A-Z]{4})[:/\s]+(\S+)$/i.exec(s)
  if (short && KINDS[short[1].toUpperCase()]) return { kind: KINDS[short[1].toUpperCase()], name: short[2].toUpperCase() }

  const path = s.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "")
  const seg = path.split("/").filter(Boolean).map(p => decodeURIComponent(p))
  const at = seg.indexOf("adt")
  const p = at >= 0 ? seg.slice(at + 1) : []
  const up = (x: string | undefined) => (x ?? "").toUpperCase()
  if (p[0] === "programs" && p[1] === "programs" && p[2]) return { kind: "PROG", name: up(p[2]) }
  if (p[0] === "programs" && p[1] === "includes" && p[2]) return { kind: "INCL", name: up(p[2]) }
  if (p[0] === "functions" && p[1] === "groups" && p[2]) {
    if (p[3] === "fmodules" && p[4]) return { kind: "FUNC", name: up(p[4]) }
    if (p[3] === "includes" && p[4]) return { kind: "INCL", name: up(p[4]) }
    return { kind: "FUGR", name: up(p[2]) }
  }
  if (p[0] === "oo" && p[1] === "classes" && p[2]) {
    const part = p[3] === "includes" ? CLASS_PARTS[p[4] ?? ""] : undefined
    if (p[3] === "includes" && p[4] !== "main" && !part) throw new Error(`Unknown class include "${p[4]}" in ${ref}.`)
    return { kind: "CLAS", name: up(p[2]), ...(part ? { classInclude: part } : {}) }
  }
  if (p[0] === "oo" && p[1] === "interfaces" && p[2]) return { kind: "INTF", name: up(p[2]) }
  throw new Error(
    `Cannot tell which object "${ref}" is. On a SOAP RFC connection name it by ADT URL ` +
    `(/sap/bc/adt/programs/programs/<name>, …/functions/groups/<group>/fmodules/<fm>, …/oo/classes/<class>) or TYPE:NAME ` +
    `(PROG:, INCL:, FUNC:, FUGR:, CLAS:, INTF:).`)
}

/** /NS/NAME → ["/NS/", "NAME"]; NAME → ["", "NAME"] */
const splitNamespace = (n: string): [string, string] => {
  const m = /^(\/[^/]+\/)(.*)$/.exec(n)
  return m ? [m[1], m[2]] : ["", n]
}

/** The main program of a function group: SAPL<group>, inside the namespace. */
export function groupProgram(group: string): string {
  const [ns, g] = splitNamespace(group)
  return `${ns}SAPL${g}`
}

/** The include holding a function module, from TFDIR's PNAME (SAPL<group>) and INCLUDE (nn): L<group>U<nn>. */
export function functionInclude(pname: string, include: string): string {
  const [ns, prog] = splitNamespace(pname.trim())
  if (!/^SAPL/i.test(prog)) throw new Error(`Unexpected main program ${pname} for a function module.`)
  return `${ns}L${prog.slice(4)}U${include.trim().padStart(2, "0")}`
}

/** A class or interface's include prefix: the name padded with "=" to 30 characters. */
export const poolPrefix = (name: string) => name.padEnd(30, "=")

// ── Reader probe ────────────────────────────────────────────────────────────

export interface SourceReader {
  fm: "RPY_PROGRAM_READ" | "RFC_READ_REPORT"
  /** the table that carries the lines */
  table: string
  lineWidth: 72 | 255
  /** RPY_PROGRAM_READ's optional flags that this release has */
  flags: string[]
}

const readers = new Map<string, Promise<SourceReader>>()

export function resetSourceReaders(): void {
  readers.clear()
}

/** Pure: choose the reader from what TFDIR and FUPARAREF say. */
export function chooseReader(tfdir: Array<{ FUNCNAME: string; FMODE: string }>, rpyParams: string[]): SourceReader | undefined {
  const remote = new Set(tfdir.filter(r => r.FMODE.trim() === "R").map(r => r.FUNCNAME.trim()))
  const params = new Set(rpyParams.map(p => p.trim()))
  const rpy = remote.has("RPY_PROGRAM_READ") && params.has("PROGRAM_NAME")
  const flags = ["WITH_INCLUDELIST", "ONLY_SOURCE", "WITH_LOWERCASE"].filter(f => params.has(f))
  if (rpy && params.has("SOURCE_EXTENDED")) return { fm: "RPY_PROGRAM_READ", table: "SOURCE_EXTENDED", lineWidth: 255, flags }
  if (remote.has("RFC_READ_REPORT")) return { fm: "RFC_READ_REPORT", table: "QTAB", lineWidth: 72, flags: [] }
  if (rpy && params.has("SOURCE")) return { fm: "RPY_PROGRAM_READ", table: "SOURCE", lineWidth: 72, flags }
  return undefined
}

async function probeReader(connectionId: string | undefined): Promise<SourceReader> {
  const tfdir = await readTable(connectionId, "TFDIR", {
    fields: ["FUNCNAME", "FMODE"], where: "FUNCNAME IN ('RPY_PROGRAM_READ', 'RFC_READ_REPORT')", maxRows: 10,
  })
  let rpyParams: string[] = []
  if (tfdir.rows.some(r => r.FUNCNAME === "RPY_PROGRAM_READ" && r.FMODE.trim() === "R")) {
    const fp = await readTable(connectionId, "FUPARAREF", {
      fields: ["PARAMETER"], where: "FUNCNAME = 'RPY_PROGRAM_READ' AND R3STATE = 'A'", maxRows: 200,
    })
    rpyParams = fp.rows.map(r => r.PARAMETER)
  }
  const reader = chooseReader(tfdir.rows as Array<{ FUNCNAME: string; FMODE: string }>, rpyParams)
  if (!reader) {
    throw new Error("This system has no remote-enabled source read function module (RPY_PROGRAM_READ or RFC_READ_REPORT, per TFDIR), so sources cannot be read over SOAP RFC.")
  }
  return reader
}

export function getSourceReader(connectionId: string | undefined, key: string): Promise<SourceReader> {
  let p = readers.get(key)
  if (!p) {
    p = probeReader(connectionId)
    readers.set(key, p)
    p.catch(() => readers.delete(key))   // a failed probe is retried on the next read
  }
  return p
}

const firstValue = (r: RfcRow) => Object.values(r)[0] ?? ""

/** Lines of one program or include. */
export async function readProgram(connectionId: string | undefined, key: string, name: string): Promise<{ lines: string[]; reader: SourceReader }> {
  const reader = await getSourceReader(connectionId, key)
  if (reader.fm === "RPY_PROGRAM_READ") {
    const flagValues: Record<string, string> = { WITH_INCLUDELIST: "", ONLY_SOURCE: "X", WITH_LOWERCASE: "X" }
    const res = await callRfc(connectionId, "RPY_PROGRAM_READ", {
      PROGRAM_NAME: name,
      ...Object.fromEntries(reader.flags.map(f => [f, flagValues[f]])),
      [reader.table]: [],
    })
    return { lines: res.table(reader.table).map(r => firstValue(r).trimEnd()), reader }
  }
  const res = await callRfc(connectionId, "RFC_READ_REPORT", { PROGRAM: name, QTAB: [] })
  const lines = res.table("QTAB").map(r => firstValue(r).trimEnd())
  if (!lines.length) {
    throw new Error(`RFC_READ_REPORT returned no source for ${name}: it does not exist, or (on some releases) it has lines longer than the 72 characters RFC_READ_REPORT can return.`)
  }
  return { lines, reader }
}

async function classIncludes(connectionId: string | undefined, prefix: string): Promise<string[]> {
  const r = await readTable(connectionId, "TRDIR", { fields: ["NAME"], where: `NAME LIKE '${prefix}%'`, maxRows: 0 })
  // "_" in the name is a LIKE wildcard: keep only real matches.
  return r.rows.map(x => x.NAME.trim()).filter(n => n.startsWith(prefix)).sort()
}

/** The class pool with each include of the class expanded where it is included. */
async function readClass(connectionId: string | undefined, key: string, name: string): Promise<{ lines: string[]; reader: SourceReader }> {
  const prefix = poolPrefix(name)
  const main = await readProgram(connectionId, key, `${prefix}CP`)
  const own = await classIncludes(connectionId, prefix)
  const methods = own.filter(n => /^CM[0-9A-Z]{3}$/.test(n.slice(prefix.length)))
  const out: string[] = []
  const inline = async (inc: string) => {
    out.push(`*" ---- include ${inc} ----`)
    out.push(...(await readProgram(connectionId, key, inc)).lines)
  }
  for (const line of main.lines) {
    const m = /^\s*include\s+([^\s.]+)\s*\.\s*(".*)?$/i.exec(line)
    const inc = m?.[1].toUpperCase()
    if (inc === "METHODS") { for (const cm of methods) await inline(cm); continue }
    if (inc && inc.startsWith(prefix) && own.includes(inc)) { await inline(inc); continue }
    out.push(line)
  }
  return { lines: out, reader: main.reader }
}

/** Read the source of the object a URL or TYPE:NAME names. `key` caches the reader probe (the connection id). */
export async function readSourceOver(connectionId: string | undefined, key: string, ref: string): Promise<{ source: string; notes: string[] }> {
  const t = sourceTarget(ref)
  let res: { lines: string[]; reader: SourceReader }
  switch (t.kind) {
    case "PROG":
    case "INCL":
      res = await readProgram(connectionId, key, t.name)
      break
    case "FUGR":
      res = await readProgram(connectionId, key, groupProgram(t.name))
      break
    case "FUNC": {
      const fm = await readTable(connectionId, "TFDIR", { fields: ["PNAME", "INCLUDE"], where: `FUNCNAME = '${t.name}'`, maxRows: 1 })
      if (!fm.rows.length) throw new Error(`Function module ${t.name} does not exist (no TFDIR entry).`)
      res = await readProgram(connectionId, key, functionInclude(fm.rows[0].PNAME, fm.rows[0].INCLUDE))
      break
    }
    case "INTF":
      res = await readProgram(connectionId, key, `${poolPrefix(t.name)}IU`)
      break
    case "CLAS":
      res = t.classInclude
        ? await readProgram(connectionId, key, `${poolPrefix(t.name)}${t.classInclude}`)
        : await readClass(connectionId, key, t.name)
      break
  }
  const notes: string[] = []
  if (res.reader.lineWidth === 72 && res.lines.some(l => l.length >= 72)) {
    notes.push(`Read with ${res.reader.fm} (${res.reader.table}), which returns lines of at most 72 characters: lines that reach 72 may be cut off.`)
  }
  return { source: res.lines.join("\n"), notes }
}
