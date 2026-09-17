import { describe, it, expect, vi, beforeEach } from "vitest"

// Keep the real isSessionDegradedError so the wrapper is tested against the
// actual classifier; only the side-effecting pieces are mocked.
vi.mock("../src/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connections")>()
  return {
    ...actual,
    forceReconnect: vi.fn(),
    log: vi.fn(),
  }
})

import { forceReconnect, isSessionDegradedError } from "../src/connections"
import { withSessionRecovery } from "../src/tools/sessionRecovery"

const http400 = () => Object.assign(new Error("Bad request"), { err: 400 })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(forceReconnect).mockResolvedValue({} as any)
})

// ─── isSessionDegradedError ───────────────────────────────────────────────────

describe("isSessionDegradedError", () => {
  it("matches HTTP 400/401/403 via .err, .status and .response.status", () => {
    expect(isSessionDegradedError(Object.assign(new Error("x"), { err: 400 }))).toBe(true)
    expect(isSessionDegradedError(Object.assign(new Error("x"), { status: 401 }))).toBe(true)
    expect(isSessionDegradedError(Object.assign(new Error("x"), { response: { status: 403 } }))).toBe(true)
  })

  it("matches CSRF and session-expiry messages", () => {
    expect(isSessionDegradedError(new Error("CSRF token validation failed"))).toBe(true)
    expect(isSessionDegradedError(new Error("Session timed out"))).toBe(true)
  })

  it("does not match business or transport errors", () => {
    expect(isSessionDegradedError(new Error("Query must start with SELECT"))).toBe(false)
    expect(isSessionDegradedError(Object.assign(new Error("Internal error"), { err: 500 }))).toBe(false)
    expect(isSessionDegradedError(new Error("timeout of 30000ms exceeded"))).toBe(false)
  })

  it("does not match editing-conflict or lock errors even with a 400 status", () => {
    expect(isSessionDegradedError(Object.assign(new Error("User BASIS is currently editing ZPROG"), { err: 400 }))).toBe(false)
    expect(isSessionDegradedError(Object.assign(new Error("Invalid lock handle"), { err: 400 }))).toBe(false)
  })
})

// ─── withSessionRecovery ──────────────────────────────────────────────────────

describe("withSessionRecovery", () => {
  it("passes through a successful call without reconnecting", async () => {
    const handler = vi.fn().mockResolvedValue("ok")
    const wrapped = withSessionRecovery("execute_data_query", handler)
    expect(await wrapped({ connectionId: "DEV" })).toBe("ok")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(forceReconnect).not.toHaveBeenCalled()
  })

  it("reconnects and retries once on a session-degraded error", async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce(http400())
      .mockResolvedValueOnce("recovered")
    const wrapped = withSessionRecovery("execute_data_query", handler)
    expect(await wrapped({ connectionId: "DEV" })).toBe("recovered")
    expect(forceReconnect).toHaveBeenCalledTimes(1)
    expect(forceReconnect).toHaveBeenCalledWith("DEV")
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("passes undefined connectionId when args have none", async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce(http400())
      .mockResolvedValueOnce("recovered")
    const wrapped = withSessionRecovery("execute_data_query", handler)
    await wrapped({ sql: "SELECT * FROM T000" })
    expect(forceReconnect).toHaveBeenCalledWith(undefined)
  })

  it("does not retry non-session errors", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("Query must start with SELECT"))
    const wrapped = withSessionRecovery("execute_data_query", handler)
    await expect(wrapped({})).rejects.toThrow("Query must start with SELECT")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(forceReconnect).not.toHaveBeenCalled()
  })

  it("gives up after the second attempt (max 2 attempts)", async () => {
    const handler = vi.fn().mockRejectedValue(http400())
    const wrapped = withSessionRecovery("execute_data_query", handler)
    await expect(wrapped({})).rejects.toThrow("Bad request")
    expect(handler).toHaveBeenCalledTimes(2)
    expect(forceReconnect).toHaveBeenCalledTimes(1)
  })

  it("surfaces the original error when the reconnect itself fails", async () => {
    vi.mocked(forceReconnect).mockRejectedValue(new Error("login failed"))
    const handler = vi.fn().mockRejectedValue(http400())
    const wrapped = withSessionRecovery("execute_data_query", handler)
    await expect(wrapped({})).rejects.toThrow("Bad request")
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("withSessionRecovery — tools that change SAP", () => {
  it("renews the session but does not run a writing tool again", async () => {
    const err = Object.assign(new Error("Bad Request"), { status: 400 })
    const handler = vi.fn().mockRejectedValue(err)
    const wrapped = withSessionRecovery("write_abap_object_source", handler)
    await expect(wrapped({ connectionId: "S4" })).rejects.toThrow(/was not run again/)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("does retry activation, which is safe to repeat", async () => {
    const err = Object.assign(new Error("Bad Request"), { status: 400 })
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok")
    const wrapped = withSessionRecovery("abap_activate", handler)
    await expect(wrapped({})).resolves.toBe("ok")
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
