/**
 * Parameter guard: common aliases, and errors a caller can act on.
 *
 * Tools grew different names for the same thing (name / objectName / table,
 * url / objectUrl, sql / query …), and a wrong name produced the SDK's raw zod
 * dump ("expected string, received undefined" at path ["name"]), while an
 * unknown name was silently dropped. This hooks the SDK's argument validation
 * (McpServer.validateToolInput) so that, for every tool and without changing the
 * schemas clients see:
 *   • a known alias is taken as the tool's own parameter name;
 *   • an unknown parameter is refused, naming the parameters the tool accepts;
 *   • a missing or mistyped parameter is reported in one plain sentence each,
 *     with the tool's parameter list.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"

/** canonical parameter → names callers use for it. Applied only when the tool has the canonical name and not the alias. */
export const PARAM_ALIASES: Record<string, string[]> = {
  name: ["objectName", "object_name"],
  objectName: ["name", "table", "tableName", "object"],
  table: ["tableName", "objectName"],
  tableName: ["table", "objectName"],
  url: ["objectUrl", "uri", "object_url"],
  objectUrl: ["url", "uri"],
  classUrl: ["url", "objectUrl"],
  sql: ["query", "statement"],
  keyword: ["query", "pattern", "searchTerm", "search"],
  query: ["keyword", "pattern", "searchTerm", "search"],
  pattern: ["query", "regex", "searchTerm"],
  packageName: ["package", "devclass", "devClass"],
  lockHandle: ["handle", "lock_handle"],
  transport: ["transportNumber", "trkorr", "corrNr", "request"],
  transportNumber: ["transport", "trkorr", "request"],
  objectType: ["type"],
  connectionId: ["connection", "system", "systemId"],
}

type Shape = Record<string, { isOptional(): boolean; description?: string } & Record<string, any>>

function shapeOf(schema: unknown): Shape | undefined {
  const s = schema as { shape?: Shape } | undefined
  return s && typeof s.shape === "object" ? s.shape : undefined
}

function typeName(field: any): string {
  let f = field
  for (let i = 0; i < 4 && f; i++) {
    const t = f?._zod?.def?.type ?? f?._def?.typeName
    if (t === "optional" || t === "default" || t === "nullable" || t === "ZodOptional" || t === "ZodDefault") {
      f = f?._zod?.def?.innerType ?? f?._def?.innerType
      continue
    }
    if (t === "enum" || t === "ZodEnum") {
      const values = f?._zod?.def?.entries ? Object.values(f._zod.def.entries) : f?._def?.values
      return values ? `one of ${(values as unknown[]).map(v => JSON.stringify(v)).join(", ")}` : "enum"
    }
    return String(t ?? "value").replace(/^Zod/, "").toLowerCase()
  }
  return "value"
}

export function describeParams(shape: Shape): string {
  return Object.entries(shape)
    .map(([k, f]) => `  • ${k}${f.isOptional() ? "" : " (required)"} — ${typeName(f)}`)
    .join("\n")
}

/** Move alias values onto the tool's own parameter names. */
export function resolveAliases(shapeKeys: string[], args: Record<string, unknown>): { args: Record<string, unknown>; renamed: Array<[string, string]> } {
  const out = { ...args }
  const renamed: Array<[string, string]> = []
  const keys = new Set(shapeKeys)
  for (const canonical of shapeKeys) {
    if (out[canonical] !== undefined) continue
    for (const alias of PARAM_ALIASES[canonical] ?? []) {
      if (keys.has(alias) || out[alias] === undefined) continue
      out[canonical] = out[alias]
      delete out[alias]
      renamed.push([alias, canonical])
      break
    }
  }
  return { args: out, renamed }
}

function suggest(unknown: string, shapeKeys: string[]): string | undefined {
  const lower = unknown.toLowerCase()
  return shapeKeys.find(k => k.toLowerCase() === lower)
    ?? shapeKeys.find(k => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))
}

export function checkArgs(toolName: string, schema: any, rawArgs: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const shape = shapeOf(schema)
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>
  if (!shape) return { ok: true, args }
  const keys = Object.keys(shape)
  const { args: resolved } = resolveAliases(keys, args)

  const problems: string[] = []
  for (const k of Object.keys(resolved)) {
    if (!(k in shape)) {
      const s = suggest(k, keys)
      problems.push(`Unknown parameter "${k}"${s ? ` — did you mean "${s}"?` : ""}`)
    }
  }
  if (!problems.length) {
    const parsed = schema.safeParse(resolved)
    if (parsed.success) return { ok: true, args: parsed.data }
    for (const issue of parsed.error.issues ?? []) {
      const path = (issue.path ?? []).join(".")
      const top = String(issue.path?.[0] ?? "")
      if (top && resolved[top] === undefined && shape[top]) {
        problems.push(`Missing required parameter "${top}" (${typeName(shape[top])})`)
      } else {
        problems.push(`Parameter "${path || "(arguments)"}": ${issue.message}`)
      }
    }
  }
  return {
    ok: false,
    message: `❌ ${toolName} was not run — ${problems.length} problem(s) with its parameters:\n` +
      problems.map(p => `  • ${p}`).join("\n") + `\n\nParameters of ${toolName}:\n${describeParams(shape)}`,
  }
}

/** Hook the SDK's argument validation for every tool on this server. */
export function installParamGuard(server: McpServer): void {
  const s = server as unknown as { validateToolInput?: (tool: any, args: unknown, name: string) => Promise<unknown> }
  const original = s.validateToolInput?.bind(server)
  if (!original) return
  s.validateToolInput = async (tool: any, args: unknown, toolName: string) => {
    if (!tool?.inputSchema || !shapeOf(tool.inputSchema)) return original(tool, args, toolName)
    const r = checkArgs(toolName, tool.inputSchema, args)
    if (!r.ok) throw new McpError(ErrorCode.InvalidParams, r.message)
    return r.args
  }
}
