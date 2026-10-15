# abap-config — SAP ABAP & customizing for Claude

Three ways to deploy the same server (`abap-config-mcp`, 58 tools) and skill (`sap-abap`).
Built by `npm run package` in the abap-config-mcp repo; everything lands in `release/`.

| You use | Install | SAP login goes in |
|---|---|---|
| **Claude Code** | this folder as a plugin marketplace | `~/.abap-mcp/connections.json` |
| **Claude Desktop** | `abap-config-mcp-<version>.mcpb` (double-click) | the extension's Configure form |
| Claude Desktop / claude.ai, guidance only | `sap-abap-skill-<version>.zip` under Settings → Capabilities → Skills | — (pair it with the .mcpb) |

No daemon, port or shared secret: Claude starts the server itself over stdio. Needs
Node.js 18+ for the Claude Code plugin (Claude Desktop brings its own).

## Claude Code

Publish this folder as a git repository (e.g. a private GitHub repo your team can read),
then each user runs, inside Claude Code:

```
/plugin marketplace add <owner>/<repo>
/plugin install abap-config@abap-config
```

For a quick local test, point it at the folder instead: `/plugin marketplace add /path/to/abap-config-marketplace`.

Then create `~/.abap-mcp/connections.json`:

```json
{
  "connections": [
    { "id": "DEV", "url": "https://your-sap-host:44300", "username": "DEVELOPER",
      "password": "…", "client": "100", "language": "EN", "allowSelfSigned": true }
  ]
}
```

and restart Claude Code. `ABAP_MCP_CONFIG` (other file) and `ABAP_MCP_MAX_TIER`
(`0` read-only, `1` + governed customizing, `2` everything) are honoured when set in the
environment Claude Code starts from.

Update: bump the version in the repo, `npm run package`, commit the new marketplace
folder; users run `/plugin marketplace update abap-config`.

## Claude Desktop

Double-click the `.mcpb` (or Settings → Extensions → Install extension…), then fill in
URL / client / user / password — the password is stored in the OS keychain — or select a
`connections.json` for several systems. Set **Max risk tier** to `0` for Production.

## Safety

Every call runs as the configured SAP user; SAP authorizations are the real control.
Intended for DEV → UAT; on Production use a read-only user and tier `0`.
