/**
 * Server mode: "direct" (default) or "governed". See docs/specs/001-two-constellations.md.
 *
 *   direct    everything over ADT, as always.
 *   governed  no ADT call at all; only the tools that work through the engine's HTTP
 *             endpoint are registered, and the engine is never deployed from here.
 *
 * Read once at startup. This module imports nothing that talks to SAP (not connections.ts),
 * so the connection layer, the tool registration and the entry points can all use it.
 */
import { loadConfig, type ConnectionConfig } from "./config"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export type ServerMode = "direct" | "governed"

let _mode: ServerMode | undefined

/** The configured mode: ABAP_MCP_MODE, else "mode" in the server section of connections.json, else direct. */
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
  if (raw === undefined) return (_mode = "direct")
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw
  if (v === "direct" || v === "governed") return (_mode = v)
  throw new Error(
    `Reading the server mode stopped: ${source} is ${JSON.stringify(raw)}, and the only modes are "direct" and "governed". ` +
    `Set it to "direct" (everything over ADT) or "governed" (no ADT calls), or remove it to get the default, direct.`)
}

export const isGoverned = (): boolean => serverMode() === "governed"

/** For tests: forget the mode read at startup. */
export function resetServerModeForTests(): void { _mode = undefined }

// ─── ADT guard ───────────────────────────────────────────────────────────────

/** The refusal every ADT entry point gives in governed mode. */
export function adtRefusal(purpose: string, connectionId: string): string {
  return `Calling ADT for ${purpose} on ${connectionId} stopped: this server runs in governed mode, which makes no ADT calls. ` +
    `Use SAP's ADT MCP server for code work, or run this server with ABAP_MCP_MODE=direct.`
}

/** Throw the three-part refusal when the server runs in governed mode. */
export function assertAdtAllowed(purpose: string, connectionId: string): void {
  if (isGoverned()) throw new Error(adtRefusal(purpose, connectionId))
}

// ─── Engine installation ─────────────────────────────────────────────────────

export const GOVERNED_ENGINE_NOTE =
  "this server does not deploy the engine in governed mode. Install it with abapGit, or transport it from a system where it was deployed in direct mode"

/** What to do about a missing or outdated engine: the bootstrap tool in direct mode, the two routes in governed mode. */
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
    `run the stdio server as your own user, or run this server with ABAP_MCP_MODE=direct.`)
}

// ─── Tool set ────────────────────────────────────────────────────────────────

/** Phase 1 of the governed tool set: every one works through the engine's HTTP endpoint only. */
export const GOVERNED_TOOLS: ReadonlySet<string> = new Set([
  "connected_systems", "customizing_engine_ping", "customizing_status",
  "hana_memory_report", "abap_memory_report", "retail_listing", "customizing_selftest",
])

type AnyFn = (...args: unknown[]) => unknown

/**
 * Proxy an McpServer so registerTool() skips every tool outside the governed set. Same style as the
 * risk-tier gating; the names left out are collected in `skipped`.
 */
export function wrapServerWithModeGating(server: McpServer, skipped: string[]): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyFn).bind(target)
        return (name: string, config: unknown, handler: AnyFn) => {
          if (!GOVERNED_TOOLS.has(name)) { skipped.push(name); return undefined }
          return original(name, config, handler)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyFn).bind(target) : value
    },
  })
}
