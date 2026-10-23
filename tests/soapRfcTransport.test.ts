import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import * as http from "http"
import type { AddressInfo } from "net"

const g = globalThis as { __soapPort?: number }
vi.mock("../src/config", () => ({
  loadConfig: () => ({
    connections: [{ id: "LOCAL", url: `http://127.0.0.1:${(globalThis as { __soapPort?: number }).__soapPort}`, username: "U", password: "p", client: "200", protocol: "soap-rfc" }],
  }),
}))

import { callRfc, resetSoapRfcState } from "../src/soapRfc/client"

// The real Node transport against a local server that keeps connections alive, as SAP's ICM does.
let server: http.Server
const seen: Array<{ auth?: string; connection?: string; soapAction?: string; path?: string; remotePort?: number }> = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, connection: req.headers.connection, soapAction: req.headers.soapaction as string, path: req.url, remotePort: req.socket.remotePort })
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/xml; charset=utf-8" })
      res.end(`<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><urn:RFC_READ_TABLE.Response xmlns:urn="urn:sap-com:document:sap:rfc:functions"><FIELDS><item><FIELDNAME>MANDT</FIELDNAME></item></FIELDS></urn:RFC_READ_TABLE.Response></SOAP-ENV:Body></SOAP-ENV:Envelope>`)
    })
  })
  server.keepAliveTimeout = 30_000
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
  g.__soapPort = (server.address() as AddressInfo).port
  resetSoapRfcState()
})

afterAll(() => new Promise<void>(r => server.close(() => r())))

describe("SOAP RFC HTTP transport", () => {
  it("answers consecutive calls, each on its own socket, with Basic auth and no Connection: close", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await callRfc("LOCAL", "RFC_READ_TABLE", { QUERY_TABLE: "T000", NO_DATA: "X", FIELDS: [] })
      expect(r.table("FIELDS")).toEqual([{ FIELDNAME: "MANDT" }])
    }
    expect(seen).toHaveLength(3)
    expect(seen[0].auth).toBe(`Basic ${Buffer.from("U:p").toString("base64")}`)
    expect(seen[0].soapAction).toBe(`"urn:sap-com:document:sap:rfc:functions"`)
    expect(seen[0].path).toBe("/sap/bc/soap/rfc?sap-client=200")
    expect(seen.every(s => s.connection !== "close")).toBe(true)
    expect(new Set(seen.map(s => s.remotePort)).size).toBe(3)   // never a reused socket
  })
})
