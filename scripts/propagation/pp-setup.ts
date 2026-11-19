/**
 * Principal propagation test set-up on a lab system (see docs/specs/001 phase 4 and
 * docs/PRINCIPAL_PROPAGATION.md). Modes: status (read only), apply, revert.
 *
 *   ABAP_MCP_CONFIG=<connections.json> node --require ts-node/register scripts/propagation/pp-setup.ts \
 *     --connection CAR --user BASIS --pki <dir with ca.crt, cc.crt, ca.key> --mode status|apply|revert [--no-proxy]
 *
 * apply: trusts <pki>/ca.crt in the SSL server Standard PSE, maps the DN of a user certificate
 * (CN=<user>, O=MCP Simulation, C=BE, issued by that CA) to <user>, and sets icm/trusted_reverse_proxy_0
 * to <pki>/cc.crt's subject and issuer (dynamic, a restart undoes it). revert undoes all three.
 */
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { runTemp, abapLiteral } from "../lib/runTemp"

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const connectionId = arg("connection")!, user = (arg("user") ?? "").toUpperCase(), pki = arg("pki")!
const mode = (arg("mode") ?? "status").toUpperCase()
if (!connectionId || !user || !pki || !["STATUS", "APPLY", "REVERT"].includes(mode)) {
  console.error("usage: --connection <id> --user <SAP user> --pki <dir> --mode status|apply|revert [--no-proxy]"); process.exit(2)
}
const der = (pem: string) => execFileSync("openssl", ["x509", "-in", pem, "-outform", "der"]).toString("base64")

// a sample user certificate, only so SAP renders its DN; the simulator issues its own per call
const sample = path.join(pki, `sample-${user}.crt`)
if (!fs.existsSync(sample)) {
  const key = path.join(pki, "sample.key"), csr = path.join(pki, "sample.csr")
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/C=BE/O=MCP Simulation/CN=${user}`], { stdio: "ignore" })
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", path.join(pki, "ca.crt"), "-CAkey", path.join(pki, "ca.key"), "-CAcreateserial", "-out", sample, "-days", "1"], { stdio: "ignore" })
}
const tpl = fs.readFileSync(path.join(__dirname, "zcl_mcp_pp_setup.abap"), "utf8")
const source = tpl.replace("{{MODE}}", mode).replace("{{SAP_USER}}", user).replace("{{WITH_PROXY}}", process.argv.includes("--no-proxy") ? "" : "X")
  .replace("{{CA_B64}}", abapLiteral(der(path.join(pki, "ca.crt"))))
  .replace("{{USER_B64}}", abapLiteral(der(sample)))
  .replace("{{PROXY_B64}}", abapLiteral(der(path.join(pki, "cc.crt"))))

runTemp(connectionId, "ZCL_MCP_PP_SETUP", source, s => { if (/❌|\[E\]/.test(s)) console.log(s) })
  .then(out => { console.log(out); process.exit(/ERROR /.test(out) ? 1 : 0) }, e => { console.error("FAILED:", e?.message ?? e); process.exit(1) })
