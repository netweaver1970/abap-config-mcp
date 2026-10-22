import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  UnitTestAlert,
  UnitTestAlertKind,
  UnitTestMethod,
  UnitTestSeverity
} from "abap-adt-api"
import { randomUUID } from "crypto"
import { ensureConnected, newIsolatedClient, resolveConnectionId, log } from "../connections"
import { resolveWorkbenchTransport } from "./write"

export async function handleRunAtcAnalysis(args: {
  url: string
  variant?: string
  maxResults?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)

  // Step 1: trigger the run, get run ID
  const runResult = await client.createAtcRun(
    args.variant ?? "DEFAULT",
    args.url,
    args.maxResults ?? 100
  )

  // Step 2: fetch the worklist for this run
  const worklist = await client.atcWorklists(runResult.id)

  if (!worklist.objects || worklist.objects.length === 0) {
    return { content: [{ type: "text" as const, text: "✅ No ATC findings — object passed all checks." }] }
  }

  const findings: string[] = []
  for (const obj of worklist.objects) {
    for (const f of obj.findings) {
      const line = f.location?.range?.start?.line ?? 0
      findings.push(`[P${f.priority}] ${f.checkTitle} (${f.checkId})\n  ${f.messageTitle}\n  ${obj.name} line ${line}`)
    }
  }

  return {
    content: [{
      type: "text" as const,
      text: `ATC Analysis — ${findings.length} finding(s):\n\n${findings.join("\n\n")}`
    }]
  }
}

// Warnings (e.g. tolerable/tolerant) don't fail a method; assertions, exceptions
// and critical/fatal alerts do.
function isFailureAlert(a: UnitTestAlert): boolean {
  return (
    a.kind === UnitTestAlertKind.exception ||
    a.kind === UnitTestAlertKind.failedAssertion ||
    a.severity === UnitTestSeverity.critical ||
    a.severity === UnitTestSeverity.fatal
  )
}

function formatAlerts(alerts: UnitTestAlert[]): string {
  return alerts
    .map(a => `\n    ⚠ [${a.severity}/${a.kind}] ${a.title}${a.details?.length ? "\n      " + a.details.join("\n      ") : ""}`)
    .join("")
}

// ADT's default runs only RISK LEVEL HARMLESS + DURATION SHORT: a DANGEROUS or
// MEDIUM test class was reported as "no unit test classes found".
const ALL_RISKS_AND_DURATIONS = { harmless: true, dangerous: true, critical: true, short: true, medium: true, long: true }

// How long one class run may take in SAP before this server gives up on its
// answer (the run itself goes on in SAP), and how long one tool call waits for it
// — below the HTTP server's 45 s watchdog and the MCP client's 60 s timeout.
const RUN_CLASS_TIMEOUT_MS = parseInt(process.env.ABAP_RUN_CLASS_TIMEOUT_MS ?? "", 10) || 30 * 60_000
const RUN_CLASS_WAIT_DEFAULT_S = 25
const RUN_CLASS_WAIT_MAX_S = 40
// A finished run nobody collected is forgotten after this long.
const RUN_CLASS_KEEP_MS = 60 * 60_000

interface ClassRun {
  className: string
  connectionId: string
  startedAt: number
  finishedAt?: number
  output?: string
  error?: string
  done: Promise<void>
}

const classRuns = new Map<string, ClassRun>()

function startClassRun(className: string, connectionId: string | undefined): string {
  const runId = randomUUID().slice(0, 8)
  const run: ClassRun = { className, connectionId: resolveConnectionId(connectionId), startedAt: Date.now(), done: Promise.resolve() }
  // Its own stateless client, not the conversation's stateful session: that
  // session's internal session keeps the class pool it loaded first, so a class
  // created or changed since ran its old version, or failed with "does not
  // implement if_oo_adt_classrun~main" (CAR, 2026-10-22). And a run that outlasts
  // our wait or times out leaves the stateful session as it was.
  run.done = (async () => {
    let client
    try {
      client = await newIsolatedClient(connectionId, RUN_CLASS_TIMEOUT_MS)
      run.output = String((await client.runClass(className)) ?? "").trim()
    } catch (err) {
      run.error = String((err as Error)?.message ?? err)
    } finally {
      run.finishedAt = Date.now()
      if (client) client.logout().catch(e => log("DEBUG", `logout after running ${className} failed`, e))
    }
  })()
  classRuns.set(runId, run)
  return runId
}

function forgetOldRuns(now = Date.now()): void {
  for (const [id, r] of classRuns) if (r.finishedAt && now - r.finishedAt > RUN_CLASS_KEEP_MS) classRuns.delete(id)
}

/**
 * Run a class that implements IF_OO_ADT_CLASSRUN — ADT's "Run as ABAP
 * Application (Console)" — and return what it wrote to OUT. The class decides
 * what happens: it can post documents and commit, so this is a tier-2 tool and
 * is never retried automatically after a lost session. A run still going after
 * the wait is left running and answered with a runId to collect it with.
 */
export async function handleRunClass(args: { className?: string; runId?: string; waitSeconds?: number; connectionId?: string }) {
  forgetOldRuns()
  if (!args.runId === !args.className) {
    return { content: [{ type: "text" as const, text: "❌ Give className to start a run, or runId to collect one that is still going — not both." }] }
  }
  let runId = args.runId
  if (runId === undefined) {
    runId = startClassRun(args.className!.trim().toUpperCase(), args.connectionId)
  }
  const run = classRuns.get(runId)
  if (!run) {
    return { content: [{ type: "text" as const, text: `❌ No class run ${runId}: it was collected already, or this server restarted, or it finished more than an hour ago.` }] }
  }

  const waitS = Math.min(Math.max(args.waitSeconds ?? RUN_CLASS_WAIT_DEFAULT_S, 0), RUN_CLASS_WAIT_MAX_S)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([run.done, new Promise<void>(r => { timer = setTimeout(r, waitS * 1000) })])
  clearTimeout(timer)

  const head = `▶ ${run.className} (IF_OO_ADT_CLASSRUN) on ${run.connectionId}`
  if (run.finishedAt === undefined) {
    const s = Math.round((Date.now() - run.startedAt) / 1000)
    return { content: [{ type: "text" as const, text:
      `${head}\n\n⏳ Still running in SAP after ${s} s. Call abap_run_class with runId: "${runId}" to wait for it and get its output ` +
      `(this server waits for SAP up to ${Math.round(RUN_CLASS_TIMEOUT_MS / 60_000)} min).` }] }
  }
  classRuns.delete(runId)
  if (run.error !== undefined) {
    const timedOut = /timeout|timed out/i.test(run.error)
    throw new Error(`${run.className} failed: ${run.error}` + (timedOut
      ? `\nThe run may still be going on in SAP (SM50) — no answer came back in time. Your session was not affected.`
      : ""))
  }
  return { content: [{ type: "text" as const, text: `${head}\n\n${run.output || "(no output)"}` }] }
}

export async function handleRunUnitTests(args: {
  url: string
  riskLevels?: Array<"harmless" | "dangerous" | "critical">
  durations?: Array<"short" | "medium" | "long">
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const flags = { ...ALL_RISKS_AND_DURATIONS }
  if (args.riskLevels?.length) for (const k of ["harmless", "dangerous", "critical"] as const) flags[k] = args.riskLevels.includes(k)
  if (args.durations?.length) for (const k of ["short", "medium", "long"] as const) flags[k] = args.durations.includes(k)
  const classes = await client.unitTestRun(args.url, flags)

  if (!classes || classes.length === 0) {
    const scope = Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(", ")
    return { content: [{ type: "text" as const, text: `No unit test classes found in this object (ran: ${scope}).` }] }
  }

  const lines: string[] = []
  let totalPassed = 0
  let totalFailed = 0
  let totalUnknown = 0

  for (const cls of classes) {
    const clsName = cls["adtcore:name"]

    // Class-level alerts (setup / class-constructor failures) apply to the whole class
    const classAlerts = cls.alerts ?? []
    if (classAlerts.length > 0) {
      const failed = classAlerts.some(isFailureAlert)
      if (failed) totalFailed++
      lines.push(`  ${failed ? "❌" : "⚠"} ${clsName} (class-level)${formatAlerts(classAlerts)}`)
    }

    // Derive pass/fail from the run result itself: its testmethods already carry
    // alerts.  unitTestEvaluation returns empty alerts on some systems (seen on
    // S/4HANA 2025), which made failing methods look green — only use it as a
    // fallback when the run result has no method details at all.
    let methods: UnitTestMethod[] = cls.testmethods ?? []
    if (methods.length === 0) {
      try {
        methods = await client.unitTestEvaluation(cls)
      } catch {
        methods = []
      }
    }

    if (methods.length === 0) {
      if (classAlerts.length === 0) {
        totalUnknown++
        lines.push(`  ❓ ${clsName} — no method results from run or evaluation; result UNKNOWN (not passed)`)
      }
      continue
    }

    for (const m of methods) {
      const alerts = m.alerts ?? []
      const failed = alerts.some(isFailureAlert)
      if (failed) totalFailed++
      else totalPassed++

      lines.push(`  ${failed ? "❌" : "✅"} ${clsName}=>${m["adtcore:name"]}${formatAlerts(alerts)}`)
    }
  }

  const summary =
    `Unit test results: ${totalPassed} passed, ${totalFailed} failed` +
    (totalUnknown > 0 ? `, ${totalUnknown} unknown (no alert data returned)` : "")

  return {
    content: [{
      type: "text" as const,
      text: `${summary}\n\n${lines.join("\n")}`
    }]
  }
}

export async function handleCreateTestInclude(args: {
  classUrl: string
  transport?: string
  createTransport?: boolean
  workItem?: string
  connectionId?: string
}, extra?: { sessionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const t = await resolveWorkbenchTransport(
    client, args.classUrl, undefined, undefined, args, extra?.sessionId,
    `the test include of ${args.classUrl.split("/").pop()}`, `MCP test include ${args.classUrl.split("/").pop()}`)
  if (t.prompt) return { content: [{ type: "text" as const, text: t.prompt }] }

  // The lock is correctly taken on the class object URL — a class test include
  // shares the class's enqueue (it is part of the class object), so the class
  // lock covers it.  But client.createTestInclude expects the class NAME, not the
  // URL: it builds /sap/bc/adt/oo/classes/<clas>/includes, so passing the full URL
  // would be URL-encoded into the path and fail.  Derive the name from the URL.
  const className = decodeURIComponent(args.classUrl.split("/").pop() ?? "")
  const lockResult = await client.lock(args.classUrl)
  const lockHandle = lockResult.LOCK_HANDLE

  try {
    await client.createTestInclude(className, lockHandle, t.transport)
    await client.unLock(args.classUrl, lockHandle)
    return {
      content: [{
        type: "text" as const,
        text: `✅ Test include created for ${className}\n${t.note ? `${t.note}\n` : ""}You can now add local test classes to this include.`
      }]
    }
  } catch (err) {
    try { await client.unLock(args.classUrl, lockHandle) } catch { /* ignore */ }
    throw err
  }
}

export function registerQualityTools(server: McpServer): void {
  server.registerTool(
    "run_atc_analysis",
    {
      title: "Run ATC Analysis",
      description: "Run ABAP Test Cockpit (ATC) quality checks on an ABAP object. Returns findings with priority, check name, message, and location.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object to analyze"),
        variant: z.string().optional().describe("ATC check variant name (default: DEFAULT)"),
        maxResults: z.number().optional().describe("Maximum findings (default: 100)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleRunAtcAnalysis
  )

  server.registerTool(
    "run_unit_tests",
    {
      title: "Run ABAP Unit Tests",
      description: "Execute ABAP unit tests for an object and return test results with pass/fail status and error details",
      inputSchema: {
        url: z.string().describe("ADT URL of the object containing unit tests"),
        riskLevels: z.array(z.enum(["harmless", "dangerous", "critical"])).optional().describe("Only run test classes of these risk levels (default: all)"),
        durations: z.array(z.enum(["short", "medium", "long"])).optional().describe("Only run test classes of these durations (default: all)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleRunUnitTests
  )

  server.registerTool(
    "abap_run_class",
    {
      title: "Run ABAP Class (Console)",
      description: "Run a class that implements IF_OO_ADT_CLASSRUN (ADT's 'Run as ABAP Application (Console)') and return what its MAIN method wrote to OUT. Runs the class's current active version, in a session of its own. The class decides what happens — it can post documents and commit — so read it before running it. Never retried automatically after a lost session. A run that takes longer than waitSeconds keeps running in SAP and answers with a runId: call again with runId to wait for it and get the output.",
      inputSchema: {
        className: z.string().optional().describe("Class name, e.g. ZCL_MY_RUNNER. Must implement IF_OO_ADT_CLASSRUN and be active. Starts a new run."),
        runId: z.string().optional().describe("Collect a run that was still going (from an earlier answer) instead of starting one."),
        waitSeconds: z.number().optional().describe(`How long this call waits for the run to finish (default ${RUN_CLASS_WAIT_DEFAULT_S}, max ${RUN_CLASS_WAIT_MAX_S}); the run itself keeps going.`),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleRunClass
  )

  server.registerTool(
    "create_test_include",
    {
      title: "Create Test Include",
      description: "Create a unit test include (local test class) for an ABAP class. The tool locks and unlocks the class itself. Transport: a transport you pass is checked and used; an object already locked into a request uses it; createTransport: true creates a new one; otherwise the transport already used for this piece of work (workItem, else this session) is reused; otherwise exactly one open request is used, several are listed for you to choose, none offers creation.",
      inputSchema: {
        classUrl: z.string().describe("ADT URL of the class to add a test include to"),
        transport: z.string().optional().describe("Workbench request to record into. Checked before use; becomes the transport for this piece of work."),
        workItem: z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        createTransport: z.boolean().optional().describe("Create a NEW Workbench request (only when you mean it; existing requests are preferred)."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleCreateTestInclude
  )
}
