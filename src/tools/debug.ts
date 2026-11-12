import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { randomUUID } from "crypto"
import { ensureConnected } from "../connections"
import { DebugBreakpoint } from "abap-adt-api"

// Per-connection debug session state
export const debugSessions = new Map<string, {
  terminalId: string
  ideId: string
  user: string
}>()

export async function handleAbapDebugSession(args: {
  action: "listen" | "detach" | "status"
  username?: string
  connectionId?: string
}) {
  const connId = args.connectionId ?? "default"
  const client = await ensureConnected(args.connectionId)

  if (args.action === "status") {
    const session = debugSessions.get(connId)
    return {
      content: [{
        type: "text" as const,
        text: session
          ? `Active debug session:\n  Terminal ID: ${session.terminalId}\n  IDE ID: ${session.ideId}\n  User: ${session.user}`
          : "No active debug session."
      }]
    }
  }

  if (args.action === "detach") {
    const session = debugSessions.get(connId)
    if (!session) return { content: [{ type: "text" as const, text: "No active debug session." }] }
    try {
      await client.debuggerDeleteListener("user", session.terminalId, session.ideId, session.user)
    } catch { /* ignore */ }
    debugSessions.delete(connId)
    return { content: [{ type: "text" as const, text: "🔌 Debug session detached." }] }
  }

  // listen
  const user = args.username ?? client.username
  const terminalId = randomUUID()
  const ideId = randomUUID()

  const conflictResult = await client.debuggerListeners("user", terminalId, ideId, user, true)
  if (conflictResult) {
    return {
      content: [{
        type: "text" as const,
        text: `❌ Debug listener conflict: ${JSON.stringify(conflictResult)}\nAnother debugger may already be attached for this user.`
      }]
    }
  }

  debugSessions.set(connId, { terminalId, ideId, user })

  // Listen for a debuggee (blocks until a breakpoint is hit or timeout)
  const debuggee = await client.debuggerListen("user", terminalId, ideId, user, false)

  if (!debuggee) {
    debugSessions.delete(connId)
    return { content: [{ type: "text" as const, text: "Debug listener ended without hitting a breakpoint." }] }
  }

  return {
    content: [{
      type: "text" as const,
      text: `🐛 Breakpoint hit!\n${JSON.stringify(debuggee, null, 2)}\n\nUse abap_debug_step, abap_debug_variable, abap_debug_stack to inspect the program state.`
    }]
  }
}

export async function handleAbapDebugSetBreakpoint(args: {
  sourceUrl: string
  line: number
  username?: string
  connectionId?: string
}) {
  const connId = args.connectionId ?? "default"
  const client = await ensureConnected(args.connectionId)
  const session = debugSessions.get(connId)
  const terminalId = session?.terminalId ?? randomUUID()
  const ideId = session?.ideId ?? randomUUID()
  const user = args.username ?? client.username

  // A breakpoint is passed as a URI string of the form "<sourceUri>#start=<line>"
  const bpUri = `${args.sourceUrl}#start=${args.line}`
  const results = await client.debuggerSetBreakpoints("user", terminalId, ideId, ideId, [bpUri], user)

  const lines = results.map(r =>
    "id" in r ? `🔴 ${r.id}` : `⚠ error: ${JSON.stringify(r)}`
  )
  return {
    content: [{
      type: "text" as const,
      text: `Breakpoint set at ${args.sourceUrl} line ${args.line}.\n${lines.join("\n")}`
    }]
  }
}

export async function handleAbapDebugDeleteBreakpoint(args: {
  breakpointId: string
  username?: string
  connectionId?: string
}) {
  const connId = args.connectionId ?? "default"
  const client = await ensureConnected(args.connectionId)
  const session = debugSessions.get(connId)
  const terminalId = session?.terminalId ?? randomUUID()
  const ideId = session?.ideId ?? randomUUID()
  const user = args.username ?? client.username

  // Only the breakpoint id is used by the delete endpoint.
  await client.debuggerDeleteBreakpoints({ id: args.breakpointId } as DebugBreakpoint, "user", terminalId, ideId, user)
  return {
    content: [{ type: "text" as const, text: `⚪ Breakpoint deleted: ${args.breakpointId}` }]
  }
}

export async function handleAbapDebugStep(args: {
  stepType: "stepInto" | "stepOver" | "stepReturn" | "stepContinue" | "terminateDebuggee"
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const result = await client.debuggerStep(args.stepType)
  return {
    content: [{
      type: "text" as const,
      text: `Step: ${args.stepType}\n${JSON.stringify(result, null, 2)}`
    }]
  }
}

export async function handleAbapDebugVariable(args: {
  variables: string[]
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const result = await client.debuggerVariables(args.variables)
  const lines = result.map(v =>
    `${v.NAME} (${v.ACTUAL_TYPE_NAME || v.DECLARED_TYPE_NAME}) = ${v.VALUE}`
  )
  return {
    content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No variables returned." }]
  }
}

export async function handleAbapDebugStack(args: { connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const stack = await client.debuggerStackTrace()
  return {
    content: [{ type: "text" as const, text: JSON.stringify(stack, null, 2) }]
  }
}

export async function handleAbapDebugSetVariable(args: {
  variableName: string
  value: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const result = await client.debuggerSetVariableValue(args.variableName, args.value)
  return {
    content: [{
      type: "text" as const,
      text: `Variable ${args.variableName} set to: ${result}`
    }]
  }
}

export function registerDebugTools(server: McpServer): void {
  server.registerTool(
    "abap_debug_session",
    {
      title: "ABAP Debug Session",
      description: "Start, check or end the external ABAP debugger listener for a user. 'listen' registers a listener and then blocks until a program of that user hits a breakpoint (set one first with abap_debug_set_breakpoint) or the listener times out, and returns the debuggee details; then use abap_debug_step, abap_debug_variable and abap_debug_stack. 'status' shows the listener this server holds for the connection; 'detach' removes it. Reports a conflict if another debugger is already attached for that user. Does not change any object.",
      inputSchema: {
        action: z.enum(["listen", "detach", "status"]).describe("listen: wait for a breakpoint hit (blocks); detach: remove the listener; status: show terminal id, IDE id and user of the current listener, if any"),
        username: z.string().optional().describe("SAP user whose programs to debug (listen only; default: the connected user)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugSession
  )

  server.registerTool(
    "abap_debug_set_breakpoint",
    {
      title: "Set ABAP Breakpoint",
      description: "Set an external breakpoint on one source line for a user. Returns the breakpoint id (or an error entry), which abap_debug_delete_breakpoint takes. Set breakpoints before abap_debug_session with action listen, then run the program as that user to trigger it. Registers the breakpoint in SAP for that user; it does not change the object's source.",
      inputSchema: {
        sourceUrl: z.string().describe("ADT source URL including /source/main (e.g. /sap/bc/adt/programs/programs/ZREPORT/source/main, /sap/bc/adt/oo/classes/zcl_order_api/source/main)"),
        line: z.number().describe("1-based line number in that source; use get_abap_object_lines or search_abap_object_lines to find it"),
        username: z.string().optional().describe("SAP username (defaults to connected user)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugSetBreakpoint
  )

  server.registerTool(
    "abap_debug_delete_breakpoint",
    {
      title: "Delete ABAP Breakpoint",
      description: "Remove one external breakpoint by the id abap_debug_set_breakpoint returned. Use it when a breakpoint should no longer stop the program; it does not end a running debug session (use abap_debug_session with detach, or abap_debug_step with terminateDebuggee, for that). Removes the breakpoint registration in SAP only; source is untouched.",
      inputSchema: {
        breakpointId: z.string().describe("Breakpoint id returned by abap_debug_set_breakpoint"),
        username: z.string().optional().describe("SAP username (defaults to connected user)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugDeleteBreakpoint
  )

  server.registerTool(
    "abap_debug_step",
    {
      title: "ABAP Debug Step",
      description: "Execute one debugger step in the active session and return the new position as JSON. stepInto, stepOver and stepReturn move one step; stepContinue runs on to the next breakpoint or to the end; terminateDebuggee ends the debugged program. Needs a debuggee stopped at a breakpoint, which abap_debug_session with action listen delivers. Changes the running program's state, so it cannot be undone.",
      inputSchema: {
        stepType: z.enum(["stepInto", "stepOver", "stepReturn", "stepContinue", "terminateDebuggee"])
          .describe("stepInto (F5): enter the called routine; stepOver (F6): next statement; stepReturn (F7): run to the end of the current routine; stepContinue (F8): run to the next breakpoint; terminateDebuggee: end the program"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugStep
  )

  server.registerTool(
    "abap_debug_variable",
    {
      title: "ABAP Debug Variable",
      description: "Read the current values of named variables in the stopped debuggee, one line each as NAME (type) = value. Use abap_debug_stack first to see which frame you are in, and abap_debug_set_variable to change a value. Read-only; needs an active session stopped at a breakpoint (abap_debug_session with action listen).",
      inputSchema: {
        variables: z.array(z.string()).describe("Variable names as written in the source, visible in the current frame (e.g. ['LV_COUNT', 'WA_MARA', 'IT_TABLE'])"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugVariable
  )

  server.registerTool(
    "abap_debug_stack",
    {
      title: "ABAP Debug Stack",
      description: "Return the call stack of the stopped debuggee as JSON (the stack entries ADT reports). Use it after a breakpoint hit to see where you are before stepping or reading variables with abap_debug_variable. Read-only; needs an active session stopped at a breakpoint (abap_debug_session with action listen).",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugStack
  )

  server.registerTool(
    "abap_debug_set_variable",
    {
      title: "ABAP Debug Set Variable",
      description: "Overwrite a variable in the stopped debuggee and return the value SAP reports back. Affects only the running program's memory for this debug session, not the database or source, but whatever the program does afterwards uses the new value. Needs an active session stopped at a breakpoint; check the current value first with abap_debug_variable.",
      inputSchema: {
        variableName: z.string().describe("Variable name as written in the source (e.g. LV_COUNT)"),
        value: z.string().describe("New value as text (e.g. 5, or ABC for a character field)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugSetVariable
  )
}
