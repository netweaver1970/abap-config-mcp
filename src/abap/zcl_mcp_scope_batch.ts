/**
 * Optional ABAP class ZCL_MCP_SCOPE_BATCH: retest_scope's eight-tables-per-statement
 * counting (ABAP SQL UNION, SAP_BASIS 7.50+). Kept out of ZCL_MCP_CUST_ENGINE so the
 * engine still activates on 7.40; the engine calls it dynamically and counts one
 * table at a time when it is missing. customizing_engine_bootstrap installs it only
 * on 7.50 and later.
 */
import { readAbap } from "./loadSource"

export const SCOPE_BATCH_CLASS_NAME = "ZCL_MCP_SCOPE_BATCH"
export const SCOPE_BATCH_CLASS_URL = `/sap/bc/adt/oo/classes/${SCOPE_BATCH_CLASS_NAME.toLowerCase()}`
/** Lowest SAP_BASIS release (CVERS-RELEASE) whose ABAP SQL has UNION. */
export const SCOPE_BATCH_MIN_BASIS = 750

export function getScopeBatchSource(): string {
  return readAbap("zcl_mcp_scope_batch")
}

/** True when this SAP_BASIS release (e.g. "750", "816", "740") can run the class. */
export function basisSupportsScopeBatch(release: string | undefined): boolean {
  const n = parseInt((release ?? "").trim(), 10)
  return Number.isFinite(n) && n >= SCOPE_BATCH_MIN_BASIS
}
