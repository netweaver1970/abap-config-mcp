/**
 * OpenAPI 3.0.3 description of the engine's HTTP endpoint, one path per action
 * (POST /sap/bc/zmcp_cust/<operation>), for SAP's MCP Gateway in Integration Suite, which turns
 * each operation of an OpenAPI-described HTTP endpoint into one MCP tool (at most 30 per MCP
 * server artifact). Spec 001, phase 4; docs/PRINCIPAL_PROPAGATION.md shows the set-up.
 *
 * The engine takes the operation from the path when the body does not name it (engine 0.10.3).
 * Curated: the actions a gateway user needs, not the engine's internal ones (retest_scope,
 * dependencies, img_index_read, selftest). Writes are dry runs unless commit is true, as in the
 * engine. `npm run openapi` writes docs/gateway/zmcp_cust.openapi.json; a test keeps it current.
 */
import { ENGINE_VERSION, ENGINE_ICF_PATH } from "../abap/zcl_mcp_cust_engine"

type Schema = Record<string, unknown>
const str = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra })
const bool = (description: string): Schema => ({ type: "boolean", description })
const int = (description: string, extra: Schema = {}): Schema => ({ type: "integer", description, ...extra })
const jsonText = (description: string): Schema => ({ type: "string", description: `${description} (JSON text)` })

const commit = bool("true writes; default is a dry run that checks and reports only")
const transport = str("Request to record on (Customizing request for customizing, Workbench request for BW objects)")
const maxRows = int("At most this many rows", { minimum: 1, maximum: 1000 })
const tlogo = str("BW object type as BW names it (TLOGO): IOBJ InfoObject, ADSO, AREA, HCPR, TRFN, DTPA, …")
const bwName = str("BW object name, e.g. ZCUSTOMER or 0MATERIAL")
const objvers = str("A active (default), M modified or D delivered", { enum: ["A", "M", "D"] })

interface Op { op: string; summary: string; description: string; write?: boolean; props: Record<string, Schema>; required?: string[] }

export const GATEWAY_OPERATIONS: Op[] = [
  // ─── reads ─────────────────────────────────────────────────────────────────
  { op: "whoami", summary: "Who SAP sees", description: "The SAP user, client and system this call runs as, and how it logged on (basic, X.509 client certificate, …). Use it to confirm principal propagation. Reads nothing.", props: {} },
  { op: "ping", summary: "Engine status", description: "Engine version, the client's change recording (SCC4) and which engine features this system offers.", props: {} },
  { op: "ddic_describe", summary: "Describe a table or view", description: "Fields, keys, delivery class, text table and maintenance object of a customizing table or view.", props: { table: str("Table or view name, e.g. T001W or V_T001W") }, required: ["table"] },
  { op: "read", summary: "Read customizing rows", description: "Rows of one customizing table (delivery class C, G or E), optionally only one key value. Needs display authorization for the table (S_TABU_DIS / S_TABU_NAM).", props: { table: str("Customizing table, e.g. T001W"), key_field: str("Key field to filter on, e.g. WERKS"), source_key: str("Value of the key field"), max_rows: maxRows }, required: ["table"] },
  { op: "img_search", summary: "Find IMG activities", description: "IMG (SPRO) activities whose text contains a keyword, with their maintenance objects.", props: { keyword: str("Text to find, e.g. plant"), language: str("One-character language (default the logon language)"), max_rows: maxRows }, required: ["keyword"] },
  { op: "transports", summary: "List transport requests", description: "Transport requests with their texts, owners and status, optionally with their objects.", props: { owner: str("Only this user's requests"), trfunction: str("Request kinds, e.g. K or W (default K, W, T, C)"), statuses: str("Statuses, e.g. D (default D and L)"), with_objects: bool("Include each request's objects"), max_rows: maxRows } },
  { op: "transport_info", summary: "Transport of one object", description: "Package, recording, transport layer and the request an object is locked on.", props: { pgmid: str("R3TR (default)"), obj_type: str("TADIR object type, e.g. PROG, CLAS, TABU"), obj_name: str("Object name") }, required: ["obj_type", "obj_name"] },
  { op: "status", summary: "Status of a background write", description: "Result of a write that the engine runs as a background job.", props: { run_id: str("Run id returned by the write") }, required: ["run_id"] },
  { op: "abap_memory", summary: "ABAP memory report", description: "ABAP application server memory parameters and usage.", props: {} },
  { op: "hana_memory", summary: "HANA memory report", description: "HANA memory usage of the system's database.", props: {} },
  { op: "bw_capabilities", summary: "BW capabilities", description: "Which BW the system has, its BW client, and per BW object type which operations work.", props: { tlogo } },
  { op: "bw_list", summary: "List BW objects", description: "BW objects of one type by name pattern, with texts.", props: { tlogo, pattern: str("Name pattern, * as wildcard (default *)"), objvers, language: str("Text language, one character"), max_rows: maxRows }, required: ["tlogo"] },
  { op: "bw_read", summary: "Read a BW object", description: "Versions, package and definition of one BW object (InfoObjects through BAPI_IOBJ_GETDETAIL).", props: { tlogo, name: bwName, objvers }, required: ["tlogo", "name"] },
  { op: "bw_where_used", summary: "BW where-used", description: "Which BW objects use the object and which it uses (RSOOBJXREF).", props: { tlogo, name: bwName, objvers }, required: ["tlogo", "name"] },
  // ─── writes (dry run unless commit) ────────────────────────────────────────
  { op: "write", write: true, summary: "Copy customizing entries", description: "Copy the entries of one key to another through the maintenance object's SM30 runtime, recorded on a Customizing request. Dry run unless commit is true.", props: { table: str("Customizing table"), view_name: str("Maintenance view, when it is not the table itself"), key_field: str("Key field, e.g. WERKS"), source_key: str("Key to copy from"), target_key: str("Key to copy to"), values_json: jsonText("Field overrides [{FIELD,VALUE}] for every copied row"), only_missing: bool("Only rows that do not exist yet"), transport, create_transport: bool("Create a Customizing request when none is given"), transport_text: str("Text of a created request"), commit }, required: ["table", "key_field", "source_key", "target_key"] },
  { op: "create", write: true, summary: "Create customizing entries", description: "Create rows in a customizing table through its SM30 runtime, recorded on a Customizing request. Dry run unless commit is true.", props: { table: str("Customizing table"), view_name: str("Maintenance view, when it is not the table itself"), rows_json: jsonText("Rows, each an array of {FIELD,VALUE} with the full key"), only_missing: bool("Skip rows that exist"), transport, create_transport: bool("Create a Customizing request when none is given"), commit }, required: ["table", "rows_json"] },
  { op: "delete", write: true, summary: "Delete customizing entries", description: "Delete the entries of one key through the SM30 runtime, recorded on a Customizing request. Dry run unless commit is true.", props: { table: str("Customizing table"), view_name: str("Maintenance view, when it is not the table itself"), key_field: str("Key field"), target_key: str("Key to delete"), transport, commit }, required: ["table", "key_field", "target_key"] },
  { op: "org_copy", write: true, summary: "Copy or delete an org unit", description: "Copy an org unit (company code, plant, sales organization, …) with its dependent customizing, or delete one (action DELE), through SAP's entity copier. Dry run unless commit is true.", props: { org_unit: str("Org-unit domain, e.g. BUKRS, WERKS, VKORG"), source_key: str("Org unit to copy (or delete)"), target_key: str("New org unit"), action: str("COPY (default) or DELE", { enum: ["COPY", "DELE"] }), create_transport: bool("Create a Customizing request"), commit }, required: ["org_unit", "source_key"] },
  { op: "listing", write: true, summary: "List articles in assortments", description: "Retail listing of articles into assortments. Dry run unless commit is true.", props: { items_json: jsonText("Items [{PRODUCT,ASSORTMENT,DATE_FROM,DATE_TO}]"), commit }, required: ["items_json"] },
  { op: "transport_move", write: true, summary: "Move objects between requests", description: "Move object entries from one request or task to another. Dry run unless commit is true.", props: { from_trkorr: str("Source task"), to_trkorr: str("Target request or task"), objects_json: jsonText("Entries [{TRKORR,PGMID,OBJECT,OBJ_NAME}]"), commit }, required: ["from_trkorr", "to_trkorr"] },
  { op: "bw_create", write: true, summary: "Create a BW object", description: "Create a BW object through BW's API (InfoObjects: BAPI_IOBJ_CREATE), activated by default, recorded on a Workbench request unless the package is local. Dry run unless commit is true.", props: { tlogo, name: bwName, package: str("Package (default $TMP)"), details_json: jsonText("InfoObject: BAPI6108 fields"), compounds_json: jsonText("InfoObject: BAPI6108CM rows"), attributes_json: jsonText("InfoObject: BAPI6108AT rows"), navattr_json: jsonText("InfoObject: BAPI6108AN rows"), activate: bool("Activate after creating (default true)"), transport, commit }, required: ["tlogo", "name", "details_json"] },
  { op: "bw_change", write: true, summary: "Change a BW object", description: "Change a BW object from its current definition. Dry run unless commit is true.", props: { tlogo, name: bwName, values_json: jsonText("Fields to set [{FIELD,VALUE}]"), compounds_json: jsonText("Replace the compound rows"), attributes_json: jsonText("Replace the attribute rows"), navattr_json: jsonText("Replace the navigation attribute rows"), activate: bool("Activate after changing (default true)"), transport, commit }, required: ["tlogo", "name"] },
  { op: "bw_activate", write: true, summary: "Activate a BW object", description: "Activate a BW object's modified version. Dry run unless commit is true.", props: { tlogo, name: bwName, transport, commit }, required: ["tlogo", "name"] },
  { op: "bw_delete", write: true, summary: "Delete a BW object", description: "Delete a BW object; a transported one is recorded on the request first, so the deletion travels. Dry run unless commit is true.", props: { tlogo, name: bwName, transport, commit }, required: ["tlogo", "name"] },
]

// ─── read-only ABAP: a second MCP server on the same endpoint (the gateway takes 30 tools per server) ───
const objType = str("Object type: PROG program, INCL include, CLAS class, INTF interface, FUGR function group, FUNC function module, TABL, VIEW, DTEL, DOMA, TTYP, TRAN, MSAG", { enum: ["PROG", "INCL", "CLAS", "INTF", "FUGR", "FUNC", "TABL", "VIEW", "DTEL", "DOMA", "TTYP", "TRAN", "MSAG"] })
const objName = str("Exact object name, e.g. ZCL_ORDER_API or RFC_READ_TABLE")
const language = str("One-character or ISO language (default the logon language)")

export const ABAP_GATEWAY_OPERATIONS: Op[] = [
  { op: "abap_search", summary: "Find ABAP objects", description: "Repository objects whose name matches a pattern (* as wildcard), with type, package and description; only objects the user may display.", props: { pattern: str("Name or pattern, e.g. ZCL_ORDER*"), object_type: objType, max_rows: maxRows, language }, required: ["pattern"] },
  { op: "abap_info", summary: "Object details", description: "Package, author, dates, description, what the object belongs to and its parts (methods, function modules).", props: { object_type: objType, name: objName, language }, required: ["object_type", "name"] },
  { op: "abap_source", summary: "Read ABAP source", description: "The active source of a program, include, class, interface, function group or function module. For a class, include picks a part.", props: { object_type: objType, name: objName, include: str("Class part: main (default), definitions, implementations, macros or testclasses", { enum: ["main", "definitions", "implementations", "macros", "testclasses"] }) }, required: ["object_type", "name"] },
  { op: "abap_where_used", summary: "Where an object is used", description: "The programs, classes (with method) and function modules that use an object, from SAP's cross-reference index.", props: { object_type: objType, name: objName, max_rows: maxRows }, required: ["object_type", "name"] },
  { op: "abap_versions", summary: "Version history", description: "Stored versions of an object (VRSD): version, date, author and transport request.", props: { object_type: objType, name: objName }, required: ["object_type", "name"] },
  { op: "abap_package", summary: "Contents of a package", description: "The objects of a package, optionally with its direct sub-packages.", props: { package: str("Package, e.g. ZORDER_API"), subpackages: bool("Also the direct sub-packages (at most 25)"), max_rows: maxRows, language }, required: ["package"] },
  { op: "abap_text_elements", summary: "Text elements", description: "Selection texts, text symbols and headings of a program, function group or class.", props: { object_type: objType, name: objName, language }, required: ["object_type", "name"] },
  { op: "abap_inactive", summary: "Inactive objects", description: "Objects saved but not activated in the user's worklist.", props: { all_users: bool("Everyone's, not only the caller's") } },
  { op: "abap_tables", summary: "Find tables and views", description: "Database tables and views by name pattern or by a word from their description.", props: { pattern: str("Name pattern, e.g. T001*"), keyword: str("Word from the description, e.g. plant"), max_rows: maxRows, language } },
  { op: "abap_syntax", summary: "Syntax check", description: "Runs SAP's syntax check on an object's active version, or on a program source you supply; saves nothing. Reports the first error.", props: { object_type: objType, name: objName, source: str("A complete program source to check instead of the stored one (executable programs only)") }, required: ["object_type", "name"] },
  { op: "abap_dumps", summary: "Short dumps (ST22)", description: "Recent runtime errors with program, include and line. The caller's own; all users' with S_DEVELOP display for DEBUG.", props: { days: int("How many days back (default 7, at most 90)", { minimum: 1, maximum: 90 }), all_users: bool("Everyone's dumps"), max_rows: maxRows } },
]

/** The operation sets, one MCP server in the gateway each. */
export const GATEWAY_SETS = {
  cust: { ops: GATEWAY_OPERATIONS, title: "abap-config-mcp Customizing Engine", file: "zmcp_cust.openapi.json",
    what: "customizing, transports and BW objects through SAP's own APIs" },
  abap: { ops: ABAP_GATEWAY_OPERATIONS, title: "abap-config-mcp ABAP (read-only)", file: "zmcp_abap.openapi.json",
    what: "read-only ABAP: search, source, where-used, versions, packages, text elements, syntax check and short dumps" },
} as const
export type GatewaySet = keyof typeof GATEWAY_SETS

/** SAP's MCP Gateway limit per MCP server artifact. */
export const GATEWAY_TOOL_LIMIT = 30

export function buildOpenApi(set: GatewaySet = "cust"): Record<string, unknown> {
  const def = GATEWAY_SETS[set]
  const response = {
    type: "object",
    properties: {
      STATUS: { type: "string", description: "ok, error, or running for a background write" },
      OPERATION: { type: "string" },
      VERSION: { type: "string", description: "Engine version" },
      DRY_RUN: { type: "string", description: "X when nothing was written" },
      MESSAGES: { type: "array", items: { type: "string" }, description: "What happened, or what stopped and why, in plain sentences" },
      DATA_JSON: { type: "string", description: "The result data as JSON text (rows, definitions, lists)" },
    },
  }
  const paths: Record<string, unknown> = {}
  for (const o of def.ops) {
    paths[`/${o.op}`] = {
      post: {
        operationId: o.op,
        summary: o.summary,
        description: o.description + (o.write ? " Changes SAP when commit is true; the SAP user's own authorizations apply." : " Read-only."),
        tags: [o.op.startsWith("bw_") ? "BW" : o.op.startsWith("abap_") ? "ABAP (read-only)" : o.write ? "Customizing writes" : "Reads"],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: o.props, ...(o.required?.length ? { required: o.required } : {}), additionalProperties: false } } } },
        responses: {
          "200": { description: "The engine's answer; STATUS says whether it worked", content: { "application/json": { schema: { $ref: "#/components/schemas/EngineResponse" } } } },
          "401": { description: "No SAP logon: missing or unmapped client certificate, or wrong credentials" },
          "403": { description: "The SICF node is inactive, or the SAP user may not call it" },
        },
      },
    }
  }
  return {
    openapi: "3.0.3",
    info: {
      title: def.title,
      version: ENGINE_VERSION,
      description: "The in-system engine of abap-config-mcp (ZCL_MCP_CUST_ENGINE behind SICF node " + ENGINE_ICF_PATH + "): " + def.what + ", as the calling SAP user. " +
        "Each call runs as the SAP user the logon maps to; with SAP Cloud Connector principal propagation that is the end user (X.509 certificate mapped in SAP). Writes are dry runs unless commit is true.",
    },
    servers: [{ url: "https://{host}:{port}" + ENGINE_ICF_PATH, variables: { host: { default: "sap-host" }, port: { default: "44300" } } }],
    paths,
    components: { schemas: { EngineResponse: response } },
  }
}
