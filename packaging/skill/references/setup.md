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
  - `ABAP_MCP_MODE=legacy-adt` — work over ADT as well (writing and testing code,
    installing the engine from here). The default, `governed`, makes no ADT calls.
- Requires Node.js 18+ on the `PATH` (`node --version`).

## Claude Desktop extension (.mcpb)

Settings → Extensions → SAP ABAP & Customizing → Configure. Either fill in one system
(URL, client, user, password) or point **connections.json** at a file with several
systems (the file wins when both are set). **Mode** is `governed` (default) or
`legacy-adt`. Lower **Max risk tier** to `0` for a read-only setup.

## SAP side

- SAP NetWeaver 7.40+ or S/4HANA.
- **Governed mode (default):** the in-system engine must be installed, with abapGit
  (online repository https://github.com/netweaver1970/abap-config-mcp, folder
  `/abapgit/src/`, or the engine zip from a release) or by transport, and its SICF
  service `/sap/bc/zmcp_cust` active. The engine's own documentation is the comment
  block at the top of class `ZCL_MCP_CUST_ENGINE` (SE24 or ADT). Code changes go
  through SAP's ADT MCP server or ADT in Eclipse.
- **legacy-adt mode:** ADT active in SICF (`/sap/bc/adt`).
- The SAP user's authorizations are the real limit: `S_DEVELOP` for code, `S_TABU_DIS`
  for table maintenance, `S_TRANSPRT` for transports, debug activities for debugging.
  A read-only user makes every write tool fail, which is right for Production.
- `admin(action: "engine_ping")` tells whether the engine is installed and current. In
  legacy-adt mode `admin(action: "engine_install")` installs it into `$TMP` or a package;
  ask the user first.

## Checking it works

Ask Claude to "list the connected SAP systems" — it calls `connected_systems`. A login
failure names the reason (wrong client, locked user, TLS); fix the file and reconnect.
