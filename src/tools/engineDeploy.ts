/**
 * In-system ABAP deployment manager — makes transportability a CHOICE.
 *
 * The MCP can install its in-system ABAP either to $TMP (local, Dev-only,
 * re-pushed by the MCP) or to a Workbench Z package on a transport (so the
 * objects flow Dev→Prod via CTS, independent of the MCP code-push — letting
 * corporate security approve specific units for Production).
 *
 * Which units are transportable is per-connection config. On first run the
 * engine_deploy tool asks; you can re-run any time to flip a unit (e.g. promote
 * a higher-tier unit to transportable later). Risk tiers (riskTiers.ts) gate the
 * MCP *tool* surface; transportability here governs the *in-system* artifacts.
 */
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, log } from "../connections"
import { handleCreateAbapObject, handleWriteAbapObjectSource } from "./write"
import { handleAbapActivate } from "./activate"
import { handleRunUnitTests } from "./quality"
import { runSql, tableRows, col } from "./customizing"
import { handleEngineBootstrap } from "./customizingEngine"
import { getDiagSource, DIAG_CLASS_NAME, DIAG_CLASS_URL, DIAG_ICF_PATH } from "../abap/zcl_mcp_diag"
import { ENGINE_CLASS_NAME, ENGINE_CLASS_URL, ENGINE_ICF_PATH } from "../abap/zcl_mcp_cust_engine"
import { WRITER_REPORT_NAME, WRITER_REPORT_URL } from "../abap/zmcp_cust_write"

export interface DeployObject { kind: "class" | "report"; name: string; url: string; getSource?: () => string }
export interface DeployUnit {
  id: string
  title: string
  tier: 0 | 1
  sicfPath: string
  description: string
  objects: DeployObject[]
}

/** The deployable in-system units. */
export const UNITS: DeployUnit[] = [
  {
    id: "diag", title: "Read-only diagnostics", tier: 0, sicfPath: DIAG_ICF_PATH,
    description: "ping/env, hana_memory, abap_memory — read-only, safe for Production",
    objects: [{ kind: "class", name: DIAG_CLASS_NAME, url: DIAG_CLASS_URL, getSource: getDiagSource }],
  },
  {
    id: "cust", title: "Customizing engine", tier: 1, sicfPath: ENGINE_ICF_PATH,
    description: "customizing write/create/delete, org_copy, retail listing",
    // cust is deployed via handleEngineBootstrap (handles its class + writer report)
    objects: [
      { kind: "class",  name: ENGINE_CLASS_NAME,  url: ENGINE_CLASS_URL },
      { kind: "report", name: WRITER_REPORT_NAME, url: WRITER_REPORT_URL },
    ],
  },
]

export function findUnit(id: string): DeployUnit | undefined {
  return UNITS.find(u => u.id === id)
}

export interface UnitDeploy { transportable: boolean; package: string; transport?: string }
export type DeployConfig = Record<string, Record<string, UnitDeploy>>   // connId → unitId → cfg

const keyOf = (connId?: string) => connId ?? "__default__"

// ── config persistence (injectable IO for tests) ───────────────────────────────
export function configPath(): string {
  if (process.env.ABAP_DEPLOY_CONFIG) return process.env.ABAP_DEPLOY_CONFIG
  // Run from the repo: keep the file there. Run from a plugin/extension bundle
  // (cwd is not ours): keep it next to the user's connections.json.
  const local = path.resolve(process.cwd(), "engine-deploy.json")
  return fs.existsSync(local) ? local : path.join(os.homedir(), ".abap-mcp", "engine-deploy.json")
}
type Reader = (p: string) => string
type Writer = (p: string, c: string) => void
const defaultRead: Reader = p => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "")
const defaultWrite: Writer = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, c)
}

export function loadConfig(read: Reader = defaultRead): DeployConfig {
  try {
    const raw = read(configPath())
    return raw ? (JSON.parse(raw) as DeployConfig) : {}
  } catch { return {} }
}
export function saveConfig(cfg: DeployConfig, write: Writer = defaultWrite): void {
  write(configPath(), JSON.stringify(cfg, null, 2))
}

export function unitConfig(cfg: DeployConfig, connId: string | undefined, unitId: string): UnitDeploy | undefined {
  return cfg[keyOf(connId)]?.[unitId]
}
export function setUnitConfig(
  cfg: DeployConfig, connId: string | undefined, unitId: string, u: UnitDeploy,
): DeployConfig {
  const k = keyOf(connId)
  return { ...cfg, [k]: { ...(cfg[k] ?? {}), [unitId]: u } }
}
export function isFirstRun(cfg: DeployConfig, connId?: string): boolean {
  const c = cfg[keyOf(connId)]
  return c === undefined || Object.keys(c).length === 0
}

// ── prompts ─────────────────────────────────────────────────────────────────
export function buildSetupPrompt(connId?: string): string {
  const lines = [
    `In-system ABAP deployment — first-run setup for connection '${connId ?? "(default)"}'.`,
    ``,
    `Decide which units are TRANSPORTABLE: created in a Workbench Z package on a`,
    `transport so they can be released to Production via CTS, independent of this MCP`,
    `(corporate security approves them like any transport). Units not made transportable`,
    `deploy to $TMP (local, Dev-only — the MCP re-pushes them as needed).`,
    ``,
    `Units:`,
    ...UNITS.map(u => `  • ${u.id}  (Tier ${u.tier}) — ${u.title}: ${u.description}`),
    ``,
    `Run engine_deploy once per unit:`,
    `  • transportable:  engine_deploy unit:"diag" transportable:true package:"ZMCP_DIAG" transport:"<DEVK9…>"`,
    `  • Dev-only ($TMP): engine_deploy unit:"cust" transportable:false`,
    ``,
    `Recommendation: make 'diag' (Tier 0, read-only) transportable for Production box-health;`,
    `keep 'cust' (writes) and all code-creation tools Dev-only. You can flip any unit later`,
    `by re-running engine_deploy with new package/transport.`,
  ]
  return lines.join("\n")
}

export function buildStatus(cfg: DeployConfig, connId?: string): string {
  const lines = [`In-system deployment config for '${connId ?? "(default)"}':`]
  for (const u of UNITS) {
    const c = unitConfig(cfg, connId, u.id)
    lines.push(c
      ? `  • ${u.id} (Tier ${u.tier}) → ${c.transportable ? `transportable in ${c.package}${c.transport ? ` (${c.transport})` : ""}` : `$TMP (Dev-only)`}`
      : `  • ${u.id} (Tier ${u.tier}) → not deployed yet`)
  }
  lines.push(``, `Flip a unit: engine_deploy unit:"<id>" transportable:true package:"<Zpkg>" transport:"<req>"`)
  return lines.join("\n")
}

/** Resolve the target package for a deploy request; '' error string when invalid. */
export function resolveTarget(args: { transportable?: boolean; package?: string; transport?: string }):
  { ok: true; deploy: UnitDeploy } | { ok: false; error: string } {
  if (args.transportable) {
    if (!args.package || args.package.toUpperCase() === "$TMP") {
      return { ok: false, error: `transportable:true needs a Workbench Z package (not $TMP) in 'package'` }
    }
    return { ok: true, deploy: { transportable: true, package: args.package, transport: args.transport } }
  }
  return { ok: true, deploy: { transportable: false, package: "$TMP" } }
}

// ── SICF node auto-registration (headless, part of the install) ────────────────
export function icfNodeName(sicfPath: string): string {
  return (sicfPath.split("/").filter(Boolean).pop() ?? "").toUpperCase()
}

const ICF_SETUP_REPORT = "ZMCP_ICF_SETUP"
const ICF_SETUP_URL = "/sap/bc/adt/programs/programs/zmcp_icf_setup"

/**
 * ABAP report that registers ONE SICF node → handler via cl_icf_tree (the proven
 * flat-char handler-row workaround), run headlessly via an AUnit test whose
 * COMMIT WORK AND WAIT hardens to the DB. The /sap/bc parent GUID is resolved
 * dynamically (SAP→BC), with the delivery-consistent GUID as fallback. The node
 * is created in `nodePackage`, so for a transportable unit the SICF node
 * transports alongside the class.
 */
export function buildIcfSetupReport(o: {
  node: string; path: string; handler: string; docu: string; nodePackage: string
}): string {
  return `REPORT zmcp_icf_setup.
* Auto-generated by engine_deploy — register SICF node ${o.path} (handler ${o.handler}).

FORM logmsg USING iv_msg TYPE clike.
  DATA ls TYPE tvarvc.
  CLEAR ls.
  ls-name = 'ZMCP_ICF_LOG_${o.node}'.
  ls-type = 'P'.
  ls-low  = iv_msg.
  MODIFY tvarvc FROM ls.
  COMMIT WORK AND WAIT.
ENDFORM.

FORM run.
  DATA: lt_handler TYPE icfhndlist,
        ls_handler TYPE icfhandler,
        lv_sap     TYPE icfparguid,
        lv_parent  TYPE icfparguid,
        lv_trkorr  TYPE trkorr,
        lv_active  TYPE flag,
        lv_log     TYPE string.
  TRY.
      SELECT SINGLE icfnodguid FROM icfservice INTO @lv_sap    WHERE icf_name = 'SAP'.
      SELECT SINGLE icfnodguid FROM icfservice INTO @lv_parent WHERE icf_name = 'BC' AND icfparguid = @lv_sap.
      IF lv_parent IS INITIAL.
        lv_parent = 'EEPI2GLFNOLHN7IW9R54I61RZ'.   " /sap/bc (SAP-delivered, consistent across systems)
      ENDIF.
      ls_handler = '${o.handler}'.
      APPEND ls_handler TO lt_handler.
*     insert_node CREATES the node; change_node only MODIFIES an existing one
*     (it SELECTs the icfservice row first and raises SHTTP/061 if absent).
      cl_icf_tree=>if_icf_tree~insert_node(
        EXPORTING
          icf_name    = '${o.node}'
          icfparguid  = lv_parent
          icfdocu     = VALUE #( icf_langu = 'E' icf_docu = '${o.docu}' )
          icfhandlst  = lt_handler
          icfactive   = 'X'
          package     = '${o.nodePackage}'
          application = space
        CHANGING
          transport   = lv_trkorr
        EXCEPTIONS
          node_already_existing = 2
          OTHERS                = 1 ).
      IF sy-subrc = 2.
*       idempotent: node already there — refresh handler + active flag
        cl_icf_tree=>if_icf_tree~change_node(
          EXPORTING
            icf_name   = '${o.node}'
            icfparguid = lv_parent
            icfhandlst = lt_handler
            icfactive  = 'X'
            package    = '${o.nodePackage}'
          EXCEPTIONS OTHERS = 1 ).
      ELSEIF sy-subrc <> 0.
        lv_log = |ERR insert_node subrc={ sy-subrc } { sy-msgid }/{ sy-msgno } { sy-msgv1 }|.
        PERFORM logmsg USING lv_log.
        RETURN.
      ENDIF.
      COMMIT WORK AND WAIT.
      cl_icf_tree=>if_icf_tree~check_service_active(
        EXPORTING url = '${o.path}' hostnr = 0
        IMPORTING active = lv_active
        EXCEPTIONS OTHERS = 1 ).
      lv_log = |OK node ${o.node} handler ${o.handler} active={ lv_active }|.
      PERFORM logmsg USING lv_log.
    CATCH cx_root INTO DATA(lx).
      lv_log = |EXC { lx->get_text( ) }|.
      PERFORM logmsg USING lv_log.
  ENDTRY.
ENDFORM.

START-OF-SELECTION.
  PERFORM run.

CLASS ltc_setup DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS run_setup FOR TESTING.
ENDCLASS.
CLASS ltc_setup IMPLEMENTATION.
  METHOD run_setup.
    PERFORM run.   " insert_node + COMMIT WORK AND WAIT hardens to DB
  ENDMETHOD.
ENDCLASS.
`
}

/** Register the unit's SICF node headlessly (generated installer report + AUnit run). */
async function setupSicf(unit: DeployUnit, target: UnitDeploy, connectionId?: string): Promise<string> {
  const node = icfNodeName(unit.sicfPath)
  const handler = unit.objects[0].name
  const src = buildIcfSetupReport({
    node, path: unit.sicfPath, handler, docu: `MCP ${unit.title}`, nodePackage: target.package,
  })
  const client = await ensureConnected(connectionId)
  let exists = false
  try { await client.getObjectSource(`${ICF_SETUP_URL}/source/main`); exists = true } catch { exists = false }
  if (!exists) {
    // The installer report itself is a local Dev tool ($TMP); it registers the
    // node into the unit's package (so a transportable unit's node transports too).
    await handleCreateAbapObject({
      objectType: "PROG/P", name: ICF_SETUP_REPORT,
      description: "MCP SICF node installer (generated)", packageName: "$TMP", connectionId,
    })
  }
  await handleWriteAbapObjectSource({ url: ICF_SETUP_URL, source: src, connectionId })
  const act = await handleAbapActivate({ url: ICF_SETUP_URL, connectionId })
  if (/❌|Activation failed/i.test(act.content[0]?.text ?? "")) {
    return `❌ SICF installer activation failed: ${act.content[0]?.text}`
  }
  await handleRunUnitTests({ url: `${ICF_SETUP_URL}/source/main`, connectionId })
  try {
    const rows = tableRows(await runSql(client, `SELECT LOW FROM TVARVC WHERE NAME = 'ZMCP_ICF_LOG_${node}'`, 1))
    return `SICF ${unit.sicfPath} → ${handler}: ${rows.length ? col(rows[0], "LOW") : "(no log)"}`
  } catch {
    return `SICF ${unit.sicfPath} installer ran (log read failed)`
  }
}

// ── deploy execution ──────────────────────────────────────────────────────────
async function deployUnitObjects(unit: DeployUnit, target: UnitDeploy, connectionId?: string): Promise<string[]> {
  const out: string[] = []
  // cust ships via the existing bootstrap (class + writer report, package/transport aware)
  if (unit.id === "cust") {
    const r = await handleEngineBootstrap({
      packageName: target.package, transport: target.transport, connectionId,
    })
    out.push(r.content[0]?.text ?? "(no output)")
    out.push(await setupSicf(unit, target, connectionId))
    return out
  }
  const client = await ensureConnected(connectionId)
  for (const o of unit.objects) {
    let exists = false
    try { await client.getObjectSource(`${o.url}/source/main`); exists = true } catch { exists = false }
    if (!exists) {
      await handleCreateAbapObject({
        objectType: o.kind === "class" ? "CLAS/OC" : "PROG/P",
        name: o.name, description: `MCP ${unit.id} unit (${unit.title})`,
        packageName: target.package, transport: target.transport, connectionId,
      })
      out.push(`created ${o.name} in ${target.package}`)
    } else {
      out.push(`${o.name} exists — updating source (package unchanged; recreate to move packages)`)
    }
    if (o.getSource) {
      await handleWriteAbapObjectSource({ url: o.url, source: o.getSource(), transport: target.transport, connectionId })
    }
    const act = await handleAbapActivate({ url: o.url, connectionId })
    if (/❌|Activation failed/i.test(act.content[0]?.text ?? "")) {
      out.push(`❌ activation of ${o.name} failed: ${act.content[0]?.text}`)
      return out
    }
    out.push(`activated ${o.name}`)
  }
  out.push(await setupSicf(unit, target, connectionId))
  return out
}

export async function handleEngineDeploy(args: {
  unit?: string
  transportable?: boolean
  package?: string
  transport?: string
  connectionId?: string
}) {
  const cfg = loadConfig()

  // No unit specified → first-run setup prompt, or current status.
  if (!args.unit) {
    const text = isFirstRun(cfg, args.connectionId)
      ? buildSetupPrompt(args.connectionId)
      : buildStatus(cfg, args.connectionId)
    return { content: [{ type: "text" as const, text }] }
  }

  const unit = findUnit(args.unit)
  if (!unit) {
    return { content: [{ type: "text" as const, text:
      `❌ Unknown unit '${args.unit}'. Known units: ${UNITS.map(u => u.id).join(", ")}.` }] }
  }
  const resolved = resolveTarget(args)
  if (!resolved.ok) {
    return { content: [{ type: "text" as const, text: `❌ ${resolved.error}.` }] }
  }
  const target = resolved.deploy

  let result: string[]
  try {
    result = await deployUnitObjects(unit, target, args.connectionId)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Deploy of unit '${unit.id}' failed: ${String((err as Error).message ?? err)}` }] }
  }

  // Persist the choice (the "flip" is just re-running with new values).
  try {
    saveConfig(setUnitConfig(cfg, args.connectionId, unit.id, target))
  } catch (err) {
    log("WARN", "could not persist engine-deploy config", err)
  }

  const head = target.transportable
    ? `✅ Unit '${unit.id}' deployed TRANSPORTABLE → package ${target.package}${target.transport ? ` on ${target.transport}` : ""} (release via CTS to reach Production).`
    : `✅ Unit '${unit.id}' deployed to $TMP (Dev-only).`
  return { content: [{ type: "text" as const, text: [head, "", ...result].join("\n") }] }
}

export function registerEngineDeployTools(server: McpServer): void {
  server.registerTool(
    "engine_deploy",
    {
      title: "Deploy In-System Engine (choose transportability)",
      description:
        "Install/manage the MCP's in-system ABAP, choosing per unit whether it is TRANSPORTABLE " +
        "(created in a Workbench Z package on a transport, to be released to Production via CTS " +
        "independent of the MCP) or deployed to $TMP (local, Dev-only). Run with NO unit to see the " +
        "first-run setup prompt (or current status). Run per unit to deploy/flip:\n" +
        "  engine_deploy unit:\"diag\" transportable:true package:\"ZMCP_DIAG\" transport:\"DEVK9…\"\n" +
        "  engine_deploy unit:\"cust\" transportable:false\n" +
        "Re-run any time to flip a unit (e.g. promote a higher-tier unit to transportable). Units: " +
        "diag (Tier 0 read-only diagnostics) · cust (Tier 1 customizing engine). After a transportable " +
        "deploy, register the unit's SICF node once (reported in the output).",
      inputSchema: {
        unit:          z.string().optional().describe("Unit to deploy: 'diag' or 'cust'. Omit to see the setup prompt / status."),
        transportable: z.boolean().optional().describe("true = create in a Workbench Z package on a transport (CTS to Prod); false/omitted = $TMP (Dev-only)."),
        package:       z.string().optional().describe("Workbench Z package for a transportable deploy (required when transportable:true; must not be $TMP)."),
        transport:     z.string().optional().describe("Workbench transport request to record the objects onto (for a transportable deploy)."),
        connectionId:  z.string().optional().describe("SAP system connection ID"),
      },
    },
    handleEngineDeploy,
  )
}
