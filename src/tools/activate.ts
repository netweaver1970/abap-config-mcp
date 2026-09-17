import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, getHeldLock, forgetLock, log, isEditingError, editingConflictHint } from "../connections"
import { ActivationResult, InactiveObjectElement } from "abap-adt-api"

export function formatActivationResult(result: ActivationResult): string {
  const msgLines = (result.messages ?? []).map(m =>
    `  [${m.type}] ${m.objDescr ? m.objDescr + " " : ""}${m.line ? `line ${m.line}: ` : ""}${m.shortText}`
  )

  if (result.success) {
    return `✅ Activation successful${msgLines.length ? "\nMessages:\n" + msgLines.join("\n") : ""}`
  }

  const stillInactive = (result.inactive ?? [])
    .map(r => r.object?.["adtcore:name"])
    .filter(Boolean)

  return `❌ Activation failed — object(s) remain inactive.\n` +
    (msgLines.length ? `Messages:\n${msgLines.join("\n")}\n` : "") +
    (stillInactive.length ? `Inactive: ${stillInactive.join(", ")}` : "Check the source for syntax errors.")
}

/**
 * What SAP still has inactive after an activation that reported success. ADT can
 * report success while objects stay in the inactive worklist (seen on S4 for a
 * function group and its include, and always for a program's text elements,
 * which activating the program does not activate). Matches the object's own URL,
 * anything under it, and entries of the same name elsewhere (text elements).
 */
export async function stillInactive(
  client: Awaited<ReturnType<typeof ensureConnected>>,
  urls: string[],
  names: string[],
): Promise<Array<{ name: string; type: string; uri: string }>> {
  let records
  try {
    records = await client.inactiveObjects()
  } catch {
    return []
  }
  const norm = (u: string) => u.toLowerCase().replace(/\/source\/main$/, "").replace(/\/$/, "")
  const wantedUrls = urls.map(norm)
  const wantedNames = new Set(names.map(n => n.toUpperCase()))
  return (records ?? [])
    .map(r => r.object)
    .filter((o): o is InactiveObjectElement => !!o)
    .filter(o => {
      const uri = norm(o["adtcore:uri"] ?? "")
      return wantedUrls.some(w => uri === w || uri.startsWith(w + "/")) || wantedNames.has(String(o["adtcore:name"] ?? "").toUpperCase().replace(/=+CP$/, ""))
    })
    .map(o => ({ name: o["adtcore:name"], type: o["adtcore:type"], uri: o["adtcore:uri"] }))
}

function inactiveWarning(left: Array<{ name: string; type: string; uri: string }>): string {
  if (!left.length) return ""
  return `\n\n⚠️ SAP reported success, but these are still inactive:\n` +
    left.map(o => `  ${o.type.padEnd(10)} ${o.name}  →  activate ${o.uri}`).join("\n") +
    `\nActivate them (abap_activate with that url, or abap_activate_multiple) before relying on the change.`
}

export async function handleAbapActivate(args: {
  url: string
  connectionId?: string
  preaudit?: boolean
}) {
  const client = await ensureConnected(args.connectionId)

  // ADT activation acquires its own internal lock.  If this server currently
  // holds a lock on the same object (e.g. left from write_abap_object_source
  // or set_text_elements), release it first — otherwise ADT sees a conflict
  // and returns "User … is currently editing".
  const heldHandle = getHeldLock(args.connectionId, args.url)
  if (heldHandle) {
    log("INFO", `Auto-releasing lock before activation: ${args.url.split("/").pop()}`)
    try {
      await client.unLock(args.url, heldHandle)
    } catch (unlockErr) {
      // Log but don't abort — the lock may already be gone (idempotent unlock).
      // If it's genuinely still held, the activation call will fail with a clear message below.
      log("WARN", `Auto-unlock failed for ${args.url.split("/").pop()} — proceeding with activation`, unlockErr)
    }
    forgetLock(args.connectionId, args.url)
  }

  const obj = await client.objectStructure(args.url)
  const objectName = obj.metaData["adtcore:name"]
  const objectType = obj.metaData["adtcore:type"]

  let result
  try {
    result = await client.activate(objectName, obj.objectUrl, undefined, args.preaudit ?? false)
  } catch (err) {
    if (isEditingError(err)) {
      throw new Error(editingConflictHint(err, objectName))
    }
    throw err
  }

  // Also surface "currently editing" that comes back as a failed activation result (not thrown)
  if (!result.success) {
    const editMsg = (result.messages ?? []).find(m =>
      isEditingError({ message: m.shortText })
    )
    if (editMsg) {
      throw new Error(editingConflictHint(new Error(editMsg.shortText), objectName))
    }
  }

  const left = result.success ? await stillInactive(client, [args.url, obj.objectUrl], [objectName]) : []
  return {
    content: [{
      type: "text" as const,
      text: `${formatActivationResult(result)}\nObject: ${objectName} (${objectType})${inactiveWarning(left)}`
    }]
  }
}

export async function handleAbapActivateMultiple(args: {
  urls: string[]
  connectionId?: string
  preaudit?: boolean
}) {
  const client = await ensureConnected(args.connectionId)

  // Release locks this server holds on any of them, as abap_activate does —
  // otherwise ADT answers "currently editing" with our own lock.
  for (const url of args.urls) {
    const held = getHeldLock(args.connectionId, url)
    if (!held) continue
    try { await client.unLock(url, held) } catch (e) { log("WARN", `Auto-unlock failed for ${url.split("/").pop()}`, e) }
    forgetLock(args.connectionId, url)
  }

  const records = await client.inactiveObjects()
  const wanted = new Set(args.urls)
  const toActivate = records
    .map(r => r.object)
    .filter((o): o is InactiveObjectElement => !!o && wanted.has(o["adtcore:uri"]))

  if (toActivate.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: "None of the requested objects are currently inactive. They may already be active, or the URLs may not match the inactive worklist."
      }]
    }
  }

  let result
  try {
    result = await client.activate(toActivate, args.preaudit ?? false)
  } catch (err) {
    if (isEditingError(err)) throw new Error(editingConflictHint(err, toActivate.map(o => o["adtcore:name"]).join(", ")))
    throw err
  }
  const names = toActivate.map(o => o["adtcore:name"]).join(", ")
  const left = result.success
    ? await stillInactive(client, toActivate.map(o => o["adtcore:uri"]), toActivate.map(o => o["adtcore:name"]))
    : []

  return {
    content: [{
      type: "text" as const,
      text: `${formatActivationResult(result)}\nActivated: ${names}${inactiveWarning(left)}`
    }]
  }
}

export function registerActivateTools(server: McpServer): void {
  server.registerTool(
    "abap_activate",
    {
      title: "Activate ABAP Object",
      description: "Activate an ABAP object — compiles it and makes it executable (equivalent to F8/Activate in the ABAP workbench). " +
        "If the object is currently locked by a prior write_abap_object_source or set_text_elements call, " +
        "the lock is released automatically before activation. " +
        "The object must have been written/saved first.",
      inputSchema: {
        url: z.string().describe("ADT URL of the ABAP object to activate (e.g. /sap/bc/adt/programs/programs/Z_MY_PROG)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
        preaudit: z.boolean().optional().describe("Run pre-activation ATC checks before activating. Default: false")
      }
    },
    handleAbapActivate
  )

  server.registerTool(
    "abap_activate_multiple",
    {
      title: "Activate Multiple ABAP Objects",
      description: "Activate several inactive ABAP objects in one batch operation. " +
        "Only objects that are currently inactive can be activated; the full object metadata is resolved automatically.",
      inputSchema: {
        urls: z.array(z.string()).describe("Array of ADT object URLs to activate"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
        preaudit: z.boolean().optional().describe("Run pre-activation ATC checks. Default: false")
      }
    },
    handleAbapActivateMultiple
  )
}
