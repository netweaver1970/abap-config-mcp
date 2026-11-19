/**
 * Where the customizing tools get their facts: DDIC metadata, the resolved maintenance object,
 * and customizing rows. See docs/specs/001-two-constellations.md.
 *
 *   direct    ADT: freestyle SQL and table contents, exactly as before.
 *   governed  the engine's purpose-built actions: ddic_describe and read (delivery class C/G/E,
 *             row cap, display authorization checked in SAP). No ADT call, no generic SQL.
 *
 * The logic on top (describe output, diff, change plan, apply/create's maintenance object)
 * stays in the tools; only the source of the facts changes.
 */
import type { ADTClient, QueryResult } from "abap-adt-api"
import { ensureConnected } from "../connections"
import { isGoverned, GOVERNED_ENGINE_NOTE } from "../mode"
import { resolveMaint, runSql, tableRows, col, type ResolvedMaint } from "./customizing"
import { freestyleQuery } from "./data"
import { callEngine, type EngineRequest, type EngineResponse } from "./customizingEngine"
import { ENGINE_VERSION } from "../abap/zcl_mcp_cust_engine"

/** Root-table metadata, keyed the way the DDIC names it (DD02L/DD02T/DD03L columns). */
export interface TableMeta {
  /** TABNAME, TABCLASS, CONTFLAG, CLIDEP, MAINFLAG, DDTEXT; undefined when the table is unknown */
  dd02?: Record<string, string>
  /** FIELDNAME, KEYFLAG, ROLLNAME, DATATYPE, LENG, DECIMALS, POSITION, DDTEXT (data element text) */
  fields: Record<string, string>[]
  /** key fields with a check table: FIELDNAME, CHECKTABLE, CHECKFIELD */
  foreignKeys: Record<string, string>[]
  authGroup: string
}

export interface RowsResult {
  result: QueryResult
  /** true when the engine cut the result at the row cap */
  more?: boolean
  /** notes from the source (for example the row cap) */
  notes?: string[]
}

export interface RowFilter { field: string; value: string }

export interface CustomizingSource {
  readonly kind: "adt" | "engine"
  /** The maintenance object behind a table or view name. */
  resolve(name: string): Promise<ResolvedMaint>
  /** Flags, fields, foreign keys and authorization group of one table. */
  tableMeta(table: string, language: string): Promise<TableMeta>
  /** customizing_read: rows of a table, optionally where one field equals one value. */
  readTable(table: string, filter: RowFilter | undefined, maxRows: number): Promise<RowsResult>
  /** customizing_diff / plan_change: rows where one field equals one value. */
  rowsWhere(table: string, filter: RowFilter, maxRows: number): Promise<RowsResult>
}

/** The source for this server's mode. */
export function customizingSource(connectionId?: string): CustomizingSource {
  return isGoverned() ? new EngineSource(connectionId) : new AdtSource(connectionId)
}

const q = (s: string) => s.replace(/'/g, "''")
const EMPTY = { columns: [], values: [] } as unknown as QueryResult

// ─── direct: ADT ─────────────────────────────────────────────────────────────

class AdtSource implements CustomizingSource {
  readonly kind = "adt" as const
  private client?: Promise<ADTClient>
  constructor(private readonly connectionId?: string) {}

  private adt(): Promise<ADTClient> {
    return (this.client ??= ensureConnected(this.connectionId))
  }

  async resolve(name: string): Promise<ResolvedMaint> {
    return resolveMaint(await this.adt(), name)
  }

  async tableMeta(table: string, language: string): Promise<TableMeta> {
    const client = await this.adt()
    const t = q(table.toUpperCase())
    const lang = q(language.toUpperCase())
    // Flags live in DD02L, the description in DD02T.
    const dd02lRows = tableRows(await runSql(client,
      `SELECT TABNAME, TABCLASS, CONTFLAG, CLIDEP, MAINFLAG FROM DD02L WHERE TABNAME = '${t}'`, 1).catch(() => EMPTY))
    const dd02tRows = tableRows(await runSql(client,
      `SELECT TABNAME, DDTEXT FROM DD02T WHERE TABNAME = '${t}' AND DDLANGUAGE = '${lang}' AND AS4LOCAL = 'A'`, 1).catch(() => EMPTY))
    const dd02 = (dd02lRows[0] || dd02tRows[0]) ? { ...(dd02lRows[0] ?? {}), ...(dd02tRows[0] ?? {}) } : undefined

    // Field list with key flag: structure from DD03L.
    const fields = tableRows(await runSql(client,
      `SELECT FIELDNAME, KEYFLAG, ROLLNAME, DATATYPE, LENG, DECIMALS, POSITION ` +
      `FROM DD03L WHERE TABNAME = '${t}' AND AS4LOCAL = 'A' AND FIELDNAME <> '.INCLUDE' ORDER BY POSITION`, 100).catch(() => EMPTY))

    const tddat = tableRows(await runSql(client, `SELECT TABNAME, CCLASS FROM TDDAT WHERE TABNAME = '${t}'`, 1).catch(() => EMPTY))

    // Foreign keys on key fields (DD08L).
    const keyFields = fields.filter(f => col(f, "KEYFLAG") === "X").map(f => col(f, "FIELDNAME"))
    let foreignKeys: Record<string, string>[] = []
    if (keyFields.length > 0) {
      const fkIn = keyFields.map(f => `'${f}'`).join(",")
      foreignKeys = tableRows(await runSql(client,
        `SELECT TABNAME, FIELDNAME, CHECKTABLE, CHECKFIELD, FRKEYNAME ` +
        `FROM DD08L WHERE TABNAME = '${t}' AND FIELDNAME IN (${fkIn}) AND AS4LOCAL = 'A'`, 20).catch(() => EMPTY))
    }
    return { dd02, fields, foreignKeys, authGroup: tddat[0] ? col(tddat[0], "CCLASS") : "" }
  }

  async readTable(table: string, filter: RowFilter | undefined, maxRows: number): Promise<RowsResult> {
    const client = await this.adt()
    const where = filter ? `${q(filter.field.toUpperCase())} = '${q(filter.value)}'` : undefined
    try {
      return { result: await client.tableContents(table, maxRows, false, where) }
    } catch (err) {
      // Fall back to freestyle SQL when table contents WITH a where clause fails (SICF not active).
      if (!where) throw err
      return { result: await freestyleQuery(client, `SELECT * FROM ${table} WHERE ${where}`, maxRows) }
    }
  }

  async rowsWhere(table: string, filter: RowFilter, maxRows: number): Promise<RowsResult> {
    const client = await this.adt()
    const sql = `SELECT * FROM ${table} WHERE ${q(filter.field.toUpperCase())} = '${q(filter.value)}'`
    return { result: await freestyleQuery(client, sql, maxRows) }
  }
}

// ─── governed: the engine ────────────────────────────────────────────────────

/** ddic_describe's DATA_JSON (keys uppercase, as /ui2/cl_json serializes them). */
export interface DdicDescription {
  INPUT: string
  IS_VIEW?: string | boolean
  VIEW?: string
  VARIANT?: string
  ROOT_TABLE: string
  TEXT_TABLE?: string
  TABLES?: string[]
  FUNC_GROUP?: string
  MAINT_TYPE?: string
  MAINT_TCODE?: string
  IMG_ACTIVITY?: string
  IMG_ACTIVITY_TEXT?: string
  AUTH_GROUP?: string
  OBJECT_TYPE?: string
  CLUSTER?: string
  DEVCLASS?: string
  SWITCH_ID?: string
  MAINT_OBJECT?: string
  RECORD_OBJECT?: string
  TRANSPORT_OBJECT?: string
  TRANSPORT_NAME?: string
  TABCLASS?: string
  CONTFLAG?: string
  CLIDEP?: string
  MAINFLAG?: string
  DDTEXT?: string
  FIELDS?: {
    FIELDNAME: string; KEYFLAG?: string; ROLLNAME?: string; DOMNAME?: string; DATATYPE?: string
    LENG?: string; DECIMALS?: string; POSITION?: string; CHECKTABLE?: string; CHECKFIELD?: string; DDTEXT?: string
  }[]
  CLIENT?: string
  CCCATEGORY?: string
  CCCORACTIV?: string
  CCNOCLIIND?: string
}

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim())
const opt = (v: unknown) => s(v) || undefined
const flag = (v: unknown) => v === true || s(v) === "X" || s(v) === "true"
const TRANSPORT_OBJECTS = ["VDAT", "TABU", "CDAT"] as const
type TransportObject = typeof TRANSPORT_OBJECTS[number]
const asTransportObject = (v: unknown): TransportObject | undefined =>
  (TRANSPORT_OBJECTS as readonly string[]).includes(s(v)) ? s(v) as TransportObject : undefined

/** Map ddic_describe's result onto the resolver's shape, so the tools need no second code path. */
export function toResolvedMaint(d: DdicDescription): ResolvedMaint {
  const rootTable = s(d.ROOT_TABLE)
  const tables = (d.TABLES ?? []).map(s).filter(Boolean)
  return {
    input: s(d.INPUT),
    isView: flag(d.IS_VIEW),
    view: opt(d.VIEW),
    rootTable,
    textTable: opt(d.TEXT_TABLE),
    tables: tables.length ? tables : [rootTable],
    funcGroup: opt(d.FUNC_GROUP),
    maintType: opt(d.MAINT_TYPE),
    maintTcode: opt(d.MAINT_TCODE),
    imgActivity: opt(d.IMG_ACTIVITY),
    imgActivityText: opt(d.IMG_ACTIVITY_TEXT),
    authGroup: opt(d.AUTH_GROUP),
    objectType: opt(d.OBJECT_TYPE),
    cluster: opt(d.CLUSTER),
    variant: opt(d.VARIANT),
    devclass: opt(d.DEVCLASS),
    switchId: opt(d.SWITCH_ID),
    maintObject: s(d.MAINT_OBJECT),
    recordObject: asTransportObject(d.RECORD_OBJECT),
    transport: { object: asTransportObject(d.TRANSPORT_OBJECT) ?? "TABU", name: s(d.TRANSPORT_NAME) || rootTable },
  }
}

/** Map ddic_describe's root-table part onto TableMeta. */
export function toTableMeta(d: DdicDescription): TableMeta {
  const fields = (d.FIELDS ?? []).map(f => ({
    FIELDNAME: s(f.FIELDNAME), KEYFLAG: s(f.KEYFLAG), ROLLNAME: s(f.ROLLNAME), DOMNAME: s(f.DOMNAME),
    DATATYPE: s(f.DATATYPE), LENG: s(f.LENG), DECIMALS: s(f.DECIMALS), POSITION: s(f.POSITION),
    CHECKTABLE: s(f.CHECKTABLE), CHECKFIELD: s(f.CHECKFIELD), DDTEXT: s(f.DDTEXT),
  }))
  const root = s(d.ROOT_TABLE)
  return {
    dd02: s(d.TABCLASS) || s(d.CONTFLAG)
      ? { TABNAME: root, TABCLASS: s(d.TABCLASS), CONTFLAG: s(d.CONTFLAG), CLIDEP: s(d.CLIDEP), MAINFLAG: s(d.MAINFLAG), DDTEXT: s(d.DDTEXT) }
      : undefined,
    fields,
    foreignKeys: fields
      .filter(f => f.KEYFLAG === "X" && f.CHECKTABLE && f.CHECKTABLE !== "*")
      .map(f => ({ TABNAME: root, FIELDNAME: f.FIELDNAME, CHECKTABLE: f.CHECKTABLE, CHECKFIELD: f.CHECKFIELD })),
    authGroup: s(d.AUTH_GROUP),
  }
}

/** The engine's read DATA_JSON → a QueryResult the formatters already understand. */
export function toRowsResult(dataJson: string | undefined, messages: string[] = []): RowsResult {
  const parsed = JSON.parse(dataJson || "{}") as { COLUMNS?: string[]; ROWS?: Record<string, unknown>[]; MORE?: boolean }
  const rows = parsed.ROWS ?? []
  const names = parsed.COLUMNS?.length ? parsed.COLUMNS : Object.keys(rows[0] ?? {})
  const values = rows.map(r => Object.fromEntries(names.map(n => [n, r[n] === undefined || r[n] === null ? "" : String(r[n])])))
  return {
    result: { columns: names.map(name => ({ name })), values } as unknown as QueryResult,
    more: parsed.MORE === true,
    notes: messages.length ? messages : undefined,
  }
}

class EngineSource implements CustomizingSource {
  readonly kind = "engine" as const
  private readonly described = new Map<string, Promise<DdicDescription>>()
  constructor(private readonly connectionId?: string) {}

  private async call(req: EngineRequest, what: string): Promise<EngineResponse> {
    const r = await callEngine(this.connectionId, req)
    if (r.STATUS === "ok") return r
    const msgs = (r.MESSAGES ?? []).join(" ")
    if (/Unknown operation/i.test(msgs)) {
      throw new Error(`${what} stopped: the engine on this system (v${r.VERSION ?? "?"}) has no ${req.operation} action, ` +
        `which this server needs (engine v${ENGINE_VERSION}). Update the engine: ${GOVERNED_ENGINE_NOTE}. Then run customizing_engine_ping.`)
    }
    throw new Error(msgs || `${what} stopped: the engine answered ${r.STATUS ?? "without a status"}.`)
  }

  describe(name: string): Promise<DdicDescription> {
    const key = name.toUpperCase()
    let p = this.described.get(key)
    if (!p) {
      p = this.call({ operation: "ddic_describe", table: key, language: "E" }, `Describing ${key}`)
        .then(r => JSON.parse(r.DATA_JSON || "{}") as DdicDescription)
      p.catch(() => this.described.delete(key))
      this.described.set(key, p)
    }
    return p
  }

  async resolve(name: string): Promise<ResolvedMaint> {
    return toResolvedMaint(await this.describe(name))
  }

  async tableMeta(table: string, language: string): Promise<TableMeta> {
    const key = table.toUpperCase()
    // Reuse a description already fetched for a view whose root is this table.
    for (const p of this.described.values()) {
      const d = await p.catch(() => undefined)
      if (d && s(d.ROOT_TABLE) === key && language.toUpperCase() === "E") return toTableMeta(d)
    }
    const r = await this.call({ operation: "ddic_describe", table: key, language: language.toUpperCase() }, `Describing ${key}`)
    return toTableMeta(JSON.parse(r.DATA_JSON || "{}") as DdicDescription)
  }

  async readTable(table: string, filter: RowFilter | undefined, maxRows: number): Promise<RowsResult> {
    return this.read(table, filter, maxRows)
  }

  async rowsWhere(table: string, filter: RowFilter, maxRows: number): Promise<RowsResult> {
    return this.read(table, filter, maxRows)
  }

  private async read(table: string, filter: RowFilter | undefined, maxRows: number): Promise<RowsResult> {
    const r = await this.call({
      operation: "read", table: table.toUpperCase(), max_rows: maxRows,
      ...(filter ? { key_field: filter.field.toUpperCase(), source_key: filter.value } : {}),
    }, `Reading ${table.toUpperCase()}`)
    return toRowsResult(r.DATA_JSON, r.MESSAGES ?? [])
  }
}
