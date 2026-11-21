// Tests must never touch the real transport memory (~/.abap-mcp/transport-memory.json).
import * as os from "os"
import * as path from "path"
process.env.ABAP_MCP_TRANSPORT_MEMORY ??= path.join(os.tmpdir(), `abap-mcp-transport-memory-test-${process.pid}.json`)

// Nor the real SAP connections: a developer's connections.json (in the repo folder or
// ~/.abap-mcp) must not decide whether the suite passes, and CI has none. One fixed
// test connection from the environment, which loadConfig prefers when ABAP_MCP_CONFIG is unset.
delete process.env.ABAP_MCP_CONFIG
delete process.env.ABAP_MCP_DEFAULT_CONNECTION
process.env.SAP_URL = "https://sap-test.invalid:44300"
process.env.SAP_USER = "TESTER"
process.env.SAP_PASSWORD = "not-a-password"
process.env.SAP_CLIENT = "100"
process.env.SAP_ID = "DEV"
process.env.ABAP_NO_WARMUP = "1"

// The server's default mode is governed (no ADT). Most suites mock ADT and test the
// legacy-adt paths, so every test starts in legacy-adt; suites for governed mode set it
// themselves in their own beforeEach, which runs after this one.
import { beforeEach } from "vitest"
import { resetServerModeForTests } from "../src/mode"
process.env.ABAP_MCP_MODE = "legacy-adt"
beforeEach(() => { process.env.ABAP_MCP_MODE = "legacy-adt"; resetServerModeForTests() })
