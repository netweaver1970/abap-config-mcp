import { describe, it, expect, beforeEach, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../src/connections", () => ({ log: vi.fn() }))

const MEM = path.join(os.tmpdir(), `abap-mcp-transport-test-${process.pid}.json`)
process.env.ABAP_MCP_TRANSPORT_MEMORY = MEM

import { selectTransport, recallTransport, workKey, type RequestInfo, type SelectionInput } from "../src/tools/transportSelection"

const open = (trkorr: string, fn = "W"): RequestInfo => ({ trkorr, fn, status: "D", owner: "GEERT", text: `text ${trkorr}` })
const requests: Record<string, RequestInfo> = {
  A1: open("A1"), A2: open("A2"), A3: open("A3"),
  REL: { ...open("REL"), status: "R" },
  WB: open("WB", "K"),
}
const base = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  connectionId: "S4", fn: "W", what: "the write",
  candidates: [{ trkorr: "A1", text: "one" }, { trkorr: "A2", text: "two" }],
  lookup: async t => requests[t],
  sessionId: "s1",
  ...over,
})

beforeEach(() => { try { fs.unlinkSync(MEM) } catch { /* none */ } })

describe("selectTransport", () => {
  it("asks which transport when several are open and nothing is remembered", async () => {
    const r = await selectTransport(base())
    expect(r.kind).toBe("ask")
    if (r.kind === "ask") {
      expect(r.text).toContain("A1")
      expect(r.text).toContain("A2")
      expect(r.text).toContain("Which transport")
    }
  })

  it("uses the only open request and remembers it", async () => {
    const r = await selectTransport(base({ candidates: [{ trkorr: "A3", text: "only" }] }))
    expect(r).toMatchObject({ kind: "use", trkorr: "A3" })
    expect(recallTransport("S4", "W", workKey(undefined, "s1"))).toBe("A3")
  })

  it("uses a named transport, then keeps proposing it for the same work", async () => {
    await selectTransport(base({ supplied: "a2", workItem: "hpm" }))
    const again = await selectTransport(base({ workItem: "HPM", sessionId: "another-session" }))
    expect(again).toMatchObject({ kind: "use", trkorr: "A2" })
    if (again.kind === "use") expect(again.note).toContain("work item HPM")
  })

  it("a different named transport replaces the remembered one", async () => {
    await selectTransport(base({ supplied: "A1", workItem: "HPM" }))
    const r = await selectTransport(base({ supplied: "A2", workItem: "HPM" }))
    expect(r).toMatchObject({ kind: "use", trkorr: "A2" })
    if (r.kind === "use") expect(r.note).toContain("was A1")
    expect(recallTransport("S4", "W", "work:HPM")).toBe("A2")
  })

  it("keeps separate sessions apart when no work item is named", async () => {
    await selectTransport(base({ supplied: "A1", sessionId: "s1" }))
    const other = await selectTransport(base({ sessionId: "s2" }))
    expect(other.kind).toBe("ask")
  })

  it("refuses a released, unknown or wrong-kind transport without remembering it", async () => {
    for (const bad of ["REL", "NOPE", "WB"]) {
      const r = await selectTransport(base({ supplied: bad, workItem: "X" }))
      expect(r.kind).toBe("ask")
    }
    expect(recallTransport("S4", "W", "work:X")).toBeUndefined()
  })

  it("stops proposing a remembered transport once it is released", async () => {
    await selectTransport(base({ supplied: "A1", workItem: "Y" }))
    requests.A1 = { ...requests.A1, status: "R" }
    const r = await selectTransport(base({ workItem: "Y" }))
    expect(r.kind).toBe("ask")
    if (r.kind === "ask") expect(r.text).toContain("no longer open")
    requests.A1 = open("A1")
  })

  it("uses the request SAP already ties the object to", async () => {
    const r = await selectTransport(base({ forced: "A3" }))
    expect(r).toMatchObject({ kind: "use", trkorr: "A3" })
  })

  it("creates only when asked, even when requests exist", async () => {
    const create = vi.fn(async () => "NEW1")
    const r = await selectTransport(base({ create }))
    expect(create).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ kind: "use", trkorr: "NEW1" })
  })

  it("offers creation when there is no open request", async () => {
    const r = await selectTransport(base({ candidates: [] }))
    expect(r.kind).toBe("ask")
    if (r.kind === "ask") expect(r.text).toContain("createTransport: true")
  })
})
