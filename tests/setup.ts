// Tests must never touch the real transport memory (~/.abap-mcp/transport-memory.json).
import * as os from "os"
import * as path from "path"
process.env.ABAP_MCP_TRANSPORT_MEMORY ??= path.join(os.tmpdir(), `abap-mcp-transport-memory-test-${process.pid}.json`)
