import { handleEngineBootstrap, handleEnginePing } from "../../src/tools/customizingEngine"
const c = process.argv[2]
;(async () => {
  const b = await handleEngineBootstrap({ connectionId: c, packageName: "$TMP" } as never)
  console.log(b.content.map((x: any) => x.text).join("\n"))
  const p = await handleEnginePing({ connectionId: c } as never)
  console.log(p.content.map((x: any) => x.text).join("\n").slice(0, 600))
})().catch(e => { console.error(e); process.exit(1) })
