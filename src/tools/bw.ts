/**
 * BW objects (spec 001, phase 2.5): list, read, where-used for every BW object type the
 * system has, and create / change / activate / delete through BW's own ABAP APIs.
 *
 * Everything runs in SAP through the engine's optional class ZCL_MCP_BW_ENGINE (operations
 * bw_*), never through ADT, so the tools are the same in direct and governed mode. The engine
 * detects the BW line (BW 7.5 or BW/4HANA) and which APIs exist; bw_capabilities shows it.
 * Writes are dry runs unless commit is true, and record on a Workbench request chosen with the
 * same rules as every other write (transportSelection.ts); a local $ package records nothing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { getConnectionConfig, resolveConnectionId } from "../connections"
import { callEngine, type EngineRequest, type EngineResponse } from "./customizingEngine"
import { selectTransport } from "./transportSelection"
import { engineTransportInfo, listOpenRequests, lookupRequest } from "./transportSql"
import { engineFixHint } from "../mode"

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] })

/** One bw_* engine call; a missing BW class or old engine reads as the reason, not a crash. */
export async function bwCall(connectionId: string | undefined, req: Record<string, unknown>): Promise<EngineResponse> {
  const r = await callEngine(connectionId, req as unknown as EngineRequest)
  if (r.STATUS !== "ok" && (r.MESSAGES ?? []).some(m => /Unknown operation: 'bw_/i.test(m))) {
    return { ...r, MESSAGES: [`The engine on this system (v${r.VERSION ?? "?"}) has no BW part yet. ${engineFixHint()}.`] }
  }
  return r
}

const messages = (r: EngineResponse) => (r.MESSAGES ?? []).map(m => `  ${m}`)
/** DATA_JSON as T: an array where the fallback is one, else the fallback's fields with the answer's on top. */
const parse = <T>(r: EngineResponse, fallback: T): T => {
  let v: unknown
  try { v = JSON.parse(r.DATA_JSON || "") } catch { return fallback }
  if (Array.isArray(fallback)) return (Array.isArray(v) ? v : fallback) as T
  return (v && typeof v === "object" && !Array.isArray(v) ? { ...fallback, ...(v as object) } : fallback) as T
}
const nonEmpty = (o: Record<string, unknown>) =>
  Object.entries(o ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined && v !== 0 && !(Array.isArray(v) && !v.length))

// ─── read side ───────────────────────────────────────────────────────────────

interface Caps {
  LINE: string; SAP_BW?: string; DW4CORE?: string; TRANSPORT?: string | boolean; WHERE_USED?: string | boolean
  BW_CLIENT?: string; IN_BW_CLIENT?: string | boolean
  TYPES?: { TLOGO: string; TLOGOTAB: string; OPS: { OP: string; STATUS: string; API?: string }[] }[]
}

export async function handleBwCapabilities(args: { type?: string; connectionId?: string }) {
  const r = await bwCall(args.connectionId, { operation: "bw_capabilities" })
  if (r.STATUS !== "ok") return text([`BW capabilities could not be read:`, ...messages(r)].join("\n"))
  const c = parse<Caps>(r, { LINE: "NONE" })
  const line = c.LINE === "BW4HANA" ? `BW/4HANA (DW4CORE ${c.DW4CORE})` : c.LINE === "BW75" ? `BW 7.5 line (SAP_BW ${c.SAP_BW})` : "no BW"
  const out = [`BW on this system: ${line}`]
  if (c.LINE === "NONE") return text(out.join("\n"))
  const wanted = args.type?.toUpperCase()
  const types = (c.TYPES ?? []).filter(t => !wanted || t.TLOGO === wanted)
  const writable = types.filter(t => t.OPS.some(o => ["create", "change", "activate", "delete"].includes(o.OP) && o.STATUS === "available"))
  const inClient = c.IN_BW_CLIENT === true || c.IN_BW_CLIENT === "X"
  out.push(c.BW_CLIENT
    ? `BW client: ${c.BW_CLIENT}${inClient ? " (this connection's client: writes possible)" : " — this connection is in another client, so writes are refused; connect to that client"}`
    : `BW client: none — BW is not set up on this system, so reading works but create/change/activate/delete are refused. Run BW's initial setup (on S/4HANA the task list SAP_BW_SETUP_INITIAL_S4HANA) in the client BW should use.`)
  out.push(`Transport recording (RS_TR_WRITE_OBJECTS_TO_REQUEST): ${c.TRANSPORT === true || c.TRANSPORT === "X" ? "available" : "missing"}`,
    `Where-used (RSOOBJXREF): ${c.WHERE_USED === true || c.WHERE_USED === "X" ? "available" : "missing"}`, "",
    `${types.length} object type(s)${wanted ? "" : " from BW's registry (RSTLOGOPROP)"}: list, read and where-used work for all of them.`)
  for (const t of wanted ? types : writable) {
    out.push("", `${t.TLOGO}  (${t.TLOGOTAB})`)
    for (const o of t.OPS) out.push(`  ${o.OP.padEnd(11)} ${o.STATUS.padEnd(10)} ${o.API ?? ""}`.trimEnd())
  }
  if (!wanted) {
    out.push("", `Write operations so far: ${writable.map(t => t.TLOGO).join(", ") || "none"}; for the others create/change/activate/delete are not built yet.`,
      `All types: ${types.map(t => t.TLOGO).join(" ")}`)
  }
  return text(out.join("\n"))
}

export async function handleBwList(args: { type: string; pattern?: string; version?: string; language?: string; maxRows?: number; connectionId?: string }) {
  const r = await bwCall(args.connectionId, { operation: "bw_list", tlogo: args.type, pattern: args.pattern ?? "*",
    objvers: args.version ?? "A", language: args.language, max_rows: args.maxRows ?? 200 })
  if (r.STATUS !== "ok") return text(messages(r).join("\n").trim())
  const rows = parse<{ NAME: string; TEXT?: string }[]>(r, [])
  const head = `${args.type.toUpperCase()} objects matching "${args.pattern ?? "*"}" (version ${args.version ?? "A"}): ${rows.length}`
  return text([head, "", ...rows.map(x => `  ${x.NAME.padEnd(30)} ${x.TEXT ?? ""}`.trimEnd()), ...(r.MESSAGES?.length ? ["", ...messages(r)] : [])].join("\n"))
}

export async function handleBwRead(args: { type: string; name: string; version?: string; connectionId?: string }) {
  const r = await bwCall(args.connectionId, { operation: "bw_read", tlogo: args.type, name: args.name, objvers: args.version ?? "A" })
  if (r.STATUS !== "ok") return text(messages(r).join("\n").trim())
  const d = parse<{ TLOGO: string; NAME: string; OBJVERS: string; VERSIONS: string[]; PACKAGE: string; TABLE: string;
    ROWS: Record<string, unknown>[]; DETAIL?: { DETAILS: Record<string, unknown>; COMPOUNDS?: unknown[]; ATTRIBUTES?: unknown[]; NAVIGATIONATTRIBUTES?: unknown[] } }>(r,
    { TLOGO: "", NAME: "", OBJVERS: "", VERSIONS: [], PACKAGE: "", TABLE: "", ROWS: [] })
  const out = [
    `${d.TLOGO} ${d.NAME}  (version ${d.OBJVERS}; versions on the system: ${d.VERSIONS.join(", ") || "none"})`,
    `Package: ${d.PACKAGE || "(no TADIR entry)"}`,
  ]
  if (d.DETAIL?.DETAILS) {
    out.push("", "Definition (BAPI_IOBJ_GETDETAIL):", ...nonEmpty(d.DETAIL.DETAILS).map(([k, v]) => `  ${k.padEnd(20)} ${String(v)}`))
    for (const [label, rows] of [["Compounds", d.DETAIL.COMPOUNDS], ["Attributes", d.DETAIL.ATTRIBUTES], ["Navigation attributes", d.DETAIL.NAVIGATIONATTRIBUTES]] as const) {
      if (rows?.length) out.push("", `${label} (${rows.length}):`, ...rows.slice(0, 50).map(x => `  ${nonEmpty(x as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join("  ")}`))
    }
  } else if (d.ROWS.length) {
    out.push("", `${d.TABLE} (${d.ROWS.length} row${d.ROWS.length === 1 ? "" : "s"}):`)
    for (const row of d.ROWS.slice(0, 20)) out.push(`  ${nonEmpty(row).map(([k, v]) => `${k}=${v}`).join("  ")}`)
  }
  if (r.MESSAGES?.length) out.push("", ...messages(r))
  return text(out.join("\n"))
}

export async function handleBwWhereUsed(args: { type: string; name: string; version?: string; connectionId?: string }) {
  const r = await bwCall(args.connectionId, { operation: "bw_where_used", tlogo: args.type, name: args.name, objvers: args.version ?? "A" })
  if (r.STATUS !== "ok") return text(messages(r).join("\n").trim())
  type X = { TLOGO: string; OBJNM: string; TLOGO_DEP: string; OBJNM_DEP: string; ASC_TYPE: string }
  const d = parse<{ USED_BY: X[]; USES: X[] }>(r, { USED_BY: [], USES: [] })
  const name = `${args.type.toUpperCase()} ${args.name.toUpperCase()}`
  return text([
    `${name} is used by ${d.USED_BY.length} object(s):`, ...d.USED_BY.map(x => `  ${x.TLOGO} ${x.OBJNM.trim()}`),
    "", `${name} uses ${d.USES.length} object(s):`, ...d.USES.map(x => `  ${x.TLOGO_DEP} ${x.OBJNM_DEP.trim()}`),
  ].join("\n"))
}

// ─── write side ──────────────────────────────────────────────────────────────

interface WriteArgs {
  type: string; name: string; commit?: boolean; activate?: boolean
  transport?: string; workItem?: string; showAllTransports?: boolean; connectionId?: string
}

/** The request an existing object is locked on, if any (only that request can take it). */
async function lockedOn(connectionId: string | undefined, type: string, name: string): Promise<string | undefined> {
  try {
    const info = await engineTransportInfo(connectionId, type, name)
    return info.LOCK_REQUEST?.trim() || undefined
  } catch { return undefined }   // no display authority for transports: the selection rule decides
}

/**
 * The Workbench request a write records on: none for a local package; for an existing object
 * already locked on a request, that request (SAP accepts no other); else the shared selection rule.
 */
async function bwTransport(args: WriteArgs, pkg: string, what: string, sessionId?: string, existing = false):
    Promise<{ transport?: string; note?: string; prompt?: string; refuse?: string; confirm?: () => void }> {
  if (!args.commit || !pkg || pkg.startsWith("$")) return { transport: args.transport }
  const lock = existing ? await lockedOn(args.connectionId, args.type, args.name) : undefined
  if (lock) {
    const supplied = args.transport?.trim().toUpperCase()
    if (supplied && supplied !== lock) {
      const req = await lookupRequest(args.connectionId, supplied)
      if (req?.trkorr !== lock) return { refuse: `${what[0].toUpperCase()}${what.slice(1)} stopped: ${args.type.toUpperCase()} ${args.name.toUpperCase()} is locked on request ${lock}, so it can only be recorded there, not on ${supplied}. Use transport: "${lock}", or release ${lock} first.` }
    }
    return { transport: lock, note: `Transport ${lock} — the request ${args.type.toUpperCase()} ${args.name.toUpperCase()} is already locked on.` }
  }
  const cfg = getConnectionConfig(args.connectionId)
  const sel = await selectTransport({
    connectionId: resolveConnectionId(args.connectionId), fn: "K", what, supplied: args.transport,
    workItem: args.workItem, sessionId,
    candidates: await listOpenRequests(args.connectionId, "K", args.showAllTransports ? undefined : cfg.username, cfg.client),
    lookup: trkorr => lookupRequest(args.connectionId, trkorr),
  })
  if (sel.kind === "ask") return { prompt: sel.text + (args.showAllTransports ? "" : `\n\nOr: showAllTransports: true to list everyone's requests.`) }
  return { transport: sel.trkorr, note: sel.note, confirm: sel.confirm }
}

function writeResult(r: EngineResponse, note?: string) {
  const ok = r.STATUS === "ok"
  const head = r.DRY_RUN === "X" || (r.DRY_RUN as unknown) === true ? "📋 DRY RUN — nothing written" : ok ? "✅ Done" : "❌ Stopped"
  return text([head, ...(note ? [`  ${note}`] : []), ...messages(r),
    ...(r.DRY_RUN === "X" || (r.DRY_RUN as unknown) === true ? ["", "Run again with commit: true to apply."] : [])].join("\n"))
}

async function packageOf(connectionId: string | undefined, type: string, name: string): Promise<string | undefined> {
  const r = await bwCall(connectionId, { operation: "bw_read", tlogo: type, name, objvers: "A" })
  if (r.STATUS !== "ok") {
    const m = await bwCall(connectionId, { operation: "bw_read", tlogo: type, name, objvers: "M" })
    return m.STATUS === "ok" ? parse<{ PACKAGE?: string }>(m, {}).PACKAGE ?? "" : undefined
  }
  return parse<{ PACKAGE?: string }>(r, {}).PACKAGE ?? ""
}

export interface IobjDefinition {
  details: Record<string, unknown>
  compounds?: Record<string, unknown>[]
  attributes?: Record<string, unknown>[]
  navigationAttributes?: Record<string, unknown>[]
}

export async function handleBwCreate(args: WriteArgs & { package?: string; definition: IobjDefinition }, extra?: { sessionId?: string }) {
  const pkg = (args.package ?? "$TMP").toUpperCase()
  const t = await bwTransport(args, pkg, `creating ${args.type.toUpperCase()} ${args.name.toUpperCase()}`, extra?.sessionId)
  if (t.prompt) return text(t.prompt)
  const up = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.toUpperCase(), v]))
  const r = await bwCall(args.connectionId, {
    operation: "bw_create", tlogo: args.type, name: args.name, package: pkg, transport: t.transport,
    commit: args.commit ? "X" : "", activate: args.activate === false ? "" : "X",
    details_json: JSON.stringify(up(args.definition?.details ?? {})),
    compounds_json: args.definition?.compounds ? JSON.stringify(args.definition.compounds.map(up)) : undefined,
    attributes_json: args.definition?.attributes ? JSON.stringify(args.definition.attributes.map(up)) : undefined,
    navattr_json: args.definition?.navigationAttributes ? JSON.stringify(args.definition.navigationAttributes.map(up)) : undefined,
  })
  if (r.STATUS === "ok" && args.commit) t.confirm?.()
  return writeResult(r, t.note)
}

export async function handleBwChange(args: WriteArgs & { values?: Record<string, string | number | boolean>;
    compounds?: Record<string, unknown>[]; attributes?: Record<string, unknown>[]; navigationAttributes?: Record<string, unknown>[] }, extra?: { sessionId?: string }) {
  const pkg = await packageOf(args.connectionId, args.type, args.name)
  if (pkg === undefined) return text(`Changing stopped: there is no ${args.type.toUpperCase()} ${args.name.toUpperCase()} on this system. Check the name with bw_list.`)
  const t = await bwTransport(args, pkg, `changing ${args.type.toUpperCase()} ${args.name.toUpperCase()}`, extra?.sessionId, true)
  if (t.prompt || t.refuse) return text((t.prompt ?? `❌ ${t.refuse}`))
  const up = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.toUpperCase(), v]))
  const r = await bwCall(args.connectionId, {
    operation: "bw_change", tlogo: args.type, name: args.name, transport: t.transport,
    commit: args.commit ? "X" : "", activate: args.activate === false ? "" : "X",
    values_json: JSON.stringify(Object.entries(args.values ?? {}).map(([FIELD, VALUE]) => ({ FIELD: FIELD.toUpperCase(), VALUE: String(VALUE) }))),
    compounds_json: args.compounds ? JSON.stringify(args.compounds.map(up)) : undefined,
    attributes_json: args.attributes ? JSON.stringify(args.attributes.map(up)) : undefined,
    navattr_json: args.navigationAttributes ? JSON.stringify(args.navigationAttributes.map(up)) : undefined,
  })
  if (r.STATUS === "ok" && args.commit) t.confirm?.()
  return writeResult(r, t.note)
}

export async function handleBwActivate(args: WriteArgs, extra?: { sessionId?: string }) {
  const pkg = await packageOf(args.connectionId, args.type, args.name)
  if (pkg === undefined) return text(`Activating stopped: there is no ${args.type.toUpperCase()} ${args.name.toUpperCase()} on this system.`)
  const t = await bwTransport(args, pkg, `activating ${args.type.toUpperCase()} ${args.name.toUpperCase()}`, extra?.sessionId, true)
  if (t.prompt || t.refuse) return text((t.prompt ?? `❌ ${t.refuse}`))
  const r = await bwCall(args.connectionId, { operation: "bw_activate", tlogo: args.type, name: args.name, transport: t.transport, commit: args.commit ? "X" : "" })
  if (r.STATUS === "ok" && args.commit) t.confirm?.()
  return writeResult(r, t.note)
}

export async function handleBwDelete(args: WriteArgs, extra?: { sessionId?: string }) {
  const pkg = await packageOf(args.connectionId, args.type, args.name)
  if (pkg === undefined) return text(`Deleting stopped: there is no ${args.type.toUpperCase()} ${args.name.toUpperCase()} on this system. Check the name with bw_list.`)
  const t = await bwTransport(args, pkg, `deleting ${args.type.toUpperCase()} ${args.name.toUpperCase()}`, extra?.sessionId, true)
  if (t.prompt || t.refuse) return text((t.prompt ?? `❌ ${t.refuse}`))
  const r = await bwCall(args.connectionId, { operation: "bw_delete", tlogo: args.type, name: args.name, transport: t.transport, commit: args.commit ? "X" : "" })
  if (r.STATUS === "ok" && args.commit) t.confirm?.()
  return writeResult(r, t.note)
}

// ─── registration ────────────────────────────────────────────────────────────

const conn = z.string().optional().describe("SAP system connection ID")
const typeArg = z.string().describe("BW object type (TLOGO) as BW names it: IOBJ InfoObject, ADSO DataStore object (advanced), AREA InfoArea, HCPR CompositeProvider, TRFN transformation, DTPA DTP, RSPC process chain, CUBE InfoCube, ODSO classic DSO, … (bw_capabilities lists the system's types)")
const nameArg = z.string().describe("Object name (e.g. ZCUSTOMER, 0MATERIAL)")
const versionArg = z.enum(["A", "M", "D"]).optional().describe("A active (default), M modified (saved, not yet activated) or D delivered (Business Content not yet installed)")
const writeCommon = {
  commit: z.boolean().optional().describe("true writes; default is a dry run that checks and reports only"),
  transport: z.string().optional().describe("Workbench request to record on, for an object in a package that records changes; without it the open requests are offered"),
  workItem: z.string().optional().describe("Name of the piece of work, to keep using one transport for it"),
  showAllTransports: z.boolean().optional().describe("Offer everyone's open Workbench requests, not just yours"),
  connectionId: conn,
}

export function registerBwTools(server: McpServer): void {
  server.registerTool("bw_capabilities", {
    title: "BW Capabilities",
    description: "Report which BW the system has (BW 7.5 line through SAP_BW, BW/4HANA through DW4CORE, or none), whether transport recording and where-used are available, and per BW object type which operations work (available), lack an API on this system (no_api) or are not built yet (not_built). " +
      "Read it first on a new system. Runs in SAP through the engine's BW class; read-only.",
    inputSchema: { type: z.string().optional().describe("Only this object type (TLOGO), with all its operations"), connectionId: conn },
  }, handleBwCapabilities)

  server.registerTool("bw_list", {
    title: "List BW Objects",
    description: "List BW objects of one type by name pattern, with their long text: any type in BW's registry (InfoObjects, ADSOs, InfoAreas, CompositeProviders, transformations, DTPs, process chains, InfoCubes, …). " +
      "Read-only; at most 1000, default 200. Use bw_read for one object and bw_where_used for its users.",
    inputSchema: { type: typeArg, pattern: z.string().optional().describe("Name pattern, * as wildcard (default *)"), version: versionArg,
      language: z.string().optional().describe("Text language, one character (default the logon language)"),
      maxRows: z.number().optional().describe("At most this many (default 200, max 1000)"), connectionId: conn },
  }, handleBwList)

  server.registerTool("bw_read", {
    title: "Read BW Object",
    description: "Read one BW object: which versions exist (A active, M modified), its package, and its header rows from BW's own table; for an InfoObject the full definition through BAPI_IOBJ_GETDETAIL (details, compounds, attributes, navigation attributes). Read-only.",
    inputSchema: { type: typeArg, name: nameArg, version: versionArg, connectionId: conn },
  }, handleBwRead)

  server.registerTool("bw_where_used", {
    title: "BW Where-Used",
    description: "Show which BW objects use a BW object and which objects it uses, from BW's where-used table RSOOBJXREF (the list BW itself checks before a delete). Read-only.",
    inputSchema: { type: typeArg, name: nameArg, version: versionArg, connectionId: conn },
  }, handleBwWhereUsed)

  server.registerTool("bw_create", {
    title: "Create BW Object",
    description: "Create a BW object through BW's own API, by default activated afterwards. This version creates InfoObjects (type IOBJ) through BAPI_IOBJ_CREATE; bw_capabilities shows what else the system and this version support. " +
      "definition.details holds BAPI6108 fields, for example a characteristic: { TYPE: \"CHA\", DATATP: \"CHAR\", INTLEN: 10, TEXTSHORT: \"Short\", TEXTLONG: \"Long text\", INFOAREA: \"<InfoArea>\" }, a key figure: { TYPE: \"KYF\", KYFTP: \"AMO\", UNINM: \"0CURRENCY\" }; an unknown field is refused; read an existing one with bw_read to see the fields. " +
      "Dry run unless commit: true. In a package that records changes (not $TMP) it records the object on a Workbench request, chosen with the same rules as other writes.",
    inputSchema: {
      type: typeArg, name: nameArg,
      package: z.string().optional().describe("Package of the new object (default $TMP: local, not transported)"),
      definition: z.object({
        details: z.record(z.string(), z.unknown()).describe("InfoObject: BAPI6108 fields (field names as in BAPI6108, e.g. TYPE, DATATP, INTLEN, TEXTSHORT, TEXTLONG, INFOAREA)"),
        compounds: z.array(z.record(z.string(), z.unknown())).optional().describe("InfoObject: compound rows (BAPI6108CM)"),
        attributes: z.array(z.record(z.string(), z.unknown())).optional().describe("InfoObject: attribute rows (BAPI6108AT)"),
        navigationAttributes: z.array(z.record(z.string(), z.unknown())).optional().describe("InfoObject: navigation attribute rows (BAPI6108AN)"),
      }).describe("The object's definition in the fields of BW's API for its type"),
      activate: z.boolean().optional().describe("Activate after creating (default true)"),
      ...writeCommon,
    },
  }, handleBwCreate)

  server.registerTool("bw_change", {
    title: "Change BW Object",
    description: "Change a BW object through BW's own API, starting from its current definition: values sets single fields, and a table given replaces that table. By default activated afterwards. This version changes InfoObjects through BAPI_IOBJ_CHANGE. " +
      "Dry run unless commit: true; records on a Workbench request when the object's package records changes.",
    inputSchema: {
      type: typeArg, name: nameArg,
      values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Fields to set, e.g. { TEXTLONG: \"New text\" } (BAPI6108 names for an InfoObject)"),
      compounds: z.array(z.record(z.string(), z.unknown())).optional().describe("Replace the compound rows"),
      attributes: z.array(z.record(z.string(), z.unknown())).optional().describe("Replace the attribute rows"),
      navigationAttributes: z.array(z.record(z.string(), z.unknown())).optional().describe("Replace the navigation attribute rows"),
      activate: z.boolean().optional().describe("Activate after changing (default true)"),
      ...writeCommon,
    },
  }, handleBwChange)

  server.registerTool("bw_activate", {
    title: "Activate BW Object",
    description: "Activate a BW object's modified version through BW's own API (InfoObjects: BAPI_IOBJ_ACTIVATE_MULTIPLE). Dry run unless commit: true; records on a Workbench request when the object's package records changes.",
    inputSchema: { type: typeArg, name: nameArg, ...writeCommon },
  }, handleBwActivate)

  server.registerTool("bw_delete", {
    title: "Delete BW Object",
    description: "Delete a BW object through BW's own function (InfoObjects: RSDG_IOBJ_MULTI_DELETE), which refuses while other objects still use it (see bw_where_used). In a package that records changes the object is first recorded on a Workbench request, so the deletion reaches the other systems when the request is imported; an object already locked on a request uses that one. " +
      "Dry run unless commit: true. Irreversible.",
    inputSchema: { type: typeArg, name: nameArg, ...writeCommon },
  }, handleBwDelete)
}
