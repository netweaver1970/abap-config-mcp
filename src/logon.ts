/**
 * Per-user SAP logon. A connection set to "logon": "per-user" has no SAP user of its own:
 * each MCP client sends its SAP user and password as HTTP headers on its requests, and
 * every call of that MCP session logs on as that user.
 *
 *   X-SAP-User, X-SAP-Password            every per-user connection
 *   X-SAP-User-<ID>, X-SAP-Password-<ID>  one connection (wins); <ID> is the connection id
 *                                         upper-cased, every non [A-Z0-9] character turned into "_"
 *
 * The credentials live in memory only, keyed by MCP session id. Nothing here logs, writes
 * or returns a password, and no error message carries one.
 *
 * This module also owns the session scope (which MCP session the running call belongs to),
 * so that code which must not import connections.ts can still ask for it.
 */
import { AsyncLocalStorage } from "async_hooks"
import { createHash } from "crypto"
import type { ConnectionConfig } from "./config"

// ─── Session scope ──────────────────────────────────────────────────────────

export const SHARED_SESSION = "shared"

const sessionScope = new AsyncLocalStorage<{ sessionId: string }>()

/** Run fn with every connection lookup inside it bound to this MCP session. */
export function runInSession<T>(sessionId: string | undefined, fn: () => T): T {
  return sessionId ? sessionScope.run({ sessionId }, fn) : fn()
}

/** The MCP session the current call belongs to; "shared" outside any (startup, tests). */
export function currentSessionId(): string {
  return sessionScope.getStore()?.sessionId ?? SHARED_SESSION
}

// ─── Credentials ────────────────────────────────────────────────────────────

export interface SapCredentials { username: string; password: string }

interface SessionCredentials {
  generic: Partial<SapCredentials>
  /** keyed by normalised connection id */
  byConnection: Map<string, Partial<SapCredentials>>
}

const sessions = new Map<string, SessionCredentials>()

export function isPerUser(cfg: Pick<ConnectionConfig, "logon">): boolean {
  return cfg.logon === "per-user"
}

/** The header suffix of a connection id: upper-cased, every non [A-Z0-9] character turned into "_". */
export function headerId(connectionId: string): string {
  return connectionId.toUpperCase().replace(/[^A-Z0-9]/g, "_")
}

function headerValue(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  return s === undefined || s === "" ? undefined : s
}

export interface ParsedHeaders { generic: Partial<SapCredentials>; byConnection: Map<string, Partial<SapCredentials>> }

/** Pick the SAP logon headers out of a request's headers (names are matched case-insensitively). */
export function parseLogonHeaders(headers: Record<string, string | string[] | undefined>): ParsedHeaders {
  const out: ParsedHeaders = { generic: {}, byConnection: new Map() }
  for (const [rawName, raw] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    const value = headerValue(raw)
    if (value === undefined) continue
    let field: "username" | "password" | undefined
    let id: string | undefined
    if (name === "x-sap-user") field = "username"
    else if (name === "x-sap-password") field = "password"
    else if (name.startsWith("x-sap-user-")) { field = "username"; id = name.slice("x-sap-user-".length) }
    else if (name.startsWith("x-sap-password-")) { field = "password"; id = name.slice("x-sap-password-".length) }
    if (!field) continue
    const v = field === "username" ? value.trim() : value   // a password is taken as sent
    if (!v) continue
    if (id === undefined) out.generic[field] = v
    else {
      const key = headerId(id)
      out.byConnection.set(key, { ...out.byConnection.get(key), [field]: v })
    }
  }
  return out
}

/**
 * Remember the credentials a request carries for its MCP session. A request without
 * logon headers changes nothing; one with them overrides the matching earlier values.
 * Returns true when the request carried any.
 */
export function captureCredentials(sessionId: string, headers: Record<string, string | string[] | undefined>): boolean {
  const parsed = parseLogonHeaders(headers)
  if (!parsed.generic.username && !parsed.generic.password && parsed.byConnection.size === 0) return false
  const cur = sessions.get(sessionId) ?? { generic: {}, byConnection: new Map() }
  cur.generic = { ...cur.generic, ...parsed.generic }
  for (const [k, v] of parsed.byConnection) cur.byConnection.set(k, { ...cur.byConnection.get(k), ...v })
  sessions.set(sessionId, cur)
  return true
}

export function clearSessionCredentials(sessionId: string): void {
  sessions.delete(sessionId)
}

/** The complete user + password this session has for a connection, if any. Per-connection headers win. */
export function credentialsFor(sessionId: string, connectionId: string): SapCredentials | undefined {
  const s = sessions.get(sessionId)
  if (!s) return undefined
  const specific = s.byConnection.get(headerId(connectionId)) ?? {}
  // A connection-specific user comes with its own password: never pair it with the generic one.
  if (specific.username || specific.password) {
    return specific.username && specific.password ? { username: specific.username, password: specific.password } : undefined
  }
  return s.generic.username && s.generic.password ? { username: s.generic.username, password: s.generic.password } : undefined
}

/** True when any session holds credentials (diagnostics, tests). */
export function sessionsWithCredentials(): string[] {
  return [...sessions.keys()]
}

/** The three-part failure for a per-user connection this session has no complete logon for. */
export function missingCredentialsMessage(connectionId: string): string {
  const id = headerId(connectionId)
  return `Logging on to ${connectionId} stopped: ${connectionId} is set to per-user logon and this client sent no SAP user (or no password). ` +
    `Add the headers X-SAP-User and X-SAP-Password to this server's entry in your MCP client configuration, ` +
    `for example "headers": { "X-SAP-User": "<your SAP user>", "X-SAP-Password": "<your SAP password>" } ` +
    `(X-SAP-User-${id} and X-SAP-Password-${id} apply to ${connectionId} only).`
}

/** The config a call logs on with: a per-user connection gets this session's user and password; a shared one is returned as is. */
export function effectiveConfig(cfg: ConnectionConfig, sessionId: string): ConnectionConfig {
  if (!isPerUser(cfg)) return cfg
  const creds = credentialsFor(sessionId, cfg.id)
  if (!creds) throw new Error(missingCredentialsMessage(cfg.id))
  return { ...cfg, username: creds.username, password: creds.password }
}

/** What connected_systems shows for the user of a connection. Never the password. */
export function logonLabel(cfg: ConnectionConfig, sessionId: string): string {
  if (!isPerUser(cfg)) return `user: ${cfg.username}`
  const creds = credentialsFor(sessionId, cfg.id)
  return creds ? `user: ${creds.username} (per-user)` : "per-user logon: this client sent no SAP user"
}

/** A short fingerprint of a password, to tell two passwords apart in a map key without holding the password there. */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12)
}
