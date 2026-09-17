#!/usr/bin/env node
import * as http from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "crypto"
import { getServerConfig } from "./config"
import { registerAllTools } from "./tools/index"
import { log, ensureConnected, listConnections, startKeepAlive, stopKeepAlive, closeSessionConnections } from "./connections"
import { ENGINE_VERSION } from "./abap/zcl_mcp_cust_engine"
import { version as SERVER_VERSION } from "../package.json"

// ─── Process-level safety net ──────────────────────────────────────────────
// Keep the server alive on unexpected errors rather than crashing silently.

process.on("uncaughtException", (err) => {
  log("ERROR", "Uncaught exception — server continuing", err)
})

process.on("unhandledRejection", (reason) => {
  log("ERROR", "Unhandled promise rejection — server continuing", reason)
})

// ─── Session management ────────────────────────────────────────────────────

const transports: Record<string, StreamableHTTPServerTransport> = {}

// ─── Auth ──────────────────────────────────────────────────────────────────

let _apiKeyWarned = false

function validateApiKey(req: http.IncomingMessage, apiKey: string): boolean {
  if (!apiKey) {
    if (!_apiKeyWarned) {
      log("WARN", "No API key configured — server is running without authentication")
      _apiKeyWarned = true
    }
    return true
  }

  const auth = req.headers["authorization"] ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth

  if (token.length !== apiKey.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ apiKey.charCodeAt(i)
  }
  return diff === 0
}

// ─── Body parsing ──────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8")
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) { reject(e) }
    })
    req.on("error", reject)
  })
}

// ─── Request logging ───────────────────────────────────────────────────────

function describeRequest(body: unknown): string {
  if (!body || typeof body !== "object") return "unknown"
  const b = body as Record<string, unknown>
  const method = b["method"]
  if (method === "tools/call") {
    const params = b["params"] as Record<string, unknown> | undefined
    return `tool:${params?.["name"] ?? "?"}`
  }
  return String(method ?? "unknown")
}

// ─── MCP server factory ────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "abap-config-mcp", version: SERVER_VERSION })
  registerAllTools(server)
  return server
}

// ─── HTTP server ───────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const cfg = getServerConfig()
  const port = cfg.port ?? 4847
  const apiKey = cfg.apiKey ?? ""

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (req.method === "OPTIONS") { res.writeHead(405); res.end(); return }

    // Health check — no auth
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", server: "abap-config-mcp", sessions: Object.keys(transports).length }))
      return
    }

    // All other routes require auth
    if (!validateApiKey(req, apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }))
      return
    }

    // Root info
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        name: "ABAP Config MCP Server",
        version: SERVER_VERSION,
        engineVersion: ENGINE_VERSION,
        mcp: `http://localhost:${port}/mcp`,
        health: `http://localhost:${port}/health`,
        sessions: Object.keys(transports).length
      }))
      return
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined

      if (req.method === "POST") {
        let body: unknown
        try { body = await readBody(req) } catch {
          res.writeHead(400); res.end(JSON.stringify({ error: "Bad JSON" })); return
        }

        const requestLabel = describeRequest(body)
        const t0 = Date.now()

        log("INFO", `→ ${requestLabel} (session: ${sessionId?.slice(0, 8) ?? "new"})`)

        let transport: StreamableHTTPServerTransport

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId]
        } else if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            // Return each tool response as a single JSON body on the POST itself,
            // instead of via a long-lived SSE stream that dies on idle.  Without
            // this, a stale SSE stream silently swallows the response and the
            // client hangs to its full 60 s timeout (the root cause of the
            // first-call-after-idle `-32001`).  Responses no longer depend on any
            // persistent stream, so idle never strands them.
            enableJsonResponse: true,
            onsessioninitialized: (sid: string) => {
              transports[sid] = transport
              log("INFO", `Session opened  ${sid.slice(0, 8)}… (active: ${Object.keys(transports).length})`)
            }
          })
          transport.onclose = () => {
            const sid = transport.sessionId
            if (sid) {
              delete transports[sid]
              log("INFO", `Session closed  ${sid.slice(0, 8)}… (active: ${Object.keys(transports).length})`)
              // Its SAP ADT sessions end with it, releasing its locks.
              closeSessionConnections(sid).catch(err => log("WARN", `Closing ADT sessions of ${sid.slice(0, 8)} failed`, err))
            }
          }
          const mcpServer = createMcpServer()
          await mcpServer.connect(transport)
          await transport.handleRequest(req, res, body)
          log("INFO", `← ${requestLabel} (${Date.now() - t0} ms)`)
          return
        } else {
          // Unknown/stale session id (server restarted, or session evicted).
          // Per the Streamable HTTP spec, respond 404 so the MCP client
          // transparently starts a fresh session with a new InitializeRequest,
          // instead of surfacing a hard 400 that needs a manual retry.
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found — reinitialize" }, id: null }))
          log("INFO", `↺ ${requestLabel} unknown session ${sessionId?.slice(0, 8)} → 404 (client will reinitialize)`)
          return
        }

        try {
          // Backstop watchdog.  With enableJsonResponse the stale-SSE hang is
          // gone, so this only guards against a genuinely stuck call (e.g. SAP
          // unresponsive).  Set above the 30 s SAP client timeout so slow-but-
          // valid ABAP ops are never killed, and below the MCP client's 60 s
          // timeout so we still fail fast.  We do NOT evict the session (a slow
          // call doesn't make the session stale).
          const WATCHDOG_MS =
            parseInt(process.env.ABAP_REQUEST_WATCHDOG_MS ?? "", 10) || 45_000
          let watchdogFired = false
          const watchdog = setTimeout(() => {
            if (res.writableEnded || res.headersSent) return
            watchdogFired = true
            log("WARN", `← ${requestLabel} watchdog (${WATCHDOG_MS / 1000}s) — request stuck, failing fast`)
            try {
              res.writeHead(504, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Request timed out server-side — retry" }, id: null }))
            } catch { /* already closed */ }
          }, WATCHDOG_MS)

          const abortOnDisconnect = new Promise<void>((resolve) => {
            req.on("close", () => {
              if (!res.writableEnded) {
                log("WARN", `← ${requestLabel} aborted — client disconnected (session: ${sessionId?.slice(0, 8)})`)
                try { res.end() } catch { /* */ }
              }
              resolve()
            })
          })
          try {
            await Promise.race([transport.handleRequest(req, res, body), abortOnDisconnect])
            if (!watchdogFired) log("INFO", `← ${requestLabel} (${Date.now() - t0} ms)`)
          } catch (e) {
            log("ERROR", `← ${requestLabel} failed after ${Date.now() - t0} ms`, e)
            if (!res.headersSent) { res.writeHead(500); res.end() }
          } finally {
            clearTimeout(watchdog)
          }
        } catch (e) {
          log("ERROR", `← ${requestLabel} outer error`, e)
          if (!res.headersSent) { res.writeHead(500); res.end() }
        }
        return
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !transports[sessionId]) {
          // 404 (not 400) so the client reinitializes cleanly.
          res.writeHead(404); res.end(JSON.stringify({ error: "Session not found" })); return
        }
        // NOTE: with enableJsonResponse, tool responses come back on their own
        // POST, NOT via this GET/SSE stream — so a closed GET stream no longer
        // strands responses.  We therefore do NOT evict the session when the SSE
        // stream closes (that only forced needless reinitializations); the
        // session stays valid across GET-stream cycles and idle gaps.
        await transports[sessionId].handleRequest(req, res)
        return
      }
    }

    res.writeHead(404); res.end(JSON.stringify({ error: "Not found" }))
  })

  const startOnPort = (p: number, retries = 10): Promise<number> =>
    new Promise((resolve, reject) => {
      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries > 0) resolve(startOnPort(p + 1, retries - 1))
        else reject(err)
      })
      httpServer.listen(p, "127.0.0.1", () => resolve(p))
    })

  const actualPort = await startOnPort(port)

  log("INFO", `ABAP Config MCP Server v${SERVER_VERSION} started`)
  const W = 70
  const row = (s: string) => `║${s.padEnd(W)}║`
  const div = `╠${"═".repeat(W)}╣`
  console.log(`\n╔${"═".repeat(W)}╗`)
  console.log(row(`                 ABAP Config MCP Server v${SERVER_VERSION}`))
  console.log(div)
  console.log(row(`  Server version    : ${SERVER_VERSION}`))
  console.log(row(`  Cust. engine ver. : ${ENGINE_VERSION}  (expected on SAP after deploy)`))
  console.log(div)
  console.log(row(`  MCP endpoint  : http://localhost:${actualPort}/mcp`))
  console.log(row(`  Health check  : http://localhost:${actualPort}/health`))
  console.log(div)
  console.log(row(`  Debug mode    : ABAP_MCP_DEBUG=1 npm start`))
  console.log(row(`  Session idle  : ABAP_SESSION_IDLE_MS=360000 npm start  (default 8m)`))
  console.log(div)
  console.log(row(`  Integration tests (read-only):`))
  console.log(row(`    SAP_TEST_CONNECTION=<id> npm run test:integration`))
  console.log(row(`  Integration tests (read + write, creates/deletes in $TMP):`))
  console.log(row(`    SAP_TEST_CONNECTION=<id> SAP_TEST_WRITE=1 npm run test:integration`))
  console.log(`╚${"═".repeat(W)}╝\n`)

  if (!apiKey) {
    log("WARN", "No apiKey configured — server is unauthenticated!")
  }

  // ── Warm-up login ─────────────────────────────────────────────────────────
  // The first ADT call pays the cost of establishing the SAP session, which can
  // exceed the MCP client's first-call timeout right after a redeploy.  Eagerly
  // log in to the default connection in the background so the session is already
  // alive by the time the first tool call arrives.  Fire-and-forget; failures
  // are logged but don't block server startup (SAP may be briefly unreachable).
  // Disable with ABAP_NO_WARMUP=1.
  if (!process.env.ABAP_NO_WARMUP) {
    const conns = listConnections()
    if (conns.length > 0) {
      const warmId = conns[0].id
      const tw = Date.now()
      log("INFO", `Warming up SAP session for ${warmId}…`)
      ensureConnected(warmId)
        .then(() => {
          log("INFO", `Warm-up login for ${warmId} ready (${Date.now() - tw} ms) — SAP session established`)
          startKeepAlive()
        })
        .catch(err => log("WARN", `Warm-up login for ${warmId} failed (will retry on first call)`, err))
    }
  }

  process.on("SIGINT", () => {
    log("INFO", "Shutting down…")
    stopKeepAlive()
    for (const t of Object.values(transports)) { try { t.close() } catch { /* */ } }
    httpServer.close(() => process.exit(0))
  })
}

start().catch(err => {
  log("ERROR", "Fatal startup error", err)
  process.exit(1)
})
