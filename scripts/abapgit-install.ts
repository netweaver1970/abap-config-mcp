/**
 * Install the engine on a system through abapGit, headless (the installed abapGit's own offline
 * import and pull, not ADT writes of the engine objects). For testing the abapGit route on lab
 * systems; customers use abapGit's GUI with abapgit/ or the release zip.
 *
 *   ABAP_MCP_CONFIG=<connections.json> node --require ts-node/register scripts/abapgit-install.ts \
 *     --connection CAR --package '$MCP_ENGINE' [--transport CARK900040] [--abapgit ZABAPGIT_STANDALONE] [--verify]
 *
 * --verify then exports the package with abapGit's own serializer and compares it file by file with
 * the repository: no difference means abapGit sees nothing to pull, i.e. the files round-trip.
 *
 * Over ADT it only creates, runs and deletes temporary classes in $TMP: ZCL_MCP_AG_INSTALL carries the
 * repository zip and calls abapGit; ZCL_MCP_AG_EXPORT (--verify) calls abapGit's export. The package must exist.
 */
import * as fs from "fs"
import * as path from "path"
import { inflateRawSync } from "zlib"
import { buildAbapGitFiles, zipFiles, ABAPGIT_ENGINE_VERSION } from "../src/abap/abapgitRepo"
import { handleCreateAbapObject, handleWriteAbapObjectSource, handleDeleteAbapObject } from "../src/tools/write"
import { handleAbapActivate } from "../src/tools/activate"
import { handleRunClass } from "../src/tools/quality"

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const connectionId = arg("connection")!
const pkg = arg("package")!.toUpperCase()
const transport = (arg("transport") ?? "").toUpperCase()
const abapgit = (arg("abapgit") ?? "ZABAPGIT_STANDALONE").toUpperCase()
if (!connectionId || !pkg) { console.error("usage: --connection <id> --package <package> [--transport <request>]"); process.exit(2) }

const verify = process.argv.includes("--verify")
const CLASS = "ZCL_MCP_AG_INSTALL"
const text = (r: { content: { text: string }[] }) => r.content.map(c => c.text).join("\n")

/** Run a generated if_oo_adt_classrun class once ($TMP), delete it again, return its output. */
async function runTemp(name: string, source: string): Promise<string> {
  const url = `/sap/bc/adt/oo/classes/${name.toLowerCase()}`
  console.log(text(await handleCreateAbapObject({ objectType: "CLAS", name, description: "MCP abapGit helper (temp)", packageName: "$TMP", connectionId } as never)))
  try {
    console.log(text(await handleWriteAbapObjectSource({ url, source, connectionId } as never)))
    const act = text(await handleAbapActivate({ url, connectionId } as never))
    if (!act.includes("✅")) { console.log(act); throw new Error(`${name} did not activate`) }
    return text(await handleRunClass({ className: name, waitSeconds: 600, connectionId }))
  } finally {
    console.log(text(await handleDeleteAbapObject({ url, connectionId } as never)))
  }
}

/** The files of a zip (stored or deflated). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let p = buf.readUInt32LE(end + 16)
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8")
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const data = buf.subarray(ds, ds + csize)
    out.set(name.replace(/^\//, ""), (method === 8 ? inflateRawSync(data) : data).toString("utf8"))
    p += 46 + nlen + xlen + clen
  }
  return out
}

async function verifyRoundTrip() {
  const tpl = fs.readFileSync(path.join(__dirname, "abapgit", "zcl_mcp_ag_export.abap"), "utf8")
  const outText = await runTemp("ZCL_MCP_AG_EXPORT", tpl.replace("{{ABAPGIT_PROGRAM}}", abapgit).replace("{{PACKAGE}}", pkg))
  const m = [...outText.matchAll(/B64BEGIN([A-Za-z0-9+/=\s]*?)B64END/g)].pop()
  if (!m) throw new Error(`abapGit export failed: ${outText.slice(0, 500)}`)
  const exported = unzip(Buffer.from(m[1].replace(/\s/g, ""), "base64"))
  const ours = buildAbapGitFiles()
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n+$/, "\n")
  const only = (a: Map<string, string>, b: Map<string, string>) => [...a.keys()].filter(k => !b.has(k))
  const differ = [...ours.keys()].filter(k => exported.has(k) && norm(exported.get(k)!) !== norm(ours.get(k)!))
  // abapGit adds the package's own file; ours leaves it to the importing system
  const extra = only(exported, ours).filter(k => !/package\.devc\.xml$/.test(k))
  console.log(`VERIFY: ${exported.size} files exported by abapGit; missing there: ${only(ours, exported).join(", ") || "none"}; ` +
    `only there: ${extra.join(", ") || "none"}; different: ${differ.join(", ") || "none"}`)
  for (const k of differ) {
    const a = norm(ours.get(k)!).split("\n"), b = norm(exported.get(k)!).split("\n")
    const i = a.findIndex((l, j) => l !== b[j])
    console.log(`  ${k} line ${i + 1}:\n    ours:    ${a[i]}\n    abapGit: ${b[i]}`)
  }
  if (differ.length || only(ours, exported).length || extra.length) process.exitCode = 1
}

async function main() {
  if (process.argv.includes("--verify-only")) return verifyRoundTrip()
  const b64 = zipFiles(buildAbapGitFiles()).toString("base64")
  const lines = b64.match(/.{1,200}/g) ?? []
  const payload = lines.map(l => `    APPEND '${l}' TO rt_lines.`).join("\n")
  const tpl = fs.readFileSync(path.join(__dirname, "abapgit", "zcl_mcp_ag_install.abap"), "utf8")
  const source = tpl.replace("{{ABAPGIT_PROGRAM}}", abapgit).replace("{{PACKAGE}}", pkg).replace("{{TRANSPORT}}", transport)
    .replace("{{ENGINE_VERSION}}", ABAPGIT_ENGINE_VERSION).replace("{{PAYLOAD}}", payload)
  console.log(`engine ${ABAPGIT_ENGINE_VERSION}: zip ${Math.round(b64.length * 3 / 4 / 1024)} KB in ${lines.length} payload lines → ${connectionId}, package ${pkg}`)

  const run = await runTemp(CLASS, source)
  console.log(run)
  if (!/\nDONE/.test(run)) process.exitCode = 1
  if (verify) await verifyRoundTrip()
}
main().then(() => process.exit(process.exitCode ?? 0), e => { console.error("FAILED:", e?.message ?? e); process.exit(1) })
