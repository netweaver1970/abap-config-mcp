/**
 * Optional ABAP class ZCL_MCP_ABAP_ENGINE: the read-only ABAP part of the engine. ZCL_MCP_CUST_ENGINE
 * hands every abap_* operation (except abap_memory) to it with a dynamic call. Governed mode uses it
 * for the ABAP read actions, so search, source, where-used and the rest work without ADT.
 */
import { readAbap } from "./loadSource"

export const ABAP_ENGINE_CLASS_NAME = "ZCL_MCP_ABAP_ENGINE"
export const ABAP_ENGINE_CLASS_URL = `/sap/bc/adt/oo/classes/${ABAP_ENGINE_CLASS_NAME.toLowerCase()}`

export function getAbapEngineSource(): string {
  return readAbap("zcl_mcp_abap_engine")
}
