import { describe, it, expect, vi } from "vitest"
import { resolveMaint } from "../src/tools/customizing"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  log: vi.fn(),
}))

// A fake ADT client whose freestyle SQL answers from fixtures (first match wins),
// shaped like CAR's /POSDW/VC_TASKSG and /POSDW/VC_STOGR (2026-10-22).
function fakeClient(answers: Array<[RegExp, Array<Record<string, string>>]>) {
  const runQuery = vi.fn(async (sql: string) => {
    const rows = answers.find(([re]) => re.test(sql))?.[1] ?? []
    return { columns: (rows[0] ? Object.keys(rows[0]) : ["X"]).map(name => ({ name })), values: rows }
  })
  return { statelessClone: { runQuery } } as any
}

describe("resolveMaint for view clusters", () => {
  it("records a cluster member as R3TR CDAT <cluster>, written through the member view", async () => {
    const c = fakeClient([
      [/FROM DD25L WHERE VIEWNAME = '\/POSDW\/V_STOGR'/, [{ VIEWNAME: "/POSDW/V_STOGR", AGGTYPE: "V", ROOTTAB: "/POSDW/STOGR", VIEWCLASS: "C" }]],
      [/FROM DD26S WHERE VIEWNAME = '\/POSDW\/V_STOGR'/, [{ TABNAME: "/POSDW/STOGR", TABPOS: "1" }, { TABNAME: "/POSDW/STOGRT", TABPOS: "2" }]],
      [/FROM TVDIR WHERE TABNAME = '\/POSDW\/V_STOGR'/, [{ AREA: "/POSDW/CUST_STOG", TYPE: "1", DEVCLASS: "/POSDW/CUSTOMIZING" }]],
      [/FROM VCLSTRUC WHERE OBJECT = '\/POSDW\/V_STOGR'/, [{ VCLNAME: "/POSDW/VC_STOGR" }]],
    ])
    const m = await resolveMaint(c, "/POSDW/V_STOGR")
    expect(m.maintObject).toBe("/POSDW/V_STOGR")
    expect(m.recordObject).toBe("CDAT")
    expect(m.cluster).toBe("/POSDW/VC_STOGR")
    expect(m.transport).toEqual({ object: "CDAT", name: "/POSDW/VC_STOGR" })
  })

  it("drives a view variant through the maintenance view it is a variant of", async () => {
    const c = fakeClient([
      [/FROM DD25L WHERE VIEWNAME = '\/POSDW\/V_GPAC3'/, [{ VIEWNAME: "/POSDW/V_GPAC3", AGGTYPE: "V", ROOTTAB: "/POSDW/V_GPAC", VIEWCLASS: "V" }]],
      [/FROM DD25L WHERE VIEWNAME = '\/POSDW\/V_GPAC'/, [{ VIEWNAME: "/POSDW/V_GPAC", AGGTYPE: "V", ROOTTAB: "/POSDW/GPAC", VIEWCLASS: "C" }]],
      [/FROM DD26S WHERE VIEWNAME = '\/POSDW\/V_GPAC'/, [{ TABNAME: "/POSDW/GPAC", TABPOS: "1" }]],
      [/FROM TVDIR WHERE TABNAME = '\/POSDW\/V_GPAC'/, [{ TABNAME: "/POSDW/V_GPAC", AREA: "/POSDW/CUST_PAR", TYPE: "1" }]],
      [/FROM VCLSTRUC WHERE OBJECT = '\/POSDW\/V_GPAC3'/, [{ VCLNAME: "/POSDW/VC_TASKSG" }]],
    ])
    const m = await resolveMaint(c, "/POSDW/V_GPAC3")
    expect(m.variant).toBe("/POSDW/V_GPAC3")
    expect(m.maintObject).toBe("/POSDW/V_GPAC")
    expect(m.rootTable).toBe("/POSDW/GPAC")
    expect(m.recordObject).toBe("CDAT")
    expect(m.cluster).toBe("/POSDW/VC_TASKSG")
  })

  it("never drives a view that has no generated maintenance", async () => {
    const c = fakeClient([
      [/FROM DD25L WHERE VIEWNAME = 'ZV_NOMAINT'/, [{ VIEWNAME: "ZV_NOMAINT", AGGTYPE: "V", ROOTTAB: "ZTAB", VIEWCLASS: "C" }]],
      [/FROM DD26S WHERE VIEWNAME = 'ZV_NOMAINT'/, [{ TABNAME: "ZTAB", TABPOS: "1" }]],
    ])
    const m = await resolveMaint(c, "ZV_NOMAINT")
    expect(m.maintObject).toBe("")
    expect(m.recordObject).toBeUndefined()
  })

  it("passes a degraded session on instead of reading it as 'no rows'", async () => {
    const c = { statelessClone: { runQuery: vi.fn(async () => { throw Object.assign(new Error("Request failed with status code 400"), { err: 400 }) }) } } as any
    await expect(resolveMaint(c, "/POSDW/V_STOGR")).rejects.toThrow(/400/)
  })
})
