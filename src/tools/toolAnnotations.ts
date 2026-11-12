/**
 * MCP tool annotations: what each tool does to the SAP system, as hints for the
 * client (MCP spec, ToolAnnotations). Clients use them to decide what to confirm
 * with the user; directories such as Glama read them when rating a tool.
 *
 *   readOnlyHint     the tool changes nothing in SAP
 *   destructiveHint  a write may overwrite or remove something (false = additive only)
 *   idempotentHint   calling again with the same arguments changes nothing further
 *   openWorldHint    the tool talks to a system outside the server (always: SAP)
 *
 * Classified by hand, per tool, from what the handler does, not from the risk
 * tier: a few tier-0 tools are not read-only (force_relogin drops the session
 * and its locks), and every tool with autoDeploy can install the engine class.
 * A tool missing here gets the most cautious hints (not read-only, destructive).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export interface ToolHints {
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

const READ: ToolHints = { readOnlyHint: true, idempotentHint: true }
const ADDITIVE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
const ADDITIVE_IDEMPOTENT: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
const OVERWRITES: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
const OVERWRITES_IDEMPOTENT: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true }

export const TOOL_HINTS: Record<string, ToolHints> = {
  // Discovery and reading: no change in SAP.
  connected_systems: READ, adt_discovery: READ,
  search_abap_objects: READ, get_abap_object_info: READ, browse_package: READ,
  get_abap_object_lines: READ, search_abap_object_lines: READ, get_abap_batch_lines: READ,
  syntax_check: READ,                 // checks the source it is given; saves nothing
  run_atc_analysis: READ,             // stores an ATC result list in SAP; no object changes
  where_used: READ, version_history: READ, analyze_dump: READ, check_inactive_objects: READ,
  get_text_elements: READ,
  list_all_transports: READ, get_transport_for_object: READ,
  execute_data_query: READ, read_table_contents: READ,
  describe_database_table: READ, search_database_tables: READ,
  customizing_read: READ, customizing_describe: READ, customizing_diff: READ,
  customizing_plan_change: READ,      // dry run only
  img_search: READ, customizing_engine_ping: READ, customizing_status: READ,
  hana_memory_report: READ, abap_memory_report: READ,
  abap_debug_stack: READ, abap_debug_variable: READ,

  // Session: ends this conversation's SAP session and releases its locks.
  force_relogin: OVERWRITES_IDEMPOTENT,

  // Repository writes.
  create_abap_object: ADDITIVE, create_package: ADDITIVE, create_test_include: ADDITIVE,
  write_abap_object_source: OVERWRITES_IDEMPOTENT,
  set_text_elements: OVERWRITES_IDEMPOTENT,    // remove/replace can drop texts
  delete_abap_object: OVERWRITES,
  abap_activate: ADDITIVE_IDEMPOTENT, abap_activate_multiple: ADDITIVE_IDEMPOTENT,
  lock_abap_object: ADDITIVE,
  unlock_abap_object: OVERWRITES_IDEMPOTENT,   // discards unsaved changes

  // Running code: the code decides what happens.
  run_unit_tests: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  abap_run_class: OVERWRITES,                  // a class can post documents and commit

  // Transports.
  manage_transport_requests: OVERWRITES,       // release and delete are irreversible
  transport_move: ADDITIVE,                    // entries change request, nothing is removed from SAP

  // Customizing and configuration writes (dry run by default; commit writes).
  customizing_apply: OVERWRITES,               // action delete removes entries
  customizing_create: OVERWRITES_IDEMPOTENT,   // onlyMissing:false updates existing rows
  org_copy: OVERWRITES,                        // action delete removes an org unit's entries
  retail_listing: ADDITIVE_IDEMPOTENT,

  // The in-system engine.
  customizing_selftest: ADDITIVE_IDEMPOTENT,   // may install or update the engine class
  customizing_engine_bootstrap: ADDITIVE_IDEMPOTENT,
  engine_deploy: ADDITIVE_IDEMPOTENT,
  customizing_engine_cleanup: OVERWRITES_IDEMPOTENT,

  // Debugging: controls a running program.
  abap_debug_session: ADDITIVE,
  abap_debug_set_breakpoint: ADDITIVE, abap_debug_delete_breakpoint: ADDITIVE_IDEMPOTENT,
  abap_debug_step: OVERWRITES,                 // terminateDebuggee ends the program
  abap_debug_set_variable: OVERWRITES_IDEMPOTENT,
}

const UNKNOWN: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false }

export function hintsFor(name: string): ToolHints & { openWorldHint: true } {
  return { ...(TOOL_HINTS[name] ?? UNKNOWN), openWorldHint: true }
}

type AnyFn = (...args: unknown[]) => unknown

/**
 * Proxy an McpServer so every registerTool() call carries its annotations.
 * Annotations a tool sets itself are kept and win over the table.
 */
export function wrapServerWithAnnotations(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyFn).bind(target)
        return (name: string, config: Record<string, unknown>, handler: AnyFn) => {
          const own = (config?.annotations ?? {}) as Record<string, unknown>
          const title = typeof config?.title === "string" ? { title: config.title } : {}
          return original(name, { ...config, annotations: { ...title, ...hintsFor(name), ...own } }, handler)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyFn).bind(target) : value
    },
  })
}
