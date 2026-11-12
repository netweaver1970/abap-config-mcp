import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerDiscoveryTools } from "./discovery"
import { registerSourceTools } from "./source"
import { registerWriteTools } from "./write"
import { registerActivateTools } from "./activate"
import { registerQualityTools } from "./quality"
import { registerTransportTools } from "./transports"
import { registerTransportMoveTools } from "./transportMove"
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
import { wrapServerWithSoapRfcRouting } from "./soapRfcRouting"
import { wrapServerWithTierGating, getMaxTier } from "./riskTiers"
import { wrapServerWithAnnotations } from "./toolAnnotations"
import { log } from "../connections"
import { serverMode, wrapServerWithModeGating, GOVERNED_TOOLS } from "../mode"

let _governedLogged = false

export function registerAllTools(server: McpServer): void {
  // Every handler registered below gets automatic forceReconnect-and-retry
  // on session-degradation errors (HTTP 400 after heavy use) — see
  // sessionRecovery.ts.
  //
  // Innermost: bind each call to its MCP session, so the recovery retry (which
  // reconnects) also acts on that session's own ADT session only.
  //
  // Between the two: a call for a SOAP RFC connection (a system without ADT) goes
  // to its read-only SOAP handler or is refused, before any ADT reconnect logic
  // can run — see soapRfcRouting.ts. ADT calls pass through unchanged.
  const guarded = wrapServerWithSessionRecovery(wrapServerWithSoapRfcRouting(wrapServerWithSessionScope(server)))

  // Risk-tier gating: ABAP_MCP_MAX_TIER caps which tools are exposed (0 = read-
  // only/diagnostics, 1 = + customizing writes, 2/unset = full incl. code
  // writes). Lets a Production-pointed server run reads only. See riskTiers.ts.
  const maxTier = getMaxTier()
  const gated = maxTier < 2 ? wrapServerWithTierGating(guarded, maxTier) : guarded

  // Governed mode (ABAP_MCP_MODE=governed): only the tools that work through the engine's HTTP
  // endpoint are registered; everything that needs ADT is left out. See mode.ts.
  const governed = serverMode() === "governed"
  const modeSkipped: string[] = []
  const moded = governed ? wrapServerWithModeGating(gated, modeSkipped) : gated

  // Outermost: every tool carries MCP annotations (read-only, destructive,
  // idempotent) from one hand-checked table — see toolAnnotations.ts.
  const target = wrapServerWithAnnotations(moded)
  log("INFO", `Registering tools with ABAP_MCP_MAX_TIER=${maxTier}` +
    (maxTier < 2 ? " — higher-tier tools will be hidden" : " (full surface)"))

  registerDiscoveryTools(target)
  registerSourceTools(target)
  registerWriteTools(target)
  registerActivateTools(target)
  registerQualityTools(target)
  registerTransportTools(target)
  registerTransportMoveTools(target)
  registerDataTools(target)
  registerAnalysisTools(target)
  registerDebugTools(target)
  registerTextElementTools(target)
  registerPackageTools(target)
  registerTableDiscoveryTools(target)
  registerCustomizingTools(target)
  registerCustomizingEngineTools(target)
  registerEngineDeployTools(target)

  if (governed && !_governedLogged) {
    _governedLogged = true   // one server per client session registers again; say it once per process
    log("INFO", `Governed mode: ${GOVERNED_TOOLS.size} tools registered; left out (they need ADT): ${modeSkipped.join(", ")}. ` +
      `Phase 2 adds the customizing and transport tools.`)
  }
}
