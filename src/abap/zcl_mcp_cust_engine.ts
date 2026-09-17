/**
 * ABAP source for the in-system Customizing Engine.
 *
 * Deployed to SAP by `customizing_engine_bootstrap` via the server's own
 * write+activate tooling.  Version-controlled here so a single tool call
 * (re)deploys the latest engine without any separate upload.
 *
 * Protocol: HTTP POST to the registered SICF node, JSON body.
 * JSON keys are UPPERCASE to map 1:1 onto ABAP structure components
 * (/ui2/cl_json pretty_mode-none).
 *
 * Request:
 *   { "OPERATION":"ping" }
 *   { "OPERATION":"read",  "TABLE":"TCURR", "KEY_FIELD":"KURST", "SOURCE_KEY":"M" }
 *   { "OPERATION":"write", "TABLE":"TCURR", "KEY_FIELD":"KURST",
 *     "SOURCE_KEY":"M", "TARGET_KEY":"Z1", "TRANSPORT":"CARK900123",
 *     "ONLY_MISSING":"X", "COMMIT":"" }
 *
 * Response:
 *   { "STATUS":"ok", "OPERATION":"write", "DRY_RUN":"X",
 *     "ROWS_PLANNED":3, "ROWS_WRITTEN":0, "TRANSPORT":"CARK900123",
 *     "MESSAGES":[ "..." ] }
 *
 * VERSION: bump on every change so `ping` confirms the deployed level.
 *
 * The ABAP body lives in `zcl_mcp_cust_engine.abap` (read from disk at call
 * time by `getEngineSource()`), so an ABAP-only edit needs no rebuild/restart —
 * just re-run `customizing_engine_bootstrap`. This file holds the metadata, the
 * generated HSRCH CASE block, and the loader.
 */
import { readAbap, applyPlaceholders } from "./loadSource"

export const ENGINE_VERSION = "0.9.29"

export const ENGINE_CLASS_NAME = "ZCL_MCP_CUST_ENGINE"
export const ENGINE_CLASS_URL = `/sap/bc/adt/oo/classes/${ENGINE_CLASS_NAME.toLowerCase()}`
/** Default SICF path the handler is expected to be registered under. */
export const ENGINE_ICF_PATH = "/sap/bc/zmcp_cust"

// IMPORT FROM DATABASE requires the cluster AREA to be a 2-char *literal* (not a
// variable), so handle_img_index_read branches per language exactly like
// SAPLSHI10's STREE_UPDATE_SEARCH_TEXT_INDEX: D=01, E=02, A=03, B=04, C=05,
// F=06 … digits 0-9 = 27-36, lowercase d,e,a,b,c,f… = 37-62. This emits the
// WHEN branches for that CASE so the ABAP stays in sync without hand-writing 62.
export function hsrchAreaCases(): string {
  const order = "DEABCFGHIJKLMNOPQRSTUVWXYZ0123456789deabcfghijklmnopqrstuvwxyz"
  return [...order].map((ch, i) => {
    const area = String(i + 1).padStart(2, "0")
    return (
      `          WHEN '${ch}'.\n` +
      `            IMPORT p_structure_texts = lt_txt p_child_structures = lt_chl\n` +
      `              FROM DATABASE indx_hsrch(${area}) ID lv_sid.\n` +
      `            lv_got = abap_true.`
    )
  }).join("\n")
}

/**
 * The engine class source, read from `zcl_mcp_cust_engine.abap` at call time
 * with the version and the generated HSRCH area-CASE substituted in.
 */
export function getEngineSource(): string {
  return applyPlaceholders(readAbap("zcl_mcp_cust_engine"), {
    ENGINE_VERSION,
    HSRCH_AREA_CASES: hsrchAreaCases(),
  })
}
