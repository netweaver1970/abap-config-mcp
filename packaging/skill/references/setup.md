# Setting up the SAP connection

The server reads its SAP systems from a JSON file. Passwords live only there (or in the
Claude Desktop install form) — never in the chat.

## Claude Code plugin

Create `~/.abap-mcp/connections.json`:

```json
{
  "connections": [
    {
      "id": "DEV",
      "url": "https://your-sap-host:44300",
      "username": "DEVELOPER",
      "password": "…",
      "client": "100",
      "language": "EN",
      "allowSelfSigned": true
    }
  ]
}
```

- `id` is the `connectionId` you pass to tools; list several systems to work across them.
- `allowSelfSigned: true` for dev boxes with self-signed TLS certificates.
- Then restart Claude Code (or run `/mcp` and reconnect the `abap` server).
- Optional environment variables, set before starting Claude Code:
  - `ABAP_MCP_CONFIG=/path/to/connections.json` — use a different file.
  - `ABAP_MCP_MAX_TIER=0` — read-only tool surface (1 = + governed customizing).
- Requires Node.js 18+ on the `PATH` (`node --version`).

## Claude Desktop extension (.mcpb)

Settings → Extensions → SAP ABAP & Customizing → Configure. Either fill in one system
(URL, client, user, password) or point **connections.json** at a file with several
systems (the file wins when both are set). Lower **Max risk tier** to `0` for a
read-only setup.

## SAP side

- SAP NetWeaver 7.40+ or S/4HANA with ADT active in SICF (`/sap/bc/adt`).
- The SAP user's authorizations are the real limit: `S_DEVELOP` for code, `S_TABU_DIS`
  for table maintenance, `S_TRANSPRT` for transports, debug activities for debugging.
  A read-only user makes every write tool fail, which is right for Production.
- Customizing tools need the in-system engine (`customizing_engine_ping` tells whether
  it is installed; `customizing_engine_bootstrap` installs it into `$TMP` or a package).

## Checking it works

Ask Claude to "list the connected SAP systems" — it calls `connected_systems`. A login
failure names the reason (wrong client, locked user, TLS); fix the file and reconnect.
