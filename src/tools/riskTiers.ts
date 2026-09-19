/**
 * Risk-tier classification + registration gating for the MCP tool surface.
 *
 * Goal: let a deployment expose only what corporate security accepts. On a
 * Production-pointed server you typically allow read-only diagnostics (Tier 0)
 * and nothing that changes config or — especially — creates ABAP code.
 *
 *   Tier 0 — read-only / diagnostics. System-management reads (memory reports,
 *            dumps, searches, customizing/table reads, syntax check, ATC).
 *            No data, config, or repository change. Safe for Production.
 *   Tier 1 — config / data writes. Customizing changes (SM30 view runtime),
 *            org-unit copies, listing, transport management. Governed writes,
 *            no ABAP source creation. Approvable with scrutiny.
 *   Tier 2 — repository / code writes + code execution + debugging. Creating,
 *            writing, activating, deleting ABAP objects; deploying the engine;
 *            running unit tests; debug control. The "pushing code" surface —
 *            Dev only; do NOT expose against Production.
 *
 * Gate with env var ABAP_MCP_MAX_TIER (0|1|2). Unset/2 = full (Dev default).
 * Set 0 for a read-only Production server, 1 to also allow customizing writes.
 * Unclassified tools default to Tier 2 (fail-safe: never silently expose a new
 * tool on a restricted server).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { log } from "../connections"

export type RiskTier = 0 | 1 | 2

type AnyFn = (...args: unknown[]) => unknown

export const TOOL_TIERS: Record<string, RiskTier> = {
  // ── Tier 0 — read-only / diagnostics ──────────────────────────────────────
  abap_memory_report: 0, hana_memory_report: 0, analyze_dump: 0,
  connected_systems: 0, force_relogin: 0, adt_discovery: 0,
  search_abap_objects: 0, search_abap_object_lines: 0, browse_package: 0,
  get_abap_object_info: 0, get_abap_object_lines: 0, get_abap_batch_lines: 0,
  where_used: 0, version_history: 0, check_inactive_objects: 0, syntax_check: 0,
  run_atc_analysis: 0, get_text_elements: 0, get_transport_for_object: 0,
  list_all_transports: 0, execute_data_query: 0, read_table_contents: 0,
  describe_database_table: 0, search_database_tables: 0, customizing_read: 0,
  customizing_describe: 0, customizing_diff: 0, img_search: 0,
  customizing_engine_ping: 0, customizing_status: 0,

  // ── Tier 1 — config / data writes ─────────────────────────────────────────
  customizing_apply: 1, customizing_create: 1, customizing_plan_change: 1,
  org_copy: 1, retail_listing: 1, manage_transport_requests: 1,
  customizing_selftest: 1,   // can auto-deploy the engine class → not pure read

  // ── Tier 2 — repository / code writes, execution, debug ───────────────────
  create_abap_object: 2, write_abap_object_source: 2, delete_abap_object: 2,
  abap_activate: 2, abap_activate_multiple: 2, create_package: 2,
  create_test_include: 2, set_text_elements: 2,
  lock_abap_object: 2, unlock_abap_object: 2, run_unit_tests: 2, abap_run_class: 2,
  customizing_engine_bootstrap: 2, customizing_engine_cleanup: 2, engine_deploy: 2,
  abap_debug_session: 2, abap_debug_set_breakpoint: 2, abap_debug_delete_breakpoint: 2,
  abap_debug_set_variable: 2, abap_debug_step: 2, abap_debug_stack: 2,
  abap_debug_variable: 2,
}

const DEFAULT_TIER: RiskTier = 2   // fail-safe for any unmapped tool

export function tierOf(name: string): RiskTier {
  return TOOL_TIERS[name] ?? DEFAULT_TIER
}

/** Read the configured ceiling. ABAP_MCP_MAX_TIER = 0 | 1 | 2 (default 2). */
export function getMaxTier(): RiskTier {
  switch (process.env.ABAP_MCP_MAX_TIER) {
    case "0": return 0
    case "1": return 1
    default:  return 2
  }
}

/**
 * Proxy an McpServer so registerTool() silently skips any tool whose tier
 * exceeds maxTier. Composes with wrapServerWithSessionRecovery (wrap that
 * first, gate on the outside).
 */
export function wrapServerWithTierGating(server: McpServer, maxTier: RiskTier): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyFn).bind(target)
        return (name: string, config: unknown, handler: AnyFn) => {
          const tier = tierOf(name)
          if (tier > maxTier) {
            log("INFO", `risk-tier gating: tool '${name}' (tier ${tier}) not exposed (ABAP_MCP_MAX_TIER=${maxTier})`)
            return undefined
          }
          return original(name, config, handler)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyFn).bind(target) : value
    },
  })
}
