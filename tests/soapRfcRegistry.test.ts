import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../src/config", () => ({
  loadConfig: () => ({
    connections: [
      { id: "ADT1", url: "http://adt.example:8000", username: "U", password: "p", client: "100" },
      { id: "OLD", url: "http://old.example:8000", username: "U", password: "p", client: "200", protocol: "soap-rfc" },
    ],
  }),
}))

import { registerAllTools } from "../src/tools/index"
import { resetSoapRfcState, setSoapTransport } from "../src/soapRfc/client"

type Handler = (args: unknown, extra: unknown) => Promise<any>

// The real registry, on a stand-in server that records each tool's final (fully wrapped) handler.
const handlers = new Map<string, Handler>()
registerAllTools({ registerTool: (name: string, _cfg: unknown, h: Handler) => { handlers.set(name, h) } } as any)

let logged: string[] = []
let sent = 0

beforeEach(() => {
  resetSoapRfcState()
  sent = 0
  logged = []
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")) })
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")) })
  // 403 is a status session recovery treats as a degraded ADT session.
  setSoapTransport(async () => { sent++; return { status: 403, body: "" } })
})

afterEach(() => {
  vi.restoreAllMocks()
  setSoapTransport(undefined)
})

describe("registered tools on a SOAP RFC connection", () => {
  it("a SOAP RFC failure never reaches session recovery (no ADT reconnect, no retry)", async () => {
    await expect(handlers.get("read_table_contents")!({ tableName: "T000", connectionId: "OLD" }, { sessionId: "s1" }))
      .rejects.toThrow(/not active in SICF/)
    expect(sent).toBe(1)
    expect(logged.join("\n")).not.toMatch(/forcing reconnect|Connecting to OLD/)
  })

  it("an ADT-only tool is refused without any request", async () => {
    const r = await handlers.get("abap_activate")!({ url: "/sap/bc/adt/programs/programs/z", connectionId: "OLD" }, { sessionId: "s1" })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not supported on OLD/)
    expect(sent).toBe(0)
  })

  it("every tool without a SOAP RFC handler is refused there, none sends anything", async () => {
    const soap = new Set(["execute_data_query", "read_table_contents", "describe_database_table", "get_abap_object_lines",
      "search_abap_object_lines", "get_abap_batch_lines", "force_relogin", "connected_systems"])
    const others = [...handlers.keys()].filter(n => !soap.has(n))
    expect(others.length).toBeGreaterThan(30)
    for (const name of others) {
      const r = await handlers.get(name)!({ connectionId: "OLD" }, { sessionId: "s1" })
      expect(r.isError, name).toBe(true)
      expect(r.content[0].text, name).toMatch(/not supported on OLD/)
    }
    expect(sent).toBe(0)
  })
})
