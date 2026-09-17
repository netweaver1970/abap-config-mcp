/**
 * Phase 1 — in-system Customizing Engine: deploy + invoke.
 *
 * These tools manage and call ZCL_MCP_CUST_ENGINE, an ABAP ICF handler that
 * performs customizing writes *inside* SAP (enqueue → validate → write →
 * transport recording → dequeue).  The engine source lives in
 * src/abap/zcl_mcp_cust_engine.ts and is deployed via the server's own
 * write+activate tooling — no separate upload, no extra local tooling.
 *
 * Tools:
 *   customizing_engine_bootstrap — create/update + activate the ABAP class
 *   customizing_engine_ping      — call the SICF endpoint, confirm deployed version
 *   customizing_apply            — run a read/write/dry-run operation via the engine
 */

import * as nodeHttp from "http"
import * as nodeHttps from "https"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, dropSessionLocks, log, getConnectionConfig } from "../connections"
import { handleCreateAbapObject, handleWriteAbapObjectSource, handleDeleteAbapObject } from "./write"
import { handleAbapActivate } from "./activate"
import {
  getEngineSource, ENGINE_VERSION, ENGINE_CLASS_NAME, ENGINE_CLASS_URL, ENGINE_ICF_PATH,
} from "../abap/zcl_mcp_cust_engine"
import { getWriterSource, WRITER_REPORT_NAME, WRITER_REPORT_URL } from "../abap/zmcp_cust_write"
import { resolveMaint, runSql, tableRows, col, type ResolvedMaint } from "./customizing"
import { selectTransport, rememberTransport, workKey } from "./transportSelection"
import { lookupRequest, listOpenRequests as listOpenRequestsSql } from "./transportSql"
import { resolveConnectionId } from "../connections"
import { getCapabilities, requireCaps, type PingResponse } from "./capabilities"

// ─── Raw HTTP helper ───────────────────────────────────────────────────────────
// The engine is reached via its SICF node, not an ADT endpoint, so we use the
// authenticated session's raw HTTP client (AdtHTTP.request).

// Keys are lowercase — /ui2/cl_json deserialize maps case-insensitively.
interface EngineRequest {
  operation: "ping" | "read" | "write" | "create" | "listing" | "delete" | "selftest" | "status" | "img_index_read" | "img_search" | "hana_memory" | "abap_memory" | "org_copy"
  table?: string
  key_field?: string
  source_key?: string
  target_key?: string
  transport?: string
  only_missing?: string       // "X" | ""
  commit?: string             // "X" | ""
  max_rows?: number
  record_transport?: string   // "" = default (true for C/G/E); "false" = skip recording
  view_name?: string          // maintenance object (resolved MCP-side): view (VDAT/CDAT member) or table (TABU)
  transport_object?: string   // "VDAT" | "TABU" | "CDAT" — what the headless write records on the transport
  cluster_name?: string       // view cluster (VCLSTRUC) when transport_object = "CDAT"; data still writes through view_name
  run_id?: string             // for operation "status" — poll a prior async write
  structure_id?: string       // img_index_read: IMG tree id (default root)
  language?: string           // img_index_read: 1-char SPRAS
  keyword?: string            // img_index_read: case-insensitive substring on node title
  create_transport?: string   // write: "X" = mint a new Customizing request when no transport given
  transport_text?: string     // write: short text for the engine-created Customizing request
  action?: string             // org_copy: "COPY" | "DELE"
  org_unit?: string           // org_copy: org-key DOMAIN name (BUKRS, WERKS, VKORG, VTWEG, SPART, EKORG, …)
  values_json?: string        // write: JSON array of {FIELD,VALUE} overrides applied to every planned row
  rows_json?: string          // create: JSON array of rows, each a JSON array of {FIELD,VALUE} (full key + data)
  items_json?: string         // listing: JSON array of {PRODUCT,ASSORTMENT,DATE_FROM,DATE_TO}
}

// ─── transport selection ─────────────────────────────────────────────────────
// Customizing writes (CTS function 'W') follow the same rule as workbench writes —
// see transportSelection.ts. Two cases record nothing and need no transport: a
// delivery class A table (application data, written directly) and a client that
// does not record changes. When the caller asks for a new request, the engine
// creates it at commit, and it is remembered for the piece of work afterwards.

interface CustomizingTransport {
  transport?: string
  note?: string
  prompt?: string
  engineCreates?: boolean
}

async function resolveCustomizingTransport(
  args: { table: string; transport?: string; createTransport?: boolean; recordTransport?: boolean;
          showAllTransports?: boolean; workItem?: string; connectionId?: string },
  commit: boolean,
  what: string,
  sessionId: string | undefined,
): Promise<CustomizingTransport> {
  if (!commit || args.recordTransport === false) return { transport: args.transport }
  const client = await ensureConnected(args.connectionId)
  const cfg = getConnectionConfig(args.connectionId)
  try {
    const dd02 = tableRows(await runSql(client, `SELECT CONTFLAG FROM DD02L WHERE TABNAME = '${args.table.toUpperCase().replace(/'/g, "''")}' AND AS4LOCAL = 'A'`, 1))[0]
    if (dd02 && col(dd02, "CONTFLAG") === "A") return { note: `No transport — ${args.table} is application data (delivery class A).` }
    const t000 = tableRows(await runSql(client, `SELECT CCCORACTIV FROM T000 WHERE MANDT = '${(cfg.client ?? "").replace(/'/g, "''")}'`, 1))[0]
    if (t000 && col(t000, "CCCORACTIV") !== "1") return { note: `No transport — client ${cfg.client} does not record changes.` }
  } catch (err) {
    log("WARN", "delivery class / client recording check failed — continuing with transport selection", err)
  }
  if (args.createTransport && !args.transport) return { engineCreates: true }

  const sel = await selectTransport({
    connectionId: resolveConnectionId(args.connectionId),
    fn: "W",
    what,
    supplied: args.transport,
    workItem: args.workItem,
    sessionId,
    candidates: await listOpenRequestsSql(args.connectionId, "W", args.showAllTransports ? undefined : cfg.username),
    lookup: trkorr => lookupRequest(args.connectionId, trkorr),
  })
  if (sel.kind === "ask") {
    return { prompt: sel.text + `\n\nOr: createTransport: true for a new Customizing request (transportText: to name it), ` +
      `recordTransport: false for a direct untransported write` +
      (args.showAllTransports ? "." : `, showAllTransports: true to list everyone's requests.`) }
  }
  return { transport: sel.trkorr, note: sel.note }
}

// Response keys come back uppercase from /ui2/cl_json pretty_mode-none serialize.
interface EngineResponse {
  STATUS?: string
  OPERATION?: string
  VERSION?: string
  DRY_RUN?: string
  TABLE?: string
  ROWS_PLANNED?: number
  ROWS_WRITTEN?: number
  TRANSPORT?: string
  MESSAGES?: string[]
  DATA_JSON?: string
  RUN_ID?: string
}

// Default timeout for engine calls. Engine ops are synchronous server-side and
// some (org_copy commits run the whole EC01 dependent-table set in one request)
// run for minutes — well past axios' 30 s default — so we give them generous
// headroom and let callers override per call.
const ENGINE_DEFAULT_TIMEOUT_MS = 10 * 60_000   // 10 min

interface EngineHttpResponse { status: number; body: string; contentType: string }

/**
 * POST to the engine's SICF endpoint over an ISOLATED HTTP connection (Node
 * http/https with Basic auth + sap-client), NOT the shared ADT session's client.
 *
 * Why: the engine handler is a plain ICF node; routing its POST through the
 * abap-adt-api stateful session clobbered that session's security cookie/CSRF
 * state, so the next ADT call came back HTTP 400 ("degraded session"). Each call
 * here opens its own short-lived connection (Connection: close), carries no
 * cookies, and never touches the ADT session — so the engine can be hit any
 * number of times without degrading reads/writes that DO use the session.
 */
function engineHttpPost(
  connectionId: string | undefined,
  icfPath: string,
  bodyStr: string,
  timeoutMs: number,
): Promise<EngineHttpResponse> {
  const cfg = getConnectionConfig(connectionId)
  const u = new URL(cfg.url)
  const isHttps = u.protocol === "https:"
  const lib = isHttps ? nodeHttps : nodeHttp
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")
  const sep = icfPath.includes("?") ? "&" : "?"
  const path = `${icfPath}${sep}sap-client=${encodeURIComponent(cfg.client ?? "")}`

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path,
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          Connection: "close",
        },
        // Self-signed handling mirrors buildClient(): only relax when configured.
        ...(isHttps && cfg.allowSelfSigned ? { rejectUnauthorized: false } : {}),
        ...(isHttps && cfg.ca ? { ca: cfg.ca } : {}),
      },
      res => {
        const chunks: Buffer[] = []
        res.on("data", d => chunks.push(d as Buffer))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        )
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Engine request timed out after ${timeoutMs} ms`)))
    req.on("error", reject)
    req.end(bodyStr)
  })
}

async function callEngine(
  connectionId: string | undefined,
  body: EngineRequest,
  icfPath: string = ENGINE_ICF_PATH,
  timeoutMs: number = ENGINE_DEFAULT_TIMEOUT_MS,
): Promise<EngineResponse> {
  const resp = await engineHttpPost(connectionId, icfPath, JSON.stringify(body), timeoutMs)
  const raw = (resp.body ?? "").trim()

  if (!raw) {
    throw new Error(`Engine returned empty body (HTTP ${resp.status || "?"})`)
  }

  // Non-200 before attempting JSON parse — body is likely an HTML/text error page
  if (resp.status >= 300) {
    throw new Error(`Engine HTTP ${resp.status}: ${raw.substring(0, 500)}`)
  }

  try {
    return JSON.parse(raw) as EngineResponse
  } catch {
    throw new Error(`Engine returned non-JSON (HTTP ${resp.status || "?"}): ${raw.substring(0, 500)}`)
  }
}

/** Engine ping for capability probing (see capabilities.ts). */
const pingEngine = (connectionId?: string): Promise<PingResponse> =>
  callEngine(connectionId, { operation: "ping" }) as Promise<PingResponse>

/** A background run that is still going: 'pending' (queued) or 'running' (active).
 *  Terminal states — 'ok' / 'error' / 'aborted' / 'unknown' — stop the poll. */
const isRunStillGoing = (s?: string): boolean => s === "pending" || s === "running"

// ─── IMG search-index read (STREE/SHI HSRCH cluster) ─────────────────────────────
// Calls the engine's img_index_read op for one IMG structure. The engine IMPORTs
// the INDX_HSRCH cluster (built by RS_SHI10_TEXTINDEX_UPDATE), keyword-filters node
// titles, and returns hits with a reconstructed breadcrumb path. status='no_index'
// means no TTREESRCH generation exists for that tree → caller should use raw tables.

export interface ImgIndexHit {
  TEXT: string
  NODE_ID: string
  EXTENSION: string
  STRUCTURE_ID: string
  PATH: string
}

export interface ImgSearchHit {
  ACTIVITY: string
  TEXT: string
  OBJECTTYPE: string
  OBJECTNAME: string
  TCODE: string
}

// Engine-side img_search: a full CUS_IMGACT scan with a server-side LIKE over the
// title TEXT *and* the activity id — no ADT Data-Preview 200-row alphabetical
// window, and it finds component-acronym hits (TSW → SIMG_OIJ_TSW_*) whose
// functional titles never contain the acronym. Returns null when the engine is
// unreachable or the op is unknown on an older engine → caller falls back to raw.
export async function imgSearchViaEngine(
  connectionId: string | undefined,
  args: { keyword: string; language?: string; maxRows?: number; icfPath?: string },
): Promise<{ hits: ImgSearchHit[]; messages: string[]; capped: boolean } | null> {
  let r: EngineResponse
  try {
    r = await callEngine(connectionId, {
      operation: "img_search",
      keyword:   args.keyword,
      language:  args.language,
      max_rows:  args.maxRows,
    }, args.icfPath)
  } catch {
    return null   // engine unreachable → fall back to the raw ADT path
  }
  if (r.STATUS !== "ok") return null   // unknown op on an older engine, or an error
  let hits: ImgSearchHit[] = []
  if (r.DATA_JSON) {
    try { hits = JSON.parse(r.DATA_JSON) as ImgSearchHit[] } catch { hits = [] }
  }
  const capped = (r.MESSAGES ?? []).some(m => /capped/i.test(m))
  return { hits, messages: r.MESSAGES ?? [], capped }
}

export async function imgIndexRead(
  connectionId: string | undefined,
  args: { structureId: string; language?: string; keyword?: string; maxRows?: number; icfPath?: string },
): Promise<{ status: string; messages: string[]; hits: ImgIndexHit[] }> {
  const r = await callEngine(connectionId, {
    operation:    "img_index_read",
    structure_id: args.structureId,
    language:     args.language,
    keyword:      args.keyword,
    max_rows:     args.maxRows,
  }, args.icfPath)
  let hits: ImgIndexHit[] = []
  if (r.DATA_JSON) {
    try { hits = JSON.parse(r.DATA_JSON) as ImgIndexHit[] } catch { hits = [] }
  }
  return { status: r.STATUS ?? "error", messages: r.MESSAGES ?? [], hits }
}

// ─── auto-deploy ────────────────────────────────────────────────────────────────
// Ensures the ABAP class is present and at the expected version before the engine
// is invoked.  Only handles the ABAP side — the one-time SICF service registration
// is manual and surfaced to the user when ping fails.

async function ensureEngineClass(connectionId?: string): Promise<{ changed: boolean; action: string }> {
  const client = await ensureConnected(connectionId)
  let current: string | undefined
  try {
    current = await client.getObjectSource(`${ENGINE_CLASS_URL}/source/main`)
  } catch {
    current = undefined
  }
  // Whitespace-tolerant match — ADT's pretty-printer may reformat the line,
  // so don't rely on exact spacing of "TYPE string VALUE".
  const versionRe = new RegExp(`c_version\\b[\\s\\S]*?VALUE\\s+'${ENGINE_VERSION.replace(/\./g, "\\.")}'`)
  if (current && versionRe.test(current)) {
    // Class is current — still verify the batch writer report exists
    let reportPresent = false
    try {
      await client.getObjectSource(`${WRITER_REPORT_URL}/source/main`)
      reportPresent = true
    } catch {
      reportPresent = false
    }
    if (reportPresent) return { changed: false, action: "already current" }
    // Report missing despite class being current — re-run bootstrap to deploy it
  }
  // bootstrap handles both create (missing) and update-in-place (stale)
  await handleEngineBootstrap({ connectionId })
  return { changed: true, action: current ? "updated" : "created" }
}

// ─── customizing_engine_bootstrap ───────────────────────────────────────────────

export async function handleEngineBootstrap(args: {
  packageName?: string
  transport?: string
  connectionId?: string
}) {
  const pkg = args.packageName ?? "$TMP"
  const lines: string[] = [`Deploying ${ENGINE_CLASS_NAME} v${ENGINE_VERSION} to package ${pkg}…`]

  // 1. ICF handler class (ZCL_MCP_CUST_ENGINE)
  const client = await ensureConnected(args.connectionId)
  let exists = false
  try {
    await client.getObjectSource(`${ENGINE_CLASS_URL}/source/main`)
    exists = true
  } catch {
    exists = false
  }

  if (!exists) {
    await handleCreateAbapObject({
      objectType: "CLAS/OC",
      name: ENGINE_CLASS_NAME,
      description: `MCP Customizing Engine v${ENGINE_VERSION}`,
      packageName: pkg,
      transport: args.transport,
      connectionId: args.connectionId,
    })
    lines.push(`✅ Created class ${ENGINE_CLASS_NAME}`)
  } else {
    lines.push(`ℹ️  Class ${ENGINE_CLASS_NAME} exists — updating source in-place`)
  }

  await handleWriteAbapObjectSource({
    url: ENGINE_CLASS_URL,
    source: getEngineSource(),
    transport: args.transport,
    connectionId: args.connectionId,
  })
  lines.push(`✅ Class source written (v${ENGINE_VERSION})`)

  const act = await handleAbapActivate({ url: ENGINE_CLASS_URL, connectionId: args.connectionId })
  const actText = act.content[0].text
  if (/❌|Activation failed/i.test(actText)) {
    lines.push(`❌ Class activation failed:`, actText)
    return { content: [{ type: "text" as const, text: lines.join("\n") }] }
  }
  lines.push(`✅ Class activated`)

  // 2. Batch writer report (ZMCP_CUST_WRITE) — runs with sy-batch='X' for TR_OBJECTS_INSERT
  let reportExists = false
  try {
    await client.getObjectSource(`${WRITER_REPORT_URL}/source/main`)
    reportExists = true
  } catch {
    reportExists = false
  }

  if (!reportExists) {
    await handleCreateAbapObject({
      objectType: "PROG/P",
      name: WRITER_REPORT_NAME,
      description: "MCP Customizing Engine — batch write worker",
      packageName: pkg,
      transport: args.transport,
      connectionId: args.connectionId,
    })
    lines.push(`✅ Created report ${WRITER_REPORT_NAME}`)
  } else {
    lines.push(`ℹ️  Report ${WRITER_REPORT_NAME} exists — updating source in-place`)
  }

  await handleWriteAbapObjectSource({
    url: WRITER_REPORT_URL,
    source: getWriterSource(),
    transport: args.transport,
    connectionId: args.connectionId,
  })
  lines.push(`✅ Report source written`)

  const actR = await handleAbapActivate({ url: WRITER_REPORT_URL, connectionId: args.connectionId })
  const actRText = actR.content[0].text
  if (/❌|Activation failed/i.test(actRText)) {
    lines.push(`❌ Report activation failed:`, actRText)
    return { content: [{ type: "text" as const, text: lines.join("\n") }] }
  }
  lines.push(`✅ Report activated`)

  lines.push(
    "",
    exists
      ? `Engine updated. Run customizing_engine_ping to confirm v${ENGINE_VERSION} is live.`
      : [
          `Next — register the SICF service once (BASIS):`,
          `  SICF → Create service under  ${ENGINE_ICF_PATH.replace(/\/[^/]+$/, "")}`,
          `  Service name:  ${ENGINE_ICF_PATH.split("/").pop()}`,
          `  Handler class: ${ENGINE_CLASS_NAME}`,
          `  Then activate the service and run customizing_engine_ping.`,
        ].join("\n"),
  )

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_engine_ping ────────────────────────────────────────────────────

export async function handleEnginePing(args: {
  icfPath?: string
  rawDump?: boolean   // set true to return raw HTTP body for diagnostics
  connectionId?: string
}) {
  const path = args.icfPath ?? ENGINE_ICF_PATH

  // Raw dump mode: bypass callEngine's JSON parsing and return the literal HTTP
  // response, over the same isolated client (never the shared ADT session).
  if (args.rawDump) {
    try {
      const resp = await engineHttpPost(args.connectionId, path, JSON.stringify({ operation: "ping" }), ENGINE_DEFAULT_TIMEOUT_MS)
      const body = resp.body || "(empty)"
      return { content: [{ type: "text" as const, text:
        `HTTP ${resp.status}\nContent-Type: ${resp.contentType || "(none)"}\n\n${body.substring(0, 2000)}` }] }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text:
        `HTTP error\n${String(err?.message ?? err).substring(0, 2000)}` }] }
    }
  }

  try {
    const r = await callEngine(args.connectionId, { operation: "ping" }, path)
    const versionMatch = r.VERSION === ENGINE_VERSION
    const lines = [
      `✅ Engine responded`,
      `   Deployed version: ${r.VERSION ?? "?"}`,
      `   Expected version: ${ENGINE_VERSION}${versionMatch ? " ✅" : " ⚠️  mismatch — run customizing_engine_bootstrap"}`,
      ...(r.MESSAGES ?? []).map(m => `   ${m}`),
    ]

    // Structured environment/capability probe (DATA_JSON) — so the assistant can
    // branch on what THIS box offers instead of assuming a release.
    if (r.DATA_JSON) {
      try {
        const e = JSON.parse(r.DATA_JSON) as Record<string, unknown>
        const on = (v: unknown) => v === "X" || v === true || v === "true"
        lines.push(
          ``,
          `   Environment & capabilities (probed live):`,
          `     • Release:   SAP_BASIS ${e.SAP_BASIS ?? "?"}${on(e.IS_S4) ? `, S4CORE ${e.S4CORE}` : " (non-S/4)"}`,
          `     • Client:    ${e.CLIENT ?? "?"} (role ${e.CLIENT_ROLE ?? "?"})`,
          `     • org_copy (ECOP entity copier): ${on(e.HAS_ORG_COPY) ? "available" : "NOT available"}`,
          `     • create CTS task (TRINT):       ${on(e.HAS_CTS_TASK) ? "available" : "NOT available"}`,
          `     • Migration Cockpit GUI (LTMC):  ${on(e.HAS_MC_GUI) ? "present" : "not present — use the Fiori app"}`,
        )
      } catch { /* non-fatal: the human summary is already in MESSAGES */ }
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] }
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    return { content: [{ type: "text" as const, text:
      `❌ Engine ping failed: ${msg}\n\n` +
      `Tip: re-run with rawDump: true to see the literal HTTP response body.` }] }
  }
}

// ─── hana_memory_report ─────────────────────────────────────────────────────────

export async function handleHanaMemory(args: {
  icfPath?: string
  connectionId?: string
}) {
  const path = args.icfPath ?? ENGINE_ICF_PATH
  try {
    const r = await callEngine(args.connectionId, { operation: "hana_memory" }, path)
    if (r.STATUS !== "ok") {
      return { content: [{ type: "text" as const, text:
        `❌ hana_memory failed: ${(r.MESSAGES ?? []).join("; ") || "unknown error"}` }] }
    }
    let lines: string[] = []
    if (r.DATA_JSON) {
      try { lines = JSON.parse(r.DATA_JSON) as string[] } catch { lines = [] }
    }
    // Group by leading tag for readability
    const groups: Record<string, string> = {
      HOST: "Host RAM / swap", SVC: "Per-service memory", HEAP: "Top heap allocators",
      CS: "Largest loaded column tables", TOT: "Loaded column-store total",
      RS: "Row store", PLAN: "SQL plan cache", GAL: "Configured allocation limit",
    }
    const out: string[] = [`HANA memory report (engine v${r.VERSION ?? "?"})`, ""]
    let lastTag = ""
    for (const l of lines) {
      const sp = l.indexOf(" ")
      const tag = sp < 0 ? l : l.substring(0, sp)
      const rest = sp < 0 ? "" : l.substring(sp + 1)
      if (tag !== lastTag) { out.push(`▸ ${groups[tag] ?? tag}`); lastTag = tag }
      out.push(`   ${rest}`)
    }
    return { content: [{ type: "text" as const, text: out.join("\n") }] }
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    return { content: [{ type: "text" as const, text:
      `❌ hana_memory failed: ${msg}\n\nRun customizing_engine_ping to confirm the engine is live ` +
      `(this tool needs engine v0.9.8+; run customizing_engine_bootstrap if older).` }] }
  }
}

// ─── abap_memory_report ───────────────────────────────────────────────────────
// ABAP app-server side of box health: key kernel memory/box-health profile
// parameters (PHYS_MEMSIZE, extended memory, heap, roll/paging, buffers, WP
// counts) via C_SAPGPARAM. Companion to hana_memory_report (the DB side); on a
// single-host AS+DB appliance, read both to reason about RAM over-commit/swap.
export async function handleAbapMemory(args: {
  icfPath?: string
  connectionId?: string
}) {
  const path = args.icfPath ?? ENGINE_ICF_PATH
  try {
    const r = await callEngine(args.connectionId, { operation: "abap_memory" }, path)
    if (r.STATUS !== "ok") {
      return { content: [{ type: "text" as const, text:
        `❌ abap_memory failed: ${(r.MESSAGES ?? []).join("; ") || "unknown error"}` }] }
    }
    let params: { NAME: string; VALUE: string }[] = []
    if (r.DATA_JSON) { try { params = JSON.parse(r.DATA_JSON) } catch { params = [] } }
    const out: string[] = [`ABAP AS memory parameters (engine v${r.VERSION ?? "?"}) — via C_SAPGPARAM`, ""]
    for (const p of params) out.push(`   ${(p.NAME ?? "").padEnd(28)} ${p.VALUE ?? ""}`)
    return { content: [{ type: "text" as const, text: out.join("\n") }] }
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    return { content: [{ type: "text" as const, text:
      `❌ abap_memory failed: ${msg}\n\nRun customizing_engine_ping to confirm the engine is live ` +
      `(this tool needs engine v0.9.16+; run customizing_engine_bootstrap if older).` }] }
  }
}

// ─── org_copy ───────────────────────────────────────────────────────────────────
// Copy/delete a whole organizational unit with ALL dependent customizing via
// SAP's standard entity copier (ECOP_ORG_UNITS_IN_THE_DARK) — the exact engine
// behind EC01 (company code), EC02 (plant), EC04 (sales org), EC05 (distribution
// channel), EC06 (division), EC13 (purchasing org) — run headlessly.

const ORG_UNIT_DOMAINS: Record<string, string> = {
  BUKRS: "company code (EC01)", WERKS: "plant (EC02)", CACCD: "controlling area (EC03)",
  VKORG: "sales organization (EC04)", VTWEG: "distribution channel (EC05)",
  SPART: "division (EC06)", VSTEL: "shipping point (EC07)", LGNUM: "warehouse number (EC09)",
  EKORG: "purchasing organization (EC13)", LGORT: "storage location (EC14)", MTART: "material type (EC15)",
}

export async function handleOrgCopy(args: {
  orgUnit: string
  sourceKey: string
  targetKey?: string
  action?: "copy" | "delete"
  transport?: string
  commit?: boolean
  createTransport?: boolean
  showAllTransports?: boolean
  autoDeploy?: boolean
  icfPath?: string
  connectionId?: string
}) {
  const commit = args.commit === true
  const isDelete = args.action === "delete"
  const orgUnit = args.orgUnit.toUpperCase()

  if (!isDelete && !args.targetKey) {
    return { content: [{ type: "text" as const, text:
      `❌ targetKey is required for a copy. For a delete, set action: "delete" — sourceKey is the unit to remove.` }] }
  }

  let deployNote = ""
  if (args.autoDeploy !== false) {
    try {
      const d = await ensureEngineClass(args.connectionId)
      if (d.changed) deployNote = `(engine ${d.action} to v${ENGINE_VERSION})\n`
    } catch (err) {
      log("WARN", "auto-deploy of engine class failed", err)
    }
  }

  // Target-aware pre-flight: the EC entity copier isn't on every box (e.g. CAR
  // has no ECOP). Refuse cleanly here instead of calling the engine and failing.
  const caps = await getCapabilities(args.connectionId, pingEngine)
  const capErr = requireCaps(caps, ["hasOrgCopy"],
    { hasOrgCopy: "the EC entity copier (ECOP_ORG_UNITS_IN_THE_DARK)" })
  if (capErr) {
    return { content: [{ type: "text" as const, text: `❌ org_copy ${capErr}.` }] }
  }

  // The entity copier ALWAYS records onto a Customizing request it mints ITSELF —
  // a caller-supplied request is not honored (ECOP's IMPORT_TR_REQUEST is a
  // different, import-only input). So there is no "pick an existing request"
  // choice; the only decision is whether to let it create one. Require the
  // explicit opt-in instead of pretending a supplied transport will be used.
  if (commit && !args.createTransport) {
    return { content: [{ type: "text" as const, text:
      `${deployNote}⚠️  org_copy records onto a Customizing request the entity copier mints ITSELF — ` +
      `it cannot record into a request you supply (a passed transport is ignored). Re-run with ` +
      `createTransport: true to acknowledge and let it create one; the new request number is ` +
      `reported on completion.` }] }
  }

  let r: EngineResponse
  try {
    r = await callEngine(args.connectionId, {
      operation: "org_copy",
      org_unit: orgUnit,
      source_key: args.sourceKey,
      target_key: args.targetKey ?? "",
      action: isDelete ? "DELE" : "COPY",
      commit: commit ? "X" : "",
      create_transport: args.createTransport === true ? "X" : "",
    }, args.icfPath)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Engine call failed: ${String((err as Error).message ?? err)}\n` +
      `Run customizing_engine_ping to diagnose (org_copy needs engine v0.9.9+).` }] }
  }

  // Async commit: the copier runs in a background job and returns 'pending' +
  // run_id if it outlives the engine's short in-handler poll. A whole-org-unit
  // copy can take a while, so keep polling here within a budget under the MCP
  // 60 s ceiling; if still running, hand back the run_id for customizing_status.
  if (commit && r.STATUS === "pending" && r.RUN_ID) {
    const runId = r.RUN_ID
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 3_000))
      let s: EngineResponse
      try {
        s = await callEngine(args.connectionId, { operation: "status", run_id: runId }, args.icfPath)
      } catch {
        continue   // transient read failure — keep polling within budget
      }
      if (s.STATUS && !isRunStillGoing(s.STATUS)) {          // terminal → stop
        r = { ...r, STATUS: s.STATUS, ROWS_WRITTEN: s.ROWS_WRITTEN ?? r.ROWS_WRITTEN,
              ROWS_PLANNED: s.ROWS_PLANNED ?? r.ROWS_PLANNED,
              TRANSPORT: s.TRANSPORT ?? r.TRANSPORT, MESSAGES: s.MESSAGES ?? r.MESSAGES, RUN_ID: undefined }
        break
      }
      if (s.STATUS === "running") {                          // still active → refresh progress, keep polling
        r = { ...r, STATUS: "running", MESSAGES: s.MESSAGES ?? r.MESSAGES }
      }
    }
  }

  // NB: the entity copier records onto a request it mints ITSELF; that request is
  // not a user-chosen one, so we do NOT rememberTransport() it — doing so would
  // offer it as "continue on …" for unrelated later writes (session poisoning).

  const isDry = !commit
  const unitDesc = ORG_UNIT_DOMAINS[orgUnit] ?? orgUnit
  const stillGoing = isRunStillGoing(r.STATUS)
  const lines: string[] = [
    ...(deployNote ? [deployNote.trimEnd()] : []),
    isDry ? `📋 DRY RUN — nothing copied`
      : r.STATUS === "ok" ? `✏️  ${isDelete ? "DELETED" : "COPIED"}`
      : stillGoing ? `⚙️  RUNNING in a background job`
      : `❌ FAILED`,
    `   Status:     ${r.STATUS}`,
    `   Org unit:   ${orgUnit} — ${unitDesc}`,
    isDelete
      ? `   Delete:     ${args.sourceKey}`
      : `   Copy:       ${args.sourceKey} → ${args.targetKey}`,
    // The copier does not enumerate its dependent-table set on a dry run; on commit
    // ROWS_WRITTEN is the E071K object-key count, NOT a table count (the real
    // dependent-table count is in the messages, e.g. "91 dependent tables processed").
    ...(isDry
      ? [`   Dependent tables: not enumerated on dry run (resolved by the copier at commit)`]
      : r.STATUS === "ok"
        ? [`   Object keys recorded: ${r.ROWS_WRITTEN ?? 0}  (on the transport task; see messages for the table count)`]
        : []),
    ...(commit && r.STATUS === "ok" ? [`   Transport:  ${r.TRANSPORT ?? "(none)"}`] : []),
    ...(stillGoing && r.RUN_ID
      ? [`   Run id:     ${r.RUN_ID}  — still running; poll with customizing_status (run_id above)`]
      : []),
    ...(r.MESSAGES?.length ? ["", "   Messages:", ...r.MESSAGES.map(m => `     • ${m}`)] : []),
  ]

  if (isDry && r.DATA_JSON) {
    try {
      const tabs = JSON.parse(r.DATA_JSON) as Array<{ TABNAME?: string; TEXT?: string }>
      if (Array.isArray(tabs) && tabs.length) {
        lines.push("", `   Dependent tables (first 40 of ${tabs.length}):`)
        for (const t of tabs.slice(0, 40)) lines.push(`     ${t.TABNAME ?? "?"}  ${t.TEXT ?? ""}`)
      }
    } catch { /* leave table list out if unparseable */ }
    lines.push("", `   To apply: re-run with commit: true and transport: <W request>`)
  }

  if (r.STATUS === "error") {
    log("WARN", `org_copy error ${orgUnit} ${args.sourceKey}→${args.targetKey}`, r.MESSAGES)
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── switch-gated packages ──────────────────────────────────────────────────────
//
// Views in switch-gated packages (IS-Oil: OIB, OIB_QCI, OIJ) used to be refused
// here, after two headless commits ran for hours (V_TOIJRMOT 2026-07-07, 12h+;
// V_OIJNOM_ST03 2026-09-03, 27 min cancelled). The cause was found on
// 2026-09-17 and is not the package, the switch state, or a cold view:
//
//   VIEW_MAINTENANCE_SINGLE_ENTRY with corr_number records through
//   TR_OBJECTS_INSERT, which hardcodes iv_with_dialog='X'. In dialog mode
//   TRINT_OBJECTS_CHECK_AND_INSERT also performs switch-BC-set recording
//   ("call_scpr_transport") whenever any switch is in use in the client —
//   always true on an industry-solution system — and for an object in a
//   switched package that recording (CL_BCFG_BCSET_DS_HELPER, CL_ABAP_SWITCH,
//   the DDIC scans of the audit trace) works through SCPRVALL, 1.4 million
//   rows on S4. In a background job it never came back.
//
// Measured on S4, V_OIB06 (package OIB, switch OIB_PAR_INVENTORY = ON):
//   VMSE no_transport, cold function group  5.9 s   (warm: 0.29 s)
//   write + headless key recording (TRINT_OBJECTS_CHECK_AND_INSERT, mode 'D':
//   insert without dialog) of 3 rows into V_OIB05: seconds
//   (mode ' ' only checks and records nothing; mode 'X' is the dialog path
//   that also runs the switch-BC-set recording)
//
// The writer (zmcp_cust_write.abap, record_headless) now writes through the
// view runtime without transport and records the keys headlessly, so there is
// nothing left to refuse. resolveMaint still resolves switchId, for information.

// ─── customizing_apply ──────────────────────────────────────────────────────────

export async function handleCustomizingApply(args: {
  table: string
  keyField: string
  sourceKey?: string
  targetKey: string
  action?: "copy" | "delete"
  values?: Record<string, string>
  transport?: string
  onlyMissing?: boolean
  commit?: boolean
  recordTransport?: boolean
  createTransport?: boolean
  transportText?: string
  showAllTransports?: boolean
  autoDeploy?: boolean
  icfPath?: string
  workItem?: string
  connectionId?: string
}, extra?: { sessionId?: string }) {
  const commit = args.commit === true
  const isDelete = args.action === "delete"

  if (!isDelete && !args.sourceKey) {
    return { content: [{ type: "text" as const, text:
      `❌ sourceKey is required for a copy (action: "copy"). For a delete, set action: "delete" and pass the key to remove as targetKey.` }] }
  }

  // Auto-deploy the ABAP class if missing/outdated (default on)
  let deployNote = ""
  if (args.autoDeploy !== false) {
    try {
      const d = await ensureEngineClass(args.connectionId)
      if (d.changed) deployNote = `(engine ${d.action} to v${ENGINE_VERSION})\n`
    } catch (err) {
      log("WARN", "auto-deploy of engine class failed", err)
    }
  }
  // Resolve the maintenance object so the engine writes through the generated
  // SM30 runtime (VIEW_MAINTENANCE_SINGLE_ENTRY) and records the correct transport
  // object: VDAT for a maintenance view, TABU for a single-table maintenance.
  // For a view-cluster member we drive the member view and record R3TR VDAT (member)
  // + the TABU keys — which transports the cluster member data correctly. True
  // R3TR CDAT (SM34) recording is NOT done: the only headless key-level recorder
  // (TR_OBJECTS_INSERT) is dialog-bound and raises TK495 even in a background job.
  // (The engine's transport_object='CDAT' path exists but is dormant pending an
  // SLCTR/VIEWCLUSTER_IMPORT approach.) Skipped for direct (recordTransport:false) writes.
  let maintObject = ""
  let transportObject = ""          // "VDAT" | "TABU"
  let clusterName = ""
  let resolveNote = ""
  if (args.recordTransport !== false) {
    try {
      const client = await ensureConnected(args.connectionId)
      const maint = await resolveMaint(client, args.table)
      if (maint.maintObject && maint.recordObject) {
        maintObject     = maint.maintObject
        // Record the member view (VDAT) / table (TABU). Cluster members record VDAT
        // for now (true CDAT recording is dialog-bound headlessly — see above).
        transportObject = maint.recordObject
        clusterName     = maint.cluster ?? ""
        const clusterNote = maint.cluster
          ? ` — in view cluster ${maint.cluster} (records the member view ${maintObject} as R3TR VDAT; SM34 R3TR CDAT not recorded headlessly)`
          : ""
        resolveNote = `(maint object ${maintObject} → R3TR ${transportObject}; ` +
          `table set ${maint.tables.join(" + ")}${clusterNote})\n`
      } else {
        // No generated SM30/SM34 maintenance — a transported write isn't possible.
        if (commit) {
          return { content: [{ type: "text" as const, text:
            `❌ ${args.table} has no generated SM30/SM34 maintenance view` +
            `${maint.objectType ? ` (CUS_ACTOBJ object type '${maint.objectType}')` : " (it is maintained by a dedicated transaction, not a view)"}, ` +
            `so a transport-recorded write through the view runtime isn't possible. ` +
            `Use recordTransport: false for a direct (untransported) write, or maintain it in SPRO.` }] }
        }
        resolveNote = `(no generated maintenance for ${args.table}; dry-run only)\n`
      }
    } catch (err) {
      log("WARN", "maintenance-object resolution failed", err)
    }
  }

  const body: EngineRequest = {
    operation: isDelete ? "delete" : "write",
    table: args.table,
    key_field: args.keyField,
    source_key: args.sourceKey ?? "",
    target_key: args.targetKey,
    transport: args.transport,
    only_missing: args.onlyMissing === false ? "" : "X",   // default true (copy only)
    commit: commit ? "X" : "",
    record_transport: args.recordTransport === false ? "" : "X",
    create_transport: args.createTransport === true ? "X" : "",
    view_name: maintObject,
    transport_object: transportObject,
    cluster_name: clusterName,
    values_json: args.values && Object.keys(args.values).length
      ? JSON.stringify(Object.entries(args.values).map(([field, value]) => ({ FIELD: field, VALUE: value })))
      : undefined,
  }

  // ── Transport (the shared rule in transportSelection.ts) ─────────────────────
  const tsel = await resolveCustomizingTransport(args, commit,
    `the customizing write (${args.table} ${args.keyField}=${args.targetKey})`, extra?.sessionId)
  if (tsel.prompt) return { content: [{ type: "text" as const, text: `${deployNote}${resolveNote}${tsel.prompt}` }] }
  body.transport = tsel.transport
  if (tsel.note) resolveNote += `${tsel.note}\n`
  // Pass the optional request name through to the engine for the create path.
  if (args.transportText) body.transport_text = args.transportText

  let r: EngineResponse
  try {
    r = await callEngine(args.connectionId, body, args.icfPath)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Engine call failed: ${String((err as Error).message ?? err)}\n` +
      `Run customizing_engine_ping to diagnose.` }] }
  }

  // Async commit: the engine submits the write to a background job and returns
  // 'pending' + run_id if the job hasn't finished within its short in-handler
  // poll.  Continue polling here (each 'status' call is a fast read) within a
  // budget safely under the MCP client's 60 s ceiling; if it's still running,
  // hand back the run_id so the user can poll with customizing_status.
  if (commit && r.STATUS === "pending" && r.RUN_ID) {
    const runId = r.RUN_ID
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2_500))
      let s: EngineResponse
      try {
        s = await callEngine(args.connectionId, { operation: "status", run_id: runId }, args.icfPath)
      } catch {
        continue   // transient read failure — keep polling within budget
      }
      if (s.STATUS && !isRunStillGoing(s.STATUS)) {           // terminal → stop
        // Keep plan/table/transport context from the write; overlay the outcome.
        r = { ...r, STATUS: s.STATUS, ROWS_WRITTEN: s.ROWS_WRITTEN ?? r.ROWS_WRITTEN,
              MESSAGES: s.MESSAGES ?? r.MESSAGES, RUN_ID: undefined }
        break
      }
      if (s.STATUS === "running") {                            // still active → refresh progress, keep polling
        r = { ...r, STATUS: "running", MESSAGES: s.MESSAGES ?? r.MESSAGES }
      }
    }
  }

  const isDry = r.DRY_RUN === "X" || !commit
  const stillGoing = isRunStillGoing(r.STATUS)

  if (commit && r.STATUS === "ok" && r.TRANSPORT && tsel.engineCreates) {
    rememberTransport(resolveConnectionId(args.connectionId), "W", workKey(args.workItem, extra?.sessionId), r.TRANSPORT)
    resolveNote += `Transport ${r.TRANSPORT} — created as asked, now the transport for ${args.workItem ? `work item ${args.workItem.toUpperCase()}` : "this session"}.\n`
  }

  const lines: string[] = [
    ...(deployNote ? [deployNote.trimEnd()] : []),
    ...(resolveNote ? [resolveNote.trimEnd()] : []),
    isDry ? `📋 DRY RUN — nothing written` : stillGoing ? `⚙️  COMMIT — running in a background job` : `✏️  COMMIT`,
    `   Status:       ${r.STATUS}`,
    isDelete
      ? `   Table:        ${r.TABLE}  (delete ${args.keyField} = ${args.targetKey})`
      : `   Table:        ${r.TABLE}  (${args.keyField}: ${args.sourceKey} → ${args.targetKey})`,
    `   Rows planned: ${r.ROWS_PLANNED ?? 0}`,
    // Don't print "Rows written: 0 / Transport: (none)" as if final while the job
    // is still going — that reads as "wrote nothing" when it simply hasn't finished.
    ...(commit && !stillGoing ? [`   Rows written: ${r.ROWS_WRITTEN ?? 0}`, `   Transport:    ${r.TRANSPORT ?? "(none)"}`] : []),
    ...(r.MESSAGES?.length ? ["", "   Messages:", ...r.MESSAGES.map(m => `     • ${m}`)] : []),
  ]

  if (isDry && r.DATA_JSON) {
    try {
      const rows = JSON.parse(r.DATA_JSON)
      lines.push("", `   Planned rows (${Array.isArray(rows) ? rows.length : 0}):`)
      lines.push("   " + JSON.stringify(rows, null, 2).split("\n").join("\n   "))
    } catch { /* leave raw out if unparseable */ }
    lines.push("", `   To apply: re-run with commit: true and transport: <request>`)
  }

  if (stillGoing && r.RUN_ID) {
    lines.push(
      "",
      r.STATUS === "running"
        ? `   ⚙️  Job RUNNING (active — see message above for its current phase). Poll with:`
        : `   ⏳ Job still running. Poll the result with:`,
      `      customizing_status  runId: ${r.RUN_ID}`,
    )
  }

  if (r.STATUS === "error") {
    log("WARN", `customizing_apply error on ${args.table}`, r.MESSAGES)
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_create ───────────────────────────────────────────────────────
// Create rows from explicit field/value maps (full key, no source row) through
// the same recorded SM30 view-runtime path as customizing_apply. Unlike copy,
// this handles composite keys and distinct per-row values — e.g. storage
// locations T001L (WERKS+LGORT+LGOBE), one description per site.
export async function handleCustomizingCreate(args: {
  table: string
  rows: Record<string, string>[]
  transport?: string
  onlyMissing?: boolean
  commit?: boolean
  recordTransport?: boolean
  recordTableKeys?: boolean
  createTransport?: boolean
  transportText?: string
  showAllTransports?: boolean
  autoDeploy?: boolean
  icfPath?: string
  workItem?: string
  connectionId?: string
}, extra?: { sessionId?: string }) {
  const commit = args.commit === true

  if (!Array.isArray(args.rows) || args.rows.length === 0) {
    return { content: [{ type: "text" as const, text:
      `❌ rows is required: a non-empty array of { FIELD: value } objects (each object is one row, including all key fields).` }] }
  }

  // Auto-deploy the ABAP class if missing/outdated (default on)
  let deployNote = ""
  if (args.autoDeploy !== false) {
    try {
      const d = await ensureEngineClass(args.connectionId)
      if (d.changed) deployNote = `(engine ${d.action} to v${ENGINE_VERSION})\n`
    } catch (err) {
      log("WARN", "auto-deploy of engine class failed", err)
    }
  }

  // Resolve the maintenance object (same as customizing_apply) so a recorded
  // write goes through the SM30 view runtime and records the right transport object.
  let maintObject = ""
  let transportObject = ""
  let clusterName = ""
  let resolveNote = ""
  if (args.recordTransport !== false) {
    try {
      const client = await ensureConnected(args.connectionId)
      const maint = await resolveMaint(client, args.table)
      if (maint.maintObject && maint.recordObject) {
        maintObject     = maint.maintObject
        transportObject = maint.recordObject
        clusterName     = maint.cluster ?? ""
        const clusterNote = maint.cluster
          ? ` — in view cluster ${maint.cluster} (records the member view ${maintObject} as R3TR VDAT)`
          : ""
        resolveNote = `(maint object ${maintObject} → R3TR ${transportObject}; table set ${maint.tables.join(" + ")}${clusterNote})\n`
      } else if (args.recordTableKeys === true) {
        // No view: write the table directly and record its row keys as R3TR TABU,
        // which is what the dedicated transaction (e.g. CUNI for T006*) records.
        // Opt-in, because it skips whatever checks that transaction makes.
        transportObject = "TABU"
        resolveNote = `(no maintenance view for ${args.table}; direct write, keys recorded as R3TR TABU ${args.table})\n`
      } else {
        if (commit) {
          return { content: [{ type: "text" as const, text:
            `❌ ${args.table} has no generated SM30/SM34 maintenance view` +
            `${maint.objectType ? ` (CUS_ACTOBJ object type '${maint.objectType}')` : " (it is maintained by a dedicated transaction, not a view)"}, ` +
            `so a transport-recorded write through the view runtime isn't possible. ` +
            `Use recordTransport: false for a direct (untransported) write, recordTableKeys: true for a direct write ` +
            `recorded as R3TR TABU, or maintain it in SPRO.` }] }
        }
        resolveNote = `(no generated maintenance for ${args.table}; dry-run only)\n`
      }
    } catch (err) {
      log("WARN", "maintenance-object resolution failed", err)
    }
  }

  // Each row object → a JSON array of {FIELD,VALUE} (the engine's rows_json shape).
  const rowsJson = JSON.stringify(
    args.rows.map(r => Object.entries(r).map(([FIELD, VALUE]) => ({ FIELD, VALUE: String(VALUE) }))),
  )

  const body: EngineRequest = {
    operation: "create",
    table: args.table,
    rows_json: rowsJson,
    transport: args.transport,
    only_missing: args.onlyMissing === false ? "" : "X",   // default true (idempotent create)
    commit: commit ? "X" : "",
    record_transport: args.recordTransport === false ? "" : "X",
    create_transport: args.createTransport === true ? "X" : "",
    view_name: maintObject,
    transport_object: transportObject,
    cluster_name: clusterName,
  }

  // ── Transport (the shared rule in transportSelection.ts) ─────────────────────
  const tsel = await resolveCustomizingTransport(args, commit,
    `the customizing create (${args.rows.length} row(s) into ${args.table})`, extra?.sessionId)
  if (tsel.prompt) return { content: [{ type: "text" as const, text: `${deployNote}${resolveNote}${tsel.prompt}` }] }
  body.transport = tsel.transport
  if (tsel.note) resolveNote += `${tsel.note}\n`
  if (args.transportText) body.transport_text = args.transportText

  let r: EngineResponse
  try {
    r = await callEngine(args.connectionId, body, args.icfPath)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Engine call failed: ${String((err as Error).message ?? err)}\nRun customizing_engine_ping to diagnose.` }] }
  }

  // Async commit: poll the run within a budget under the MCP client's ceiling.
  if (commit && r.STATUS === "pending" && r.RUN_ID) {
    const runId = r.RUN_ID
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2_500))
      let s: EngineResponse
      try {
        s = await callEngine(args.connectionId, { operation: "status", run_id: runId }, args.icfPath)
      } catch { continue }
      if (s.STATUS && !isRunStillGoing(s.STATUS)) {            // terminal → stop
        r = { ...r, STATUS: s.STATUS, ROWS_WRITTEN: s.ROWS_WRITTEN ?? r.ROWS_WRITTEN,
              MESSAGES: s.MESSAGES ?? r.MESSAGES, RUN_ID: undefined }
        break
      }
      if (s.STATUS === "running") {                            // still active → refresh progress, keep polling
        r = { ...r, STATUS: "running", MESSAGES: s.MESSAGES ?? r.MESSAGES }
      }
    }
  }

  const isDry = r.DRY_RUN === "X" || !commit
  const stillGoing = isRunStillGoing(r.STATUS)
  if (commit && r.STATUS === "ok" && r.TRANSPORT && tsel.engineCreates) {
    rememberTransport(resolveConnectionId(args.connectionId), "W", workKey(args.workItem, extra?.sessionId), r.TRANSPORT)
    resolveNote += `Transport ${r.TRANSPORT} — created as asked, now the transport for ${args.workItem ? `work item ${args.workItem.toUpperCase()}` : "this session"}.\n`
  }

  const lines: string[] = [
    ...(deployNote ? [deployNote.trimEnd()] : []),
    ...(resolveNote ? [resolveNote.trimEnd()] : []),
    isDry ? `📋 DRY RUN — nothing written` : stillGoing ? `⚙️  COMMIT — running in a background job` : `✏️  COMMIT`,
    `   Status:       ${r.STATUS}`,
    `   Table:        ${r.TABLE}  (create ${args.rows.length} row(s))`,
    `   Rows planned: ${r.ROWS_PLANNED ?? 0}`,
    ...(commit && !stillGoing ? [`   Rows written: ${r.ROWS_WRITTEN ?? 0}`, `   Transport:    ${r.TRANSPORT ?? "(none)"}`] : []),
    ...(r.MESSAGES?.length ? ["", "   Messages:", ...r.MESSAGES.map(m => `     • ${m}`)] : []),
  ]
  if (isDry && r.DATA_JSON) {
    try {
      const rows = JSON.parse(r.DATA_JSON)
      lines.push("", `   Planned rows (${Array.isArray(rows) ? rows.length : 0}):`)
      lines.push("   " + JSON.stringify(rows, null, 2).split("\n").join("\n   "))
    } catch { /* leave raw out if unparseable */ }
    lines.push("", `   To apply: re-run with commit: true (+ transport, or recordTransport: false)`)
  }
  if (stillGoing && r.RUN_ID) {
    lines.push("", r.STATUS === "running"
      ? `   ⚙️  Job RUNNING (active — see message above). Poll with: customizing_status runId: ${r.RUN_ID}`
      : `   ⏳ Job still running. Poll with: customizing_status runId: ${r.RUN_ID}`)
  }
  if (r.STATUS === "error") log("WARN", `customizing_create error on ${args.table}`, r.MESSAGES)

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── retail_listing ───────────────────────────────────────────────────────────
// List articles into assortments via SAP's listing engine
// (EXECUTE_LISTING_ART_ASSORT_RFC, determine_data=X). Extends each article to
// the assortment's assigned sites (MARC/valuation segments) and writes the
// WLK1 listing conditions. DRY RUN by default (returns the prepared items).
export async function handleRetailListing(args: {
  items: { product: string; assortment: string; dateFrom?: string; dateTo?: string }[]
  commit?: boolean
  autoDeploy?: boolean
  icfPath?: string
  connectionId?: string
}) {
  const commit = args.commit === true
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return { content: [{ type: "text" as const, text:
      `❌ items is required: a non-empty array of { product, assortment } (optionally dateFrom/dateTo as YYYYMMDD).` }] }
  }
  let deployNote = ""
  if (args.autoDeploy !== false) {
    try {
      const d = await ensureEngineClass(args.connectionId)
      if (d.changed) deployNote = `(engine ${d.action} to v${ENGINE_VERSION})\n`
    } catch (err) { log("WARN", "auto-deploy of engine class failed", err) }
  }
  const itemsJson = JSON.stringify(args.items.map(i => ({
    PRODUCT: i.product, ASSORTMENT: i.assortment,
    DATE_FROM: i.dateFrom ?? "", DATE_TO: i.dateTo ?? "",
  })))
  const body: EngineRequest = {
    operation: "listing",
    items_json: itemsJson,
    commit: commit ? "X" : "",
  }
  let r: EngineResponse
  try {
    r = await callEngine(args.connectionId, body, args.icfPath)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Engine call failed: ${String((err as Error).message ?? err)}\nRun customizing_engine_ping to diagnose.` }] }
  }
  const isDry = r.DRY_RUN === "X" || !commit
  const lines: string[] = [
    ...(deployNote ? [deployNote.trimEnd()] : []),
    isDry ? `📋 DRY RUN — nothing listed` : `✏️  LISTING`,
    `   Status:   ${r.STATUS}`,
    `   Items:    ${args.items.length}`,
    `   Planned:  ${r.ROWS_PLANNED ?? 0}`,
    ...(commit ? [`   Listed:   ${r.ROWS_WRITTEN ?? 0}`] : []),
    ...(r.MESSAGES?.length ? ["", "   Messages:", ...r.MESSAGES.map(m => `     • ${m}`)] : []),
  ]
  if (isDry && r.DATA_JSON) {
    try {
      const rows = JSON.parse(r.DATA_JSON)
      lines.push("", `   Prepared items (${Array.isArray(rows) ? rows.length : 0}):`)
      lines.push("   " + JSON.stringify(rows, null, 2).split("\n").join("\n   "))
    } catch { /* leave raw out if unparseable */ }
    lines.push("", `   To execute: re-run with commit: true`)
  }
  if (r.STATUS === "error") log("WARN", `retail_listing error`, r.MESSAGES)
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_status ─────────────────────────────────────────────────────────
// Poll the result of an async write (customizing_apply commit) by its run_id.

export async function handleCustomizingStatus(args: {
  runId: string
  icfPath?: string
  connectionId?: string
}) {
  let r: EngineResponse
  try {
    r = await callEngine(args.connectionId, { operation: "status", run_id: args.runId }, args.icfPath)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Status call failed: ${String((err as Error).message ?? err)}\n` +
      `Run customizing_engine_ping to diagnose.` }] }
  }

  // Non-terminal = the job is still going (queued or actively running) → poll again.
  // Terminal = ok / error / aborted / unknown → stop.
  const nonTerminal = r.STATUS === "pending" || r.STATUS === "running"
  const icon =
    r.STATUS === "ok"      ? "✅" :
    r.STATUS === "running" ? "⚙️" :
    r.STATUS === "pending" ? "⏳" :
    r.STATUS === "aborted" ? "🛑" :
    r.STATUS === "unknown" ? "❓" : "❌"
  const lines: string[] = [
    `${icon} Run ${args.runId} — ${r.STATUS}`,
    ...(r.STATUS === "ok" && r.ROWS_WRITTEN !== undefined ? [`   Rows written: ${r.ROWS_WRITTEN}`] : []),
    ...(r.TRANSPORT ? [`   Transport:    ${r.TRANSPORT}`] : []),
    ...(r.MESSAGES?.length ? ["", "   Messages:", ...r.MESSAGES.map(m => `     • ${m}`)] : []),
    ...(nonTerminal ? ["", `   Not finished yet — re-run customizing_status with the same runId${r.STATUS === "running" ? " (it IS progressing — see the message above)" : ""}.`] : []),
  ]
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_selftest ───────────────────────────────────────────────────────

export async function handleCustomizingSelftest(args: {
  table?: string
  transport?: string
  autoDeploy?: boolean
  icfPath?: string
  connectionId?: string
}) {
  const lines: string[] = []

  if (args.autoDeploy !== false) {
    try {
      const d = await ensureEngineClass(args.connectionId)
      if (d.changed) lines.push(`Engine ${d.action} to v${ENGINE_VERSION}`)
    } catch (err) {
      log("WARN", "auto-deploy of engine class failed", err)
    }
  }

  let r: EngineResponse
  try {
    r = await callEngine(args.connectionId, {
      operation: "selftest",
      table: args.table,
      transport: args.transport,
    }, args.icfPath)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Self-test call failed: ${String((err as Error).message ?? err)}\n` +
      `Run customizing_engine_ping to diagnose (SICF service may not be registered).` }] }
  }

  const ok = r.STATUS === "ok"
  lines.push(
    `${ok ? "✅" : "❌"} Self-test ${ok ? "passed" : "failed"} (engine v${r.VERSION})`,
    `   Table tested: ${r.TABLE}`,
    ...(args.transport ? [] : [`   (pass transport: <request> to also validate transport recording in simulation)`]),
    "",
    "   Steps:",
    ...(r.MESSAGES ?? []).map(m => `     ${m}`),
  )
  if (ok && r.DATA_JSON) lines.push("", `   Sample TABKEY built: '${r.DATA_JSON}'`)

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── customizing_engine_cleanup ─────────────────────────────────────────────────

export async function handleEngineCleanup(args: {
  confirm?: boolean
  connectionId?: string
}) {
  if (args.confirm !== true) {
    return { content: [{ type: "text" as const, text:
      `⚠️  This will delete the ABAP class ${ENGINE_CLASS_NAME} from the system.\n` +
      `   The SICF service must be removed separately in transaction SICF.\n\n` +
      `   Re-run with confirm: true to proceed.` }] }
  }

  const lines: string[] = []
  try {
    await handleDeleteAbapObject({ url: ENGINE_CLASS_URL, connectionId: args.connectionId })
    lines.push(`🗑️  Deleted class ${ENGINE_CLASS_NAME}`)
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    if (/not found|does not exist|cannot find/i.test(msg)) {
      lines.push(`ℹ️  Class ${ENGINE_CLASS_NAME} was not present (nothing to delete)`)
    } else {
      lines.push(`❌ Could not delete ${ENGINE_CLASS_NAME}: ${msg}`)
    }
  }

  // Release any residual locks from the delete
  try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }

  lines.push(
    "",
    `Manual step remaining (BASIS):`,
    `  SICF → delete the service node ${ENGINE_ICF_PATH}`,
  )
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── registration ─────────────────────────────────────────────────────────────

export function registerCustomizingEngineTools(server: McpServer): void {
  server.registerTool(
    "customizing_engine_bootstrap",
    {
      title: "Deploy/Update Customizing Engine",
      description:
        "Deploy or update the in-system ABAP Customizing Engine (ZCL_MCP_CUST_ENGINE) " +
        "using the server's own write+activate tooling. Run this once to install, and " +
        "again whenever the engine version changes. After deploying, a one-time SICF " +
        "service registration (handler = ZCL_MCP_CUST_ENGINE) is required.",
      inputSchema: {
        packageName: z.string().optional().describe("Target package (default: $TMP; use a transportable Z package for production)"),
        transport:   z.string().optional().describe("Transport request for the class (required if package is transportable)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleEngineBootstrap
  )

  server.registerTool(
    "customizing_engine_ping",
    {
      title: "Ping Customizing Engine",
      description:
        "Call the deployed Customizing Engine over its SICF endpoint and report the " +
        "running version. Use to confirm the engine is installed, the SICF service is " +
        "active, and the deployed version matches the server's expected version.",
      inputSchema: {
        icfPath:     z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        rawDump:     z.boolean().optional().describe("Return the raw HTTP body for diagnostics instead of parsing it (useful when the engine is reachable but returning unexpected content)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleEnginePing
  )

  server.registerTool(
    "hana_memory_report",
    {
      title: "HANA Memory Report",
      description:
        "Diagnose HANA memory pressure on the tenant this ABAP system runs on, via the " +
        "Customizing Engine's SICF endpoint (ADBC over SYS.M_* monitoring views — read-only). " +
        "Reports host RAM/swap, per-service usage, top heap allocators, the largest loaded " +
        "column tables, row store, SQL plan cache, and the configured global_allocation_limit. " +
        "Use when the system is slow/swapping or before resizing. Needs engine v0.9.8+ " +
        "(run customizing_engine_bootstrap to update).",
      inputSchema: {
        icfPath:      z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleHanaMemory
  )

  server.registerTool(
    "abap_memory_report",
    {
      title: "ABAP App-Server Memory Report",
      description:
        "Report the ABAP application server's key kernel memory / box-health profile parameters " +
        "(PHYS_MEMSIZE, em/initial_size_MB extended memory, abap/heap_area_*, ztta/roll_*, " +
        "abap/buffersize, work-process counts) via C_SAPGPARAM — basis-only, so it works on any " +
        "ABAP box. Companion to hana_memory_report: on a single-host AS+DB appliance, read BOTH " +
        "and check that HANA global_allocation_limit + ABAP working memory + OS ≤ physical RAM " +
        "(over-commit shows up as swap). Needs engine v0.9.16+.",
      inputSchema: {
        icfPath:      z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleAbapMemory
  )

  server.registerTool(
    "org_copy",
    {
      title: "Copy Organizational Unit (EC01-style)",
      description:
        "Copy or delete a WHOLE organizational unit including all its dependent customizing, " +
        "via SAP's standard entity copier (ECOP_ORG_UNITS_IN_THE_DARK) — the exact engine behind " +
        "EC01/EC02/EC04…, run headlessly through the in-system Customizing Engine.\n\n" +
        "  orgUnit values (org-key DOMAIN): BUKRS company code (EC01), WERKS plant (EC02), " +
        "CACCD controlling area (EC03), VKORG sales org (EC04), VTWEG distribution channel (EC05), " +
        "SPART division (EC06), VSTEL shipping point (EC07), LGNUM warehouse no. (EC09), " +
        "EKORG purchasing org (EC13), LGORT storage location (EC14), MTART material type (EC15).\n\n" +
        "DRY RUN by default (the dependent-table set is resolved by the copier at commit, " +
        "not enumerated on the dry run). commit: true performs the copy and commits.\n\n" +
        "TRANSPORT: the entity copier records onto a Customizing request it MINTS ITSELF and " +
        "reports back — it cannot record into a request you supply (a passed transport is " +
        "ignored). On commit set createTransport: true to acknowledge that; the copier names " +
        "the request. The copier never overwrites: it fails if the target unit already exists. " +
        "After the copy, patch unit-specific values (name, currency, country, …) with " +
        "customizing_apply using values + onlyMissing: false. Needs engine v0.9.9+.",
      inputSchema: {
        orgUnit:     z.string().describe("Org-key domain: BUKRS, WERKS, VKORG, VTWEG, SPART, EKORG, LGORT, CACCD, VSTEL, LGNUM, MTART"),
        sourceKey:   z.string().describe("Source unit to copy from (e.g. company code 2510). For action: \"delete\" — the unit to remove."),
        targetKey:   z.string().optional().describe("New unit to create (e.g. Z100). Not used for delete."),
        action:      z.enum(["copy", "delete"]).optional().describe("\"copy\" (default) duplicates source→target; \"delete\" removes sourceKey's unit with all dependent entries"),
        commit:           z.boolean().optional().describe("Actually copy (default: false = dry run)"),
        createTransport:  z.boolean().optional().describe("Required on commit in a recording client: acknowledge that the copier mints its OWN Customizing request (a supplied transport is not honored). The copier names the request; transportText is not applied. The new request number is reported on completion."),
        autoDeploy:       z.boolean().optional().describe("Auto-deploy/update the engine class if missing or outdated (default: true)"),
        icfPath:     z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleOrgCopy
  )

  server.registerTool(
    "customizing_apply",
    {
      title: "Apply Customizing Change",
      description:
        "Copy or delete customizing rows through the in-system engine, which drives the " +
        "SM30 maintenance-view runtime (VIEW_MAINTENANCE_SINGLE_ENTRY) so FK checks, " +
        "events, change docs and transport recording all run the standard way. " +
        "DRY RUN by default — returns the exact rows affected. Set commit: true to apply.\n\n" +
        "  action: \"copy\"  (default) — duplicate rows from sourceKey to targetKey.\n" +
        "  action: \"delete\"          — remove the entry whose keyField = targetKey " +
        "(sourceKey not needed), recording the deletion onto the transport like an SM30 delete.\n\n" +
        "Delivery class behaviour:\n" +
        "  C / G / E — customizing + control tables: transport-based write. " +
        "Provide a transport when committing.\n" +
        "  A         — application data (e.g. /POSDW/STORE): direct MODIFY + COMMIT, " +
        "no transport recording (copy only). Do NOT pass a transport for class-A tables.\n\n" +
        "The engine enforces S_TABU_DIS authorization on the target table.",
      inputSchema: {
        table:       z.string().describe("Table name (e.g. /POSDW/PROF, /POSDW/STORE, TCURR, TVKO)"),
        keyField:    z.string().describe("Key field (e.g. PROFILE, WERKS, BUKRS, VKORG, or the full key field for delete)"),
        sourceKey:   z.string().optional().describe("Copy: source value (reference config). Not used for action: \"delete\"."),
        targetKey:   z.string().describe("Copy: target value to create. Delete: the key value of the entry to remove."),
        action:      z.enum(["copy", "delete"]).optional().describe("\"copy\" (default) duplicates source→target; \"delete\" removes the targetKey entry via the SM30 runtime, recording the deletion to the transport."),
        values:      z.record(z.string(), z.string()).optional().describe("Field overrides applied to every planned row after the key swap, e.g. { NAME1: \"Z Retail\", WAERS: \"EUR\" }. With sourceKey = targetKey and onlyMissing: false this patches an existing row in place."),
        transport:        z.string().optional().describe("Existing open request to record into (the 'already chosen for this task' case — used as-is, no prompt). If omitted on a recorded commit and createTransport is not set, the tool returns an interactive prompt: the open Customizing requests to pick from PLUS the create options."),
        onlyMissing:      z.boolean().optional().describe("Only write rows absent from target (default: true)"),
        commit:           z.boolean().optional().describe("Actually write (default: false = dry run)"),
        recordTransport:  z.boolean().optional().describe("Record the write on a transport request (default: true for C/G/E). Set false for sandbox/test-data writes that should not be transported — transport must be omitted when false."),
        createTransport:  z.boolean().optional().describe("Create a NEW Customizing request at commit (only when you mean it; existing requests are preferred). Combine with transportText to name it."),
        transportText:    z.string().optional().describe("Short description for the engine-created Customizing request (only used with createTransport: true). Omit to use an auto-generated text."),
        showAllTransports: z.boolean().optional().describe("When prompting for a transport, list ALL users' open requests instead of only your own (default: false = your own)."),
        workItem:         z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        autoDeploy:       z.boolean().optional().describe("Auto-deploy/update the ABAP engine class if missing or outdated (default: true)"),
        icfPath:     z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingApply
  )

  server.registerTool(
    "customizing_create",
    {
      title: "Create Customizing Rows",
      description:
        "Create new customizing rows from explicit field/value maps — full keys (including " +
        "COMPOSITE keys) and distinct per-row values, with NO source row to copy from. " +
        "This is what customizing_apply (a single-key copy) can't express: e.g. storage " +
        "locations T001L (key WERKS+LGORT) each with their own LGOBE description.\n\n" +
        "Each entry in `rows` is one row as a { FIELD: value } object and must include all " +
        "key fields. Rows are written through the SM30 view runtime (VIEW_MAINTENANCE_SINGLE_ENTRY, " +
        "INS→UPD fallback) so FK checks, events, change docs and transport recording run the " +
        "standard way; INITIAL/blank non-key fields are allowed.\n\n" +
        "DRY RUN by default — returns the planned rows. Set commit: true to write.\n" +
        "  onlyMissing (default true) skips rows whose key already exists — idempotent create.\n" +
        "  recordTransport: false → direct write, no transport (sandbox/test data); omit transport then.\n" +
        "Delivery class C/G/E records onto a Customizing request (provide transport or createTransport); " +
        "class A writes directly. Enforces S_TABU_DIS on the table.",
      inputSchema: {
        table:       z.string().describe("Table name (e.g. T001L, T001W). Its generated SM30 maintenance view is resolved automatically for recorded writes."),
        rows:        z.array(z.record(z.string(), z.string())).describe("Array of rows; each a { FIELD: value } object including ALL key fields, e.g. [{ WERKS: \"GHDC\", LGORT: \"0001\", LGOBE: \"Goods Receipt\" }]."),
        transport:        z.string().optional().describe("Existing open Customizing request to record into (used as-is, no prompt). If omitted on a recorded commit and createTransport is not set, the tool returns an interactive prompt."),
        onlyMissing:      z.boolean().optional().describe("Only create rows whose key is absent (default: true = idempotent). false also updates existing rows."),
        commit:           z.boolean().optional().describe("Actually write (default: false = dry run returning the planned rows)"),
        recordTransport:  z.boolean().optional().describe("Record the write on a transport (default: true for C/G/E). Set false for a direct, untransported sandbox write — transport must be omitted then."),
        recordTableKeys:  z.boolean().optional().describe("For a table with no maintenance view (e.g. T006/T006A, normally CUNI): write it directly and record the row keys as R3TR TABU on the transport. Skips the dedicated transaction's checks — supply complete rows."),
        createTransport:  z.boolean().optional().describe("Create a NEW Customizing request at commit (only when you mean it; existing requests are preferred). Combine with transportText to name it."),
        transportText:    z.string().optional().describe("Short description for the engine-created Customizing request (only used with createTransport: true)."),
        showAllTransports: z.boolean().optional().describe("When prompting for a transport, list ALL users' open requests instead of only your own (default: false)."),
        workItem:         z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        autoDeploy:       z.boolean().optional().describe("Auto-deploy/update the engine class if missing or outdated (default: true)"),
        icfPath:     z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingCreate
  )

  server.registerTool(
    "retail_listing",
    {
      title: "List Articles into Assortments (Retail)",
      description:
        "List one or more articles into retail assortments via SAP's standard listing engine " +
        "(EXECUTE_LISTING_ART_ASSORT_RFC, determine_data=X). Listing EXTENDS each article to the " +
        "assortment's assigned sites (creating the plant/valuation segments) and writes the WLK1 " +
        "listing conditions, so the article becomes available at those sites. Listing into a " +
        "GENERAL assortment propagates to all its assigned sites (incl. their local assortments).\n\n" +
        "DRY RUN by default — returns the prepared listing items. Set commit: true to execute. " +
        "dateFrom/dateTo default to today / 9999-12-31. Material numbers are ALPHA-padded automatically.",
      inputSchema: {
        items: z.array(z.object({
          product:    z.string().describe("Article/material number (e.g. 000000000000000151 or 151 — ALPHA-padded automatically)"),
          assortment: z.string().describe("Assortment to list into (e.g. BE_STD, or a site's local assortment)"),
          dateFrom:   z.string().optional().describe("Validity start YYYYMMDD (default: today)"),
          dateTo:     z.string().optional().describe("Validity end YYYYMMDD (default: 99991231)"),
        })).describe("Article→assortment listing items, e.g. [{ product: \"151\", assortment: \"BE_STD\" }]."),
        commit:       z.boolean().optional().describe("Actually list (default: false = dry run returning the prepared items)"),
        autoDeploy:   z.boolean().optional().describe("Auto-deploy/update the engine class if missing or outdated (default: true)"),
        icfPath:      z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleRetailListing
  )

  server.registerTool(
    "customizing_status",
    {
      title: "Poll Async Customizing Write",
      description:
        "Check the result of an asynchronous customizing write (customizing_apply with " +
        "commit: true) by its run_id. The write runs in a background job for headless " +
        "transport recording; if it doesn't finish within apply's poll budget, apply " +
        "returns a run_id — use this tool to poll until it reports ok/error.",
      inputSchema: {
        runId:        z.string().describe("The run_id returned by a pending customizing_apply commit"),
        icfPath:      z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingStatus
  )

  server.registerTool(
    "customizing_selftest",
    {
      title: "Self-Test Customizing Engine",
      description:
        "Non-destructively validate the engine's risky internals — dynamic table " +
        "typing, sample read, flat TABKEY construction, and (if a transport is given) " +
        "TR_OBJECTS_INSERT in SIMULATION mode — without writing data or recording any " +
        "transport. Auto-deploys the engine class if needed. Run this after the first " +
        "bootstrap to confirm the write path will work before any real commit.",
      inputSchema: {
        table:       z.string().optional().describe("Customizing table to test against (default: TCURR — present on every system). Must have at least one row."),
        transport:   z.string().optional().describe("If given, also validates transport recording in simulation mode (no actual recording)"),
        autoDeploy:  z.boolean().optional().describe("Auto-deploy/update the engine class if needed (default: true)"),
        icfPath:     z.string().optional().describe(`SICF path of the engine (default: ${ENGINE_ICF_PATH})`),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleCustomizingSelftest
  )

  server.registerTool(
    "customizing_engine_cleanup",
    {
      title: "Remove Customizing Engine",
      description:
        "Delete the ABAP Customizing Engine class from the system. Requires confirm: true. " +
        "The SICF service node must be removed manually in transaction SICF.",
      inputSchema: {
        confirm:     z.boolean().optional().describe("Must be true to actually delete (default: false = show what would happen)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleEngineCleanup
  )
}
