#!/bin/sh
# Start the stdio server. With no SAP system configured (no SAP_URL, no
# ABAP_MCP_CONFIG), start against a placeholder that can never be reached, so the
# server still answers the MCP handshake and tools/list. Nothing is sent anywhere:
# warm-up is off, and a tool call fails with a name-resolution error.
if [ -z "$SAP_URL" ] && [ -z "$ABAP_MCP_CONFIG" ]; then
  echo "abap-config-mcp: no SAP system configured (set SAP_URL, SAP_USER, SAP_PASSWORD or ABAP_MCP_CONFIG); tools are listed but cannot run." >&2
  export SAP_URL="https://sap-not-configured.invalid"
  export SAP_USER="NOT_CONFIGURED"
  export SAP_PASSWORD="not-configured"
  export ABAP_NO_WARMUP=1
fi
exec node /app/dist/stdio.js "$@"
