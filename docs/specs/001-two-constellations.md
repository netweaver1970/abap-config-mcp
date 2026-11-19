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
| `ddic_describe` | for a table or maintenance view: the resolved maintenance object (view, base tables, text table, function group, IMG activity, view cluster, transport object, by the same rules as the server's resolver), the root table's fields, keys, data elements, domains, check tables and check fields, delivery class, client dependency, and the client's recording settings (T000, which apply and create need) | DDIC metadata only; display authorization on the root table (S_TABU_DIS on its group, else S_TABU_NAM) |
| `read` (extended) | rows of a customizing table, optionally where one field of it equals one value (the server resolves a view to its root table first) | database tables of delivery class C, G or E only; maxRows capped (default 200, max 1000) and the answer says when it was cut; display authorization (S_TABU_DIS, else S_TABU_NAM) |
| `transports` | requests with their tasks: number, kind, status, owner, date, client, text, target, optionally their objects; or one request looked up by number (a task gives its request); filters: kinds, statuses, owner (optionally with the requests the owner has a task in), client | modifiable only by default; capped at 500 requests, objects for the newest 100 and at most 500 per request; S_TRANSPRT display |
| `transport_info` | for one object (R3TR type and name; the server maps an ADT URL): package, whether it records (TDEVC-KORRFLAG), transport layer and target (TR_GET_TRANSPORT_TARGET, guarded by FUNCTION_EXISTS), the open request and task holding it, and the user's open workbench requests to that target | read-only; S_TRANSPRT display |
| `retest_scope` | for an org-key domain and source/target values: the client-dependent transparent tables keyed on the domain (C/G/E and A, at most 8000 key fields each), with source and target row counts, counted in org_copy's priority order (customizing outside the copier's set, then the copier's tables, then application data); the server sorts them into the three lists org_copy shows today | counts only, never rows; eight tables per statement (a UNION ALL of eight dynamic branches); stops after a time budget (default 25 s, max 120 s) and reports what it didn't count; a table the user may not display (S_TABU_DIS, else S_TABU_NAM) is not counted |
| `dependencies` | transport_move's facts, in three parts: FACTS (for the two numbers: their requests, every task of those requests, their object entries and the modules of each function group among them), WHERE_USED (for the moved repository objects: the names they use, function modules resolved to their group, and the includes that use them, from WBCROSSGT/CROSS), HOLDERS (the open tasks and requests holding R3TR entries of given names) | read-only; S_TRANSPRT display; at most 20000 entries (the plan stops above that), 100 objects for where-used, 2000 names for holders |

The server keeps the logic it has today (transport selection rules, retest classification,
release order, plan building); only where it gets its facts from changes.

## Phases

1. **Switch and gating.** The mode switch, the ADT guard, governed tool registration for the
   tools whose engine actions already exist, the startup checks (rules 4 and 5), docs. Tools
   that need new actions are not registered in governed mode yet.
2. **New engine actions.** The six actions above, with ABAP unit tests where the logic allows,
   then the remaining governed-mode tools. Live test on S4 in both modes.
2.5. **BW objects** (requested 19 Nov 2026, not designed yet). MCP tools for create, read, update and
   delete on all BW objects. Decided (19 Nov 2026):
   - both BW 7.5 and BW/4HANA, detected at run time (object types differ: InfoCubes and classic DSOs
     exist only in BW 7.5; ADSOs and CompositeProviders in both), never assumed from the release;
   - no ADT, so not the BW modeling REST services either: BW's own ABAP APIs (the RSD* / RSO* function
     modules and classes BW itself uses for create, change, activate and delete) behind the engine,
     guarded the same way as the customizing actions (each one checked with FUNCTION_EXISTS or a class
     lookup before use, an authority check per action, no generic SQL).
   Still to settle:
   - which objects first: InfoObjects, ADSOs, CompositeProviders, transformations, DTPs, process
     chains, queries, InfoAreas, source systems and DataSources;
   - activation and transport: BW objects record on Workbench requests and need activation, which
     changes M versions into A versions;
   - test system: a BW system in the lab, since CAR and S4 are not BW systems (embedded BW in S4 may do
     for a first pass).
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

### Phase 2 progress

- Step 1 (engine 0.9.37): `read` hardened, `ddic_describe` added; `customizing_describe`, `customizing_read`,
  `customizing_diff` and `customizing_plan_change` registered in governed mode through
  `src/tools/customizingSource.ts` (ADT source in direct mode, engine source in governed mode).
  Compared live on S4 in both modes: same maintenance object for V_T001W, T001W, TVKO, T001, T005, T006;
  same rows for read; byte-identical diff and change plan on TVKOV. Differences, all on purpose:
  governed describe drops the `.INCLU` pseudo-fields, gives field texts and foreign keys (direct
  mode's DD08L query asks for a column DD08L does not have, so it never lists any), refuses an
  unknown name instead of describing it, and dates come back as YYYY-MM-DD.
  The text table is now found the DDIC's way in both modes (DD08L FRKART 'TEXT' to the root table),
  not by the first member with a LANG field.
- Step 2 (engine 0.9.38): `transports` and `transport_info` added. `transportSql.ts` answers from the
  engine in governed mode (request lookup, open requests for transport selection), so
  `customizing_apply` and `customizing_create` run in governed mode with the same selection rules;
  their delivery-class and SCC4 checks come from `ddic_describe`, and in governed mode a failed
  resolve or recording check stops the write instead of carrying on. `list_all_transports` and
  `get_transport_for_object` registered. Compared live on S4: apply and create dry runs and the two
  refused commits (unknown request, workbench request) byte-identical; transport_info gives the same
  package, lock and allowed requests as ADT. Direct mode's object listing reads 8 requests at a time
  with one 2000-row cap, so a large request crowds out its neighbours (A4HK900030: 8 objects shown,
  over 500 there); the engine reads each request on its own.
- Step 3 (engine 0.9.39): `retest_scope` added; `org_copy` registered in governed mode
  (`buildOrgScopeViaEngine` in `orgScope.ts`, same classification and output as direct mode).
  One table per statement was too slow (about 22 ms a table, cold; the plant's application part
  ran out of time); eight per statement brought the plant (WERKS, about 1,800 keyed tables) to
  28 s cold and 5 s warm, against 17 s in direct mode. Compared live on S4: VKORG and WERKS
  dry runs byte-identical; BUKRS (about 5,000 keyed tables) gives the same customizing section
  in both modes, and both run out of time in the application part, which the re-run with
  `retestScope: "application"` covers. ABAP SQL goes through S/4's replacement objects
  (MARD and the like), which is why the counts match.
- Step 4 (engine 0.9.40): `dependencies` added; `transport_move` registered in governed mode
  (`MoveFacts` in `transportMove.ts`: `AdtMoveFacts` keeps the SQL, `EngineMoveFacts` answers from one
  FACTS snapshot of both request families and refuses a question outside them). A unit test serves
  the engine from the same fake tables as the direct-mode tests and requires identical plans for ten
  scenarios. Compared live on S4: six dry runs byte-identical in both modes (including SAP's own
  TR712 refusal), governed 7 s against 58 s.
- Release floor (found 19 Nov 2026): the engine's syntax needs about 7.40 SP08 (inline declarations,
  `@` host variables, /ui2/cl_json). Step 3's batched counting uses UNION, which ABAP SQL has only from
  7.50, so as it stands the class no longer activates on a 7.40 system (Solution Manager 7.2, ECC EHP7).
  Fixed in engine 0.9.41: the batching lives in the optional class ZCL_MCP_SCOPE_BATCH, which the
  engine calls dynamically (CALL METHOD ('ZCL_MCP_SCOPE_BATCH')=>('COUNT8')); the engine class has
  no UNION again. `customizing_engine_bootstrap` installs the optional class only when CVERS says
  SAP_BASIS 750 or later, and a failed activation of it is a warning, not a failed install;
  `customizing_engine_cleanup` removes it. Without it the engine counts one table per statement and
  the scope says so when it runs out of time. Tested on S4 both ways: with the class, WERKS in 3 to 5 s
  and identical to direct mode; without it, WERKS complete in 13 s, BUKRS out of time after 920 of
  1573 customizing tables, with the note. Not tested: activation on a real 7.40 system (none in the
  lab); the floor is read from the syntax. Open: on a 7.40 system a company code's scope may not
  finish within the 30 s budget even with retestScope: "customizing"; a background job (as org_copy
  uses) would lift that limit.

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
