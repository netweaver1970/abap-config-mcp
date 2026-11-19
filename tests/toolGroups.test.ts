import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"

// No SAP: ADT construction throws; https answers as the engine.
vi.mock("abap-adt-api", () => ({
  session_types: { stateful: "stateful" },
  createSSLConfig: () => ({}),
  ADTClient: class { constructor() { throw new Error("ADT client constructed") } },
}))
const engine = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], reply: (_r: Record<string, unknown>) => ({}) as Record<string, unknown> }))
vi.mock("https", () => ({ default: { request: fakeRequest }, request: fakeRequest }))
function fakeRequest(_o: unknown, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) {
  const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: (b: string) => void }
  req.setTimeout = () => {}
  req.end = (body: string) => {
    const parsed = JSON.parse(body); engine.requests.push(parsed)
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
    res.statusCode = 200; res.headers = { "content-type": "application/json" }
    cb(res); res.emit("data", Buffer.from(JSON.stringify(engine.reply(parsed)))); res.emit("end")
  }
  return req
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpServer } from "../src/server"
import { resetServerModeForTests, GOVERNED_TOOLS } from "../src/mode"
import { TOOL_GROUPS, rewriteToolNames, toolSurface } from "../src/tools/toolGroups"
import { ENGINE_VERSION } from "../src/abap/zcl_mcp_cust_engine"

type Tool = { description: string; inputSchema: { shape: Record<string, any> }; annotations: Record<string, unknown>;
  handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }
const toolsOf = (s: McpServer) => (s as unknown as { _registeredTools: Record<string, Tool> })._registeredTools
const actionsOf = (t: Tool): string[] => t.inputSchema.shape.action._zod.def.entries ? Object.values(t.inputSchema.shape.action._zod.def.entries) : t.inputSchema.shape.action.options

function setEnv(mode?: string, tools?: string) {
  if (mode) process.env.ABAP_MCP_MODE = mode; else delete process.env.ABAP_MCP_MODE
  if (tools) process.env.ABAP_MCP_TOOLS = tools; else delete process.env.ABAP_MCP_TOOLS
  resetServerModeForTests()
}

beforeEach(() => {
  engine.requests = []
  engine.reply = () => ({ STATUS: "ok", VERSION: ENGINE_VERSION, DATA_JSON: "[]", MESSAGES: [] })
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => { setEnv(); vi.restoreAllMocks() })

describe("grouped surface", () => {
  it("is the default, and legacy gives the old names", () => {
    setEnv("direct")
    expect(toolSurface()).toBe("grouped")
    const grouped = Object.keys(toolsOf(createMcpServer()))
    expect(grouped.length).toBeLessThanOrEqual(14)
    expect(grouped).toContain("abap")
    setEnv("direct", "legacy")
    const legacy = Object.keys(toolsOf(createMcpServer()))
    expect(legacy.length).toBeGreaterThan(50)
    expect(legacy).toContain("search_abap_objects")
  })

  it("every legacy tool of the full direct surface is an action of some group, so nothing is lost", () => {
    setEnv("direct", "legacy")
    const legacy = Object.keys(toolsOf(createMcpServer()))
    const grouped = new Set(TOOL_GROUPS.flatMap(g => g.actions.map(a => a.tool)))
    expect(legacy.filter(n => !grouped.has(n))).toEqual([])
    setEnv("direct")
    const names = Object.keys(toolsOf(createMcpServer()))
    expect(names.every(n => TOOL_GROUPS.some(g => g.name === n))).toBe(true)
  })

  it("governed mode shows only groups with engine actions, and only those actions", () => {
    setEnv("governed")
    const tools = toolsOf(createMcpServer())
    expect(Object.keys(tools)).not.toContain("abap_write")
    expect(Object.keys(tools)).not.toContain("abap_debug")
    const offered = Object.entries(tools).flatMap(([g, t]) => actionsOf(t).map(a => TOOL_GROUPS.find(x => x.name === g)!.actions.find(x => x.action === a)!.tool))
    expect([...new Set(offered)].sort()).toEqual([...GOVERNED_TOOLS].sort())
    expect(actionsOf(tools.customizing)).toEqual(["search", "describe", "read", "diff", "plan", "status"])
  })

  it("read groups are read-only, write groups are not", () => {
    setEnv("direct")
    const tools = toolsOf(createMcpServer())
    for (const g of ["sap_system", "abap", "transport", "customizing", "bw"]) expect(tools[g].annotations.readOnlyHint, g).toBe(true)
    for (const g of ["abap_write", "transport_write", "customizing_write", "bw_write", "admin"]) expect(tools[g].annotations.readOnlyHint, g).toBe(false)
    expect(tools.bw_write.annotations.destructiveHint).toBe(true)
  })

  it("an action's parameters are checked against that action's own schema", async () => {
    setEnv("governed")
    const bw = toolsOf(createMcpServer()).bw
    await expect(bw.handler({ action: "read", type: "IOBJ" }, {})).rejects.toThrow(/bw\(action: "read"\) was not run — 1 problem.*Missing required parameter "name"/s)
    await expect(bw.handler({ action: "list", type: "IOBJ", commit: true }, {})).rejects.toThrow(/Unknown parameter "commit"/)
    await expect(bw.handler({ action: "nope" }, {})).rejects.toThrow(/is not one of capabilities, list, read, where_used/)
  })

  it("a split tool gets its inner action fixed by the group action", async () => {
    setEnv("governed")
    engine.reply = r => r.operation === "retest_scope"
      ? { STATUS: "error", VERSION: ENGINE_VERSION, MESSAGES: ["stopped here"] }
      : { STATUS: "ok", VERSION: ENGINE_VERSION, DATA_JSON: "[]", MESSAGES: [] }
    const t = toolsOf(createMcpServer()).customizing_write
    expect(actionsOf(t)).toEqual(expect.arrayContaining(["copy", "delete", "org_copy", "org_delete"]))
    expect(Object.keys(t.inputSchema.shape)).not.toContain("actionX")
    expect(t.description).toContain("• org_delete — Delete an org unit's entries")
  })

  it("a split action shows and takes only its own parameters", async () => {
    setEnv("direct")
    const tools = toolsOf(createMcpServer())
    expect(tools.transport.description).toContain("• mine — List a user's open requests (default: the connected user). Optional: username.")
    expect(tools.transport.description).not.toMatch(/• mine[^\n]*newOwner/)
    await expect(tools.transport.handler({ action: "mine", newOwner: "X" }, {})).rejects.toThrow(/Unknown parameter "newOwner"/)
    expect(tools.transport_write.description).toContain("• change_owner — Give a request to another user. Required: newOwner, transportNumber.")
  })

  it("old tool names in descriptions and answers read as group calls", async () => {
    expect(rewriteToolNames("run customizing_engine_bootstrap, then customizing_read")).toBe(
      'run admin(action: "engine_install"), then customizing(action: "read")')
    expect(rewriteToolNames("Unknown operation: 'bw_list' at /sap/bc/adt/where_used")).toBe("Unknown operation: 'bw_list' at /sap/bc/adt/where_used")
    expect(rewriteToolNames("features: org_copy= cts_task=X")).toBe("features: org_copy= cts_task=X")
    expect(rewriteToolNames("use manage_transport_requests")).toBe('use transport(action: "mine" | "details") or transport_write(action: "create" | "release" | "delete" | "change_owner")')
    setEnv("direct")
    const all = Object.values(toolsOf(createMcpServer())).map(t => t.description).join("\n")
    expect(all).not.toMatch(/\bcustomizing_engine_bootstrap\b/)
  })

  it("a group call reaches the tool and its answer is rewritten", async () => {
    setEnv("governed")
    const t = toolsOf(createMcpServer()).sap_system
    const r = await t.handler({ action: "systems" }, { sessionId: "g1" })
    expect(r.content[0].text).toMatch(/governed/i)
  })
})
