/**
 * Server mode: "governed" (default) or "legacy-adt". See docs/specs/001-two-constellations.md.
 *
 *   governed    no ADT call at all; only the tools that work through the engine's HTTP
 *               endpoint are registered, and the engine is never deployed from here.
 *   legacy-adt  everything over ADT, as before 2.1 (then called "direct"; that name still works).
 *
 * Read once at startup. This module imports nothing that talks to SAP (not connections.ts),
 * so the connection layer, the tool registration and the entry points can all use it.
 */
import { loadConfig, type ConnectionConfig } from "./config"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export type ServerMode = "governed" | "legacy-adt"

let _mode: ServerMode | undefined

/** The configured mode: ABAP_MCP_MODE, else "mode" in the server section of connections.json, else governed. */
export function serverMode(): ServerMode {
  if (_mode) return _mode
  const fromEnv = process.env.ABAP_MCP_MODE?.trim()
  let raw: unknown = fromEnv || undefined
  let source = "ABAP_MCP_MODE"
  if (raw === undefined) {
    const fromFile = (loadConfig().server as { mode?: unknown } | undefined)?.mode
    if (fromFile !== undefined && fromFile !== null && fromFile !== "") {
      raw = fromFile
      source = `"mode" in the server section of connections.json`
    }
  }
  if (raw === undefined) return (_mode = "governed")
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw
  if (v === "governed" || v === "legacy-adt") return (_mode = v)
  if (v === "direct") return (_mode = "legacy-adt")   // the name before 2.1
  throw new Error(
    `Reading the server mode stopped: ${source} is ${JSON.stringify(raw)}, and the only modes are "governed" and "legacy-adt". ` +
    `Set it to "legacy-adt" (everything over ADT) or "governed" (no ADT calls), or remove it to get the default, governed.`)
}

export const isGoverned = (): boolean => serverMode() === "governed"
export const isLegacyAdt = (): boolean => serverMode() === "legacy-adt"

/** For tests: forget the mode read at startup. */
export function resetServerModeForTests(): void { _mode = undefined }

// ─── ADT guard ───────────────────────────────────────────────────────────────

/** The refusal every ADT entry point gives in governed mode. */
export function adtRefusal(purpose: string, connectionId: string): string {
  return `Calling ADT for ${purpose} on ${connectionId} stopped: this server runs in governed mode, which makes no ADT calls. ` +
    `Use SAP's ADT MCP server for code work, or run this server with ABAP_MCP_MODE=legacy-adt.`
}

/** Throw the three-part refusal when the server runs in governed mode. */
export function assertAdtAllowed(purpose: string, connectionId: string): void {
  if (isGoverned()) throw new Error(adtRefusal(purpose, connectionId))
}

// ─── Engine installation ─────────────────────────────────────────────────────

export const GOVERNED_ENGINE_NOTE =
  "this server does not deploy the engine in governed mode. Install it with abapGit, or transport it from a system where it was deployed in legacy-adt mode"

/** What to do about a missing or outdated engine: the bootstrap tool in legacy-adt mode, the two routes in governed mode. */
export function engineFixHint(): string {
  return isGoverned() ? GOVERNED_ENGINE_NOTE : "run customizing_engine_bootstrap"
}

// ─── Rule 4: own users only ──────────────────────────────────────────────────

/**
 * The HTTP server is shared by several people, so in governed mode every connection must log on
 * per user. Throws the three-part message naming the connections that do not. (stdio is exempt:
 * each process runs as its own SAP_* user, so the caller does not call this.)
 */
export function assertGovernedLogon(connections: Pick<ConnectionConfig, "id" | "logon">[]): void {
  if (!isGoverned()) return
  const shared = connections.filter(c => c.logon !== "per-user").map(c => c.id)
  if (shared.length === 0) return
  const list = shared.join(", ")
  throw new Error(
    `Starting the HTTP server in governed mode stopped: connection${shared.length > 1 ? "s" : ""} ${list} ` +
    `${shared.length > 1 ? "log" : "logs"} on with one shared SAP user, and in governed mode every call must run as the person making it. ` +
    `Set "logon": "per-user" on ${shared.length > 1 ? "each of them" : "it"} in connections.json (every client then sends its own SAP user), ` +
    `run the stdio server as your own user, or run this server with ABAP_MCP_MODE=legacy-adt.`)
}

// ─── Tool set ────────────────────────────────────────────────────────────────

/** The governed tool set: every one works through the engine's HTTP endpoint only. */
export const GOVERNED_TOOLS: ReadonlySet<string> = new Set([
  // phase 1: engine actions that already existed
  "connected_systems", "customizing_engine_ping", "customizing_status",
  "hana_memory_report", "abap_memory_report", "retail_listing", "customizing_selftest",
  // phase 2: ddic_describe and the hardened read (engine 0.9.37)
  "customizing_describe", "customizing_read", "customizing_diff", "customizing_plan_change",
  // phase 2: transports and transport_info (engine 0.9.38)
  "list_all_transports", "get_transport_for_object", "customizing_apply", "customizing_create",
  // phase 2: retest_scope (engine 0.9.39)
  "org_copy",
  // phase 2: dependencies (engine 0.9.40)
  "transport_move",
  // phase 2: the engine's img_search (no new action)
  "img_search",
  // phase 2.5: BW objects through the engine's BW class (the same in both modes)
  "bw_capabilities", "bw_list", "bw_read", "bw_where_used", "bw_create", "bw_change", "bw_activate", "bw_delete",
  // read-only ABAP through the engine's ZCL_MCP_ABAP_ENGINE (engine 0.11.0); handlers in tools/abapEngineRead.ts
  "search_abap_objects", "get_abap_object_info", "get_abap_object_lines", "get_abap_batch_lines", "search_abap_object_lines",
  "where_used", "version_history", "browse_package", "get_text_elements", "check_inactive_objects",
  "search_database_tables", "describe_database_table", "syntax_check", "analyze_dump",
])

type AnyFn = (...args: unknown[]) => unknown

/**
 * Proxy an McpServer so registerTool() skips every tool outside the governed set, and registers the
 * governed handler from `overrides` instead of the ADT one where there is one. Same style as the
 * risk-tier gating; the names left out are collected in `skipped`.
 */
export function wrapServerWithModeGating(server: McpServer, skipped: string[],
  overrides: Record<string, AnyFn> = {}): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyFn).bind(target)
        return (name: string, config: unknown, handler: AnyFn) => {
          if (!GOVERNED_TOOLS.has(name)) { skipped.push(name); return undefined }
          // a tool that reads over ADT in legacy-adt mode gets its engine-backed handler here
          return original(name, config, overrides[name] ?? handler)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyFn).bind(target) : value
    },
  })
}
