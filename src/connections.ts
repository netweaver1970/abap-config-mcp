import { AsyncLocalStorage } from "async_hooks"
import { ADTClient, createSSLConfig, session_types } from "abap-adt-api"
import { loadConfig, ConnectionConfig } from "./config"

// ─── Logging ───────────────────────────────────────────────────────────────
// Set ABAP_MCP_DEBUG=1 for verbose per-call logging (lock tracking, timings)

const DEBUG = !!process.env.ABAP_MCP_DEBUG

export function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string, data?: unknown): void {
  if (level === "DEBUG" && !DEBUG) return
  const ts = new Date().toISOString()
  const line = `[${ts}] [abap-mcp] [${level}] ${msg}`
  if (data !== undefined) {
    const detail = data instanceof Error ? data.message : JSON.stringify(data)
    if (level === "ERROR") console.error(line, detail)
    else console.log(line, detail)
  } else {
    if (level === "ERROR") console.error(line)
    else console.log(line)
  }
}

// ─── Session idle threshold ────────────────────────────────────────────────
// SAP ICM default session timeout is 600 s (10 min). We refresh at 8 min so
// we always beat the server-side expiry.  Override with ABAP_SESSION_IDLE_MS.

const SESSION_IDLE_MS =
  parseInt(process.env.ABAP_SESSION_IDLE_MS ?? "", 10) || 8 * 60_000   // 8 min

// Keep-alive fires at half the idle threshold so we always stay ahead of SAP's
// ICM session expiry.  Minimum 2 min so we don't hammer a slow system.
const KEEPALIVE_MS = Math.max(SESSION_IDLE_MS / 2, 2 * 60_000)

let _keepAliveTimer: ReturnType<typeof setInterval> | null = null

// ─── Session scope ──────────────────────────────────────────────────────────
// Every MCP session (one conversation) gets its own stateful ADT session per SAP
// connection. SAP enqueue locks belong to the ADT session that took them, so a
// shared session meant one conversation's force_relogin or reconnect released the
// locks of every other conversation. The MCP session id reaches this layer through
// AsyncLocalStorage (set around every tool handler in tools/index.ts), so tool
// handlers keep calling ensureConnected(connectionId) unchanged.

const sessionScope = new AsyncLocalStorage<{ sessionId: string }>()

/** Run fn with every ensureConnected() inside it bound to this MCP session. */
export function runInSession<T>(sessionId: string | undefined, fn: () => T): T {
  return sessionId ? sessionScope.run({ sessionId }, fn) : fn()
}

/** The MCP session the current call belongs to; "shared" outside any (startup, tests). */
export function currentSessionId(): string {
  return sessionScope.getStore()?.sessionId ?? SHARED_SESSION
}

const SHARED_SESSION = "shared"

// A session whose MCP client vanished without closing is closed after this long
// unused (its locks are released with it). Keep-alive pings do not count as use.
const SESSION_EVICT_MS =
  parseInt(process.env.ABAP_SESSION_EVICT_MS ?? "", 10) || 60 * 60_000   // 60 min

// ─── Connection state ──────────────────────────────────────────────────────

interface ManagedConnection {
  config: ConnectionConfig
  client: ADTClient
  sessionId: string
  loggedIn: boolean
  /** last SAP round-trip, keep-alive included (drives re-login before SAP's timeout) */
  lastActivityAt: number
  /** last use by a tool call (drives eviction) */
  lastUsedAt: number
  /** objectUrl → LOCK_HANDLE for locks this ADT session currently holds */
  locks: Map<string, string>
}

/** Keyed by connection id + MCP session id. */
const connections = new Map<string, ManagedConnection>()

const connKey = (id: string, sessionId: string) => `${id}\u0000${sessionId}`

function buildClient(cfg: ConnectionConfig): ADTClient {
  const isHttps = cfg.url.toLowerCase().startsWith("https:")
  const sslOptions = isHttps ? createSSLConfig(cfg.allowSelfSigned ?? false, cfg.ca) : {}
  // Default 30 s timeout — prevents the server hanging on an unresponsive SAP system
  const timeout = cfg.timeout ?? 30_000
  return new ADTClient(
    cfg.url,
    cfg.username,
    cfg.password,
    cfg.client ?? "",
    cfg.language ?? "EN",
    { ...sslOptions, timeout }
  )
}

export function resolveConnectionId(connectionId?: string): string {
  return connectionId ?? loadConfig().connections[0].id
}

async function doLogin(managed: ManagedConnection): Promise<void> {
  log("INFO", `Connecting to ${managed.config.id} (${managed.config.url}) as ${managed.config.username}`)
  await managed.client.login()
  managed.client.stateful = session_types.stateful
  managed.loggedIn = true
  managed.lastActivityAt = Date.now()
  // All lock handles from a prior session are dead after re-login
  if (managed.locks.size > 0) {
    log("WARN", `Session re-established for ${managed.config.id} — ${managed.locks.size} stale lock handle(s) cleared`)
    managed.locks.clear()
  }
  log("INFO", `Connected to ${managed.config.id}`)
  // Ensure keep-alive is running after every successful login, including
  // re-logins triggered by session expiry (warm-up may have failed at startup).
  startKeepAlive()
}

async function getManagedConnection(connectionId?: string): Promise<ManagedConnection> {
  const id = resolveConnectionId(connectionId)
  const sessionId = currentSessionId()
  const config = loadConfig()

  let managed = connections.get(connKey(id, sessionId))
  if (!managed) {
    const cfg = config.connections.find(c => c.id === id)
    if (!cfg) {
      throw new Error(`Unknown connection: ${id}. Available: ${config.connections.map(c => c.id).join(", ")}`)
    }
    managed = { config: cfg, client: buildClient(cfg), sessionId, loggedIn: false, lastActivityAt: 0, lastUsedAt: Date.now(), locks: new Map() }
    connections.set(connKey(id, sessionId), managed)
    log("DEBUG", `New ADT session for ${id} / MCP session ${sessionId.slice(0, 8)}`)
  }
  managed.lastUsedAt = Date.now()

  // Proactively re-login before the SAP session times out
  if (managed.loggedIn && Date.now() - managed.lastActivityAt > SESSION_IDLE_MS) {
    log("INFO", `Session for ${managed.config.id} idle for ${Math.round((Date.now() - managed.lastActivityAt) / 60_000)} min — refreshing`)
    managed.loggedIn = false
  }

  if (!managed.loggedIn) {
    await doLogin(managed)
  }

  managed.lastActivityAt = Date.now()
  return managed
}

export async function getClient(connectionId?: string): Promise<ADTClient> {
  return (await getManagedConnection(connectionId)).client
}

export async function ensureConnected(connectionId?: string): Promise<ADTClient> {
  return getClient(connectionId)
}

/**
 * Force a fresh stateful session: drop the current one server-side and re-login.
 * The ADT Data Preview (freestyle SQL) endpoint on some systems starts returning
 * HTTP 400 for all queries once the session has been driven hard for a while;
 * a clean reconnect clears that degraded state (same effect as restarting the
 * server, without the downtime).  Returns the re-logged-in client.
 */
export async function forceReconnect(connectionId?: string): Promise<ADTClient> {
  const managed = await getManagedConnection(connectionId)
  try {
    await managed.client.dropSession()
  } catch (err) {
    log("DEBUG", `dropSession during forceReconnect failed (continuing to re-login)`, err)
  }
  managed.loggedIn = false
  log("WARN", `Forcing reconnect for ${managed.config.id} (recovering degraded ADT session)`)
  return getClient(connectionId)
}

export function listConnections(): ConnectionConfig[] {
  return loadConfig().connections
}

/**
 * Resolve the static connection config (url/user/password/client/SSL) for a
 * connection id, WITHOUT logging in or touching the shared ADT session.  Used by
 * callers that talk to SAP over their own isolated HTTP client (e.g. the
 * Customizing Engine's SICF endpoint) so an ICF round-trip can't clobber the
 * stateful ADT session's security cookie/CSRF state (the old HTTP-400 cause).
 */
export function getConnectionConfig(connectionId?: string): ConnectionConfig {
  const id = resolveConnectionId(connectionId)
  const cfg = loadConfig().connections.find(c => c.id === id)
  if (!cfg) {
    throw new Error(`Unknown connection: ${id}. Available: ${loadConfig().connections.map(c => c.id).join(", ")}`)
  }
  return cfg
}

/**
 * Start a periodic keep-alive that pings each connected SAP system to prevent
 * SAP's ICM from expiring the session between tool calls.  The ping reuses the
 * existing stateful session (no new login unless the session was already dead).
 * Call once after the initial warm-up login; safe to call multiple times.
 */
export function startKeepAlive(): void {
  if (_keepAliveTimer) return
  _keepAliveTimer = setInterval(async () => {
    await evictIdleSessions()
    for (const managed of connections.values()) {
      const id = `${managed.config.id}/${managed.sessionId.slice(0, 8)}`
      if (!managed.loggedIn) continue
      try {
        // Hit the same lightweight ADT endpoint login() uses.  In stateful
        // mode the session lock token is included, so this refreshes the
        // ICM session without creating a new SAP session.
        const http = (managed.client as unknown as { httpClient: { request: Function } }).httpClient
        await http.request("/sap/bc/adt/compatibility/graph", { method: "GET" })
        managed.lastActivityAt = Date.now()
        log("DEBUG", `Keep-alive ping ok for ${id}`)
      } catch (err) {
        log("WARN", `Keep-alive ping failed for ${id} — will re-login on next call`, err)
        managed.loggedIn = false
      }
    }
  }, KEEPALIVE_MS)
  // Don't prevent clean process exit if only this timer is running
  _keepAliveTimer.unref()
  log("INFO", `Keep-alive started (interval: ${Math.round(KEEPALIVE_MS / 60_000)} min)`)
}

async function closeManaged(key: string, managed: ManagedConnection, reason: string): Promise<void> {
  connections.delete(key)
  const held = managed.locks.size
  if (!managed.loggedIn) return
  try {
    await managed.client.dropSession()
  } catch (err) {
    log("DEBUG", `dropSession while closing ${managed.config.id}/${managed.sessionId.slice(0, 8)} failed`, err)
  }
  log("INFO", `ADT session closed for ${managed.config.id} / MCP session ${managed.sessionId.slice(0, 8)} (${reason})` +
    (held ? ` — ${held} lock(s) released` : ""))
}

/** Close every ADT session of one MCP session (call when the MCP session ends). Releases its locks. */
export async function closeSessionConnections(sessionId: string): Promise<void> {
  const mine = [...connections.entries()].filter(([, m]) => m.sessionId === sessionId)
  await Promise.all(mine.map(([k, m]) => closeManaged(k, m, "MCP session ended")))
}

/** Close ADT sessions no tool call has used for ABAP_SESSION_EVICT_MS. */
export async function evictIdleSessions(now = Date.now()): Promise<void> {
  const idle = [...connections.entries()].filter(([, m]) => now - m.lastUsedAt > SESSION_EVICT_MS)
  await Promise.all(idle.map(([k, m]) => closeManaged(k, m, `unused for ${Math.round((now - m.lastUsedAt) / 60_000)} min`)))
}

/** Open ADT sessions, for diagnostics. */
export function listSessions(): Array<{ connectionId: string; sessionId: string; loggedIn: boolean; locks: number; idleMs: number }> {
  const now = Date.now()
  return [...connections.values()].map(m => ({
    connectionId: m.config.id, sessionId: m.sessionId, loggedIn: m.loggedIn, locks: m.locks.size, idleMs: now - m.lastUsedAt,
  }))
}

export function stopKeepAlive(): void {
  if (_keepAliveTimer) {
    clearInterval(_keepAliveTimer)
    _keepAliveTimer = null
  }
}

/**
 * Drop the current stateful session, releasing any enqueue locks it holds
 * server-side, then re-enable stateful mode.  ADT object creation registers
 * an implicit edit-lock for the author that has no handle we can reuse;
 * dropping the session releases it so a subsequent lock/write starts clean.
 * Unlike logout(), dropSession() keeps the client usable.
 */
export async function dropSessionLocks(connectionId?: string): Promise<void> {
  const managed = await getManagedConnection(connectionId)
  try {
    await managed.client.dropSession()
    if (managed.locks.size > 0) {
      log("DEBUG", `Dropped session for ${managed.config.id} — ${managed.locks.size} lock(s) released`)
    }
    managed.locks.clear()
  } finally {
    // Restore stateful mode for subsequent lock/write operations
    managed.client.stateful = session_types.stateful
  }
}

// ─── Lock registry ─────────────────────────────────────────────────────────
// Tracks which objects this server session currently holds ADT enqueue locks
// on, keyed by objectUrl.  Lock handles are valid only within the same
// stateful HTTP session — they are cleared automatically on re-login.
//
// URLs are normalised (lowercase, no trailing slash, strip /source/main suffix)
// so that write_abap_object_source and abap_activate always resolve to the
// same key regardless of which URL variant the caller passes.

function normUrl(url: string): string {
  return url.toLowerCase().replace(/\/source\/main$/, "").replace(/\/$/, "")
}

export function getHeldLock(connectionId: string | undefined, objectUrl: string): string | undefined {
  const id = resolveConnectionId(connectionId)
  return connections.get(connKey(id, currentSessionId()))?.locks.get(normUrl(objectUrl))
}

export function trackLock(connectionId: string | undefined, objectUrl: string, handle: string): void {
  const id = resolveConnectionId(connectionId)
  const managed = connections.get(connKey(id, currentSessionId()))
  if (managed) {
    managed.locks.set(normUrl(objectUrl), handle)
    log("DEBUG", `Lock tracked   ${objectUrl.split("/").pop() ?? objectUrl} → ${handle.slice(0, 8)}…`)
  }
}

export function forgetLock(connectionId: string | undefined, objectUrl: string): void {
  const id = resolveConnectionId(connectionId)
  const managed = connections.get(connKey(id, currentSessionId()))
  const key = normUrl(objectUrl)
  if (managed?.locks.has(key)) {
    managed.locks.delete(key)
    log("DEBUG", `Lock forgotten ${objectUrl.split("/").pop() ?? objectUrl}`)
  }
}

// ─── Error classification helpers (exported for tools) ────────────────────

/**
 * True when an error looks like the degraded-stateful-session failure mode:
 * after heavy use, some systems start answering HTTP 400 (or CSRF/auth
 * failures) for every ADT call until a fresh login.  Used by the generic
 * tool-level retry (see tools/sessionRecovery.ts) to decide whether a
 * forceReconnect + retry is worth attempting.  Business/validation errors
 * (editing conflicts, lock errors, plain Errors without an HTTP status)
 * must NOT match — retrying those would just drop session locks for nothing.
 */
/**
 * True for errors that are about the request itself — an SQL statement ADT's data
 * preview could not parse, a table or column that does not exist. ADT answers
 * these with HTTP 400 too, which used to be read as a degraded session: the
 * server then forced a reconnect, and a reconnect drops the stateful session and
 * every object lock it holds. A typo in a query must never release a lock.
 */
export function isRequestError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? "")
  return /unknown column|is invalid here|is expected|not allowed|literals? across|syntax|cannot find|does not exist|unknown table|not supported|only select|must start with select|invalid (table|field|name)/i.test(msg)
}

export function isSessionDegradedError(err: unknown): boolean {
  if (isEditingError(err) || isInvalidLockError(err) || isRequestError(err)) return false
  const e = err as {
    err?: unknown
    status?: unknown
    response?: { status?: unknown }
    message?: unknown
  }
  // AdtErrorException carries the HTTP status in .err, AdtHttpException in
  // .status, raw transport errors in .response.status — check all three.
  const status =
    typeof e?.err === "number" ? e.err :
    typeof e?.status === "number" ? e.status :
    typeof e?.response?.status === "number" ? e.response.status : undefined
  if (status === 400 || status === 401 || status === 403) return true
  const msg = String(e?.message ?? "").toLowerCase()
  return (
    msg.includes("csrf") ||
    msg.includes("session timed out") ||
    msg.includes("session expired") ||
    msg.includes("not authenticated")
  )
}

export function isInvalidLockError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? "").toLowerCase()
  return (
    msg.includes("not locked") ||
    msg.includes("invalid lock handle") ||
    msg.includes("lock expired")
  )
}

export function isEditingError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? "").toLowerCase()
  return msg.includes("currently editing") || msg.includes("being edited")
}

/** Appends SM12 cleanup instructions to "currently editing" error messages. */
export function editingConflictHint(err: unknown, objectName?: string): string {
  const msg = String((err as { message?: string })?.message ?? String(err))
  const obj = objectName ?? "the object"
  return (
    `${msg}\n\n` +
    `This is usually a lock held by another conversation (each has its own SAP session and locks) or left by one that ended.\n` +
    `To release it:\n` +
    `  1. Open SM12 in SAP GUI\n` +
    `  2. Find and delete the TRDIR / ${obj} entry\n` +
    `  3. Retry this operation\n` +
    `Or wait ~10 minutes for the SAP session to expire automatically.`
  )
}
