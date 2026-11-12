# 001: Two constellations, direct and governed

Status: draft, 12 Nov 2026. Items marked NEEDS CONFIRMATION are open.

## Why

SAP's API Policy (v.4.2026a) and its FAQ (v1.3, June 2026) shape what an MCP server for SAP
may do. FAQ question 33 says ADT is for development through SAP's own channels (Eclipse ADT,
abapGit, SAP's own tools), and not for reading application tables or running SQL. Question 37
endorses SAP's own MCP servers, which now include an ADT MCP server in Eclipse ADT and ADT for
VS Code. Questions 23 and 27 say customer-namespace code is the customer's own, as long as it
does not circumvent API controls or open a pathway for unendorsed agentic AI or mass data
extraction.

Today this server does everything itself over ADT. That stays available, unchanged, as the
**direct** constellation. This spec adds a **governed** constellation in which the server never
calls ADT: code work goes through SAP's own ADT MCP server running next to it in the same AI
client, and this server adds what SAP's doesn't have (customizing through the SM30/SM34
runtime, org copy with its retest list, transport intelligence), working only through the
in-system engine, which is customer-namespace code.

## The switch

- `ABAP_MCP_MODE=direct|governed`, or `"mode"` in the `server` section of `connections.json`.
  The environment variable wins. Default `direct`.
- Read once at startup; changing it needs a restart. One mode per server process.
- `connected_systems` and the startup log state the mode.
- NEEDS CONFIRMATION: a per-connection override (`"mode"` on a connection) for landscapes that
  mix a sandbox (direct) with a controlled Dev (governed). Not in the first version.

## Direct mode

Exactly today's behaviour and tool set, including the opt-in data tools
(`ABAP_MCP_DATA_TOOLS`) and per-user logon. No change in this spec.

## Governed mode

### Rules

1. **No ADT.** The server creates no ADT client. `ensureConnected` refuses with a three-part
   message (what: "Calling ADT for <tool> on <ID>", why: "this server runs in governed mode,
   which makes no ADT calls", what to do: "use SAP's ADT MCP server for code work, or run this
   server with ABAP_MCP_MODE=direct"). A test proves that no governed-mode tool reaches it.
2. **Engine only.** Every governed-mode tool works through the engine's ICF endpoint
   (`/sap/bc/zmcp_cust`, customer namespace), or a later gateway in front of it (phase 4).
3. **Purpose-built engine actions, no generic SQL.** Each engine action does one documented
   thing with a row limit and its own authority check (S_TABU_DIS for table reads,
   S_TRANSPRT for CTS). The engine gets no "run this SELECT" action, so it can't become the
   pathway question 27 warns about.
4. **Own users only.** In governed mode a connection must be per-user (shared HTTP server) or
   the person's own user (stdio). A shared-user connection is refused at startup with a
   three-part message. NEEDS CONFIRMATION: refuse, or allow with a warning.
5. **No engine deployment through ADT.** `customizing_engine_bootstrap`, `engine_deploy`,
   `customizing_engine_cleanup` and every `autoDeploy` are off. The engine arrives by abapGit
   (phase 3) or by transport from a system where it was deployed in direct mode. A missing or
   outdated engine gives a three-part message naming both routes.

### Tool set

| Tool | Governed mode | Through |
| --- | --- | --- |
| connected_systems | yes | local config |
| customizing_engine_ping, customizing_status | yes | engine (existing) |
| img_search | yes | engine (existing) |
| customizing_apply, customizing_create | yes | engine (existing); transport candidates via new `transports` action |
| retail_listing | yes | engine (existing) |
| org_copy | yes | engine (existing); retest scope via new `retest_scope` action |
| transport_move | yes | engine (existing); open requests and dependencies via new actions |
| hana_memory_report, abap_memory_report | yes | engine (existing) |
| customizing_read | yes | new `read` mode with keyField/keyValue filter and maxRows |
| customizing_describe | yes | new `ddic_describe` action |
| customizing_diff | yes | two engine reads, compared in the server |
| customizing_plan_change | yes | `ddic_describe` + engine read, plan built in the server |
| list_all_transports | yes | new `transports` action |
| get_transport_for_object | yes | new `transport_info` action |
| customizing_selftest | yes, without autoDeploy | engine (existing) |
| All code tools: source, write, create, delete, activate, ATC, unit tests, run class, debugger, where-used, version history, dumps, inactive objects, text elements, packages, table discovery, data tools, manage_transport_requests | no | SAP's ADT MCP server instead |
| customizing_engine_bootstrap, engine_deploy, customizing_engine_cleanup | no | abapGit or transport (rule 5) |

Tool descriptions in governed mode say, where it helps, which SAP ADT MCP tool covers the
code side (for example: "to activate, use SAP's ADT MCP server").

### New engine actions (ABAP, customer namespace)

| Action | Returns | Limits and checks |
| --- | --- | --- |
| `ddic_describe` | for a table or maintenance view: fields, keys, data elements, domains, check tables, delivery class, client dependency, the view's base tables and its transport object | DDIC metadata only; S_TABU_DIS on the table's authorization group |
| `read` (extended) | rows of a customizing table or view, optionally where one key field equals one value | delivery class C, G or E only; maxRows capped (default 200, max 1000); S_TABU_DIS |
| `transports` | open requests and tasks: number, kind, owner, client, text, target, optionally their objects | modifiable only by default; capped at 500 requests and 100 with objects; S_TRANSPRT display |
| `transport_info` | for one object: package, whether it records, the request holding its lock, the requests its transport layer allows | read-only; S_TRANSPRT display |
| `retest_scope` | for an org key and source/target values: row counts per keyed table, in the three lists org_copy shows today | counts only, never rows; stops after a time budget and reports what it didn't count |
| `dependencies` | for objects on a request: what they use and what uses them on other open requests, from the where-used index | read-only; capped |

The server keeps the logic it has today (transport selection rules, retest classification,
release order, plan building); only where it gets its facts from changes.

## Phases

1. **Switch and gating.** The mode switch, the ADT guard, governed tool registration for the
   tools whose engine actions already exist, the startup checks (rules 4 and 5), docs. Tools
   that need new actions are not registered in governed mode yet.
2. **New engine actions.** The six actions above, with ABAP unit tests where the logic allows,
   then the remaining governed-mode tools. Live test on S4 in both modes.
3. **Engine through abapGit.** Publish the engine objects (ZCL_MCP_CUST_ENGINE,
   ZMCP_CUST_WRITE, ZCL_MCP_DIAG) as an abapGit repository, with a short install guide
   including the SICF node. `engine_deploy` in direct mode stays as it is.
4. **Engine behind SAP's MCP Gateway** (optional). SAP's MCP Gateway in Integration Suite
   (Premium and Enhanced editions, trial and free plan for trying; Integration Cell runtime
   only; up to 50 tools per MCP server; OAuth in front) can turn an on-premise HTTP endpoint
   with an OpenAPI 3.0.x description into MCP tools, one tool per operation, through a Cloud
   Connector destination that supports principal propagation. Tool names, descriptions and
   parameters can be curated in the gateway. So:
   - give the engine's ICF handler one path per action (for example `/read`, `/ddic_describe`,
     `/apply`, `/org_copy`, `/transports`) and a curated OpenAPI 3.0.x description;
   - accept the propagated user (X.509 from Cloud Connector) instead of basic auth on that
     path;
   - any MCP client that speaks Streamable HTTP (Claude, Copilot Studio, Joule) then calls
     the engine through SAP's gateway, with gateway logging, quotas and access policies.
   In that set-up this server is optional for the gateway's tools; it stays useful for the
   logic the engine doesn't carry (transport rules, release order, retest classification).
   Fallback if HTTP propagation fails: RFC-enabled function modules per action (the gateway's
   RFC source, one tool per function module), about twice the effort.
   NEEDS CONFIRMATION, before building: a one-day test that the agent's own user reaches SAP
   end to end (SAP's July 2026 roadmap still listed full propagation as coming), payload and
   timeout limits, metering of MCP calls, and whether SAP sees a customer-namespace
   customizing writer behind its gateway as within questions 23, 27 and 35.

## Tests

- Mode switch: each mode registers exactly its tool set; the environment variable wins over the
  config; default is direct.
- Governed mode never constructs an ADT client (mock the constructor to throw) for any
  registered tool; a direct-mode run of the same tool still does.
- Startup refusals for rules 4 and 5 give the three-part messages.
- Engine action contracts on the server side with a mocked engine; live runs on S4 for every
  governed tool, compared with the direct-mode result for the same input.

## Docs

README: a short "Two ways to run it" section near the top (direct: everything in one server,
for your own sandbox and Dev; governed: next to SAP's ADT MCP server, no ADT calls of its own),
the switch, the governed tool list, and the link to the API Policy section.

## Open questions (NEEDS CONFIRMATION)

- Does SAP's ADT MCP server work against on-premise S/4HANA and older NetWeaver, and is its
  transport tool set enough for code requests in the governed constellation?
- Rule 4: refuse or warn on shared-user connections in governed mode.
- Per-connection mode override.
- Which CTS function modules are released for `transport_info`, or whether plain SELECTs on
  E070/E071/TLOCK in customer code are the safer route.
- Phase 4 details from the MCP Gateway scoping.
