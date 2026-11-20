/** Run the ABAP read tools in direct mode (ADT) and governed mode (engine) on one system and print both. */
process.env.ABAP_MCP_TOOLS = "legacy"
import { createMcpServer } from "../../src/server"
import { resetServerModeForTests } from "../../src/mode"
const c = process.argv[2] ?? "CAR"
const calls: [string, Record<string, unknown>][] = [
  ["search_abap_objects", { query: "ZCL_MCP_*", maxResults: 10 }],
  ["get_abap_object_info", { url: "/sap/bc/adt/oo/classes/zcl_mcp_bw_engine" }],
  ["get_abap_object_lines", { url: "/sap/bc/adt/programs/programs/zmcp_cust_write/source/main" }],
  ["search_abap_object_lines", { url: "/sap/bc/adt/oo/classes/zcl_mcp_abap_engine", pattern: "AUTHORITY-CHECK" }],
  ["where_used", { url: "/sap/bc/adt/oo/classes/zcl_mcp_cust_engine" }],
  ["version_history", { url: "/sap/bc/adt/programs/programs/rsparam" }],
  ["browse_package", { packageName: "$MCP_ENGINE" }],
  ["get_text_elements", { objectType: "PROG/P", objectName: "RSPARAM" }],
  ["check_inactive_objects", {}],
  ["search_database_tables", { keyword: "T001W" }],
  ["describe_database_table", { tableName: "T001W" }],
  ["syntax_check", { url: "/sap/bc/adt/programs/programs/rsparam/source/main", source: "REPORT rsparam.\nWRITE x." }],
  ["analyze_dump", {}],
]
;(async () => {
  for (const mode of ["direct", "governed"]) {
    process.env.ABAP_MCP_MODE = mode; resetServerModeForTests()
    const tools = (createMcpServer() as any)._registeredTools
    console.log(`\n################ ${mode.toUpperCase()} ################`)
    for (const [name, args] of calls) {
      let t: string
      try { const r = await tools[name].handler({ ...args, connectionId: c }, { sessionId: `cmp-${mode}` }); t = r.content.map((x: any) => x.text).join("\n") }
      catch (e) { t = `THROWN ${(e as Error).message}` }
      console.log(`\n=== ${name}\n${t.split("\n").slice(0, 9).join("\n").slice(0, 900)}`)
    }
  }
  process.exit(0)
})()
