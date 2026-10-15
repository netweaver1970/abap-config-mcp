const { build } = require("esbuild")
const fs = require("fs")

fs.mkdirSync("dist", { recursive: true })

build({
  entryPoints: ["src/index.ts", "src/stdio.ts", "src/test-connection.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outdir: "dist",
  external: [
    "abap-adt-api",
    "@modelcontextprotocol/sdk",
    "zod",
  ],
  sourcemap: true,
}).then(() => {
  console.log("Build complete: dist/index.js, dist/stdio.js, dist/test-connection.js")
}).catch(err => {
  console.error(err)
  process.exit(1)
})
