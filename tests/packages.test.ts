import { describe, it, expect, vi, beforeEach } from "vitest"
import { handleBrowsePackage, handleCreatePackage } from "../src/tools/packages"

vi.mock("../src/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections")>()),
  ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn(), log: vi.fn(),
}))
vi.mock("../src/tools/transportSql", () => ({
  lookupRequest: vi.fn(async (_conn: string | undefined, trkorr: string) => ({ trkorr, fn: "K", status: "D", owner: "DEV", text: "Test request" })),
  listOpenRequests: vi.fn(async () => []),
}))
import * as os from "os"
import * as path from "path"
process.env.ABAP_MCP_TRANSPORT_MEMORY = path.join(os.tmpdir(), `abap-mcp-pkg-test-${process.pid}.json`)
import { ensureConnected } from "../src/connections"

const mockClient = {
  nodeContents: vi.fn(),
  createObject: vi.fn(),
  transportInfo: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  mockClient.createObject.mockResolvedValue(undefined)
  mockClient.transportInfo.mockResolvedValue({ RECORDING: "X", DEVCLASS: "ZCAR_MM", TRANSPORTS: [] })
})

// ─── browse_package ───────────────────────────────────────────────────────────

describe("browse_package", () => {
  const nodes = [
    { OBJECT_TYPE: "PROG/P", OBJECT_NAME: "ZCAR_MM_ORDERS", TECH_NAME: "ZCAR_MM_ORDERS", OBJECT_URI: "/url/1", OBJECT_VIT_URI: "", EXPANDABLE: "", DESCRIPTION: "Order report" },
    { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_CAR_ORDER",  TECH_NAME: "ZCL_CAR_ORDER",  OBJECT_URI: "/url/2", OBJECT_VIT_URI: "", EXPANDABLE: "", DESCRIPTION: "Order class" },
    { OBJECT_TYPE: "DEVC/K",  OBJECT_NAME: "ZCAR_MM_HELPER", TECH_NAME: "ZCAR_MM_HELPER", OBJECT_URI: "/url/3", OBJECT_VIT_URI: "", EXPANDABLE: "X", DESCRIPTION: "Helper package" },
  ]

  it("returns objects grouped by type", async () => {
    mockClient.nodeContents.mockResolvedValue({ nodes, categories: [], objectTypes: [] })
    const result = await handleBrowsePackage({ packageName: "ZCAR_MM" })
    const text = result.content[0].text
    expect(text).toContain("ZCAR_MM")
    expect(text).toContain("PROG/P (1)")
    expect(text).toContain("ZCAR_MM_ORDERS")
    expect(text).toContain("Order report")
    expect(text).toContain("CLAS/OC (1)")
    expect(text).toContain("ZCL_CAR_ORDER")
    expect(text).toContain("DEVC/K (1)")
    expect(text).toContain("ZCAR_MM_HELPER")
  })

  it("marks expandable sub-packages with ▶", async () => {
    mockClient.nodeContents.mockResolvedValue({ nodes, categories: [], objectTypes: [] })
    const result = await handleBrowsePackage({ packageName: "ZCAR_MM" })
    expect(result.content[0].text).toContain("▶")
  })

  it("returns empty message for an empty package", async () => {
    mockClient.nodeContents.mockResolvedValue({ nodes: [], categories: [], objectTypes: [] })
    const result = await handleBrowsePackage({ packageName: "ZEMPTY" })
    expect(result.content[0].text).toContain("ZEMPTY is empty")
  })

  it("shows total object count", async () => {
    mockClient.nodeContents.mockResolvedValue({ nodes, categories: [], objectTypes: [] })
    const result = await handleBrowsePackage({ packageName: "ZCAR_MM" })
    expect(result.content[0].text).toContain("3 object(s)")
  })

  it("fetches sub-packages when includeSubPackages is true", async () => {
    mockClient.nodeContents
      .mockResolvedValueOnce({ nodes, categories: [], objectTypes: [] })       // parent
      .mockResolvedValueOnce({ nodes: [                                         // sub-package
        { OBJECT_TYPE: "PROG/P", OBJECT_NAME: "ZCAR_MM_UTIL", TECH_NAME: "ZCAR_MM_UTIL", OBJECT_URI: "/url/4", OBJECT_VIT_URI: "", EXPANDABLE: "", DESCRIPTION: "Utility" }
      ], categories: [], objectTypes: [] })

    const result = await handleBrowsePackage({ packageName: "ZCAR_MM", includeSubPackages: true })
    const text = result.content[0].text
    expect(mockClient.nodeContents).toHaveBeenCalledTimes(2)
    expect(text).toContain("ZCAR_MM_HELPER")
    expect(text).toContain("ZCAR_MM_UTIL")
    expect(text).toContain("─")   // section separator
  })

  it("does not call nodeContents for sub-packages when none exist", async () => {
    const noSubPkgs = nodes.filter(n => n.OBJECT_TYPE !== "DEVC/K")
    mockClient.nodeContents.mockResolvedValue({ nodes: noSubPkgs, categories: [], objectTypes: [] })
    await handleBrowsePackage({ packageName: "ZCAR_MM", includeSubPackages: true })
    expect(mockClient.nodeContents).toHaveBeenCalledTimes(1)
  })

  it("tolerates a failing sub-package fetch without breaking the result", async () => {
    mockClient.nodeContents
      .mockResolvedValueOnce({ nodes, categories: [], objectTypes: [] })
      .mockRejectedValueOnce(new Error("not found"))

    const result = await handleBrowsePackage({ packageName: "ZCAR_MM", includeSubPackages: true })
    // Parent result should still be returned
    expect(result.content[0].text).toContain("ZCAR_MM_ORDERS")
  })
})

// ─── create_package ───────────────────────────────────────────────────────────

describe("create_package", () => {
  it("asks for a transport when the package records and none is open", async () => {
    const result = await handleCreatePackage({ name: "ZCAR_MM_NEW", description: "New MM package", parentPackage: "ZCAR_MM" })
    expect(mockClient.createObject).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain("createTransport: true")
  })

  it("creates a package with required fields", async () => {
    mockClient.transportInfo.mockResolvedValue({ RECORDING: "", DEVCLASS: "$TMP" })
    const result = await handleCreatePackage({
      name: "ZCAR_MM_NEW",
      description: "New MM package",
      parentPackage: "ZCAR_MM",
    })
    expect(mockClient.createObject).toHaveBeenCalledWith(
      expect.objectContaining({
        objtype: "DEVC/K",
        name: "ZCAR_MM_NEW",
        parentName: "ZCAR_MM",
        description: "New MM package",
        parentPath: "/sap/bc/adt/packages/ZCAR_MM",
        packagetype: "development",
      })
    )
    const text = result.content[0].text
    expect(text).toContain("✅")
    expect(text).toContain("ZCAR_MM_NEW")
    expect(text).toContain("ZCAR_MM")
    expect(text).toContain("development")
  })

  it("passes optional fields through", async () => {
    await handleCreatePackage({
      name: "ZCAR_MAIN",
      description: "Main package",
      parentPackage: "ZCAR",
      packageType: "main",
      swComponent: "HOME",
      transportLayer: "Z",
      transport: "CARX000123",
    })
    expect(mockClient.createObject).toHaveBeenCalledWith(
      expect.objectContaining({
        packagetype: "main",
        swcomp: "HOME",
        transportLayer: "Z",
        transport: "CARX000123",
      })
    )
  })

  it("mentions the transport in the success message when provided", async () => {
    const result = await handleCreatePackage({
      name: "ZPKG",
      description: "Test",
      parentPackage: "ZROOT",
      transport: "CARX000099",
    })
    expect(result.content[0].text).toContain("CARX000099")
  })

  it("hints to use create_abap_object next", async () => {
    const result = await handleCreatePackage({
      name: "ZPKG",
      description: "Test",
      parentPackage: "ZROOT",
    })
    expect(result.content[0].text).toContain("create_abap_object")
    expect(result.content[0].text).toContain("ZPKG")
  })
})
