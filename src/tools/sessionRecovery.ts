/**
 * Generic session-degradation recovery for tool handlers.
 *
 * The ADT stateful session degrades after heavy use on some systems: every
 * call starts returning HTTP 400 until a fresh login.  runSql() in
 * customizing.ts already recovers via forceReconnect(); this module applies
 * the same pattern to EVERY registered tool, at the registration layer, so
 * individual handlers stay untouched: on a session-type failure, force a
 * clean reconnect, wait briefly, and re-run the handler once (max 2 attempts
 * total).  Handlers obtain their client via ensureConnected() at the top, so
 * a re-run automatically picks up the fresh session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { forceReconnect, isSessionDegradedError, log, runInSession } from "../connections"

const RETRY_DELAY_MS = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type AnyToolHandler = (...handlerArgs: unknown[]) => unknown

/**
 * Wrap a tool handler so a session-degraded failure triggers one
 * forceReconnect + retry.  Non-session errors propagate unchanged, and if
 * the reconnect itself fails the ORIGINAL error is surfaced (it is the more
 * informative of the two).
 */
export function withSessionRecovery<H extends AnyToolHandler>(toolName: string, handler: H): H {
  const wrapped = async (...handlerArgs: unknown[]) => {
    try {
      return await handler(...handlerArgs)
    } catch (err) {
      if (!isSessionDegradedError(err)) throw err
      // MCP handlers receive (args, extra) — connectionId, when present,
      // is on the first argument.
      const first = handlerArgs[0] as { connectionId?: unknown } | undefined
      const connectionId = typeof first?.connectionId === "string" ? first.connectionId : undefined
      log("WARN", `${toolName} failed with a session-type error — forcing reconnect and retrying once`, err)
      try {
        await forceReconnect(connectionId)
      } catch (reconnectErr) {
        log("ERROR", `Reconnect during ${toolName} retry failed — surfacing original error`, reconnectErr)
        throw err
      }
      await sleep(RETRY_DELAY_MS)
      return handler(...handlerArgs)
    }
  }
  return wrapped as unknown as H
}

/**
 * Bind a tool handler to its MCP session: every ensureConnected() inside it then
 * uses that session's own ADT session (and locks). MCP handlers receive
 * (args, extra); extra.sessionId is the MCP session.
 */
export function withSessionScope<H extends AnyToolHandler>(handler: H): H {
  const wrapped = (...handlerArgs: unknown[]) => {
    const extra = handlerArgs[1] as { sessionId?: unknown } | undefined
    const sessionId = typeof extra?.sessionId === "string" ? extra.sessionId : undefined
    return runInSession(sessionId, () => handler(...handlerArgs))
  }
  return wrapped as unknown as H
}

export function wrapServerWithSessionScope(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyToolHandler).bind(target)
        return (name: string, config: unknown, handler: AnyToolHandler) =>
          original(name, config, withSessionScope(handler))
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyToolHandler).bind(target) : value
    }
  })
}

/**
 * Proxy an McpServer so every handler passed to registerTool() is wrapped
 * with withSessionRecovery().  All tool modules register exclusively through
 * registerTool, so wrapping here covers the entire tool surface.
 */
export function wrapServerWithSessionRecovery(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = (target.registerTool as AnyToolHandler).bind(target)
        return (name: string, config: unknown, handler: AnyToolHandler) =>
          original(name, config, withSessionRecovery(name, handler))
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? (value as AnyToolHandler).bind(target) : value
    }
  })
}
