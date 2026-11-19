/**
 * Show, set or clear icm/trusted_reverse_proxy_0 (the Cloud Connector header path) in the running ICM of a lab system:
 *   ABAP_MCP_CONFIG=<cfg> node --require ts-node/register scripts/propagation/pp-profile.ts --connection CAR --pki <dir> --mode show|set|clear
 * set: SUBJECT/ISSUER of <pki>/cc.crt as SAP renders them. Runtime only (SMICM change value): no profile is written, an ICM restart drops it.
 */
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { runTemp } from "../lib/runTemp"

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const connectionId = arg("connection")!, pki = arg("pki")!, mode = (arg("mode") ?? "show").toUpperCase()
const dn = (which: "subject" | "issuer") => execFileSync("openssl", ["x509", "-in", path.join(pki, "cc.crt"), "-noout", `-${which}`, "-nameopt", "RFC2253"]).toString().replace(/^\w+=/, "").trim()
// SAP renders a DN as "CN=…, O=…, C=…" (most specific first, comma and space)
const sapDn = (rfc2253: string) => rfc2253.split(/,(?=[A-Z]+=)/).join(", ")
const value = `SUBJECT="${sapDn(dn("subject"))}", ISSUER="${sapDn(dn("issuer"))}"`
const src = fs.readFileSync(path.join(__dirname, "zcl_mcp_pp_profile.abap"), "utf8").replace("{{MODE}}", mode).replace("{{VALUE}}", value.replace(/'/g, "''"))
runTemp(connectionId, "ZCL_MCP_PP_PROFILE", src, s => { if (/❌|\[E\]/.test(s)) console.log(s) })
  .then(o => { console.log(o); process.exit(0) }, e => { console.error("FAILED:", e?.message ?? e); process.exit(1) })
