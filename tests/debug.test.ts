import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleAbapDebugSession,
  handleAbapDebugSetBreakpoint,
  handleAbapDebugDeleteBreakpoint,
  handleAbapDebugStep,
  handleAbapDebugVariable,
  handleAbapDebugStack,
  handleAbapDebugSetVariable,
  debugSessions,
} from "../src/tools/debug"

vi.mock("../src/connections", () => ({ ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn() }))
import { ensureConnected } from "../src/connections"

const mockClient = {
  username: "BASIS",
  debuggerListeners: vi.fn(),
  debuggerListen: vi.fn(),
  debuggerDeleteListener: vi.fn(),
  debuggerSetBreakpoints: vi.fn(),
  debuggerDeleteBreakpoints: vi.fn(),
  debuggerStep: vi.fn(),
  debuggerVariables: vi.fn(),
  debuggerStackTrace: vi.fn(),
  debuggerSetVariableValue: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  debugSessions.clear()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
})

// ─── abap_debug_session: status ───────────────────────────────────────────────

describe("abap_debug_session status", () => {
  it("reports no session when none is active", async () => {
    const result = await handleAbapDebugSession({ action: "status" })
    expect(result.content[0].text).toContain("No active debug session")
  })

  it("reports session details when active", async () => {
    debugSessions.set("default", { terminalId: "T1", ideId: "I1", user: "BASIS" })
    const result = await handleAbapDebugSession({ action: "status" })
    const text = result.content[0].text
    expect(text).toContain("T1")
    expect(text).toContain("I1")
    expect(text).toContain("BASIS")
  })
})

// ─── abap_debug_session: detach ───────────────────────────────────────────────

describe("abap_debug_session detach", () => {
  it("returns message when no session to detach", async () => {
    const result = await handleAbapDebugSession({ action: "detach" })
    expect(result.content[0].text).toContain("No active debug session")
  })

  it("calls deleteListener and clears session", async () => {
    debugSessions.set("default", { terminalId: "T1", ideId: "I1", user: "BASIS" })
    mockClient.debuggerDeleteListener.mockResolvedValue(undefined)
    const result = await handleAbapDebugSession({ action: "detach" })
    expect(mockClient.debuggerDeleteListener).toHaveBeenCalledWith("user", "T1", "I1", "BASIS")
    expect(debugSessions.has("default")).toBe(false)
    expect(result.content[0].text).toContain("🔌")
  })
})

// ─── abap_debug_session: listen ───────────────────────────────────────────────

describe("abap_debug_session listen", () => {
  it("reports conflict when another debugger is attached", async () => {
    mockClient.debuggerListeners.mockResolvedValue({ conflict: true })
    const result = await handleAbapDebugSession({ action: "listen" })
    expect(result.content[0].text).toContain("conflict")
    expect(debugSessions.size).toBe(0)
  })

  it("returns breakpoint-hit message when debuggee is received", async () => {
    mockClient.debuggerListeners.mockResolvedValue(null)
    mockClient.debuggerListen.mockResolvedValue({ program: "ZPROG", line: 42 })
    const result = await handleAbapDebugSession({ action: "listen" })
    expect(result.content[0].text).toContain("🐛")
    expect(result.content[0].text).toContain("ZPROG")
    expect(debugSessions.size).toBe(1)
  })

  it("clears session when listener ends without a hit", async () => {
    mockClient.debuggerListeners.mockResolvedValue(null)
    mockClient.debuggerListen.mockResolvedValue(null)
    const result = await handleAbapDebugSession({ action: "listen" })
    expect(result.content[0].text).toContain("without hitting")
    expect(debugSessions.size).toBe(0)
  })
})

// ─── abap_debug_set_breakpoint ────────────────────────────────────────────────

describe("abap_debug_set_breakpoint", () => {
  it("sets breakpoint with correct URI format", async () => {
    mockClient.debuggerSetBreakpoints.mockResolvedValue([{ id: "BP001" }])
    const result = await handleAbapDebugSetBreakpoint({
      sourceUrl: "/sap/bc/adt/programs/ZPROG/source/main",
      line: 42,
    })
    expect(mockClient.debuggerSetBreakpoints).toHaveBeenCalledWith(
      "user", expect.any(String), expect.any(String), expect.any(String),
      ["/sap/bc/adt/programs/ZPROG/source/main#start=42"],
      "BASIS"
    )
    expect(result.content[0].text).toContain("BP001")
    expect(result.content[0].text).toContain("line 42")
  })

  it("uses session IDs when a debug session is active", async () => {
    debugSessions.set("default", { terminalId: "T1", ideId: "I1", user: "BASIS" })
    mockClient.debuggerSetBreakpoints.mockResolvedValue([{ id: "BP002" }])
    await handleAbapDebugSetBreakpoint({ sourceUrl: "/url", line: 10 })
    expect(mockClient.debuggerSetBreakpoints).toHaveBeenCalledWith(
      "user", "T1", "I1", "I1", expect.any(Array), "BASIS"
    )
  })
})

// ─── abap_debug_delete_breakpoint ────────────────────────────────────────────

describe("abap_debug_delete_breakpoint", () => {
  it("deletes breakpoint by id", async () => {
    mockClient.debuggerDeleteBreakpoints.mockResolvedValue(undefined)
    const result = await handleAbapDebugDeleteBreakpoint({ breakpointId: "BP001" })
    expect(mockClient.debuggerDeleteBreakpoints).toHaveBeenCalledWith(
      { id: "BP001" }, "user", expect.any(String), expect.any(String), "BASIS"
    )
    expect(result.content[0].text).toContain("⚪")
    expect(result.content[0].text).toContain("BP001")
  })
})

// ─── abap_debug_step ─────────────────────────────────────────────────────────

describe("stepping and inspecting without a stopped program", () => {
  it.each([
    ["step", () => handleAbapDebugStep({ stepType: "stepOver" })],
    ["variable", () => handleAbapDebugVariable({ variables: ["X"] } as any)],
    ["stack", () => handleAbapDebugStack({})],
    ["set_variable", () => handleAbapDebugSetVariable({ variableName: "X", value: "1" } as any)],
  ] as const)("%s is refused before calling SAP", async (_n, call) => {
    const r = await call()
    expect(r.content[0].text).toMatch(/stopped: no program is stopped in the debugger/)
    expect(ensureConnected).not.toHaveBeenCalled()
  })
})

describe("abap_debug_step", () => {
  beforeEach(() => { debugSessions.set("default", { terminalId: "t", ideId: "i", user: "BASIS" } as any) })
  it.each(["stepInto", "stepOver", "stepReturn", "stepContinue", "terminateDebuggee"] as const)(
    "calls debuggerStep with %s",
    async (stepType) => {
      mockClient.debuggerStep.mockResolvedValue({ done: true })
      const result = await handleAbapDebugStep({ stepType })
      expect(mockClient.debuggerStep).toHaveBeenCalledWith(stepType)
      expect(result.content[0].text).toContain(stepType)
    }
  )
})

// ─── abap_debug_variable ──────────────────────────────────────────────────────

describe("abap_debug_variable", () => {
  beforeEach(() => { debugSessions.set("default", { terminalId: "t", ideId: "i", user: "BASIS" } as any) })
  it("returns formatted variable values", async () => {
    mockClient.debuggerVariables.mockResolvedValue([
      { NAME: "LV_COUNT", ACTUAL_TYPE_NAME: "I", DECLARED_TYPE_NAME: "I", VALUE: "42" },
      { NAME: "LV_FLAG", ACTUAL_TYPE_NAME: "C", DECLARED_TYPE_NAME: "C", VALUE: "X" },
    ])
    const result = await handleAbapDebugVariable({ variables: ["LV_COUNT", "LV_FLAG"] })
    const text = result.content[0].text
    expect(text).toContain("LV_COUNT (I) = 42")
    expect(text).toContain("LV_FLAG (C) = X")
  })

  it("returns message when no variables returned", async () => {
    mockClient.debuggerVariables.mockResolvedValue([])
    const result = await handleAbapDebugVariable({ variables: [] })
    expect(result.content[0].text).toContain("No variables returned")
  })
})

// ─── abap_debug_stack ─────────────────────────────────────────────────────────

describe("abap_debug_stack", () => {
  beforeEach(() => { debugSessions.set("default", { terminalId: "t", ideId: "i", user: "BASIS" } as any) })
  it("returns JSON-serialised stack", async () => {
    mockClient.debuggerStackTrace.mockResolvedValue([{ program: "ZPROG", line: 10 }])
    const result = await handleAbapDebugStack({})
    expect(result.content[0].text).toContain("ZPROG")
  })
})

// ─── abap_debug_set_variable ─────────────────────────────────────────────────

describe("abap_debug_set_variable", () => {
  beforeEach(() => { debugSessions.set("default", { terminalId: "t", ideId: "i", user: "BASIS" } as any) })
  it("sets variable value and confirms", async () => {
    mockClient.debuggerSetVariableValue.mockResolvedValue("99")
    const result = await handleAbapDebugSetVariable({ variableName: "LV_COUNT", value: "99" })
    expect(mockClient.debuggerSetVariableValue).toHaveBeenCalledWith("LV_COUNT", "99")
    expect(result.content[0].text).toContain("LV_COUNT")
    expect(result.content[0].text).toContain("99")
  })
})
