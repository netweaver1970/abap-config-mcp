/**
 * Tool groups: the server's tools as a dozen top-level tools, each with an `action`.
 *
 * Every tool is still registered as before (its own module, its own schema), and every layer
 * that acts per tool still runs underneath: session scope and recovery, SOAP RFC routing,
 * risk tiers, governed mode and annotations. This outermost layer collects what those layers
 * let through and registers one tool per group instead, whose `action` enum lists only the
 * actions available on this server. So a governed or tier-capped server shows the same groups
 * with fewer actions, and a group with no action left is not registered at all.
 *
 * Groups split reads from writes, so a client can allow a whole read group without asking and
 * still confirm every write; the annotations of a group are the most cautious of its actions.
 *
 * A call is checked against the chosen action's own schema (unknown, missing and mistyped
 * parameters named per action), then passed to that action's handler. A few old tools took an
 * `action` of their own (manage_transport_requests, abap_debug_session, org_copy,
 * customizing_apply); each of their actions is an action of the group here, with that value fixed.
 *
 * Old names everywhere in descriptions and answers are rewritten to `group(action: "x")`.
 * ABAP_MCP_TOOLS=legacy (or "tools": "legacy" in the server section of connections.json)
 * registers the old one-tool-per-operation surface instead.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { loadConfig } from "../config"
import { checkArgs, SELF_CHECKED_TOOLS } from "./paramGuard"
import { hintsFor, type ToolHints } from "./toolAnnotations"

export type ToolSurface = "grouped" | "legacy"

/** ABAP_MCP_TOOLS, else "tools" in the server section of connections.json, else grouped. */
export function toolSurface(): ToolSurface {
  let raw: unknown = process.env.ABAP_MCP_TOOLS?.trim() || undefined
  if (raw === undefined) {
    try { raw = (loadConfig().server as { tools?: unknown } | undefined)?.tools } catch { raw = undefined }
  }
  if (raw === undefined || raw === null || raw === "") return "grouped"
  const v = String(raw).trim().toLowerCase()
  if (v === "grouped" || v === "legacy") return v
  throw new Error(`Reading the tool surface stopped: ABAP_MCP_TOOLS (or "tools" in connections.json) is ${JSON.stringify(raw)}, ` +
    `and the only values are "grouped" and "legacy". Set one of them, or remove it to get the default, grouped.`)
}

// ─── the catalog ─────────────────────────────────────────────────────────────

export interface GroupAction {
  /** Action name within the group */
  action: string
  /** The tool (old name) that does it */
  tool: string
  /** Parameters fixed for this action (taken out of its schema) */
  fixed?: Record<string, unknown>
  /** Description to use instead of the tool's own (for split tools) */
  summary?: string
  /** This action only reads, though the tool it splits from also writes */
  readOnly?: boolean
  /** The tool's parameters this action takes (connectionId always); default all */
  params?: string[]
  /** Of those, the ones this action needs (the split tool checked them itself) */
  required?: string[]
}

export interface GroupDef {
  name: string
  title: string
  intro: string
  actions: GroupAction[]
}

export const TOOL_GROUPS: GroupDef[] = [
  { name: "sap_system", title: "SAP System", intro: "The configured SAP systems and their state: connections, ADT services, short dumps, memory. Read-only.",
    actions: [
      { action: "systems", tool: "connected_systems" },
      { action: "adt_services", tool: "adt_discovery" },
      { action: "dumps", tool: "analyze_dump" },
      { action: "abap_memory", tool: "abap_memory_report" },
      { action: "hana_memory", tool: "hana_memory_report" },
    ] },
  { name: "abap", title: "ABAP Repository (read)", intro: "Find and read ABAP repository objects and the dictionary: search, metadata, source, where-used, versions, packages, text elements, tables. Read-only.",
    actions: [
      { action: "search", tool: "search_abap_objects" },
      { action: "info", tool: "get_abap_object_info" },
      { action: "source", tool: "get_abap_object_lines" },
      { action: "sources", tool: "get_abap_batch_lines" },
      { action: "grep", tool: "search_abap_object_lines" },
      { action: "where_used", tool: "where_used" },
      { action: "versions", tool: "version_history" },
      { action: "package", tool: "browse_package" },
      { action: "text_elements", tool: "get_text_elements" },
      { action: "inactive", tool: "check_inactive_objects" },
      { action: "table", tool: "describe_database_table" },
      { action: "tables", tool: "search_database_tables" },
    ] },
  { name: "abap_write", title: "ABAP Repository (write)", intro: "Create, change, activate and delete ABAP repository objects: source, locks, packages, test includes, text elements. Records on Workbench requests.",
    actions: [
      { action: "create", tool: "create_abap_object" },
      { action: "write", tool: "write_abap_object_source" },
      { action: "activate", tool: "abap_activate" },
      { action: "activate_many", tool: "abap_activate_multiple" },
      { action: "delete", tool: "delete_abap_object" },
      { action: "lock", tool: "lock_abap_object" },
      { action: "unlock", tool: "unlock_abap_object" },
      { action: "create_package", tool: "create_package" },
      { action: "create_test_include", tool: "create_test_include" },
      { action: "set_text_elements", tool: "set_text_elements" },
    ] },
  { name: "abap_test", title: "ABAP Checks and Tests", intro: "Check ABAP code: syntax check, ABAP Unit, ATC. Changes no source.",
    actions: [
      { action: "syntax", tool: "syntax_check" },
      { action: "unit", tool: "run_unit_tests" },
      { action: "atc", tool: "run_atc_analysis" },
    ] },
  { name: "abap_debug", title: "ABAP Run and Debug", intro: "Run a class (if_oo_adt_classrun) and debug: listen for breakpoints, set and delete them, step, read and set variables.",
    actions: [
      { action: "run_class", tool: "abap_run_class" },
      { action: "listen", tool: "abap_debug_session", fixed: { action: "listen" }, params: ["username"], summary: "Wait for a breakpoint hit of the debug listener (blocks until hit or timeout)." },
      { action: "detach", tool: "abap_debug_session", fixed: { action: "detach" }, params: [], summary: "Remove the debug listener." },
      { action: "status", tool: "abap_debug_session", fixed: { action: "status" }, params: [], summary: "Show terminal id, IDE id and user of the current debug listener, if any." },
      { action: "set_breakpoint", tool: "abap_debug_set_breakpoint" },
      { action: "delete_breakpoint", tool: "abap_debug_delete_breakpoint" },
      { action: "step", tool: "abap_debug_step" },
      { action: "stack", tool: "abap_debug_stack" },
      { action: "variable", tool: "abap_debug_variable" },
      { action: "set_variable", tool: "abap_debug_set_variable" },
    ] },
  { name: "data", title: "Table Data", intro: "Read table rows and run SELECTs (only when switched on with ABAP_MCP_DATA_TOOLS=1). Read-only.",
    actions: [
      { action: "query", tool: "execute_data_query" },
      { action: "rows", tool: "read_table_contents" },
    ] },
  { name: "transport", title: "Transports (read)", intro: "Transport requests: the open and released ones with their objects, one request's details, and which request an object is on. Read-only.",
    actions: [
      { action: "list", tool: "list_all_transports" },
      { action: "mine", tool: "manage_transport_requests", fixed: { action: "list" }, readOnly: true, params: ["username"], summary: "List a user's open requests (default: the connected user)." },
      { action: "details", tool: "manage_transport_requests", fixed: { action: "details" }, readOnly: true, params: ["transportNumber"], required: ["transportNumber"], summary: "One request's header, tasks and objects." },
      { action: "for_object", tool: "get_transport_for_object" },
    ] },
  { name: "transport_write", title: "Transports (write)", intro: "Create, release, delete and reassign transport requests, and move objects between requests with their dependencies. Release and delete are irreversible.",
    actions: [
      { action: "create", tool: "manage_transport_requests", fixed: { action: "create" }, params: ["objectUrl", "description", "packageName"], required: ["objectUrl", "description", "packageName"], summary: "Create a Workbench request for an object." },
      { action: "release", tool: "manage_transport_requests", fixed: { action: "release" }, params: ["transportNumber"], required: ["transportNumber"], summary: "Release a request (irreversible)." },
      { action: "delete", tool: "manage_transport_requests", fixed: { action: "delete" }, params: ["transportNumber"], required: ["transportNumber"], summary: "Delete a request that is not released (irreversible)." },
      { action: "change_owner", tool: "manage_transport_requests", fixed: { action: "change_owner" }, params: ["transportNumber", "newOwner"], required: ["transportNumber", "newOwner"], summary: "Give a request to another user." },
      { action: "move", tool: "transport_move" },
    ] },
  { name: "customizing", title: "Customizing (read)", intro: "Customizing (IMG/SPRO): find activities, describe and read maintenance objects and tables, compare keys, plan a change, show the system's recording status. Read-only.",
    actions: [
      { action: "search", tool: "img_search" },
      { action: "describe", tool: "customizing_describe" },
      { action: "read", tool: "customizing_read" },
      { action: "diff", tool: "customizing_diff" },
      { action: "plan", tool: "customizing_plan_change" },
      { action: "status", tool: "customizing_status" },
    ] },
  { name: "customizing_write", title: "Customizing (write)", intro: "Change customizing through the engine's SM30 path, recorded on Customizing requests: copy or delete entries, create entries, copy or delete a whole org unit, list articles.",
    actions: [
      { action: "copy", tool: "customizing_apply", fixed: { action: "copy" }, summary: "Copy the entries of one key to another in a maintenance object (SM30 runtime, recorded on a Customizing request)." },
      { action: "delete", tool: "customizing_apply", fixed: { action: "delete" }, summary: "Delete the entry of one key in a maintenance object (SM30 runtime, recorded on a Customizing request)." },
      { action: "create", tool: "customizing_create" },
      { action: "org_copy", tool: "org_copy", fixed: { action: "copy" }, summary: "Copy an org unit (company code, plant, sales org, …) with all dependent customizing to a new key." },
      { action: "org_delete", tool: "org_copy", fixed: { action: "delete" }, summary: "Delete an org unit's entries with all dependent customizing." },
      { action: "retail_listing", tool: "retail_listing" },
    ] },
  { name: "bw", title: "BW Objects (read)", intro: "BW objects of any type: capabilities of the system's BW, list, read and where-used. Read-only.",
    actions: [
      { action: "capabilities", tool: "bw_capabilities" },
      { action: "list", tool: "bw_list" },
      { action: "read", tool: "bw_read" },
      { action: "where_used", tool: "bw_where_used" },
    ] },
  { name: "bw_write", title: "BW Objects (write)", intro: "Create, change, activate and delete BW objects through BW's own APIs, recorded on Workbench requests. Dry run unless commit: true.",
    actions: [
      { action: "create", tool: "bw_create" },
      { action: "change", tool: "bw_change" },
      { action: "activate", tool: "bw_activate" },
      { action: "delete", tool: "bw_delete" },
    ] },
  { name: "admin", title: "Server and Engine Admin", intro: "This server's SAP sessions and the in-system Customizing Engine: re-login, ping, install, update, self-test, remove.",
    actions: [
      { action: "relogin", tool: "force_relogin" },
      { action: "engine_ping", tool: "customizing_engine_ping" },
      { action: "engine_install", tool: "customizing_engine_bootstrap" },
      { action: "engine_deploy", tool: "engine_deploy" },
      { action: "engine_selftest", tool: "customizing_selftest" },
      { action: "engine_remove", tool: "customizing_engine_cleanup" },
    ] },
]

/** Old tool name → how to call it now. A split tool maps to its group without an action. */
export function legacyRef(tool: string): string | undefined {
  const hits = TOOL_GROUPS.map(g => [g.name, g.actions.filter(a => a.tool === tool).map(a => `"${a.action}"`)] as const).filter(([, acts]) => acts.length)
  return hits.length ? hits.map(([g, acts]) => `${g}(action: ${acts.join(" | ")})`).join(" or ") : undefined
}

let _rewrite: RegExp | undefined
/** Old tool names in a text, rewritten to the grouped call. */
export function rewriteToolNames(text: string): string {
  if (!_rewrite) {
    const names = [...new Set(TOOL_GROUPS.flatMap(g => g.actions.map(a => a.tool)))].sort((a, b) => b.length - a.length)
    _rewrite = new RegExp(`(?<![\\w/'.-])(${names.join("|")})(?![\\w'=])`, "g")
  }
  return text.replace(_rewrite, (m: string) => legacyRef(m) ?? m)
}

// ─── building a group from collected tools ───────────────────────────────────

type AnyFn = (...args: any[]) => any
interface Collected { name: string; config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodType>; annotations?: Record<string, unknown> }; handler: AnyFn }

const unwrap = (t: z.ZodType): z.ZodType => {
  let f: any = t
  for (let i = 0; i < 4 && f; i++) {
    const kind = f?._zod?.def?.type
    if (kind === "optional" || kind === "default" || kind === "nullable") { f = f._zod.def.innerType; continue }
    break
  }
  return f as z.ZodType
}
const typeKey = (t: z.ZodType): string => { try { return JSON.stringify(z.toJSONSchema(unwrap(t), { unrepresentable: "any" })) } catch { return String(Math.random()) } }

function actionShape(c: Collected, a: GroupAction): Record<string, z.ZodType> {
  const shape = { ...(c.config.inputSchema ?? {}) }
  for (const k of Object.keys(a.fixed ?? {})) delete shape[k]
  if (a.params) for (const k of Object.keys(shape)) if (k !== "connectionId" && !a.params.includes(k)) delete shape[k]
  for (const k of a.required ?? []) if (shape[k]) shape[k] = unwrap(shape[k])
  return shape
}

function mergeHints(list: ToolHints[]): ToolHints {
  return {
    readOnlyHint: list.every(h => h.readOnlyHint),
    destructiveHint: list.some(h => !h.readOnlyHint && h.destructiveHint !== false),
    idempotentHint: list.every(h => h.idempotentHint === true),
  }
}

const firstSentences = (s: string, n: number) => {
  const parts = s.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [s]
  return parts.slice(0, n).join("").trim()
}

export interface BuiltGroup {
  name: string
  config: { title: string; description: string; inputSchema: Record<string, z.ZodType>; annotations: Record<string, unknown> }
  handler: AnyFn
  actions: string[]
}

/** One group tool from the tools collected for it, or undefined when none of its actions is available. */
export function buildGroup(g: GroupDef, collected: Map<string, Collected>): BuiltGroup | undefined {
  const avail = g.actions.filter(a => collected.has(a.tool))
  if (!avail.length) return undefined
  const shapes = new Map(avail.map(a => [a.action, actionShape(collected.get(a.tool)!, a)]))

  // merged parameters: optional, typed when every action agrees, described per action when they differ
  const params = new Map<string, { types: Map<string, z.ZodType>; descs: Map<string, string[]> }>()
  for (const a of avail) {
    for (const [k, t] of Object.entries(shapes.get(a.action)!)) {
      const p = params.get(k) ?? { types: new Map(), descs: new Map() }
      p.types.set(typeKey(t), unwrap(t))
      const d = rewriteToolNames((t as any).description ?? (unwrap(t) as any).description ?? "")
      p.descs.set(d, [...(p.descs.get(d) ?? []), a.action])
      params.set(k, p)
    }
  }
  const users = (k: string) => avail.filter(a => k in shapes.get(a.action)!).map(a => a.action)
  const inputSchema: Record<string, z.ZodType> = {
    action: z.enum(avail.map(a => a.action) as [string, ...string[]]).describe(`What to do: ${avail.map(a => a.action).join(", ")} (see the tool description)`),
  }
  for (const [k, p] of params) {
    const types = [...p.types.values()]
    const base: z.ZodType = types.length === 1 ? types[0] : z.union(types as [z.ZodType, z.ZodType, ...z.ZodType[]])
    const all = users(k)
    const descs = [...p.descs.entries()]
    const desc = descs.length === 1
      ? (all.length === avail.length ? descs[0][0] : `${all.join(", ")}: ${descs[0][0]}`)
      : descs.map(([d, acts]) => `${acts.join(", ")}: ${d}`).join(" | ")
    inputSchema[k] = base.optional().describe(desc)
  }

  const lines = avail.map(a => {
    const c = collected.get(a.tool)!
    const shape = shapes.get(a.action)!
    const req = Object.entries(shape).filter(([, t]) => !(t as any).isOptional?.()).map(([k]) => k)
    const opt = Object.keys(shape).filter(k => !req.includes(k) && k !== "connectionId")
    const text = rewriteToolNames(a.summary ?? firstSentences(c.config.description ?? "", 3))
    return `• ${a.action} — ${text}` +
      (req.length ? ` Required: ${req.join(", ")}.` : "") + (opt.length ? ` Optional: ${opt.join(", ")}.` : "")
  })
  const description = `${g.intro}\n\nActions (pass action plus that action's parameters; connectionId picks the system):\n${lines.join("\n")}`

  const hints = mergeHints(avail.map(a => {
    const own = (collected.get(a.tool)!.config.annotations ?? {}) as Partial<ToolHints>
    return a.readOnly ? { readOnlyHint: true, idempotentHint: true } : { ...hintsFor(a.tool), ...own } as ToolHints
  }))

  const byAction = new Map(avail.map(a => [a.action, a]))
  const handler = async (args: Record<string, unknown>, extra: unknown) => {
    const { action, ...given } = args ?? {}
    const a = byAction.get(String(action))
    if (!a) throw new McpError(ErrorCode.InvalidParams,
      `❌ ${g.name} was not run: action ${JSON.stringify(action)} is not one of ${avail.map(x => x.action).join(", ")}. Pass one of those as action.`)
    const c = collected.get(a.tool)!
    const shape = shapes.get(a.action)!
    const label = `${g.name}(action: "${a.action}")`
    // connectionId is offered for every action; one that works without a system just ignores it
    const { connectionId, ...rest } = given
    if (connectionId !== undefined && "connectionId" in shape) rest.connectionId = connectionId
    const r = checkArgs(label, z.object(shape), rest)
    if (!r.ok) throw new McpError(ErrorCode.InvalidParams, r.message)
    const result = await c.handler({ ...r.args, ...(a.fixed ?? {}) }, extra)
    return rewriteResult(result)
  }

  return {
    name: g.name,
    config: { title: g.title, description, inputSchema, annotations: { title: g.title, ...hints, openWorldHint: true } },
    handler,
    actions: avail.map(a => a.action),
  }
}

function rewriteResult(result: any): any {
  if (!result || !Array.isArray(result.content)) return result
  return { ...result, content: result.content.map((c: any) => c?.type === "text" && typeof c.text === "string" ? { ...c, text: rewriteToolNames(c.text) } : c) }
}

/**
 * Wrap a server so registerTool() only collects; flush() then registers the groups on the real
 * server. A tool that is in no group is registered as it is (and logged), so nothing gets lost.
 */
export function groupingServer(server: McpServer): { target: McpServer; flush: () => { groups: BuiltGroup[]; ungrouped: string[] } } {
  const collected = new Map<string, Collected>()
  const target = new Proxy(server, {
    get(t, prop) {
      if (prop === "registerTool") {
        return (name: string, config: Collected["config"], handler: AnyFn) => { collected.set(name, { name, config, handler }); return undefined }
      }
      const value = Reflect.get(t, prop, t)
      return typeof value === "function" ? (value as AnyFn).bind(t) : value
    },
  })
  const flush = () => {
    const groups: BuiltGroup[] = []
    for (const g of TOOL_GROUPS) {
      const b = buildGroup(g, collected)
      if (!b) continue
      SELF_CHECKED_TOOLS.add(b.name)
      ;(server.registerTool as AnyFn).call(server, b.name, b.config, b.handler)
      groups.push(b)
    }
    const grouped = new Set(TOOL_GROUPS.flatMap(g => g.actions.map(a => a.tool)))
    const ungrouped = [...collected.keys()].filter(n => !grouped.has(n))
    for (const n of ungrouped) {
      const c = collected.get(n)!
      ;(server.registerTool as AnyFn).call(server, n, c.config, c.handler)
    }
    return { groups, ungrouped }
  }
  return { target, flush }
}
