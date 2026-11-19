/**
 * Optional ABAP class ZCL_MCP_BW_ENGINE: the BW part of the engine (spec 001, phase 2.5).
 * ZCL_MCP_CUST_ENGINE hands every bw_* operation to it with a dynamic call, so the
 * customizing engine never depends on BW. customizing_engine_bootstrap installs it only
 * when the system has BW (CVERS: SAP_BW for BW 7.5, DW4CORE for BW/4HANA).
 */
import { readAbap } from "./loadSource"

export const BW_ENGINE_CLASS_NAME = "ZCL_MCP_BW_ENGINE"
export const BW_ENGINE_CLASS_URL = `/sap/bc/adt/oo/classes/${BW_ENGINE_CLASS_NAME.toLowerCase()}`

export function getBwEngineSource(): string {
  return readAbap("zcl_mcp_bw_engine")
}
