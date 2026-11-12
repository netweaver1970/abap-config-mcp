import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// A fake ADT client per construction, remembering who it logs on as.
const calls: string[] = []
const created: Array<{ url: string; user: string; password: string; login: ReturnType<typeof vi.fn> }> = []
vi.mock("abap-adt-api", () => ({
  session_types: { stateful: "stateful" },
  createSSLConfig: () => ({}),
  ADTClient: class {
    login = vi.fn(async () => { calls.push(`login ${this.user}`) })
    dropSession = vi.fn(async () => { calls.push(`drop ${this.user}`) })
    unLock = vi.fn(async () => undefined)
    stateful: unknown
    username: string
    constructor(public url: string, public user: string, public password: string) {
      this.username = user
      created.push(this as any)
    }
  },
}))

const conns: any[] = []
vi.mock("../src/config", () => ({ loadConfig: () => ({ connections: conns }) }))

import {
  ensureConnected, runInSession, getConnectionConfig, applySessionCredentials, endSessionCredentials,
  closeSessionConnections, listSessions, stopKeepAlive, setServerBindLoopback,
} from "../src/connections"
import { parseLogonHeaders, headerId, credentialsFor, captureCredentials, missingCredentialsMessage, sessionsWithCredentials } from "../src/logon"
import { callRfc, resetSoapRfcState, setSoapTransport } from "../src/soapRfc/client"
import { handleConnectedSystems } from "../src/tools/discovery"

const SECRET = "s3cret-pw!"

function setConns() {
  conns.length = 0
  conns.push(
    { id: "S4", url: "https://s4", username: "SHARED", password: "sharedpw", client: "100" },
    { id: "car-2", url: "https://car", username: "", password: "", logon: "per-user", client: "600" },
    { id: "OLD", url: "https://old", username: "", password: "", logon: "per-user", protocol: "soap-rfc" },
  )
}

let logs: string[] = []
beforeEach(async () => {
  stopKeepAlive()
  for (const s of listSessions()) await closeSessionConnections(s.sessionId)
  for (const s of sessionsWithCredentials()) endSessionCredentials(s)
  created.length = 0
  calls.length = 0
  setConns()
  resetSoapRfcState()
  logs = []
  for (const m of ["log", "error", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")) })
  setServerBindLoopback(true)
})
afterEach(() => vi.restoreAllMocks())

describe("logon headers", () => {
  it("normalises connection ids", () => {
    expect(headerId("car-2")).toBe("CAR_2")
    expect(headerId("S4.dev")).toBe("S4_DEV")
  })

  it("reads generic and per-connection headers, case-insensitively", () => {
    const p = parseLogonHeaders({ "X-SAP-User": "ANNA", "x-sap-password": "pw1", "X-Sap-User-Car_2": "BOB", "X-SAP-PASSWORD-CAR_2": "pw2", host: "x" })
    expect(p.generic).toEqual({ username: "ANNA", password: "pw1" })
    expect(p.byConnection.get("CAR_2")).toEqual({ username: "BOB", password: "pw2" })
  })

  it("lets the per-connection header win and does not mix a generic password with a specific user", () => {
    captureCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pw1", "x-sap-user-car_2": "BOB", "x-sap-password-car_2": "pw2" })
    expect(credentialsFor("a", "car-2")).toEqual({ username: "BOB", password: "pw2" })
    expect(credentialsFor("a", "other")).toEqual({ username: "ANNA", password: "pw1" })
    captureCredentials("b", { "x-sap-user": "ANNA", "x-sap-password": "pw1", "x-sap-user-car_2": "BOB" })
    expect(credentialsFor("b", "car-2")).toBeUndefined()
  })
})

describe("effective config per session", () => {
  it("gives each session its own user on a per-user connection", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa" })
    await applySessionCredentials("b", { "x-sap-user": "BOB", "x-sap-password": "pb" })
    expect(runInSession("a", () => getConnectionConfig("car-2"))).toMatchObject({ username: "ANNA", password: "pa", url: "https://car", client: "600" })
    expect(runInSession("b", () => getConnectionConfig("car-2")).username).toBe("BOB")
    await runInSession("a", () => ensureConnected("car-2"))
    await runInSession("b", () => ensureConnected("car-2"))
    expect(created.map(c => c.user).sort()).toEqual(["ANNA", "BOB"])
  })

  it("leaves shared connections alone and ignores headers for them", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa", "x-sap-user-s4": "ANNA", "x-sap-password-s4": "pa" })
    const cfg = runInSession("a", () => getConnectionConfig("S4"))
    expect(cfg.username).toBe("SHARED")
    expect(cfg.password).toBe("sharedpw")
    await runInSession("a", () => ensureConnected("S4"))
    expect(created[0].user).toBe("SHARED")
  })

  it("fails with a three-part message when the client sent no user, in a session and outside one", async () => {
    for (const run of [() => runInSession("none", () => getConnectionConfig("car-2")), () => getConnectionConfig("car-2")]) {
      try { run(); expect.unreachable() } catch (e) {
        const m = (e as Error).message
        expect(m).toContain("Logging on to car-2")
        expect(m).toContain("set to per-user logon and this client sent no SAP user")
        expect(m).toContain("X-SAP-User and X-SAP-Password")
        expect(m).toContain("X-SAP-User-CAR_2")
      }
    }
    await expect(runInSession("none", () => ensureConnected("car-2"))).rejects.toThrow(/per-user logon/)
    expect(created).toHaveLength(0)
  })

  it("a user without a password counts as no logon", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA" })
    expect(() => runInSession("a", () => getConnectionConfig("car-2"))).toThrow(/per-user logon/)
  })

  it("drops the session's connection when the user changes, and logs on as the new user", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa" })
    await runInSession("a", () => ensureConnected("car-2"))
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa" })   // unchanged: kept
    expect(listSessions()).toHaveLength(1)
    await applySessionCredentials("a", { "x-sap-user": "CARL", "x-sap-password": "pc" })
    expect(listSessions()).toHaveLength(0)
    expect(calls).toContain("drop ANNA")
    await runInSession("a", () => ensureConnected("car-2"))
    expect(created.map(c => c.user)).toEqual(["ANNA", "CARL"])
  })

  it("does not touch another session or a shared connection when a user changes", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa" })
    await applySessionCredentials("b", { "x-sap-user": "BOB", "x-sap-password": "pb" })
    await runInSession("a", () => ensureConnected("S4"))
    await runInSession("a", () => ensureConnected("car-2"))
    await runInSession("b", () => ensureConnected("car-2"))
    await applySessionCredentials("a", { "x-sap-user": "CARL", "x-sap-password": "pc" })
    expect(listSessions().map(s => `${s.connectionId}/${s.sessionId}`).sort()).toEqual(["S4/a", "car-2/b"])
  })

  it("clears the credentials when the session closes", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa" })
    expect(credentialsFor("a", "car-2")).toBeDefined()
    endSessionCredentials("a")
    expect(credentialsFor("a", "car-2")).toBeUndefined()
    expect(() => runInSession("a", () => getConnectionConfig("car-2"))).toThrow(/per-user logon/)
  })
})

describe("SOAP refusal state is per user", () => {
  it("one user's 401 does not stop another user's calls", async () => {
    const seenUsers: string[] = []
    setSoapTransport(async cfg => {
      seenUsers.push(cfg.username)
      if (cfg.username === "ANNA" && cfg.password === "bad") return { status: 401, body: "<html>no</html>" }
      return { status: 200, body: `<E:Envelope xmlns:E="x"><E:Body><n:RFC_READ_TABLE.Response xmlns:n="y"/></E:Body></E:Envelope>` }
    })
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "bad" })
    await applySessionCredentials("b", { "x-sap-user": "BOB", "x-sap-password": "good" })
    await expect(runInSession("a", () => callRfc("OLD", "RFC_READ_TABLE", {}))).rejects.toThrow(/refused the logon of ANNA/)
    await expect(runInSession("a", () => callRfc("OLD", "RFC_READ_TABLE", {}))).rejects.toThrow(/No further calls/)
    expect(seenUsers).toEqual(["ANNA"])
    await runInSession("b", () => callRfc("OLD", "RFC_READ_TABLE", {}))
    expect(seenUsers).toEqual(["ANNA", "BOB"])
    // ANNA, with a corrected password, is tried again.
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "fixed" })
    await runInSession("a", () => callRfc("OLD", "RFC_READ_TABLE", {}))
    expect(seenUsers).toEqual(["ANNA", "BOB", "ANNA"])
  })
})

describe("connected_systems", () => {
  it("shows the session's user, or that none was sent, never a password", async () => {
    const none = (await runInSession("x", () => handleConnectedSystems())).content[0].text
    expect(none).toContain("car-2: https://car (per-user logon: this client sent no SAP user")
    expect(none).toContain("S4: https://s4 (user: SHARED")
    await applySessionCredentials("x", { "x-sap-user": "ANNA", "x-sap-password": SECRET })
    const some = (await runInSession("x", () => handleConnectedSystems())).content[0].text
    expect(some).toContain("car-2: https://car (user: ANNA (per-user)")
    expect(some).not.toContain(SECRET)
    expect(some).not.toContain("sharedpw")
  })
})

describe("passwords stay out of logs and errors", () => {
  it("never appears in log output or error messages", async () => {
    setServerBindLoopback(false)
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": SECRET })
    await runInSession("a", () => ensureConnected("car-2"))
    await applySessionCredentials("a", { "x-sap-user": "CARL", "x-sap-password": SECRET + "2" })
    setSoapTransport(async () => ({ status: 401, body: "<html/>" }))
    const err = await runInSession("a", () => callRfc("OLD", "RFC_READ_TABLE", {})).catch(e => e as Error)
    const all = [...logs, (err as Error).message, missingCredentialsMessage("car-2")].join("\n")
    expect(all).not.toContain(SECRET)
    expect(logs.join("\n")).toContain("as ANNA (per-user)")
    expect(logs.filter(l => /credentials travel in HTTP headers/.test(l))).toHaveLength(1)
  })

  it("does not warn when the server is bound to loopback", async () => {
    await applySessionCredentials("a", { "x-sap-user": "ANNA", "x-sap-password": "pa" })
    expect(logs.join("\n")).not.toContain("credentials travel")
  })
})

describe("loadConfig validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perUser-"))
  async function load(connections: unknown[]) {
    const file = path.join(dir, `c${Math.random()}.json`)
    fs.writeFileSync(file, JSON.stringify({ connections }))
    process.env.ABAP_MCP_CONFIG = file
    vi.resetModules()
    vi.doUnmock("../src/config")
    const actual = await vi.importActual<typeof import("../src/config")>("../src/config")
    return actual.loadConfig()
  }
  afterEach(() => { delete process.env.ABAP_MCP_CONFIG })

  it("accepts a per-user connection without username and password", async () => {
    const cfg = await load([{ id: "A", url: "https://a", logon: "per-user" }])
    expect(cfg.connections[0].logon).toBe("per-user")
  })

  it("ignores a username and password in the file for a per-user connection", async () => {
    const cfg = await load([{ id: "A", url: "https://a", logon: "per-user", username: "X", password: "Y" }])
    expect(cfg.connections[0].username).toBe("")
    expect(cfg.connections[0].password).toBe("")
  })

  it("still rejects a shared connection without them", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit") }) as never)
    await expect(load([{ id: "A", url: "https://a" }])).rejects.toThrow("exit")
    await expect(load([{ id: "A", url: "https://a", logon: "shared", username: "U" }])).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(1)
    const cfg = await load([{ id: "A", url: "https://a", username: "U", password: "P" }])
    expect(cfg.connections[0].username).toBe("U")
  })

  it("rejects an unknown logon value", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit") }) as never)
    await expect(load([{ id: "A", url: "https://a", logon: "peruser", username: "U", password: "P" }])).rejects.toThrow("exit")
  })
})
