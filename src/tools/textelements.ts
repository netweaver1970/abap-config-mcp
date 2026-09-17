import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ADTClient } from "abap-adt-api"
import { ensureConnected, dropSessionLocks, isInvalidLockError, isEditingError, editingConflictHint, log } from "../connections"
import { handleAbapActivate } from "./activate"
import { resolveWorkbenchTransport } from "./write"

// Text elements are read and written here in ADT's own text format rather than
// through abap-adt-api's helpers, which get two things wrong against a real
// system (verified on S4, 2026-09-17, SAP_BASIS 816):
//
//  • A dictionary-referenced selection text is marked by a BARE "@DDICReference"
//    line before the element. The library only recognises "@DDICReference:<x>",
//    so it cannot read the flag and cannot write it in a form SAP accepts.
//  • Every text symbol needs an "@MaxLength:<n>" line before it. Without one SAP
//    rejects the whole write ("Text elements contain errors; correct all
//    inconsistencies"), so symbols could not be written at all.
//
// And the ADT PUT replaces the whole category: a partial list deletes every text
// not in it. Writes therefore merge into what is there unless asked to replace.
//
// Activating the program does NOT activate its text elements: they stay in the
// inactive worklist (PROG/PX) and the selection screen keeps showing the old
// texts. Only activating the text-element resource does it. The write therefore
// activates that resource itself unless told not to.

export type TextCategory = "selections" | "symbols" | "headings"
const CATEGORIES: TextCategory[] = ["selections", "symbols", "headings"]

export interface TextEntry {
  id: string
  text: string
  maxLength?: number            // symbols
  dictionaryReference?: boolean // selections: text comes from the data element
}

export const HEADING_IDS = ["LISTHEADER", "COLUMNHEADER_1", "COLUMNHEADER_2", "COLUMNHEADER_3", "COLUMNHEADER_4"] as const
const SELECTION_TEXT_MAX = 30
const LISTHEADER_MAX = 71
const COLUMNHEADER_MAX = 255
const SYMBOL_MAX = 132

/** The ADT URL of the object whose texts these are (for its transport). */
export function objectUrlFor(objectType: string, objectName: string): string {
  const name = encodeURIComponent(objectName.toLowerCase())
  const t = objectType.toUpperCase()
  if (t.startsWith("CLAS")) return `/sap/bc/adt/oo/classes/${name}`
  if (t.startsWith("FUGR")) return `/sap/bc/adt/functions/groups/${name}`
  return `/sap/bc/adt/programs/programs/${name}`
}

const mediaType = (cat: TextCategory) => `application/vnd.sap.adt.textelements.${cat}.v1`

/** Parse ADT's text body. Heading ids come back camel-cased (listHeader) and are normalised to upper case. */
export function parseTextBody(body: string, category: TextCategory): TextEntry[] {
  const out: TextEntry[] = []
  let maxLength: number | undefined
  let ddic = false
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "")
    const trimmed = line.trim()
    if (trimmed === "") continue
    if (trimmed.startsWith("@MaxLength")) {
      const n = parseInt(trimmed.slice("@MaxLength".length).replace(/^:/, ""), 10)
      maxLength = isNaN(n) ? undefined : n
      continue
    }
    if (trimmed.startsWith("@DDICReference")) { ddic = true; continue }
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const id = line.slice(0, eq).trim().toUpperCase()
    if (!id) continue
    const entry: TextEntry = { id, text: line.slice(eq + 1) }
    if (category === "symbols" && maxLength !== undefined) entry.maxLength = maxLength
    if (category === "selections" && ddic) entry.dictionaryReference = true
    // Unmaintained selection texts come back as "?...": keep them out of merges.
    if (!(category === "selections" && !ddic && entry.text === "?...")) out.push(entry)
    maxLength = undefined
    ddic = false
  }
  // Headings: SAP always returns all four column headers, empty ones included.
  return category === "headings" ? out.filter(e => e.text !== "" || e.id === "LISTHEADER") : out
}

/** Check entries against what SAP accepts; returns problems in plain sentences. */
export function validateEntries(entries: TextEntry[], category: TextCategory): string[] {
  const problems: string[] = []
  for (const e of entries) {
    const id = e.id.toUpperCase()
    if (category === "symbols") {
      if (!/^[A-Z0-9]{3}$/.test(id)) problems.push(`Symbol id "${e.id}" must be exactly 3 letters or digits (e.g. 001).`)
      const max = e.maxLength ?? e.text.length
      if (e.text.length > SYMBOL_MAX) problems.push(`Symbol ${id} is ${e.text.length} characters; the maximum is ${SYMBOL_MAX}.`)
      if (max < e.text.length) problems.push(`Symbol ${id} is ${e.text.length} characters, longer than its maxLength ${max}.`)
      if (max > SYMBOL_MAX) problems.push(`Symbol ${id} maxLength ${max} is above ${SYMBOL_MAX}.`)
    } else if (category === "selections") {
      if (!/^[A-Z0-9_]{1,8}$/.test(id)) problems.push(`Selection id "${e.id}" must be the PARAMETERS / SELECT-OPTIONS name (up to 8 characters).`)
      if (!e.dictionaryReference && e.text.length > SELECTION_TEXT_MAX)
        problems.push(`Selection text for ${id} is ${e.text.length} characters; the maximum is ${SELECTION_TEXT_MAX}.`)
    } else {
      if (!(HEADING_IDS as readonly string[]).includes(id))
        problems.push(`Heading id "${e.id}" is not one of ${HEADING_IDS.join(", ")}.`)
      const limit = id === "LISTHEADER" ? LISTHEADER_MAX : COLUMNHEADER_MAX
      if (e.text.length > limit) problems.push(`Heading ${id} is ${e.text.length} characters; the maximum is ${limit}.`)
    }
  }
  return problems
}

/** Format entries into the body ADT accepts (CRLF, the markers SAP expects, symbols always with a max length). */
export function formatTextBody(entries: TextEntry[], category: TextCategory): string {
  const lines: string[] = []
  for (const e of entries) {
    const id = e.id.toUpperCase()
    if (category === "headings") {
      lines.push(`${id}=${e.text}`)
      continue
    }
    if (category === "symbols") lines.push(`@MaxLength:${Math.max(e.maxLength ?? 0, e.text.length, 1)}`)
    if (category === "selections" && e.dictionaryReference) lines.push("@DDICReference")
    // A dictionary reference takes its text from the data element; SAP fills it.
    const text = category === "selections" && e.dictionaryReference ? "" : e.text
    lines.push(`${category === "selections" ? id.padEnd(8) : id}=${text}`)
    lines.push("")
  }
  return lines.length ? lines.join("\r\n") + "\r\n" : ""
}

/** Upsert `changes` into `current` by id (keeping order), then drop `remove`. */
export function mergeEntries(current: TextEntry[], changes: TextEntry[], remove: string[] = []): TextEntry[] {
  const byId = new Map<string, TextEntry>()
  for (const e of current) byId.set(e.id.toUpperCase(), { ...e, id: e.id.toUpperCase() })
  for (const e of changes) byId.set(e.id.toUpperCase(), { ...e, id: e.id.toUpperCase() })
  for (const r of remove) byId.delete(r.toUpperCase())
  return [...byId.values()]
}

async function readCategory(client: any, textUrl: string, category: TextCategory): Promise<TextEntry[]> {
  try {
    const r = await client.h.request(`${textUrl}/source/${category}`, { headers: { Accept: mediaType(category) } })
    return parseTextBody(String(r?.body ?? ""), category)
  } catch (e: any) {
    if (e?.status === 404 || e?.response?.status === 404) return []
    throw e
  }
}

async function writeCategory(client: any, textUrl: string, category: TextCategory, entries: TextEntry[], lockHandle: string, transport?: string) {
  const qs: Record<string, string> = { lockHandle }
  if (transport) qs.corrNr = transport
  await client.h.request(`${textUrl}/source/${category}`, {
    method: "PUT",
    headers: { "Content-Type": `${mediaType(category)}; charset=UTF-8`, Accept: mediaType(category) },
    qs,
    body: formatTextBody(entries, category),
  })
}

function formatForDisplay(entries: TextEntry[], category: TextCategory): string {
  if (entries.length === 0) return `No ${category} text elements found.`
  const rows = entries.map(e => {
    const max = e.maxLength ? `  (max ${e.maxLength})` : ""
    const ddic = e.dictionaryReference ? "  [dictionary reference]" : ""
    return `  ${e.id.padEnd(32)} ${e.text}${max}${ddic}`
  })
  return `${category} (${entries.length}):\n${rows.join("\n")}`
}

export async function handleGetTextElements(args: {
  objectType: string
  objectName: string
  category?: TextCategory
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const url = ADTClient.textElementsUrl(args.objectType, args.objectName)
  const cats = args.category ? [args.category] : CATEGORIES
  const sections = await Promise.all(cats.map(async cat => {
    try {
      return formatForDisplay(await readCategory(client, url, cat), cat)
    } catch (e) {
      if (args.category) throw e
      return formatForDisplay([], cat)
    }
  }))
  return { content: [{ type: "text" as const, text: `Text elements for ${args.objectName}:\n\n${sections.join("\n\n")}` }] }
}

export async function handleSetTextElements(args: {
  objectType: string
  objectName: string
  objectUrl?: string
  category: TextCategory
  elements: TextEntry[]
  remove?: string[]
  replace?: boolean
  activate?: boolean
  transport?: string
  createTransport?: boolean
  workItem?: string
  connectionId?: string
}, extra?: { signal?: AbortSignal; sessionId?: string }) {
  const problems = validateEntries(args.elements, args.category)
  if (problems.length) {
    return { content: [{ type: "text" as const, text: `❌ Nothing written — ${problems.length} problem(s):\n  • ${problems.join("\n  • ")}` }] }
  }

  const client = await ensureConnected(args.connectionId)
  const textUrl = ADTClient.textElementsUrl(args.objectType, args.objectName)

  // Texts record on the transport of the object they belong to.
  const t = await resolveWorkbenchTransport(
    client, objectUrlFor(args.objectType, args.objectName), undefined, undefined, args, extra?.sessionId,
    `the text elements of ${args.objectName}`, `MCP texts ${args.objectName}`)
  if (t.prompt) return { content: [{ type: "text" as const, text: t.prompt }] }

  // If the MCP client abandons the call mid-flight, the lock taken below would
  // otherwise leak server-side until the HTTP timeout. Drop the session to release it.
  if (extra?.signal) {
    extra.signal.addEventListener("abort", () => {
      log("WARN", `set_text_elements on ${args.objectName} cancelled — dropping session to release locks`)
      dropSessionLocks(args.connectionId).catch(() => { /* best-effort */ })
    }, { once: true })
  }

  // Merge unless told to replace: the PUT replaces the whole category.
  const current = args.replace ? [] : await readCategory(client, textUrl, args.category)
  const target = mergeEntries(current, args.elements, args.remove)

  // Text elements are a SEPARATE enqueue resource (REPT text pool) from the program
  // source. Lock the text-elements URL; release it whatever happens.
  const lockResource = async (): Promise<string> => {
    try {
      const r = await client.lock(textUrl)
      return r.LOCK_HANDLE
    } catch (lockErr) {
      try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }
      if (isEditingError(lockErr)) throw new Error(editingConflictHint(lockErr, args.objectName))
      throw lockErr
    }
  }
  const unlockResource = async (handle: string, reason: string) => {
    try {
      await client.unLock(textUrl, handle)
    } catch (e) {
      log("WARN", `Failed to release text-element lock for ${args.objectName} (${reason}) — dropping session`, e)
      try { await dropSessionLocks(args.connectionId) } catch (e2) {
        log("WARN", `Session drop also failed for ${args.objectName}`, e2)
      }
    }
  }
  const doWrite = (handle: string) => writeCategory(client, textUrl, args.category, target, handle, t.transport)

  let lockHandle = await lockResource()
  try {
    await doWrite(lockHandle)
  } catch (err) {
    if (isInvalidLockError(err)) {
      log("WARN", `Stale text-element lock on ${args.objectName} — releasing, re-acquiring, retrying`)
      await unlockResource(lockHandle, "stale before re-acquire")
      let freshHandle: string | undefined
      try {
        freshHandle = await lockResource()
        await doWrite(freshHandle)
        lockHandle = freshHandle
      } catch (retryErr) {
        if (freshHandle) await unlockResource(freshHandle, "re-acquire retry failure")
        throw retryErr
      }
    } else {
      await unlockResource(lockHandle, "write error")
      if (isEditingError(err)) throw new Error(editingConflictHint(err, args.objectName))
      throw err
    }
  }
  await unlockResource(lockHandle, "success")

  // Read back: SAP fills dictionary-referenced texts and is the only authority on what was stored.
  let stored: TextEntry[] | undefined
  try { stored = await readCategory(client, textUrl, args.category) } catch { stored = undefined }
  const mode = args.replace
    ? "replaced"
    : `merged (${args.elements.length} set${args.remove?.length ? `, ${args.remove.length} removed` : ""})`

  let activation: string
  if (args.activate === false) {
    activation = `Not activated. Activate the text elements themselves — abap_activate with url ${textUrl}; ` +
      `activating the program does not activate its texts.`
  } else {
    try {
      const act = await handleAbapActivate({ url: textUrl, connectionId: args.connectionId })
      const actText = act.content.map(c => c.text).join("\n")
      activation = /❌|failed/i.test(actText) ? `⚠️ Written but not activated:\n${actText}` : `Activated (${textUrl}).`
    } catch (e) {
      activation = `⚠️ Written but activation failed: ${String((e as Error)?.message ?? e)} — activate ${textUrl}.`
    }
  }

  return {
    content: [{
      type: "text" as const,
      text: `✅ ${args.category} text elements ${mode} for ${args.objectName} — ${target.length} in total.\n` +
        (t.note ? `${t.note}\n` : "") + `\n` +
        (stored ? formatForDisplay(stored, args.category) : "(read-back failed)") +
        `\n\n${activation}`,
    }],
  }
}

export function registerTextElementTools(server: McpServer): void {
  server.registerTool(
    "get_text_elements",
    {
      title: "Get Text Elements",
      description:
        "Read text elements for an ABAP program, function group or class: selection texts (PARAMETERS / SELECT-OPTIONS " +
        "labels, flagged when they are dictionary references), text symbols (TEXT-001 etc., with their maximum length), " +
        "and list headings (LISTHEADER, COLUMNHEADER_1..4). Omit category to retrieve all three.",
      inputSchema: {
        objectType: z.string().describe("ADT object type, e.g. PROG/P, FUGR/F, CLAS/OC"),
        objectName: z.string().describe("Object name, e.g. ZCAR_MM_ORDERS"),
        category: z.enum(["selections", "symbols", "headings"]).optional()
          .describe("selections, symbols or headings. Omit for all three."),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      },
    },
    handleGetTextElements
  )

  server.registerTool(
    "set_text_elements",
    {
      title: "Set Text Elements",
      description:
        "Write text elements for an ABAP program, function group or class, in the format SAP requires.\n" +
        "• selections — selection-screen texts for PARAMETERS / SELECT-OPTIONS. Set dictionaryReference: true to take the " +
        "text from the data element (the SE38 'Dictionary ref.' box); text may then be empty and SAP fills it. Own texts max 30 characters.\n" +
        "• symbols — TEXT-xxx, ids of 3 characters. Every symbol is written with a maximum length (maxLength, default the " +
        "text's length); SAP rejects symbols without one.\n" +
        "• headings — LISTHEADER (max 71) and COLUMNHEADER_1..COLUMNHEADER_4 (max 255).\n" +
        "Writes MERGE by default: listed ids are added or updated, everything else is kept (the underlying ADT write replaces " +
        "the whole category, so the tool reads first). Use remove to delete ids, or replace: true to write exactly the list. " +
        "Returns what SAP stored, then activates the text elements (activating the program alone does not; pass " +
        "activate: false to leave them inactive).",
      inputSchema: {
        objectType: z.string().describe("ADT object type, e.g. PROG/P, FUGR/F, CLAS/OC"),
        objectName: z.string().describe("Object name, e.g. ZCAR_MM_ORDERS"),
        objectUrl: z.string().optional().describe("Deprecated and ignored — the text-element resource is derived from objectType+objectName"),
        category: z.enum(["selections", "symbols", "headings"]).describe("selections, symbols or headings"),
        elements: z.array(z.object({
          id: z.string().describe("selections: the PARAMETERS / SELECT-OPTIONS name; symbols: 3 characters e.g. '001'; headings: LISTHEADER or COLUMNHEADER_1..4"),
          text: z.string().describe("The text. For a dictionary-referenced selection it may be empty."),
          maxLength: z.number().int().positive().optional().describe("symbols only: maximum length (default: the text's length; at most 132)"),
          dictionaryReference: z.boolean().optional().describe("selections only: take the text from the data element (Dictionary ref.)"),
        })).describe("Texts to add or update"),
        remove: z.array(z.string()).optional().describe("Ids to delete from the category"),
        replace: z.boolean().optional().describe("Write exactly `elements` and drop everything else in the category. Default false = merge."),
        activate: z.boolean().optional().describe("Activate the text elements after writing (default true). Activating the program does not activate them."),
        transport: z.string().optional().describe("Workbench request to record into. Checked before use; becomes the transport for this piece of work."),
        workItem: z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        createTransport: z.boolean().optional().describe("Create a NEW Workbench request (only when you mean it; existing requests are preferred)."),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      },
    },
    handleSetTextElements
  )
}
