#!/usr/bin/env node
/**
 * Standalone live smoke test for a configured SAP connection.
 *
 * Usage:
 *   npm run test-connection            # tests the first configured connection
 *   npm run test-connection -- CAR     # tests the connection with id "CAR"
 *
 * It logs in, fetches the ADT discovery, and runs a tiny object search —
 * enough to confirm the URL, credentials, TLS settings, and ADT service are
 * all working, without modifying anything on the system.
 */
import { loadConfig } from "./config"
import { getClient } from "./connections"

async function main(): Promise<void> {
  const requestedId = process.argv[2]
  const config = loadConfig()
  const target = requestedId
    ? config.connections.find(c => c.id === requestedId)
    : config.connections[0]

  if (!target) {
    console.error(`❌ No connection found${requestedId ? ` with id "${requestedId}"` : ""}.`)
    console.error(`   Available: ${config.connections.map(c => c.id).join(", ") || "(none)"}`)
    process.exit(1)
  }

  if (target.logon === "per-user") {
    console.error(`❌ ${target.id} is set to per-user logon: it has no SAP user of its own here. Each MCP client sends its own in the X-SAP-User and X-SAP-Password headers, so test it through an MCP client.`)
    process.exit(1)
  }

  console.log(`\n🔌 Testing connection "${target.id}" → ${target.url}`)
  console.log(`   user: ${target.username} | client: ${target.client ?? "(default)"} | language: ${target.language ?? "EN"}`)
  if (target.url.toLowerCase().startsWith("https:")) {
    console.log(`   TLS: ${target.allowSelfSigned ? "accepting self-signed certs" : "verifying certificate"}`)
  }

  const t0 = Date.now()

  try {
    console.log(`\n→ Logging in...`)
    const client = await getClient(target.id)
    console.log(`✅ Login OK (${Date.now() - t0} ms)`)

    console.log(`→ Fetching ADT discovery...`)
    const discovery = await client.adtDiscovery()
    console.log(`✅ ADT service reachable — ${discovery.length} service collection(s) advertised`)

    console.log(`→ Running a sample object search (Z*)...`)
    const results = await client.searchObject("Z*", undefined, 5)
    console.log(`✅ Search OK — ${results.length} object(s) returned`)
    for (const r of results.slice(0, 5)) {
      console.log(`     ${r["adtcore:type"].padEnd(10)} ${r["adtcore:name"]}`)
    }

    console.log(`\n🎉 Connection "${target.id}" is fully working (${Date.now() - t0} ms total).`)
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = (err as { response?: { status?: number } })?.response?.status
    console.error(`\n❌ Connection test failed after ${Date.now() - t0} ms:`)
    console.error(`   ${msg}`)
    console.error(`\nTroubleshooting:`)
    if (status === 401) {
      console.error(`   401 = authentication rejected (the ICM and /sap/bc/adt are reachable — good).`)
      console.error(`   • Wrong client? "${target.client ?? "(default)"}" — confirm ${target.username} actually logs into that client in SAP GUI.`)
      console.error(`   • Initial/expired password? ADT Basic auth can't change it — set a productive password in SU01, then retry.`)
      console.error(`   • Quick check: open http://<host>:<port>/sap/bc/adt/discovery?sap-client=${target.client ?? "001"} in a browser and log in.`)
    } else if (status === 403) {
      console.error(`   403 = authenticated but not authorized — check S_DEVELOP / S_TCODE (SE80) for ${target.username}.`)
    } else {
      console.error(`   • Wrong port? System nr 01 → HTTP usually :8001, HTTPS :44301`)
      console.error(`   • TLS error on HTTPS? add "allowSelfSigned": true to the connection`)
      console.error(`   • Connection refused? ensure ICF node /sap/bc/adt is active (SICF)`)
    }
    process.exit(1)
  }
}

main()
