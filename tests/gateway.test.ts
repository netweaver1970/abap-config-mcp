import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as crypto from "crypto"
import { execFileSync } from "child_process"
import { buildOpenApi, GATEWAY_OPERATIONS, GATEWAY_TOOL_LIMIT, GATEWAY_SETS, ABAP_GATEWAY_OPERATIONS } from "../src/gateway/openapi"
import { createIdp, verifyToken, issueUserCert, createGatewayServer, type SapCall } from "../src/gateway/simulator"
import { getEngineSource } from "../src/abap/zcl_mcp_cust_engine"
import { getBwEngineSource } from "../src/abap/zcl_mcp_bw_engine"
import { getAbapEngineSource } from "../src/abap/zcl_mcp_abap_engine"

describe("the engine's OpenAPI for SAP's MCP Gateway", () => {
  const api = buildOpenApi() as { openapi: string; paths: Record<string, { post: { operationId: string; requestBody: { content: { "application/json": { schema: { properties: object; required?: string[] } } } } } }> }

  it("fits the gateway: at most 30 operations, OpenAPI 3.0.x, one POST per path", () => {
    expect(GATEWAY_OPERATIONS.length).toBeLessThanOrEqual(GATEWAY_TOOL_LIMIT)
    expect(api.openapi).toMatch(/^3\.0\./)
    expect(Object.keys(api.paths)).toHaveLength(GATEWAY_OPERATIONS.length)
  })

  it("every operation is one the engine dispatches, and every required field is described", () => {
    const dispatched = new Set([...getEngineSource().matchAll(/WHEN '([a-z_]+)'\.\s/g), ...getBwEngineSource().matchAll(/WHEN '(bw_[a-z_]+)'\./g)].map(m => m[1]))
    for (const o of GATEWAY_OPERATIONS) {
      expect(dispatched.has(o.op), o.op).toBe(true)
      for (const r of o.required ?? []) expect(Object.keys(o.props), `${o.op}.${r}`).toContain(r)
    }
  })

  it("the engine takes the operation from the path when the body does not name it", () => {
    expect(getEngineSource()).toContain("get_header_field( '~path_info' )")
    expect(getEngineSource()).toContain("WHEN 'whoami'.")
  })

  it("every docs/gateway/*.openapi.json is current (npm run openapi)", () => {
    for (const [set, def] of Object.entries(GATEWAY_SETS)) {
      const file = path.resolve(__dirname, "..", "docs", "gateway", def.file)
      expect(fs.readFileSync(file, "utf8"), def.file).toBe(JSON.stringify(buildOpenApi(set as never), null, 2) + "\n")
    }
  })

  it("the read-only ABAP set fits one gateway server, is all reads, and the ABAP class dispatches each", () => {
    expect(ABAP_GATEWAY_OPERATIONS.length).toBeLessThanOrEqual(GATEWAY_TOOL_LIMIT)
    const src = getAbapEngineSource()
    for (const o of ABAP_GATEWAY_OPERATIONS) {
      expect(o.write, o.op).toBeFalsy()
      expect(src, o.op).toContain(`WHEN '${o.op}'.`)
      for (const r of o.required ?? []) expect(Object.keys(o.props), `${o.op}.${r}`).toContain(r)
    }
  })
})

describe("the simulated chain", () => {
  const idp = createIdp()

  it("a token from the trusted IdP verifies; forged, foreign, expired and missing ones do not", () => {
    expect(verifyToken(idp.issue("BASIS"), idp).user_name).toBe("BASIS")
    expect(() => verifyToken(createIdp(idp.issuer, idp.audience).issue("BASIS"), idp)).toThrow(/signature/)
    expect(() => verifyToken(idp.issue("BASIS", { issuer: "https://evil" }), idp)).toThrow(/issuer/)
    expect(() => verifyToken(idp.issue("BASIS", { audience: "other" }), idp)).toThrow(/audience/)
    expect(() => verifyToken(idp.issue("BASIS", { ttlSeconds: -10 }), idp)).toThrow(/expired/)
    expect(() => verifyToken(undefined, idp)).toThrow(/did not sign in/)
  })

  it("Cloud Connector's certificate carries the user from the subject pattern and lives minutes, not days", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pki-"))
    const ca = { cert: path.join(dir, "ca.crt"), key: path.join(dir, "ca.key") }
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", ca.key, "-out", ca.cert, "-days", "1", "-subj", "/CN=Test CA"], { stdio: "ignore" })
    const c = issueUserCert(verifyToken(idp.issue("JDOE"), idp), "CN=${user_name},O=MCP Simulation,C=BE", ca, 5)
    const x = new crypto.X509Certificate(c.certPem)
    expect(x.subject.replace(/\n/g, ",")).toBe("C=BE,O=MCP Simulation,CN=JDOE")
    expect(x.checkIssued(new crypto.X509Certificate(fs.readFileSync(ca.cert)))).toBe(true)
    expect(new Date(x.validTo).getTime() - Date.now()).toBeLessThan(6 * 60_000)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("the gateway shows one tool per operation, refuses without a valid token, and forwards the token", async () => {
    let token: string | undefined
    const calls: { token: string; path: string; body: unknown }[] = []
    const server = createGatewayServer({ idp, token: () => token, forward: async (t, p, b) => { calls.push({ token: t, path: p, body: b }); return { status: 200, body: JSON.stringify({ STATUS: "ok", MESSAGES: ["BASIS on CAR/600, logged on by X.509 client certificate"] }), userCertSubject: "CN=BASIS" } as SapCall } })
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools
    expect(Object.keys(tools)).toHaveLength(GATEWAY_OPERATIONS.length)
    const refused = await tools.whoami.handler({}, {})
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toMatch(/Gateway refused the call: no token/)
    expect(calls).toHaveLength(0)
    token = idp.issue("BASIS")
    const r = await tools.bw_delete.handler({ tlogo: "IOBJ", name: "ZX", commit: false }, {})
    expect(r.content[0].text).toContain("logged on by X.509 client certificate")
    expect(calls[0]).toMatchObject({ token, path: "/sap/bc/zmcp_cust/bw_delete", body: { tlogo: "IOBJ", name: "ZX", commit: "" } })
  })
})
