import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"

// No SAP here. Any ADT client construction throws, so a test that reaches one fails loudly.
const adtConstructed = vi.hoisted(() => ({ n: 0 }))
vi.mock("abap-adt-api", () => ({
  session_types: { stateful: "stateful" },
  createSSLConfig: () => ({}),
  ADTClient: class { constructor() { adtConstructed.n++; throw new Error("ADT client constructed") } },
}))

// The engine's HTTP endpoint: https.request answers every call with a canned engine response.
const engineReply = vi.hoisted(() => ({ status: 200, body: "" as string | ((req: string) => string), requests: [] as string[] }))
vi.mock("https", () => ({
  default: { request: fakeRequest },
  request: fakeRequest,
}))
function fakeRequest(_opts: unknown, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) {
  const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: (b: string) => void }
  req.setTimeout = () => {}
  req.end = (body: string) => {
    engineReply.requests.push(body)
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
    res.statusCode = engineReply.status
    res.headers = { "content-type": "application/json" }
    cb(res)
    const text = typeof engineReply.body === "function" ? engineReply.body(body) : engineReply.body
    res.emit("data", Buffer.from(text))
    res.emit("end")
  }
  return req
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { serverMode, resetServerModeForTests, assertGovernedLogon, GOVERNED_TOOLS } from "../src/mode"
import { createMcpServer } from "../src/server"
import { ensureConnected, newIsolatedClient, runInSession } from "../src/connections"
import { ensureEngineClass, callEngine } from "../src/tools/customizingEngine"
import { ENGINE_VERSION } from "../src/abap/zcl_mcp_cust_engine"

const SEVEN = [
  "connected_systems", "customizing_engine_ping", "customizing_status", "hana_memory_report",
  "abap_memory_report", "retail_listing", "customizing_selftest",
].sort()

const ADT_REFUSAL = "Calling ADT for X on DEV stopped: this server runs in governed mode, which makes no ADT calls. " +
  "Use SAP's ADT MCP server for code work, or run this server with ABAP_MCP_MODE=direct."

function toolsOf(server: McpServer): Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }> {
  return (server as unknown as { _registeredTools: never })._registeredTools
}

function setMode(m: string | undefined) {
  if (m === undefined) delete process.env.ABAP_MCP_MODE
  else process.env.ABAP_MCP_MODE = m
  resetServerModeForTests()
}

beforeEach(() => {
  adtConstructed.n = 0
  engineReply.status = 200
  engineReply.requests = []
  engineReply.body = () => JSON.stringify({ STATUS: "ok", VERSION: ENGINE_VERSION, DATA_JSON: "[]", MESSAGES: [] })
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => { setMode(undefined); vi.restoreAllMocks() })

describe("mode switch", () => {
  it("defaults to direct", () => {
    setMode(undefined)
    expect(serverMode()).toBe("direct")
  })

  it("reads ABAP_MCP_MODE", () => {
    setMode("governed")
    expect(serverMode()).toBe("governed")
  })

  it("refuses an unknown value with what, why and what to do", () => {
    setMode("sandbox")
    expect(() => serverMode()).toThrow(/Reading the server mode stopped: ABAP_MCP_MODE is "sandbox", and the only modes are "direct" and "governed"\. Set it to/)
  })

  it("lets the environment variable win over the config file", async () => {
    vi.resetModules()
    vi.doMock("../src/config", () => ({ loadConfig: () => ({ connections: [], server: { mode: "governed" } }) }))
    const fresh = await import("../src/mode")
    delete process.env.ABAP_MCP_MODE
    fresh.resetServerModeForTests()
    expect(fresh.serverMode()).toBe("governed")           // from the file
    process.env.ABAP_MCP_MODE = "direct"
    fresh.resetServerModeForTests()
    expect(fresh.serverMode()).toBe("direct")             // env wins
    vi.doUnmock("../src/config")
    vi.resetModules()
  })
})

describe("tool set", () => {
  it("governed mode registers exactly the seven engine-only tools", () => {
    setMode("governed")
    const names = Object.keys(toolsOf(createMcpServer())).sort()
    expect(names).toEqual(SEVEN)
    expect([...GOVERNED_TOOLS].sort()).toEqual(SEVEN)
  })

  it("direct mode registers the full set, a superset of the governed one", () => {
    setMode("direct")
    const direct = Object.keys(toolsOf(createMcpServer()))
    expect(direct.length).toBeGreaterThan(50)
    for (const t of SEVEN) expect(direct).toContain(t)
    for (const t of ["write_abap_object_source", "engine_deploy", "customizing_engine_bootstrap", "customizing_apply"]) expect(direct).toContain(t)
  })

  it("direct mode registers the same tools as with the mode unset", () => {
    setMode(undefined)
    const unset = Object.keys(toolsOf(createMcpServer())).sort()
    setMode("direct")
    expect(Object.keys(toolsOf(createMcpServer())).sort()).toEqual(unset)
  })
})

describe("ADT guard in governed mode", () => {
  it("ensureConnected refuses with the three-part message and builds no client", async () => {
    setMode("governed")
    await expect(ensureConnected("DEV")).rejects.toThrow(
      "Calling ADT for this call on DEV stopped: this server runs in governed mode, which makes no ADT calls. " +
      "Use SAP's ADT MCP server for code work, or run this server with ABAP_MCP_MODE=direct.")
    expect(adtConstructed.n).toBe(0)
  })

  it("newIsolatedClient refuses the same way", async () => {
    setMode("governed")
    await expect(newIsolatedClient("DEV", 1000)).rejects.toThrow(ADT_REFUSAL.replace("for X", "for this call"))
    expect(adtConstructed.n).toBe(0)
  })

  it("names the tool that was running", async () => {
    setMode("governed")
    // A governed tool never calls ADT, so run the guard inside a tool's scope by hand.
    await expect(runInSession("s1", () => ensureConnected("DEV"), "retail_listing"))
      .rejects.toThrow("Calling ADT for retail_listing on DEV stopped:")
  })

  it("none of the seven tools constructs an ADT client", async () => {
    setMode("governed")
    const tools = toolsOf(createMcpServer())
    const args: Record<string, unknown> = {
      customizing_status: { runId: "R1" },
      retail_listing: { items: [{ product: "P1", assortment: "A1" }] },   // autoDeploy defaults to true
      customizing_selftest: {},                                           // autoDeploy defaults to true
    }
    for (const name of SEVEN) {
      const r = await tools[name].handler(args[name] ?? {}, { sessionId: "s1" })
      expect(r.content[0].text, name).not.toMatch(/ADT client constructed|governed mode, which makes no ADT calls/)
    }
    expect(adtConstructed.n).toBe(0)
    expect(engineReply.requests.length).toBeGreaterThan(0)   // they did reach the engine's endpoint
  })

  it("a direct-mode run of an ADT tool does build a client", async () => {
    setMode("direct")
    await expect(ensureConnected("DEV")).rejects.toThrow("ADT client constructed")
    expect(adtConstructed.n).toBe(1)
  })

  it("connected_systems states the mode on its first line", async () => {
    setMode("governed")
    const r = await toolsOf(createMcpServer()).connected_systems.handler({}, { sessionId: "s1" })
    expect(r.content[0].text.split("\n")[0]).toMatch(/^Mode: governed/)
    setMode("direct")
    const d = await toolsOf(createMcpServer()).connected_systems.handler({}, { sessionId: "s1" })
    expect(d.content[0].text.split("\n")[0]).toMatch(/^Mode: direct/)
  })
})

describe("engine installation in governed mode", () => {
  it("ensureEngineClass makes no ADT call and deploys nothing", async () => {
    setMode("governed")
    const r = await ensureEngineClass("DEV")
    expect(r.changed).toBe(false)
    expect(r.action).toMatch(/^governed mode: the engine is installed by abapGit or transport/)
    expect(adtConstructed.n).toBe(0)
  })

  it("a missing engine names both ways to install it", async () => {
    setMode("governed")
    engineReply.status = 404
    engineReply.body = "<html>Not found</html>"
    await expect(callEngine("DEV", { operation: "ping" })).rejects.toThrow(/Install it with abapGit, or transport it from a system where it was deployed in direct mode/)
  })

  it("the ping reports a wrong version with the two routes, not the bootstrap tool", async () => {
    setMode("governed")
    engineReply.body = () => JSON.stringify({ STATUS: "ok", VERSION: "0.0.1", MESSAGES: [] })
    const r = await toolsOf(createMcpServer()).customizing_engine_ping.handler({}, { sessionId: "s1" })
    expect(r.content[0].text).toContain("Install it with abapGit")
    expect(r.content[0].text).not.toContain("customizing_engine_bootstrap")
  })

  it("direct mode keeps the old wording for a missing engine", async () => {
    setMode("direct")
    engineReply.status = 404
    engineReply.body = "<html>Not found</html>"
    await expect(callEngine("DEV", { operation: "ping" })).rejects.toThrow(/^Engine HTTP 404: <html>Not found<\/html>$/)
  })
})

describe("rule 4: own users only", () => {
  it("refuses a shared connection in governed mode, naming it", () => {
    setMode("governed")
    expect(() => assertGovernedLogon([{ id: "S4", logon: "per-user" }, { id: "CAR" }])).toThrow(
      'Starting the HTTP server in governed mode stopped: connection CAR logs on with one shared SAP user, ' +
      'and in governed mode every call must run as the person making it. Set "logon": "per-user" on it in connections.json')
  })

  it("accepts per-user connections", () => {
    setMode("governed")
    expect(() => assertGovernedLogon([{ id: "S4", logon: "per-user" }, { id: "CAR", logon: "per-user" }])).not.toThrow()
  })

  it("does not apply in direct mode", () => {
    setMode("direct")
    expect(() => assertGovernedLogon([{ id: "S4" }])).not.toThrow()
  })
})
