/**
 * Table reads over SOAP RFC with RFC_READ_TABLE.
 *
 * RFC_READ_TABLE returns each row as one 512-character string (DATA-WA), cut
 * into fields by the offsets it reports. Fields are separated by a "|" delimiter
 * so that a row whose blanks were trimmed in transit is detected (the delimiters
 * are then not where the offsets say) and split on the delimiters instead.
 *
 * A field list wider than one row fails with DATA_BUFFER_EXCEEDED, so a wide read
 * is split into several calls whose field lists each fit, every one carrying the
 * table's key fields, and the parts are joined on the key. The calls have no ORDER
 * BY, so with a row limit two parts may return different rows: only rows found in
 * every part are returned, and the answer says how many were dropped. Without
 * usable keys (a view, an unreadable DD03L) a wide read is refused rather than
 * joined by row position, which could silently glue different rows together.
 */
import { callRfc, RfcRow } from "./client"
import { whereToOptions } from "./sql"

export const WA_WIDTH = 512
export const DELIMITER = "|"

export interface FieldMeta {
  name: string
  offset: number
  length: number
  /** ABAP internal type as RFC_READ_TABLE reports it (C, N, D, T, P, I, F, X, g, y, …) */
  type: string
  text: string
}

export interface TableRead {
  columns: string[]
  rows: Record<string, string>[]
  notes: string[]
}

/** Types RFC_READ_TABLE cannot put into its character row. */
const UNREADABLE_TYPES = new Set(["g", "y", "h", "r", "l", "v", "u"])
/** Types whose value RFC_READ_TABLE right-aligns (leading blanks are padding). */
const NUMERIC_TYPES = new Set(["P", "I", "F", "b", "s", "a", "e"])

const toInt = (s: string | undefined) => parseInt(s ?? "", 10) || 0

function fieldOf(r: RfcRow): FieldMeta {
  return { name: (r.FIELDNAME ?? "").trim(), offset: toInt(r.OFFSET), length: toInt(r.LENGTH), type: (r.TYPE ?? "").trim(), text: (r.FIELDTEXT ?? "").trim() }
}

/** The fields of a table or view as RFC_READ_TABLE sees them (NO_DATA: no rows read). */
export async function tableFields(connectionId: string | undefined, table: string): Promise<FieldMeta[]> {
  const res = await callRfc(connectionId, "RFC_READ_TABLE", {
    QUERY_TABLE: table, NO_DATA: "X", DELIMITER: "", OPTIONS: [], FIELDS: [],
  })
  return res.table("FIELDS").map(fieldOf)
}

/** Key field names from DD03L (empty when there are none, e.g. a view, or DD03L cannot be read). */
export async function keyFields(connectionId: string | undefined, table: string): Promise<{ keys: string[]; error?: string }> {
  try {
    const res = await callRfc(connectionId, "RFC_READ_TABLE", {
      QUERY_TABLE: "DD03L", DELIMITER, ROWCOUNT: "0",
      OPTIONS: whereToOptions(`TABNAME = '${table}' AND AS4LOCAL = 'A' AND KEYFLAG = 'X'`).map(TEXT => ({ TEXT })),
      FIELDS: [{ FIELDNAME: "FIELDNAME" }, { FIELDNAME: "POSITION" }], DATA: [],
    })
    const rows = parseRows(res.table("FIELDS").map(fieldOf), res.table("DATA"))
    return { keys: rows.sort((a, b) => toInt(a.POSITION) - toInt(b.POSITION)).map(r => r.FIELDNAME).filter(f => f && !f.startsWith(".")) }
  } catch (err) {
    return { keys: [], error: String((err as Error)?.message ?? err) }
  }
}

/**
 * Cut DATA rows into fields by the offsets RFC_READ_TABLE reported (with the
 * delimiter between fields). A row whose delimiters are not at those offsets lost
 * blanks in transit: it is split on the delimiter instead, if that is unambiguous.
 */
export function parseRows(fields: FieldMeta[], data: RfcRow[]): Record<string, string>[] {
  const clean = (f: FieldMeta, v: string) => NUMERIC_TYPES.has(f.type) ? v.trim() : v.trimEnd()
  return data.map(r => {
    const wa = r.WA ?? ""
    // A delimiter is never blank, so trimming cannot remove one: every boundary must be inside the row.
    const aligned = fields.every((f, i) => i === 0 || wa[f.offset - 1] === DELIMITER)
    const row: Record<string, string> = {}
    if (aligned) {
      for (const f of fields) row[f.name] = clean(f, wa.substr(f.offset, f.length))
      return row
    }
    const pieces = wa.split(DELIMITER)
    if (pieces.length !== fields.length) {
      throw new Error(`A row from RFC_READ_TABLE does not line up with its field offsets, and a value contains "${DELIMITER}", so it cannot be split safely: ${wa.slice(0, 80)}`)
    }
    fields.forEach((f, i) => { row[f.name] = clean(f, pieces[i]) })
    return row
  })
}

/** Characters a field list takes in one row: the fields plus a delimiter between each two. */
export const rowWidth = (fields: FieldMeta[]) => fields.reduce((s, f) => s + f.length, 0) + Math.max(0, fields.length - 1)

/**
 * Split fields into groups that each fit one row together with the key fields,
 * which every group carries. Returns undefined when a field cannot fit beside the keys.
 */
export function planChunks(fields: FieldMeta[], keys: FieldMeta[], width = WA_WIDTH): FieldMeta[][] | undefined {
  const keyNames = new Set(keys.map(k => k.name))
  const rest = fields.filter(f => !keyNames.has(f.name))
  if (rest.some(f => rowWidth([...keys, f]) > width)) return undefined
  const chunks: FieldMeta[][] = []
  let cur: FieldMeta[] = []
  for (const f of rest) {
    if (cur.length && rowWidth([...keys, ...cur, f]) > width) { chunks.push([...keys, ...cur]); cur = [] }
    cur.push(f)
  }
  if (cur.length || !chunks.length) chunks.push([...keys, ...cur])
  return chunks
}

async function readPart(connectionId: string | undefined, table: string, fields: FieldMeta[], options: string[], maxRows: number) {
  const res = await callRfc(connectionId, "RFC_READ_TABLE", {
    QUERY_TABLE: table, DELIMITER, ROWCOUNT: String(maxRows),
    OPTIONS: options.map(TEXT => ({ TEXT })),
    FIELDS: fields.map(f => ({ FIELDNAME: f.name })),
    DATA: [],
  })
  return parseRows(res.table("FIELDS").map(fieldOf), res.table("DATA"))
}

const describeFields = (fs: FieldMeta[]) => fs.map(f => `${f.name} (type ${f.type}, length ${f.length})`).join(", ")

/** Read rows of a table: all readable fields or the named ones, optionally filtered, at most maxRows (0 = all). */
export async function readTable(connectionId: string | undefined, table: string, opts: {
  fields?: "*" | string[]
  where?: string
  maxRows: number
}): Promise<TableRead> {
  const notes: string[] = []
  const options = opts.where?.trim() ? whereToOptions(opts.where.trim()) : []
  const all = await tableFields(connectionId, table)
  if (!all.length) throw new Error(`RFC_READ_TABLE reports no fields for ${table}.`)
  const byName = new Map(all.map(f => [f.name, f]))

  let wanted: FieldMeta[]
  if (!opts.fields || opts.fields === "*") {
    wanted = all.filter(f => !UNREADABLE_TYPES.has(f.type) && f.length > 0 && f.length <= WA_WIDTH)
    const skipped = all.filter(f => !wanted.includes(f))
    if (skipped.length) notes.push(`Not readable through RFC_READ_TABLE and left out: ${describeFields(skipped)}.`)
  } else {
    const missing = opts.fields.filter(n => !byName.has(n))
    if (missing.length) throw new Error(`${table} has no field ${missing.join(", ")}. Its fields: ${all.map(f => f.name).join(", ")}`)
    wanted = opts.fields.map(n => byName.get(n) as FieldMeta)
    const bad = wanted.filter(f => UNREADABLE_TYPES.has(f.type) || f.length <= 0 || f.length > WA_WIDTH)
    if (bad.length) throw new Error(`RFC_READ_TABLE cannot read ${describeFields(bad)}.`)
  }
  const columns = wanted.map(f => f.name)

  const width = rowWidth(wanted)
  if (width <= WA_WIDTH) {
    return { columns, rows: await readPart(connectionId, table, wanted, options, opts.maxRows), notes }
  }

  // Wider than one row: read in parts that each carry the key, and join them on it.
  const { keys: keyNames, error } = await keyFields(connectionId, table)
  const keys = keyNames.map(k => byName.get(k)).filter((f): f is FieldMeta => !!f)
  const chunks = keys.length > 0 && keys.length === keyNames.length ? planChunks(wanted, keys) : undefined
  if (!chunks) {
    const why = error ? `its key fields could not be read (${error})`
      : !keyNames.length ? `it has no key fields in DD03L (a view?)`
      : keys.length !== keyNames.length ? `its key fields (${keyNames.join(", ")}) are not all in the field list RFC_READ_TABLE reports`
      : `its key fields (${keyNames.join(", ")}) leave no room for some fields in one row`
    throw new Error(`The selected fields of ${table} take ${width} characters, more than RFC_READ_TABLE's ${WA_WIDTH}-character row, ` +
      `and the read cannot be split into parts joined on the key: ${why}. Select fewer fields (at most ${WA_WIDTH} characters together, counting one per field boundary).`)
  }
  const parts: Record<string, string>[][] = []
  for (const c of chunks) parts.push(await readPart(connectionId, table, c, options, opts.maxRows))

  const keyOf = (r: Record<string, string>) => keys.map(k => r[k.name]).join("\u0000")
  const indexes = parts.map(p => new Map(p.map(r => [keyOf(r), r])))
  if (indexes.some((ix, i) => ix.size !== parts[i].length)) {
    throw new Error(`${table}: rows with the same key came back, so the parts of this wide read cannot be joined. Select fewer fields (at most ${WA_WIDTH} characters together).`)
  }
  const rows: Record<string, string>[] = []
  let dropped = 0
  for (const r of parts[0]) {
    const k = keyOf(r)
    const pieces = indexes.map(ix => ix.get(k))
    if (pieces.some(p => !p)) { dropped++; continue }
    const joined = Object.assign({}, ...pieces) as Record<string, string>
    rows.push(Object.fromEntries(columns.map(c => [c, joined[c] ?? ""])))
  }
  notes.push(`The selected fields take ${width} characters, more than RFC_READ_TABLE's ${WA_WIDTH}: read in ${chunks.length} parts joined on the key (${keyNames.join(", ")}).`)
  if (dropped) {
    notes.push(`The result is incomplete: ${dropped} row(s) were not returned by every part (with a row limit and no sort order, the parts can return different rows) and are left out. ` +
      `A narrower WHERE clause, a higher row limit or fewer fields avoids this.`)
  }
  return { columns, rows, notes }
}
