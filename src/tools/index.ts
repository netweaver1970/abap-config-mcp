import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerDiscoveryTools } from "./discovery"
import { registerSourceTools } from "./source"
import { registerWriteTools } from "./write"
import { registerActivateTools } from "./activate"
import { registerQualityTools } from "./quality"
import { registerTransportTools } from "./transports"
import { registerDataTools } from "./data"
import { registerAnalysisTools } from "./analysis"
import { registerDebugTools } from "./debug"
import { registerTextElementTools } from "./textelements"
import { registerPackageTools } from "./packages"
import { registerTableDiscoveryTools } from "./tablediscovery"
import { registerCustomizingTools } from "./customizing"
import { registerCustomizingEngineTools } from "./customizingEngine"
import { registerEngineDeployTools } from "./engineDeploy"
import { wrapServerWithSessionRecovery, wrapServerWithSessionScope } from "./sessionRecovery"
import { wrapServerWithTierGating, getMaxTier } from "./riskTiers"
import { log } from "../connections"

export function registerAllTools(server: McpServer): void {
  // Every handler registered below gets automatic forceReconnect-and-retry
  // on session-degradation errors (HTTP 400 after heavy use) — see
  // sessionRecovery.ts.
  //
  // Innermost: bind each call to its MCP session, so the recovery retry (which
  // reconnects) also acts on that session's own ADT session only.
  const guarded = wrapServerWithSessionRecovery(wrapServerWithSessionScope(server))

  // Risk-tier gating: ABAP_MCP_MAX_TIER caps which tools are exposed (0 = read-
  // only/diagnostics, 1 = + customizing writes, 2/unset = full incl. code
  // writes). Lets a Production-pointed server run reads only. See riskTiers.ts.
  const maxTier = getMaxTier()
  const target = maxTier < 2 ? wrapServerWithTierGating(guarded, maxTier) : guarded
  log("INFO", `Registering tools with ABAP_MCP_MAX_TIER=${maxTier}` +
    (maxTier < 2 ? " — higher-tier tools will be hidden" : " (full surface)"))

  registerDiscoveryTools(target)
  registerSourceTools(target)
  registerWriteTools(target)
  registerActivateTools(target)
  registerQualityTools(target)
  registerTransportTools(target)
  registerDataTools(target)
  registerAnalysisTools(target)
  registerDebugTools(target)
  registerTextElementTools(target)
  registerPackageTools(target)
  registerTableDiscoveryTools(target)
  registerCustomizingTools(target)
  registerCustomizingEngineTools(target)
  registerEngineDeployTools(target)
}
