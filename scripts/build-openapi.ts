/** Writes docs/gateway/<set>.openapi.json, one per gateway MCP server (the engine's OpenAPI for SAP's MCP Gateway). Run: npm run openapi */
import * as fs from "fs"
import * as path from "path"
import { buildOpenApi, GATEWAY_SETS, type GatewaySet } from "../src/gateway/openapi"
for (const set of Object.keys(GATEWAY_SETS) as GatewaySet[]) {
  const out = path.resolve(__dirname, "..", "docs", "gateway", GATEWAY_SETS[set].file)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(buildOpenApi(set), null, 2) + "\n")
  console.log(`wrote ${path.relative(process.cwd(), out)} (${GATEWAY_SETS[set].ops.length} operations)`)
}
