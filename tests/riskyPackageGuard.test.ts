import { describe, it, expect } from "vitest"
import { riskyPackageGuard } from "../src/tools/customizingEngine"
import type { ResolvedMaint } from "../src/tools/customizing"

// docs/audit-2026-07-07-transport-handling.md, debugger-verified with wp_detail:
// a headless VIEW_MAINTENANCE_SINGLE_ENTRY commit into a view whose PACKAGE
// carries a Switch Framework assignment can run for 12+ hours without
// terminating (V_TOIJRMOT, package OIJ, switch OIJ_TSW) — confirmed a second
// time 2026-09-03 (V_OIJNOM_ST03, same package/switch, cancelled at 27+ min).
//
// The discriminator is package switch-gating, NOT view-cluster membership:
// V_TOIJRMOT is not a cluster member and still hung; /POSDW/GPAP IS a cluster
// member in a non-switch-gated package and wrote in seconds (2026-06-10). An
// earlier version of this guard gated on cluster membership and would have
// gotten both of those backwards.

function maint(overrides: Partial<ResolvedMaint> = {}): ResolvedMaint {
  return {
    input: "TEST",
    isView: true,
    rootTable: "TEST",
    tables: ["TEST"],
    maintObject: "V_TEST",
    recordObject: "VDAT",
    transport: { object: "VDAT", name: "V_TEST" },
    ...overrides,
  }
}

describe("riskyPackageGuard", () => {
  it("refuses a plain view in a switch-gated package (the V_TOIJRMOT case — no cluster involved)", () => {
    const m = maint({ maintObject: "V_TOIJRMOT", devclass: "OIJ", switchId: "OIJ_TSW" })
    const msg = riskyPackageGuard(m, "TOIJTSWMOT")
    expect(msg).toBeDefined()
    expect(msg).toContain("V_TOIJRMOT")
    expect(msg).toContain("OIJ_TSW")
    expect(msg).not.toContain("cluster member") // no cluster set — must not claim one
  })

  it("refuses the view-cluster member that hung 2026-09-03, and names the cluster as incidental", () => {
    const m = maint({
      maintObject: "V_OIJNOM_ST03",
      devclass: "OIJ",
      switchId: "OIJ_TSW",
      cluster: "VC_OIJNOMST",
    })
    const msg = riskyPackageGuard(m, "TOIJNOM_ST03")
    expect(msg).toBeDefined()
    expect(msg).toContain("VC_OIJNOMST")
    expect(msg).toContain("not the cause")
  })

  it("allows a view-cluster member in a package with no switch assignment (the /POSDW/GPAP case)", () => {
    const m = maint({ maintObject: "/POSDW/V_GPAP", devclass: "/POSDW/RETAIL", cluster: "/POSDW/VC_GPAP" })
    expect(riskyPackageGuard(m, "/POSDW/GPAP")).toBeUndefined()
  })

  it("allows a plain view in a non-switch-gated package (the V_TVTR case)", () => {
    const m = maint({ maintObject: "V_TVTR", devclass: "VZ0C" })
    expect(riskyPackageGuard(m, "TVTR")).toBeUndefined()
  })

  it("allows a single-table (no view) maintenance object", () => {
    const m = maint({ isView: false, maintObject: "T001L", recordObject: "TABU", devclass: "SANY" })
    expect(riskyPackageGuard(m, "T001L")).toBeUndefined()
  })
})
