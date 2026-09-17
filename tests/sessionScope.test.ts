import { describe, it, expect, vi, beforeEach } from "vitest"

// A fake ADT client per construction, so each ADT session is observable.
const created: Array<{ login: ReturnType<typeof vi.fn>; dropSession: ReturnType<typeof vi.fn>; stateful: unknown }> = []
vi.mock("abap-adt-api", () => ({
  session_types: { stateful: "stateful" },
  createSSLConfig: () => ({}),
  ADTClient: class {
    login = vi.fn(async () => undefined)
    dropSession = vi.fn(async () => undefined)
    stateful: unknown
    constructor() { created.push(this as any) }
  },
}))
vi.mock("../src/config", () => ({
  loadConfig: () => ({ connections: [{ id: "S4", url: "https://sap", username: "U", password: "P" }] }),
}))

import {
  ensureConnected, runInSession, trackLock, getHeldLock, dropSessionLocks,
  closeSessionConnections, evictIdleSessions, listSessions, stopKeepAlive,
} from "../src/connections"

beforeEach(async () => {
  stopKeepAlive()
  for (const s of listSessions()) await closeSessionConnections(s.sessionId)
  created.length = 0
})

describe("one ADT session per MCP session", () => {
  it("gives each conversation its own client and keeps reusing it", async () => {
    const a1 = await runInSession("conv-a", () => ensureConnected("S4"))
    const b = await runInSession("conv-b", () => ensureConnected("S4"))
    const a2 = await runInSession("conv-a", () => ensureConnected("S4"))
    expect(a1).not.toBe(b)
    expect(a1).toBe(a2)
    expect(created).toHaveLength(2)
  })

  it("keeps lock registries apart", async () => {
    await runInSession("conv-a", async () => { await ensureConnected("S4"); trackLock("S4", "/obj", "LA") })
    await runInSession("conv-b", async () => { await ensureConnected("S4") })
    expect(runInSession("conv-a", () => getHeldLock("S4", "/obj"))).toBe("LA")
    expect(runInSession("conv-b", () => getHeldLock("S4", "/obj"))).toBeUndefined()
  })

  it("a relogin in one conversation does not touch another's session or locks", async () => {
    await runInSession("conv-a", async () => { await ensureConnected("S4"); trackLock("S4", "/obj", "LA") })
    await runInSession("conv-b", async () => { await ensureConnected("S4"); await dropSessionLocks("S4") })
    const [clientA, clientB] = created
    expect(clientB.dropSession).toHaveBeenCalled()
    expect(clientA.dropSession).not.toHaveBeenCalled()
    expect(runInSession("conv-a", () => getHeldLock("S4", "/obj"))).toBe("LA")
  })

  it("closes a conversation's ADT session when the conversation ends", async () => {
    await runInSession("conv-a", () => ensureConnected("S4"))
    await runInSession("conv-b", () => ensureConnected("S4"))
    await closeSessionConnections("conv-a")
    expect(created[0].dropSession).toHaveBeenCalled()
    expect(created[1].dropSession).not.toHaveBeenCalled()
    expect(listSessions().map(s => s.sessionId)).toEqual(["conv-b"])
  })

  it("evicts sessions no tool call has used for an hour", async () => {
    await runInSession("old", () => ensureConnected("S4"))
    await evictIdleSessions(Date.now() + 61 * 60_000)
    expect(created[0].dropSession).toHaveBeenCalled()
    expect(listSessions()).toHaveLength(0)
  })
})

import { withSessionScope } from "../src/tools/sessionRecovery"
import { currentSessionId } from "../src/connections"

describe("withSessionScope", () => {
  it("binds a tool handler to the MCP session in its extra argument", async () => {
    const seen: string[] = []
    const handler = withSessionScope(async (_args: unknown, _extra: unknown) => { seen.push(currentSessionId()) })
    await handler({}, { sessionId: "conv-x" })
    await handler({}, {})
    expect(seen).toEqual(["conv-x", "shared"])
  })
})
