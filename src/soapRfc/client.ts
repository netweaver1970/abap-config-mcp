/**
 * Calling a remote-enabled function module through SAP's SOAP RFC service
 * (/sap/bc/soap/rfc). It exists on NetWeaver releases far older than ADT, so a
 * system without /sap/bc/adt can still be read: RFC_READ_TABLE for tables, the
 * program read FMs for sources (see readTable.ts, source.ts).
 *
 * Each call is its own HTTP request on its own socket (a fresh agent per call,
 * destroyed when the answer is in), with Basic auth and no cookies: there is no
 * session to keep alive or degrade. It sends no "Connection: close": an old CAR
 * system (2026-10-23) dropped the first logged-on call from Node 24 that carried
 * it ("socket hang up"), while curl's same request without it was answered.
 *
 * Calls to one connection run one at a time, and a 401 — or any answer that is
 * not a SOAP envelope, such as a logon page — stops every further call to that
 * connection until the server process restarts: each failed logon counts towards
 * locking the SAP user, so a wrong password must cost one attempt, not one per
 * queued call.
 *
 * Callers must only invoke function modules that read. The tool layer
 * (tools/soapRfcRouting.ts) never exposes anything else on such a connection.
 */
import * as nodeHttp from "http"
import * as nodeHttps from "https"
import type { ConnectionConfig } from "../config"
import { getConnectionConfig, log } from "../connections"
import { escapeXml, find, parseXml, XmlNode } from "./xml"

export const SOAP_RFC_PATH = "/sap/bc/soap/rfc"
const RFC_NS = "urn:sap-com:document:sap:rfc:functions"

export type RfcRow = Record<string, string>
/** Scalars are strings; a table is an array of rows (pass [] to have SAP send a table back). */
export type RfcParams = Record<string, string | RfcRow[]>

export interface RfcResult {
  scalar(name: string): string
  table(name: string): RfcRow[]
}

/** A SOAP fault: SAP's exception name (TABLE_NOT_AVAILABLE, FU_NOT_FOUND, …) when it sent one. */
export class SoapRfcError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message)
    this.name = "SoapRfcError"
  }
}

export interface SoapHttpResponse { status: number; body: string }
export type SoapTransport = (cfg: ConnectionConfig, path: string, body: string, timeoutMs: number) => Promise<SoapHttpResponse>

const defaultTransport: SoapTransport = (cfg, path, body, timeoutMs) => {
  const u = new URL(cfg.url)
  const isHttps = u.protocol === "https:"
  const lib = isHttps ? nodeHttps : nodeHttp
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")
  // keepAlive: Node then sends no "Connection: close" (agent: false or a plain agent would).
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 })
  return new Promise<SoapHttpResponse>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path,
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${RFC_NS}"`,
          "Content-Length": Buffer.byteLength(body),
        },
        agent,
        ...(isHttps && cfg.allowSelfSigned ? { rejectUnauthorized: false } : {}),
        ...(isHttps && cfg.ca ? { ca: cfg.ca } : {}),
      },
      res => {
        const chunks: Buffer[] = []
        res.on("data", d => chunks.push(d as Buffer))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`SOAP RFC request timed out after ${timeoutMs} ms`)))
    req.on("error", reject)
    req.end(body)
  }).finally(() => agent.destroy())
}

let transport: SoapTransport = defaultTransport

/** Tests replace the HTTP layer; pass undefined to restore it. */
export function setSoapTransport(t: SoapTransport | undefined): void {
  transport = t ?? defaultTransport
}

/** Connections whose logon was refused (HTTP 401, or a non-SOAP answer): never called again by this process. */
const logonRefused = new Map<string, string>()
/** Per-connection queue: one SOAP call at a time. */
const queues = new Map<string, Promise<unknown>>()

export function resetSoapRfcState(): void {
  logonRefused.clear()
  queues.clear()
}

export function buildEnvelope(fm: string, params: RfcParams): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const items = value.map(row =>
        `<item>${Object.entries(row).map(([f, v]) => `<${f}>${escapeXml(v)}</${f}>`).join("")}</item>`).join("")
      parts.push(items ? `<${name}>${items}</${name}>` : `<${name}/>`)
    } else {
      parts.push(`<${name}>${escapeXml(value)}</${name}>`)
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${RFC_NS}">` +
    `<soapenv:Body><urn:${fm}>${parts.join("")}</urn:${fm}></soapenv:Body></soapenv:Envelope>`
}

function rowOf(item: XmlNode): RfcRow {
  const row: RfcRow = {}
  for (const f of item.children) row[f.name] = f.text
  return row
}

/** Read a SOAP RFC response: the FM's result, or a SoapRfcError for a fault. */
export function parseResponse(fm: string, xml: string, status = 200): RfcResult {
  const doc = parseXml(xml)
  const body = find(doc, "Body")
  if (!body) throw new SoapRfcError(`SOAP RFC answer for ${fm} has no SOAP body (HTTP ${status})`, undefined, status)
  const fault = body.children.find(c => c.name === "Fault")
  if (fault) {
    const faultstring = find(fault, "faultstring")?.text.trim() ?? ""
    const exception = find(fault, "Name")?.text.trim() || undefined
    // SAP puts the readable text in <Text>; <Message> carries <ID>/<Number> (or text on some releases).
    const message = find(fault, "Message")
    const msgParts = message ? [message.text.trim(), ...message.children.map(c => c.text.trim())].filter(Boolean) : []
    const text = find(fault, "Text")?.text.trim() || msgParts.join(" ")
    throw new SoapRfcError(`${fm} failed: ${exception ?? faultstring}${text && text !== exception ? ` (${text})` : ""}`, exception ?? faultstring, status)
  }
  const resp = body.children.find(c => c.name === `${fm}.Response`) ?? body.children[0]
  if (!resp) throw new SoapRfcError(`SOAP RFC answer for ${fm} is empty (HTTP ${status})`, undefined, status)
  return {
    scalar: name => resp.children.find(c => c.name === name)?.text ?? "",
    table: name => (resp.children.find(c => c.name === name)?.children ?? []).filter(c => c.name === "item").map(rowOf),
  }
}

function soapPath(cfg: ConnectionConfig): string {
  const q: string[] = []
  if (cfg.client) q.push(`sap-client=${encodeURIComponent(cfg.client)}`)
  if (cfg.language) q.push(`sap-language=${encodeURIComponent(cfg.language)}`)
  return q.length ? `${SOAP_RFC_PATH}?${q.join("&")}` : SOAP_RFC_PATH
}

function refuseFurtherCalls(cfg: ConnectionConfig, msg: string): SoapRfcError {
  logonRefused.set(cfg.id, msg)
  log("ERROR", msg)
  return new SoapRfcError(msg, "LOGON_REFUSED", 401)
}

async function callOnce(cfg: ConnectionConfig, fm: string, params: RfcParams): Promise<RfcResult> {
  const refused = logonRefused.get(cfg.id)
  if (refused) throw new SoapRfcError(refused, "LOGON_REFUSED", 401)
  const t0 = Date.now()
  let resp: SoapHttpResponse
  try {
    resp = await transport(cfg, soapPath(cfg), buildEnvelope(fm, params), cfg.timeout ?? 60_000)
  } catch (err) {
    const e = err as { message?: string; code?: string }
    log("WARN", `SOAP RFC ${cfg.id} ${fm} failed after ${Date.now() - t0} ms: ${e?.message ?? err}${e?.code ? ` (${e.code})` : ""}`)
    throw new SoapRfcError(`${cfg.id}: ${fm} got no answer: ${e?.message ?? err}${e?.code ? ` (${e.code})` : ""}`, e?.code)
  }
  log("INFO", `SOAP RFC ${cfg.id} ${fm} → HTTP ${resp.status} (${Date.now() - t0} ms)`)
  if (resp.status === 401) {
    throw refuseFurtherCalls(cfg, `${cfg.id}: SAP refused the logon of ${cfg.username} (HTTP 401). No further calls go to ${cfg.id} until the ` +
      `server restarts, so a wrong password cannot lock the user. Check the user and password for ${cfg.id} in connections.json, then restart the server.`)
  }
  if (resp.status === 403) {
    throw new SoapRfcError(`${cfg.id}: HTTP 403 on ${SOAP_RFC_PATH} — the SOAP RFC service is not active in SICF on this system, ` +
      `or the user may not use it. Basis can activate /default_host/sap/bc/soap/rfc in SICF.`, "FORBIDDEN", 403)
  }
  if (resp.status === 404) {
    throw new SoapRfcError(`${cfg.id}: HTTP 404 on ${SOAP_RFC_PATH} — this system has no SOAP RFC service at that path.`, "NOT_FOUND", 404)
  }
  if (!/<([A-Za-z0-9_-]+:)?Envelope[\s>]/.test(resp.body)) {
    const shown = resp.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
    // A 5xx without SOAP is a server, proxy or ICM error page, not a logon answer.
    if (resp.status >= 500) {
      throw new SoapRfcError(`${cfg.id}: ${fm} answered HTTP ${resp.status}${shown ? `: ${shown}` : " with no body"}`, undefined, resp.status)
    }
    // Otherwise possibly a logon page (a form or SSO fallback answers a bad
    // password with HTTP 200 or a redirect), so it is treated like a 401.
    throw refuseFurtherCalls(cfg, `${cfg.id}: ${fm} got HTTP ${resp.status} with something that is not a SOAP answer` +
      `${shown ? ` ("${shown}")` : ""} — possibly a logon page after a failed logon. No further calls go to ${cfg.id} until the server ` +
      `restarts, so a wrong password cannot lock the user. Check ${SOAP_RFC_PATH} on ${cfg.id} and its user and password, then restart the server.`)
  }
  return parseResponse(fm, resp.body, resp.status)
}

/** Call a function module on a SOAP RFC connection (queued behind that connection's other calls). */
export function callRfc(connectionId: string | undefined, fm: string, params: RfcParams): Promise<RfcResult> {
  const cfg = getConnectionConfig(connectionId)
  const prev = queues.get(cfg.id) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(() => callOnce(cfg, fm, params))
  queues.set(cfg.id, run)
  return run
}
