/**
 * Build the deployable bundles into release/:
 *   abap-config-marketplace/      Claude Code plugin marketplace (plugin = stdio server + sap-abap skill)
 *   abap-config-mcp-<v>.mcpb      Claude Desktop extension (one-click install, SAP login in the install form)
 *   sap-abap-skill-<v>.zip        the skill alone (upload in Claude Desktop / claude.ai → Skills)
 *
 * The server is bundled into ONE self-contained stdio.js (all npm deps inlined),
 * so neither bundle ships node_modules. Run: npm run package
 */
const { build } = require("esbuild")
const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const OUT = path.join(ROOT, "release")
const WORK = path.join(OUT, ".work")
const { version } = require(path.join(ROOT, "package.json"))

const rel = (...p) => path.join(ROOT, ...p)
const copy = (from, to) => fs.cpSync(from, to, { recursive: true })
const fill = (file, vars) => {
  let s = fs.readFileSync(file, "utf8")
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(v)
  return s
}
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** Text of README between two headings (start inclusive, end exclusive). */
function readmeSection(startHeading, endHeading) {
  const lines = fs.readFileSync(rel("README.md"), "utf8").split("\n")
  const a = lines.findIndex(l => l.startsWith(startHeading))
  const b = lines.findIndex((l, i) => i > a && l.startsWith(endHeading))
  if (a < 0 || b < 0) throw new Error(`README section ${startHeading} … ${endHeading} not found`)
  return lines.slice(a, b).join("\n").replace(/^## /, "# ")
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // ── 1. self-contained server: server/dist/stdio.js + server/src/abap/*.abap
  //    (loadSource.ts finds the engine ABAP at <dist>/../src/abap)
  const server = path.join(WORK, "server")
  await build({
    entryPoints: [rel("src/stdio.ts")],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    outfile: path.join(server, "dist/stdio.js"),
    legalComments: "linked",
    logLevel: "warning",
  })
  fs.mkdirSync(path.join(server, "src/abap"), { recursive: true })
  for (const f of fs.readdirSync(rel("src/abap")).filter(f => f.endsWith(".abap")))
    copy(rel("src/abap", f), path.join(server, "src/abap", f))

  // ── 2. ask the bundle for its tools (also proves it starts without node_modules)
  const tools = listTools(path.join(server, "dist/stdio.js"))
  console.log(`server bundle OK — ${tools.length} tools`)

  // ── 3. the skill
  const skill = path.join(WORK, "sap-abap")
  copy(rel("packaging/skill"), skill)
  copy(rel("docs/customizing-engine.md"), path.join(skill, "references/customizing-engine.md"))
  copy(rel("docs/TIERS.md"), path.join(skill, "references/tiers.md"))
  write(path.join(skill, "references/tools.md"), readmeSection("## All ", "## Typical workflows"))
  const skillText = fs.readFileSync(path.join(skill, "SKILL.md"), "utf8")
  const unknown = [...skillText.matchAll(/`([a-z][a-z0-9_]+)`/g)].map(m => m[1])
    .filter(n => n.includes("_") && !tools.some(t => t.name === n))
    .filter(n => n !== "change_owner")   // a manage_transport_requests action, not a tool
  if (unknown.length) throw new Error(`SKILL.md names tools the server does not have: ${[...new Set(unknown)].join(", ")}`)

  // ── 4. Claude Code marketplace + plugin
  const market = path.join(OUT, "abap-config-marketplace")
  const plugin = path.join(market, "plugins/abap-config")
  write(path.join(market, ".claude-plugin/marketplace.json"), fill(rel("packaging/plugin/marketplace.json"), { VERSION: version }))
  write(path.join(plugin, ".claude-plugin/plugin.json"), fill(rel("packaging/plugin/.claude-plugin/plugin.json"), { VERSION: version }))
  copy(rel("packaging/plugin/.mcp.json"), path.join(plugin, ".mcp.json"))
  copy(server, path.join(plugin, "server"))
  copy(skill, path.join(plugin, "skills/sap-abap"))
  for (const f of ["LICENSE", "NOTICE"]) copy(rel(f), path.join(plugin, f))
  copy(rel("packaging/INSTALL.md"), path.join(market, "README.md"))

  // ── 5. Claude Desktop extension (.mcpb)
  const mcpb = path.join(WORK, "mcpb")
  const manifest = JSON.parse(fill(rel("packaging/mcpb/manifest.json"), { VERSION: version }))
  manifest.tools = tools.map(t => ({ name: t.name, description: firstSentence(t.description) }))
  write(path.join(mcpb, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  copy(server, path.join(mcpb, "server"))
  for (const f of ["LICENSE", "NOTICE"]) copy(rel(f), path.join(mcpb, f))
  const mcpbFile = path.join(OUT, `abap-config-mcp-${version}.mcpb`)
  const npx = process.platform === "win32" ? "npx.cmd" : "npx"
  execFileSync(npx, ["-y", "@anthropic-ai/mcpb@2.1.2", "validate", path.join(mcpb, "manifest.json")], { stdio: "inherit" })
  execFileSync(npx, ["-y", "@anthropic-ai/mcpb@2.1.2", "pack", mcpb, mcpbFile], { stdio: "inherit" })

  // ── 6. the skill on its own
  execFileSync("zip", ["-qr", path.join(OUT, `sap-abap-skill-${version}.zip`), "sap-abap"], { cwd: WORK })

  fs.rmSync(WORK, { recursive: true, force: true })
  console.log(`\nrelease/ ready (v${version}):\n  abap-config-marketplace/\n  ${path.basename(mcpbFile)}\n  sap-abap-skill-${version}.zip`)
}

function firstSentence(s = "") {
  const one = s.split("\n")[0]
  const m = one.match(/^(.{20,}?[.!?])(\s|$)/)
  return (m ? m[1] : one).slice(0, 200)
}

/** Start the bundled stdio server against a dummy system and read tools/list. */
function listTools(entry) {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package", version } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]
  const out = execFileSync(process.execPath, [entry], {
    input: msgs.map(m => JSON.stringify(m)).join("\n") + "\n",
    cwd: OUT,   // not the repo: prove nothing is resolved from the working directory
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ABAP_NO_WARMUP: "1",
           SAP_URL: "http://sap.invalid:8000", SAP_USER: "X", SAP_PASSWORD: "X" },
    stdio: ["pipe", "pipe", "ignore"],
  }).toString()
  const res = out.trim().split("\n").map(l => JSON.parse(l)).find(m => m.id === 2)
  if (!res?.result?.tools?.length) throw new Error(`tools/list failed:\n${out}`)
  return res.result.tools
}

main().catch(err => { console.error(err); process.exit(1) })
