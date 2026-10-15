#!/usr/bin/env node
/**
 * stdio entry point — the same 58 tools as the HTTP server, spoken over
 * stdin/stdout so an MCP client can launch it as a child process. This is what
 * the Claude Code plugin and the Claude Desktop extension (.mcpb) run: no
 * daemon, no port, no shared secret.
 */
import "./stdioGuard"
import { randomUUID } from "crypto"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config"
import { createMcpServer } from "./server"
import { log, ensureConnected, listConnections, startKeepAlive, stopKeepAlive, closeSessionConnections } from "./connections"
import { ENGINE_VERSION } from "./abap/zcl_mcp_cust_engine"
import { version as SERVER_VERSION } from "../package.json"

process.on("uncaughtException", (err) => {
  log("ERROR", "Uncaught exception — server continuing", err)
})

process.on("unhandledRejection", (reason) => {
  log("ERROR", "Unhandled promise rejection — server continuing", reason)
})

async function start(): Promise<void> {
  loadConfig()   // fail fast (exit 1 with a message on stderr) before the client handshakes

  const transport = new StdioServerTransport()
  // One process = one client. Give it its own MCP session id so its ADT
  // session, locks and remembered transports are scoped exactly like an HTTP
  // session (instead of falling into the shared "session:default" bucket).
  const sessionId = randomUUID()
  ;(transport as { sessionId?: string }).sessionId = sessionId   // Transport.sessionId is optional; stdio leaves it unset

  await createMcpServer().connect(transport)
  log("INFO", `ABAP Config MCP Server v${SERVER_VERSION} started (stdio, engine ${ENGINE_VERSION})`)

  // Same warm-up as the HTTP server: log in to the default connection in the
  // background so the first tool call doesn't pay for it. ABAP_NO_WARMUP=1 skips it.
  if (!process.env.ABAP_NO_WARMUP) {
    const conns = listConnections()
    if (conns.length > 0) {
      const warmId = conns[0].id
      const tw = Date.now()
      ensureConnected(warmId)
        .then(() => {
          log("INFO", `Warm-up login for ${warmId} ready (${Date.now() - tw} ms)`)
          startKeepAlive()
        })
        .catch(err => log("WARN", `Warm-up login for ${warmId} failed (will retry on first call)`, err))
    }
  }

  let stopping = false
  const shutdown = (why: string) => {
    if (stopping) return
    stopping = true
    log("INFO", `Shutting down (${why})…`)
    stopKeepAlive()
    // Ending the ADT sessions releases any locks this client still holds.
    closeSessionConnections(sessionId)
      .catch(err => log("WARN", "Closing ADT sessions failed", err))
      .finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.stdin.on("end", () => shutdown("client closed stdin"))
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

start().catch(err => {
  log("ERROR", "Fatal startup error", err)
  process.exit(1)
})
