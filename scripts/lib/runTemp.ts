/** Run a generated if_oo_adt_classrun class once in $TMP over ADT, delete it again, return its output. */
import { handleCreateAbapObject, handleWriteAbapObjectSource, handleDeleteAbapObject } from "../../src/tools/write"
import { handleAbapActivate } from "../../src/tools/activate"
import { handleRunClass } from "../../src/tools/quality"

const text = (r: { content: { text: string }[] }) => r.content.map(c => c.text).join("\n")

export async function runTemp(connectionId: string, name: string, source: string, log: (s: string) => void = console.log): Promise<string> {
  const url = `/sap/bc/adt/oo/classes/${name.toLowerCase()}`
  log(text(await handleCreateAbapObject({ objectType: "CLAS", name, description: "MCP helper (temp)", packageName: "$TMP", connectionId } as never)))
  try {
    log(text(await handleWriteAbapObjectSource({ url, source, connectionId } as never)))
    const act = text(await handleAbapActivate({ url, connectionId } as never))
    if (!act.includes("✅")) { log(act); throw new Error(`${name} did not activate`) }
    return text(await handleRunClass({ className: name, waitSeconds: 600, connectionId }))
  } finally {
    log(text(await handleDeleteAbapObject({ url, connectionId } as never)))
  }
}

/** A string as ABAP backquote literals of at most 200 characters, joined with &&. */
export function abapLiteral(s: string): string {
  return (s.match(/.{1,200}/g) ?? [""]).map(p => "`" + p.replace(/`/g, "``") + "`").join("\n      && ")
}
