/**
 * End-to-end identity test through the simulated SAP MCP Gateway chain (src/gateway/simulator.ts):
 * an MCP client calls the gateway's tools as a signed-in user; the Cloud Connector simulator turns
 * the token into a short-lived X.509 certificate and calls SAP; the engine says who SAP sees.
 *
 *   node --require ts-node/register scripts/propagation/e2e.ts --pki <dir> --sap https://sap.example.com:44300 \
 *     --client 600 --user BASIS [--resolve sap.example.com=10.0.0.10] [--mode direct|header] [--skew-minutes 150]
 *
 * Prints one line per scenario (PASS / FAIL with what came back) and exits 1 on any FAIL.
 */
import * as path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createIdp, createGatewayServer, cloudConnectorCall, type CloudConnectorOptions } from "../../src/gateway/simulator"

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const pkiDir = arg("pki")!, sapUrl = arg("sap")!, sapClient = arg("client", "600")!, user = arg("user", "BASIS")!.toUpperCase()
const mode = (arg("mode", "direct") as "direct" | "header")
const skew = Number(arg("skew-minutes", "0"))
const resolve = Object.fromEntries((arg("resolve") ?? "").split(",").filter(Boolean).map(p => p.split("=")))
const pki = { dir: pkiDir, caCert: path.join(pkiDir, "ca.crt"), caKey: path.join(pkiDir, "ca.key"), ccCert: path.join(pkiDir, "cc.crt"), ccKey: path.join(pkiDir, "cc.key") }

const idp = createIdp()
const foreignIdp = createIdp(idp.issuer, idp.audience)   // same names, other key: a forged token

async function gatewayClient(token: () => string | undefined, cc: Partial<CloudConnectorOptions> = {}, set: "cust" | "abap" = "cust") {
  const ccOpts: CloudConnectorOptions = { idp, pki, mode, sapUrl, sapClient, resolve, clockSkewMinutes: skew, ...cc }
  const server = createGatewayServer({ idp, token, set, forward: (t, p, b) => cloudConnectorCall(ccOpts, t, p, b) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: "agent", version: "1" })
  await client.connect(b)
  return client
}

const results: [string, boolean, string][] = []
async function scenario(name: string, token: () => string | undefined, tool: string, args: Record<string, unknown>, expect: RegExp, cc: Partial<CloudConnectorOptions> = {}, set: "cust" | "abap" = "cust") {
  const client = await gatewayClient(token, cc, set)
  let text: string
  try {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180_000 })
    text = (r.content as { text: string }[]).map(c => c.text).join("\n")
  } catch (e) { text = `ERROR ${(e as Error).message}` }
  await client.close()
  const ok = expect.test(text.replace(/\s+/g, " "))
  results.push([name, ok, text.replace(/\s+/g, " ").slice(0, 220)])
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${text.replace(/\s+/g, " ").slice(0, 220)}`)
}

;(async () => {
  console.log(`Chain: agent → gateway (OpenAPI tools) → Cloud Connector (${mode}) → ${sapUrl} client ${sapClient}\n`)
  const good = () => idp.issue(user)
  const tools = await (await gatewayClient(good)).listTools()
  console.log(`Gateway offers ${tools.tools.length} tools: ${tools.tools.map(t => t.name).join(", ")}\n`)

  await scenario(`${user} signed in: SAP sees ${user}, logged on by certificate`, good, "whoami", {},
    new RegExp(`HTTP 200 .*${user} on .*logged on by X\\.509 client certificate`))
  await scenario("read through the gateway (BW capabilities) as that user", good, "bw_capabilities", {}, /HTTP 200 .*ok: .*BW on this system|HTTP 200 .*ok/)
  // a customizing copy (units of measure, KG → ZZ9) exists on every ABAP system; without commit nothing is written
  await scenario("write tool stays a dry run without commit", good, "write",
    { table: "T006", key_field: "MSEHI", source_key: "KG", target_key: "ZZ9" }, /HTTP 200 .*ok: DRY RUN/)
  await scenario("no sign-in: the gateway refuses, SAP is never called", () => undefined, "whoami", {}, /Gateway refused the call: no token/)
  await scenario("forged token (other key): refused", () => foreignIdp.issue(user), "whoami", {}, /Gateway refused the call: signature/)
  await scenario("expired token: refused", () => idp.issue(user, { ttlSeconds: -5 }), "whoami", {}, /Gateway refused the call: token expired/)
  await scenario("token for a user SAP does not map (JDOE): SAP refuses the logon", () => idp.issue("JDOE"), "whoami", {}, /HTTP 401/)
  // A certificate from a CA SAP does not trust must not log on. Direct mode: ICM refuses it in the TLS
  // handshake. Header mode: ICM trusts the proxy and does NOT check the forwarded certificate's issuer, so
  // only a mapping bound to the issuer (VUSREXTID with issuer, or a CERTRULE rule per issuer) refuses it.
  await scenario("certificate from a CA SAP does not trust: refused", good, "whoami", {}, /^(?!.*HTTP 200).*(Cloud Connector refused the call|HTTP 401)/,
    { signWith: { cert: path.join(pkiDir, "rogue.crt"), key: path.join(pkiDir, "rogue.key") } })

  // the second gateway server: read-only ABAP through the engine, as the same user
  const abapTools = await (await gatewayClient(good, {}, "abap")).listTools()
  console.log(`\nABAP gateway server offers ${abapTools.tools.length} tools: ${abapTools.tools.map(t => t.name).join(", ")}\n`)
  await scenario("read ABAP source through the gateway as that user", good, "abap_source", { object_type: "PROG", name: "ZMCP_CUST_WRITE" },
    /HTTP 200 .*ok: .*REPORT zmcp_cust_write/i, {}, "abap")
  await scenario("find ABAP objects through the gateway (only what the user may display)", good, "abap_search", { pattern: "ZCL_MCP_*" },
    /HTTP 200 .*ok: .*ZCL_MCP_CUST_ENGINE/, {}, "abap")
  await scenario("no sign-in: the ABAP server refuses too", () => undefined, "abap_source", { object_type: "PROG", name: "ZMCP_CUST_WRITE" },
    /Gateway refused the call: no token/, {}, "abap")

  const failed = results.filter(r => !r[1]).length
  console.log(`\n${results.length - failed}/${results.length} scenarios passed (${mode} mode)`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error("E2E ERROR", e); process.exit(2) })
