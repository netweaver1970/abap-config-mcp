import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAllTools } from "./tools/index"
import { installParamGuard } from "./tools/paramGuard"
import { version as SERVER_VERSION } from "../package.json"

// ─── MCP server factory (shared by the HTTP and stdio entry points) ────────

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "abap-config-mcp", version: SERVER_VERSION })
  installParamGuard(server)
  registerAllTools(server)
  return server
}
