/**
 * Writes the engine's abapGit repository to abapgit/ and an offline-import zip to
 * release/abap-config-mcp-engine-<version>.zip. Run: npm run abapgit
 */
import * as fs from "fs"
import * as path from "path"
import { buildAbapGitFiles, zipFiles, ABAPGIT_ENGINE_VERSION, ROOT_DOT_ABAPGIT } from "../src/abap/abapgitRepo"

const root = path.resolve(__dirname, "..")
const out = path.join(root, "abapgit")
const files = buildAbapGitFiles()
fs.rmSync(path.join(out, "src"), { recursive: true, force: true })
for (const [rel, content] of files) {
  const p = path.join(out, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, "utf8")
}
fs.writeFileSync(path.join(root, ".abapgit.xml"), ROOT_DOT_ABAPGIT, "utf8")   // online repo: this Git repository
fs.mkdirSync(path.join(root, "release"), { recursive: true })
const zip = path.join(root, "release", `abap-config-mcp-engine-${ABAPGIT_ENGINE_VERSION}.zip`)
fs.writeFileSync(zip, zipFiles(files))
console.log(`abapgit/: ${files.size} files (engine ${ABAPGIT_ENGINE_VERSION}); offline zip: ${path.relative(root, zip)}`)
