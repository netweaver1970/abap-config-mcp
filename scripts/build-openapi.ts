/** Writes docs/gateway/zmcp_cust.openapi.json (the engine's OpenAPI for SAP's MCP Gateway). Run: npm run openapi */
import * as fs from "fs"
import * as path from "path"
import { buildOpenApi } from "../src/gateway/openapi"
const out = path.resolve(__dirname, "..", "docs", "gateway", "zmcp_cust.openapi.json")
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n")
console.log(`wrote ${path.relative(process.cwd(), out)}`)
