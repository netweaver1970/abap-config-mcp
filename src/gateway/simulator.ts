/**
 * A local stand-in for SAP's MCP Gateway chain, to test the engine behind it with the end
 * user's identity (spec 001, phase 4; docs/PRINCIPAL_PROPAGATION.md):
 *
 *   MCP client ──Bearer JWT──▶ Gateway ──SAP-Connectivity-Authentication──▶ Cloud Connector ──mTLS──▶ ICM ──▶ engine
 *   (agent)        (IdP token)   (one tool per                (short-lived X.509 for the user)   (maps the certificate
 *                                 OpenAPI operation)                                              to an SAP user)
 *
 * - IdP: signs RS256 JWTs (stands in for SAP Cloud Identity Services / IAS).
 * - Gateway: an MCP server whose tools are the OpenAPI operations (as Integration Suite's MCP
 *   Gateway does, at most 30); every call needs a valid, unexpired token from the trusted IdP.
 * - Cloud Connector: checks the token again, issues an X.509 certificate for the user from a
 *   subject pattern (as Cloud Connector's principal propagation does), and calls SAP either with
 *   that certificate ("direct") or with its own system certificate and the user's certificate in
 *   the SSL_CLIENT_CERT header ("header": what Cloud Connector does, accepted by ICM only from a
 *   reverse proxy trusted in icm/trusted_reverse_proxy_<n>).
 *
 * Certificates are made with the openssl command line; nothing here talks to BTP.
 */
import * as crypto from "crypto"
import * as fs from "fs"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { GATEWAY_SETS, GATEWAY_TOOL_LIMIT, type GatewaySet } from "./openapi"

// ─── IdP ─────────────────────────────────────────────────────────────────────

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

export interface Idp { issuer: string; audience: string; publicKey: crypto.KeyObject; issue(user: string, opts?: { ttlSeconds?: number; email?: string; issuer?: string; audience?: string }): string }

export function createIdp(issuer = "https://ias.mcp-simulation.test", audience = "mcp-gateway"): Idp {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  return {
    issuer, audience, publicKey,
    issue(user, opts = {}) {
      const now = Math.floor(Date.now() / 1000)
      const header = { alg: "RS256", typ: "JWT" }
      const payload = { iss: opts.issuer ?? issuer, aud: opts.audience ?? audience, sub: user, user_name: user,
        email: opts.email ?? `${user.toLowerCase()}@mcp-simulation.test`, iat: now, exp: now + (opts.ttlSeconds ?? 300) }
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
      return `${signingInput}.${b64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey))}`
    },
  }
}

export interface TokenClaims { iss: string; aud: string; sub: string; user_name: string; email: string; exp: number }

/** Verify an RS256 JWT against the trusted IdP: signature, issuer, audience, expiry. Throws the reason. */
export function verifyToken(token: string | undefined, idp: Pick<Idp, "issuer" | "audience" | "publicKey">): TokenClaims {
  if (!token) throw new Error("no token: the caller did not sign in")
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("not a JWT")
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
  if (header.alg !== "RS256") throw new Error(`algorithm ${header.alg} is not accepted`)
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), idp.publicKey, Buffer.from(parts[2], "base64url"))
  if (!ok) throw new Error("signature does not verify against the trusted identity provider")
  const c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenClaims
  if (c.iss !== idp.issuer) throw new Error(`issuer ${c.iss} is not trusted`)
  if (c.aud !== idp.audience) throw new Error(`audience ${c.aud} is not this gateway`)
  if (!c.exp || c.exp * 1000 < Date.now()) throw new Error("token expired")
  return c
}

// ─── Cloud Connector ─────────────────────────────────────────────────────────

export interface Pki { dir: string; caCert: string; caKey: string; ccCert: string; ccKey: string }

export interface CloudConnectorOptions {
  idp: Pick<Idp, "issuer" | "audience" | "publicKey">
  pki: Pki
  /** Subject pattern of the user certificate, as in Cloud Connector's principal propagation settings */
  subjectPattern?: string
  /** "direct": present the user certificate; "header": own system certificate + SSL_CLIENT_CERT header */
  mode: "direct" | "header"
  /** SAP: https://host:port, client */
  sapUrl: string
  sapClient: string
  /** Validity of the user certificate in minutes (Cloud Connector default: 60) */
  certMinutes?: number
  /** For negative tests: sign user certificates with another CA */
  signWith?: { cert: string; key: string }
  /** Host name → address, when the SAP host name in the TLS certificate is not in DNS here */
  resolve?: Record<string, string>
  /** Widen the user certificate's validity by this many minutes on both sides, for a back end whose clock is off */
  clockSkewMinutes?: number
}

export interface IssuedCert { subject: string; certPem: string; keyPem: string }

/** A short-lived certificate for the token's user, signed by the given CA (openssl). */
export function issueUserCert(claims: TokenClaims, pattern: string, ca: { cert: string; key: string }, minutes: number, skewMinutes = 0): IssuedCert {
  const subject = pattern.replace(/\$\{(\w+)\}/g, (_m, k: string) => String((claims as unknown as Record<string, unknown>)[k] ?? ""))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cc-"))
  try {
    const key = path.join(dir, "u.key"), csr = path.join(dir, "u.csr"), crt = path.join(dir, "u.crt"), ext = path.join(dir, "ext")
    fs.writeFileSync(ext, "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n")
    const subj = "/" + subject.split(",").map(s => s.trim()).reverse().join("/")
    execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", subj], { stdio: "ignore" })
    // valid from now (minus a minute of clock skew) for the given minutes, like Cloud Connector's short-lived certificates
    const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"
    execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca.cert, "-CAkey", ca.key, "-set_serial", "0x" + crypto.randomBytes(8).toString("hex"),
      "-not_before", stamp(new Date(Date.now() - (1 + skewMinutes) * 60_000)), "-not_after", stamp(new Date(Date.now() + (minutes + skewMinutes) * 60_000)),
      "-out", crt, "-extfile", ext], { stdio: "ignore" })
    return { subject, certPem: fs.readFileSync(crt, "utf8"), keyPem: fs.readFileSync(key, "utf8") }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

export interface SapCall { status: number; body: string; userCertSubject: string }

/** One call through the Cloud Connector: token in, SAP's answer out. */
export async function cloudConnectorCall(o: CloudConnectorOptions, token: string | undefined, sapPath: string, body: unknown): Promise<SapCall> {
  const claims = verifyToken(token, o.idp)   // Cloud Connector trusts only the subaccount's IdP
  const ca = o.signWith ?? { cert: o.pki.caCert, key: o.pki.caKey }
  const user = issueUserCert(claims, o.subjectPattern ?? "CN=${user_name},O=MCP Simulation,C=BE", ca, o.certMinutes ?? 5, o.clockSkewMinutes ?? 0)
  const url = new URL(sapPath, o.sapUrl)
  url.searchParams.set("sap-client", o.sapClient)
  const payload = JSON.stringify(body ?? {})
  const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }
  let cert: string, key: string
  if (o.mode === "header") {
    cert = fs.readFileSync(o.pki.ccCert, "utf8"); key = fs.readFileSync(o.pki.ccKey, "utf8")
    headers["SSL_CLIENT_CERT"] = user.certPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "")
  } else {
    cert = user.certPem; key = user.keyPem
  }
  return await new Promise((resolve, reject) => {
    const pinned = o.resolve?.[url.hostname]
    const lookup = pinned ? ((_h: string, opts: unknown, cb: (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void) =>
      (opts as { all?: boolean })?.all ? cb(null, [{ address: pinned, family: 4 }]) : cb(null, pinned, 4)) : undefined
    const req = https.request(url, { method: "POST", headers, cert, key, rejectUnauthorized: true, timeout: 120_000, ...(lookup ? { lookup: lookup as never } : {}) }, res => {
      const chunks: Buffer[] = []
      res.on("data", c => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), userCertSubject: user.subject }))
    })
    req.on("error", reject)
    req.on("timeout", () => req.destroy(new Error("SAP did not answer within 120 s")))
    req.end(payload)
  })
}

// ─── Gateway ─────────────────────────────────────────────────────────────────

export interface GatewayOptions {
  /** The token of the MCP session's user (the real gateway takes it from the OAuth flow) */
  token: () => string | undefined
  idp: Pick<Idp, "issuer" | "audience" | "publicKey">
  /** Forward a call: the Cloud Connector hop */
  forward: (token: string, path: string, body: unknown) => Promise<SapCall>
  /** Base path of the engine on SAP */
  basePath?: string
  /** Which gateway MCP server: cust (default) or abap (read-only ABAP) */
  set?: GatewaySet
}

const toZod = (s: Record<string, unknown>): z.ZodType => {
  const t = s.type as string
  const base = t === "boolean" ? z.boolean() : t === "integer" ? z.number().int() : Array.isArray(s.enum) ? z.enum(s.enum as [string, ...string[]]) : z.string()
  return base.describe(String(s.description ?? ""))
}

/** An MCP server with one tool per OpenAPI operation, as the gateway exposes them. */
export function createGatewayServer(o: GatewayOptions): McpServer {
  const ops = GATEWAY_SETS[o.set ?? "cust"].ops
  if (ops.length > GATEWAY_TOOL_LIMIT) throw new Error(`${ops.length} operations: the gateway takes at most ${GATEWAY_TOOL_LIMIT} per MCP server`)
  const server = new McpServer({ name: "sap-mcp-gateway-simulator", version: "1.0.0" })
  for (const op of ops) {
    const shape: Record<string, z.ZodType> = {}
    for (const [k, s] of Object.entries(op.props)) shape[k] = op.required?.includes(k) ? toZod(s) : toZod(s).optional()
    server.registerTool(op.op, {
      title: op.summary, description: op.description, inputSchema: shape,
      annotations: { readOnlyHint: !op.write, destructiveHint: !!op.write, openWorldHint: true },
    }, async (args: Record<string, unknown>) => {
      let token: string
      try { token = o.token() ?? ""; verifyToken(token, o.idp) } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Gateway refused the call: ${(e as Error).message}.` }] }
      }
      const body = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "X" : "") : v]))
      try {
        const r = await o.forward(token, `${o.basePath ?? "/sap/bc/zmcp_cust"}/${op.op}`, body)
        let text = `HTTP ${r.status} (SAP logon with certificate ${r.userCertSubject})\n`
        try {
          const j = JSON.parse(r.body)
          text += [`${j.STATUS}: ${(j.MESSAGES ?? []).join("\n")}`, j.DATA_JSON ? `DATA: ${j.DATA_JSON}` : ""].filter(Boolean).join("\n")
        } catch { text += r.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400) }
        return { isError: r.status !== 200, content: [{ type: "text" as const, text }] }
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Cloud Connector refused the call: ${(e as Error).message}.` }] }
      }
    })
  }
  return server
}
