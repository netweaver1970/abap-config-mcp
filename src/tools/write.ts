import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, trackLock, forgetLock, getHeldLock, dropSessionLocks, isEditingError, editingConflictHint, log, resolveConnectionId, getConnectionConfig } from "../connections"
import { selectTransport, type TransportCandidate } from "./transportSelection"
import { lookupRequest, listOpenRequests } from "./transportSql"

interface ResolvedTransport {
  transport?: string   // request to record into (undefined = none needed / local package)
  note?: string        // human note for the success message
  prompt?: string      // set when the caller must STOP and return this (needs a choice)
}

export interface TransportArgs {
  transport?: string
  createTransport?: boolean
  workItem?: string
  connectionId?: string
}

/**
 * Transport for a workbench change (CTS function 'K'), by the shared rule in
 * transportSelection.ts. ADT's transportInfo says whether the object records at
 * all, whether SAP already ties it to a request, and which requests its transport
 * layer allows; when that list is empty the user's open Workbench requests are
 * offered instead.
 */
export async function resolveWorkbenchTransport(
  client: Awaited<ReturnType<typeof ensureConnected>>,
  refUrl: string,
  devClass: string | undefined,
  operation: string | undefined,
  args: TransportArgs,
  sessionId: string | undefined,
  what: string,
  requestText: string,
): Promise<ResolvedTransport> {
  let info
  try {
    info = await client.transportInfo(refUrl, devClass, operation)
  } catch (err) {
    // Without transportInfo the object's needs are unknown: pass an explicit
    // transport through and let SAP decide, rather than blocking the write.
    log("WARN", `transportInfo failed for ${refUrl} — using the given transport as is`, err)
    return { transport: args.transport, note: args.transport ? `Transport ${args.transport} (not checked: ${String((err as Error)?.message ?? err)})` : undefined }
  }

  // Local / non-transportable package ($TMP etc.) — no transport, whatever was passed.
  if (!info.RECORDING || info.RECORDING.trim() === "") {
    return { note: `No transport — local package ${info.DEVCLASS || "$TMP"}${args.transport ? ` (${args.transport} ignored)` : ""}.` }
  }

  let candidates: TransportCandidate[] = (info.TRANSPORTS ?? []).map(h => ({ trkorr: h.TRKORR, text: h.AS4TEXT, owner: h.AS4USER }))
  if (candidates.length === 0) {
    candidates = await listOpenRequests(args.connectionId, "K", getConnectionConfig(args.connectionId).username)
  }

  const sel = await selectTransport({
    connectionId: resolveConnectionId(args.connectionId),
    fn: "K",
    what,
    supplied: args.transport,
    workItem: args.workItem,
    sessionId,
    forced: info.LOCKS?.HEADER?.TRKORR || undefined,
    candidates,
    lookup: trkorr => lookupRequest(args.connectionId, trkorr),
    create: args.createTransport
      ? async () => {
          if (info.EXISTING_REQ_ONLY === "X") {
            throw new Error(`SAP allows ${info.OBJECTNAME || "this object"} only on an existing request — pass transport: instead of createTransport.`)
          }
          return client.createTransport(refUrl, requestText, info.DEVCLASS)
        }
      : undefined,
  })
  return sel.kind === "use" ? { transport: sel.trkorr, note: sel.note } : { prompt: sel.text }
}

export async function handleWriteAbapObjectSource(args: {
  url: string
  sourceUrl?: string
  source: string
  transport?: string
  createTransport?: boolean
  workItem?: string
  keepLock?: boolean
  connectionId?: string
}, extra?: { signal?: AbortSignal; sessionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const objectUrl = args.url
  const sourceUrl = args.sourceUrl ?? `${objectUrl}/source/main`

  // Governed transport selection BEFORE locking, so a "pick a request" prompt
  // never leaves the object locked behind.
  const t = await resolveWorkbenchTransport(
    client, objectUrl, undefined, undefined, args, extra?.sessionId,
    `the change to ${objectUrl.split("/").pop()}`, `MCP edit ${objectUrl.split("/").pop()}`)
  if (t.prompt) return { content: [{ type: "text" as const, text: t.prompt }] }

  // If the client abandons the call mid-flight, drop the session immediately to
  // release any acquired lock rather than waiting for the HTTP timeout to fire.
  if (extra?.signal) {
    extra.signal.addEventListener("abort", () => {
      log("WARN", `write_abap_object_source on ${objectUrl.split("/").pop()} cancelled — dropping session to release locks`)
      dropSessionLocks(args.connectionId).catch(() => { /* best-effort */ })
    }, { once: true })
  }

  let lockHandle: string | undefined
  // A lock this conversation already holds (lock_abap_object, keepLock) is reused:
  // locking again would be refused as "currently editing" by our own lock.
  const heldBefore = getHeldLock(args.connectionId, objectUrl)
  try {
    if (heldBefore) {
      lockHandle = heldBefore
    } else {
      const lockResult = await client.lock(objectUrl)
      lockHandle = lockResult.LOCK_HANDLE
      trackLock(args.connectionId, objectUrl, lockHandle)
    }

    await client.setObjectSource(sourceUrl, args.source, lockHandle, t.transport)

    // Read it back. ADT has accepted writes it did not apply (a function group's
    // own URL instead of its main program), which only showed later.
    let verify = ""
    try {
      const stored = await client.getObjectSource(sourceUrl, { version: "inactive" } as any)
      const norm = (x: string) => String(x ?? "").replace(/\r/g, "").split("\n").map(l => l.replace(/\s+$/, "")).join("\n").trim()
      if (norm(stored) !== norm(args.source)) {
        verify = `⚠️ Read back from ${sourceUrl}, the source differs from what was sent — SAP may not have stored it there. ` +
          `Check the URL (for a function group's main program use .../functions/groups/<g>/includes/sapl<g>).\n`
      }
    } catch (e) {
      verify = `(Could not read the source back to verify: ${String((e as Error)?.message ?? e)})\n`
    }

    // Release the lock unless asked to keep it: activation does not need it, and a
    // lock left behind outlives mistakes (it stays until this session ends).
    let lockText = `Lock handle: ${lockHandle}\n\nThe object is still locked (${heldBefore ? "it was locked before this write" : "keepLock"}). abap_activate releases it; unlock_abap_object keeps the inactive version and releases it.`
    if (!args.keepLock && !heldBefore) {
      try {
        await client.unLock(objectUrl, lockHandle)
        forgetLock(args.connectionId, objectUrl)
        lockText = `Unlocked. The new source is the inactive version — abap_activate to activate it.`
      } catch (e) {
        lockText = `Lock handle: ${lockHandle}\n\n⚠️ Could not release the lock (${String((e as Error)?.message ?? e)}); abap_activate releases it.`
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `✅ Source written to ${objectUrl}\n` + verify +
          (t.transport ? `Transport: ${t.transport}\n` : "") +
          (t.note ? `${t.note}\n` : "") +
          `\n${lockText}`
      }]
    }
  } catch (err) {
    if (lockHandle && heldBefore) {
      // The lock predates this call: leave it with its owner.
    } else if (lockHandle) {
      // We have the handle — try targeted unlock first, fall back to session drop
      try {
        await client.unLock(objectUrl, lockHandle)
      } catch (unlockErr) {
        log("WARN", `unLock failed for ${objectUrl.split("/").pop()} — dropping session to release all locks`, unlockErr)
        try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }
      }
      forgetLock(args.connectionId, objectUrl)
    } else {
      // lock() itself timed out or failed — SAP may have created the enqueue before the
      // response arrived.  Drop the session to release any handle-less orphan locks.
      try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }
    }
    if (isEditingError(err)) {
      throw new Error(editingConflictHint(err, objectUrl.split("/").pop()))
    }
    throw err
  }
}

export async function handleLockAbapObject(args: { url: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  let result
  try {
    result = await client.lock(args.url)
  } catch (err) {
    // lock() timed out after SAP may have taken the enqueue — drop session to clean up
    try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }
    if (isEditingError(err)) {
      throw new Error(editingConflictHint(err, args.url.split("/").pop()))
    }
    throw err
  }
  trackLock(args.connectionId, args.url, result.LOCK_HANDLE)
  return {
    content: [{
      type: "text" as const,
      text: `🔒 Object locked.\nLock handle: ${result.LOCK_HANDLE}`
    }]
  }
}

export async function handleUnlockAbapObject(args: {
  url: string
  lockHandle?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const handle = args.lockHandle ?? getHeldLock(args.connectionId, args.url)
  if (!handle) {
    return { content: [{ type: "text" as const, text:
      `❌ No lock handle for ${args.url}: none was given and this server holds no lock on it.\n` +
      `If SAP still shows it locked by you (SM12), the handle belongs to an earlier session — force_relogin drops that ` +
      `session and releases its locks (all of them, for every caller of this server).` }] }
  }
  await client.unLock(args.url, handle)
  forgetLock(args.connectionId, args.url)
  return { content: [{ type: "text" as const, text: `🔓 Object unlocked: ${args.url}` }] }
}

// abap-adt-api's createObject only accepts the FULL creatable typeId
// ("PROG/P", "CLAS/OC", …) — its CreatableTypes.get(objtype) returns undefined
// for a bare prefix and throws "Unsupported object type". Accept the prefix too
// and normalise it, so callers can pass "PROG"/"CLAS" naturally.
const CREATABLE_TYPE_ALIASES: Record<string, string> = {
  PROG: "PROG/P",   // executable program / report
  CLAS: "CLAS/OC",  // global class
  INTF: "INTF/OI",  // interface
  FUGR: "FUGR/F",   // function group
  TABL: "TABL/DT",  // transparent table
  DTEL: "DTEL/DE",  // data element
  DOMA: "DOMA/DO",  // domain
  TTYP: "TTYP/DA",  // table type
  VIEW: "VIEW/DV",  // view
  DEVC: "DEVC/K",   // package
  MSAG: "MSAG/N",   // message class
  ENQU: "ENQU/DL",  // lock object
  SHLP: "SHLP/DH",  // search help
}
function normalizeCreatableType(t: string): string {
  if (t.includes("/")) return t // already a full typeId
  return CREATABLE_TYPE_ALIASES[t.trim().toUpperCase()] ?? t // unknown → pass through; lib validates
}

export async function handleCreateAbapObject(args: {
  objectType: string
  name: string
  description: string
  packageName: string
  parentPath?: string
  transport?: string
  createTransport?: boolean
  workItem?: string
  connectionId?: string
}, extra?: { sessionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const parentPath = args.parentPath ?? `/sap/bc/adt/packages/${args.packageName}`
  const objectType = normalizeCreatableType(args.objectType)

  // Governed transport selection (function 'K'). Uses the package as the CTS
  // reference; a local package ($TMP) resolves to no transport. Best-effort —
  // any determination failure falls back to the supplied transport.
  const t = await resolveWorkbenchTransport(
    client, parentPath, args.packageName, "I", args, extra?.sessionId,
    `creating ${args.name}`, `MCP create ${args.name}`)
  if (t.prompt) return { content: [{ type: "text" as const, text: t.prompt }] }

  await client.createObject(
    objectType as any,
    args.name,
    args.packageName,
    args.description,
    parentPath,
    undefined,
    t.transport
  )

  // ADT registers an implicit author edit-lock on creation.  Drop the session so
  // a subsequent write_abap_object_source can acquire a proper lock handle.
  // Without this, client.lock() fails with "already being edited by <user>".
  try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }

  return {
    content: [{
      type: "text" as const,
      text: `✅ Created ${objectType} ${args.name}\n` +
        `Description: ${args.description}\nPackage: ${args.packageName}\n` +
        (t.transport ? `Transport: ${t.transport}\n` : "") +
        (t.note ? `${t.note}\n` : "") +
        `\nUse write_abap_object_source to add source code, then abap_activate to activate.`
    }]
  }
}

export async function handleDeleteAbapObject(args: {
  url: string
  transport?: string
  createTransport?: boolean
  workItem?: string
  connectionId?: string
}, extra?: { sessionId?: string }) {
  const client = await ensureConnected(args.connectionId)

  // Governed transport selection before locking (a "pick a request" prompt
  // should not leave the object locked).
  const t = await resolveWorkbenchTransport(
    client, args.url, undefined, undefined, args, extra?.sessionId,
    `deleting ${args.url.split("/").pop()}`, `MCP delete ${args.url.split("/").pop()}`)
  if (t.prompt) return { content: [{ type: "text" as const, text: t.prompt }] }

  const held = getHeldLock(args.connectionId, args.url)
  const lockHandle = held ?? (await client.lock(args.url)).LOCK_HANDLE

  try {
    await client.deleteObject(args.url, lockHandle, t.transport)
    try { await client.unLock(args.url, lockHandle) } catch { /* ignore — object gone, lock entry may already be cleared */ }
    forgetLock(args.connectionId, args.url)
    return {
      content: [{ type: "text" as const, text: `🗑️ Object deleted: ${args.url}` }]
    }
  } catch (err) {
    try { await client.unLock(args.url, lockHandle) } catch { /* ignore */ }
    forgetLock(args.connectionId, args.url)
    throw err
  }
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "write_abap_object_source",
    {
      title: "Write ABAP Object Source",
      description: "Write/update the source code of an ABAP object: locks, writes, reads back to verify, and releases the lock (keepLock: true to keep it). The new source is the inactive version until abap_activate. Transport: a transport you pass is checked and used; an object already locked into a request uses it; createTransport: true creates a new one; otherwise the transport already used for this piece of work (workItem, else this session) is reused; otherwise exactly one open request is used, several are listed for you to choose, none offers creation.",
      inputSchema: {
        url: z.string().describe("ADT object URL (e.g. /sap/bc/adt/programs/programs/Z_MY_PROG)"),
        sourceUrl: z.string().optional().describe("ADT source URL — defaults to <url>/source/main"),
        source: z.string().describe("New ABAP source code to write"),
        transport: z.string().optional().describe("Workbench request to record into. Checked before use; becomes the transport for this piece of work."),
        createTransport: z.boolean().optional().describe("Create a NEW Workbench request (only when you mean it; existing requests are preferred)."),
        workItem: z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        keepLock: z.boolean().optional().describe("Keep the object locked after writing (default false). A kept lock belongs to this conversation and lasts until abap_activate, unlock_abap_object or the end of the conversation."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleWriteAbapObjectSource
  )

  server.registerTool(
    "lock_abap_object",
    {
      title: "Lock ABAP Object",
      description: "Lock an ABAP object for editing. Returns the lock handle required for write and activate operations.",
      inputSchema: {
        url: z.string().describe("ADT object URL"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleLockAbapObject
  )

  server.registerTool(
    "unlock_abap_object",
    {
      title: "Unlock ABAP Object",
      description: "Unlock a previously locked ABAP object (discards any unsaved changes)",
      inputSchema: {
        url: z.string().describe("ADT object URL"),
        lockHandle: z.string().optional().describe("Lock handle returned by lock_abap_object or write_abap_object_source. Optional: defaults to the lock this server holds on the object."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleUnlockAbapObject
  )

  server.registerTool(
    "create_abap_object",
    {
      title: "Create ABAP Object",
      description: "Create a new ABAP development object (program, class, function group, include, table, etc.) in a package. A local package ($TMP) needs no transport. Creating a function group include (FUGR/I) also adds its INCLUDE line to the group's main program — do not add it again. Transport: a transport you pass is checked and used; an object already locked into a request uses it; createTransport: true creates a new one; otherwise the transport already used for this piece of work (workItem, else this session) is reused; otherwise exactly one open request is used, several are listed for you to choose, none offers creation.",
      inputSchema: {
        objectType: z.string().describe("ABAP object type. Full typeId (PROG/P, CLAS/OC, FUGR/F, TABL/DT, DTEL/DE, DOMA/DO, INTF/OI) or the bare prefix (PROG, CLAS, FUGR, TABL, DTEL, DOMA, INTF, …) — the bare form is normalised to the full typeId."),
        name: z.string().describe("Object name (e.g. Z_MY_PROGRAM)"),
        description: z.string().describe("Object short description"),
        packageName: z.string().describe("Target package (e.g. ZDEV_PKG)"),
        parentPath: z.string().optional().describe("Parent ADT URL — defaults to /sap/bc/adt/packages/<packageName>"),
        transport: z.string().optional().describe("Workbench request to record into. Checked before use; becomes the transport for this piece of work."),
        createTransport: z.boolean().optional().describe("Create a NEW Workbench request (only when you mean it; existing requests are preferred)."),
        workItem: z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleCreateAbapObject
  )

  server.registerTool(
    "delete_abap_object",
    {
      title: "Delete ABAP Object",
      description: "Delete an ABAP development object. Locks the object, deletes it, and unlocks. Transport: a transport you pass is checked and used; an object already locked into a request uses it; createTransport: true creates a new one; otherwise the transport already used for this piece of work (workItem, else this session) is reused; otherwise exactly one open request is used, several are listed for you to choose, none offers creation.",
      inputSchema: {
        url: z.string().describe("ADT object URL to delete"),
        transport: z.string().optional().describe("Workbench request to record into. Checked before use; becomes the transport for this piece of work."),
        createTransport: z.boolean().optional().describe("Create a NEW Workbench request (only when you mean it; existing requests are preferred)."),
        workItem: z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleDeleteAbapObject
  )
}
