# 001: Two constellations, legacy-adt and governed

> Since 2.1 (21 Nov 2026) governed is the default and the ADT constellation is called **legacy-adt**.
> This spec was written when it was called **direct**; below, "direct" means legacy-adt.

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

- `ABAP_MCP_MODE=governed|legacy-adt`, or `"mode"` in the `server` section of `connections.json`.
  The environment variable wins. Default `governed` since 2.1 (`direct` before); `direct` is still
  accepted as the old name of `legacy-adt`.
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
| Code reads: search, info, source, batch source, grep, where-used, version history, packages, text elements, inactive objects, table search and describe, syntax check (saves nothing), dumps | yes (engine 0.11.0) | the engine's read-only class ZCL_MCP_ABAP_ENGINE (abap_* actions), S_DEVELOP display checked per object |
| Code writes: write, create, delete, activate, ATC, unit tests, run class, debugger, data tools, manage_transport_requests | no | SAP's ADT MCP server instead |
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
   Design (draft, 19 Nov 2026; the API per object type is filled in from the research below):
   - **Lab facts.** S4 (SAP_BW 816) and CAR (SAP_BW 757) both have embedded BW of the BW 7.5 line;
     neither has BW/4HANA (DW4CORE). BW/4HANA support is built from detection and SAP's documented
     APIs and verified when a BW/4 system is available.
   - **A separate class, ZCL_MCP_BW_ENGINE**, reached through the existing endpoint: the customizing
     engine dispatches operations starting with `bw_` to it with a dynamic call, so a system without
     BW (or with the other BW line) never stops the customizing engine from activating.
   - **No static references to BW objects.** BW/4HANA has no SAP_BW component and lacks many BW 7.5
     APIs (InfoCube and classic DSO BAPIs), and BW 7.5 lacks some BW/4 ones, so every BW function
     module is called by name after FUNCTION_EXISTS, every BW class through a dynamic call after a
     class lookup, and BW structures are created by name at run time. The class activates on BW 7.5,
     BW/4HANA and a system with no BW at all.
   - **Detection, never assumption.** `bw_capabilities` reports the BW line (DW4CORE → BW/4HANA,
     SAP_BW → BW 7.5, none) and, per object type and operation, whether the API it needs exists.
     Every other action refuses an operation whose API is missing with a three-part message.
   - **Tools, the same in both modes** (BW never goes through ADT, so direct and governed register
     the same BW tools): `bw_list` (type, name pattern, InfoArea), `bw_read` (type, name, version A or
     M), `bw_where_used` (RSOOBJXREF), and the writes `bw_create`, `bw_change`, `bw_activate`,
     `bw_delete`, each a dry run unless `commit: true`, each with governed transport selection
     (Workbench requests, as BW objects record on them), and `bw_delete` refusing while the object is
     still used, unless the caller names the users to go with it.
   - **Order:** InfoObject and InfoArea, then ADSO, then CompositeProvider, transformation and DTP,
     then process chains; classic objects (InfoCube, classic DSO, MultiProvider) on BW 7.5 only;
     queries read and delete only, if a headless API exists.
   API research (19 Nov 2026, S4 and CAR, read-only): every modern BW class implements the TLOGO
   framework (IF_RSO_TLOGO_MAINTAIN: prepare/save/activate/delete/check; IF_RSO_TLOGO_GENERAL:
   get_all, get_related); RSTLOGOPROP is the registry of all object types (main table, name field,
   text table, classes); RSOOBJXREF the generic where-used. No BW API takes a transport request, and
   with BW's transport layer on they ask for one in a dialog, so the engine calls them with it off
   and records with RS_TR_WRITE_OBJECTS_TO_REQUEST (package and master language supplied: no
   popup). Per type: InfoObject BAPI_IOBJ_CREATE/CHANGE/ACTIVATE_MULTIPLE/GETDETAIL/GETLIST, delete
   only RSDG_IOBJ_MULTI_DELETE; ADSO CL_RSO_ADSO_API (CREATE/READ/UPDATE/DELETE/GET_ADSO_LIST, no
   separate activate); InfoArea RSAPI_AREA_CREATE/DELETE (transport layer always on: dialog risk);
   CompositeProvider CL_RSO_HCPR_METADATA_API (union only; joins only through the model XML);
   transformation RSTRAN_API_CREATE plus CL_RSTRAN_TRFN; DTP CL_RSBK_DTP (CREATE_FROM_TLOGO_LIST
   forces the transport layer on, so its three steps are repeated with it off); process chain
   CL_RSPC_CHAIN with I_WITH_DIALOG = ' ' (RSPC_API_* are run-time only); InfoCube, classic DSO and
   MultiProvider BAPIs without a delete (the TLOGO collection deletes); queries RSZ_X_COMPONENT_GET
   and _DELETE, create only by copying. Traps: the collection's ACTIVATE defaults to a check
   protocol popup (always pass ' '); the delete popup appears only with a GUI.

   Slice 1 (engine 0.10.0, ZCL_MCP_BW_ENGINE, commit 4d7f6a4):
   - `bw_capabilities` (line, BW client, per type and operation available / no_api / not_built),
     `bw_list`, `bw_read` (versions, package, header rows; InfoObject definition through
     BAPI_IOBJ_GETDETAIL) and `bw_where_used` for all 75 types in RSTLOGOPROP on S4, driven by the
     registry, no type named in code; InfoObject create, change (from the current definition, single
     fields or whole tables), activate and delete (where-used checked by BW).
     Unknown fields are refused (texts are TEXTSHORT and TEXTLONG in BAPI6108).
   - Writes refuse when BW is not set up in the connection's client (RS_MANDT_UNIQUE_GET).
   - Live: S4 has embedded BW without a BW client and only delivered (D) content, so reads work
     (version D) and writes are refused with that reason. CAR (BW client 600): create, read, change,
     list, where-used, delete of a test InfoObject in $TMP, with texts, through BW's own APIs, no popup.
   - Not tested live yet: BW/4HANA (no system). A $TMP object gets no TADIR entry, since BW's
     transport layer is off.

   Slice 1b (engine 0.10.1): transportable objects end to end, live on CAR in package ZMCP_BW_E2E
   (KORRFLAG X, no transport layer) on request CARK900038:
   - create records R3TR IOBJ on the request's task, locked there, with a TADIR entry in the package;
     change, activate and delete of an object already locked on a request use that request without
     asking (SAP accepts no other), and naming another request is refused before anything is written;
   - a dry run no longer needs a request; it says one is needed to commit;
   - recorded deletion, as RSD1 does it: the object goes on the request first
     (RS_TR_WRITE_OBJECTS_TO_REQUEST), then RSDG_IOBJ_MULTI_DELETE deletes it (now with I_MANUAL = 'X',
     a user's deletion; before it ran in after-import mode). BW's own delete always runs with its
     transport layer off (I_WITH_CTO false), so recording is the caller's job. The R3TR IOBJ entry
     stays on the request for an object with no versions left, and BW's export ships the deletion;
     TADIR keeps the entry until then. BW dropped the generated DDIC objects' TADIR entries itself.
   - Next slices: ADSO (CL_RSO_ADSO_API), InfoArea, CompositeProvider union, transformation and DTP, process chains, classic objects on BW 7.5,
     ABAP Unit tests for the BW class.
   Still to settle:
   - activation and transport: BW objects record on Workbench requests and need activation, which
     changes M versions into A versions;
   - test system: a BW system in the lab, since CAR and S4 are not BW systems (embedded BW in S4 may do
     for a first pass).
3. **Engine through abapGit.** Publish the engine objects (ZCL_MCP_CUST_ENGINE,
   ZMCP_CUST_WRITE, ZCL_MCP_DIAG) as an abapGit repository, with a short install guide
   including the SICF node. `engine_deploy` in direct mode stays as it is.
   DONE (engine 0.10.1): `abapgit/` generated from the deployed sources (`npm run abapgit`, plus the
   offline zip in release/ and a root `.abapgit.xml` for linking the repository online), metadata
   byte-identical to abapGit 1.133's own serializers (taken from a headless export on S4), and a
   test that keeps the folder current. Installed on CAR through abapGit's own offline import and
   pull, headless (`scripts/abapgit-install.ts`): fresh install into `$MCP_ENGINE`, 7 objects
   active, ping through the new SICF node, 13/13 ABAP Unit tests, and abapGit's export of the
   package identical to `abapgit/` (round trip, `--verify`). Found on the way: abapGit matches an
   existing SICF node by a hash of its URL; a node from an older ADT deploy did not match on CAR,
   and abapGit nested a second node under it, so the guide says to remove an earlier node first.
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
   PROGRESS 2026-11-19 (engine 0.10.3): one path per action and a `whoami` action in the engine;
   OpenAPI 3.0.3 description, 24 operations (src/gateway/openapi.ts, docs/gateway/), plus a second
   document of 11 read-only ABAP operations for a second MCP server (engine 0.11.0); a local
   stand-in for IdP, gateway and Cloud Connector (src/gateway/simulator.ts). On CAR, through that
   chain: the signed-in user reached SAP as that user by X.509 client certificate over TLS, reads
   and a dry-run write worked, missing/forged/expired tokens, an unmapped user and an untrusted CA
   were all refused (8/8, scripts/propagation/e2e.ts). The Cloud Connector header path (system
   certificate + SSL_CLIENT_CERT, icm/trusted_reverse_proxy_0 set in the running ICM) also 8/8;
   without the trusted proxy ICM ignored the header (401). Finding: behind a trusted proxy ICM does
   not check the forwarded certificate's issuer, so a DN-only mapping let a rogue-CA certificate log
   on; mapping with the issuer (VUSREXTID) or CERTRULE closes it (tested). CAR was reverted.
   Made permanent on CAR, then redone on S4 from docs/PRINCIPAL_PROPAGATION.md (user GEERT): both
   systems 8/8 in both modes. The redo found that the back end's clock matters: S4 runs about two
   hours ahead and refused every short-lived certificate as expired (simulator: --skew-minutes); after NTP was enabled on the host (2026-11-20) S4 passes 8/8 in both modes without it. Set-up guide: docs/PRINCIPAL_PROPAGATION.md.
   Still open: the real BTP side (IAS, destination, MCP server artifact, Cloud Connector).
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
- Step 5: `img_search` registered in governed mode. It uses only the engine's existing img_search
  action (a full CUS_IMGACT scan in SAP); the STREE-index and raw-table fallbacks read through ADT and
  are left out, so an engine that does not answer gives the reason instead. An empty keyword is refused
  (the engine needs one) and `inScopeOnly` is not applied (the engine does not read CUS_IMGACH_SCOPE),
  which the answer says. Compared live on S4: three searches identical in both modes.
- Step 6 (engine 0.9.42): ABAP Unit tests in the engine's test include
  (`zcl_mcp_cust_engine.testclasses.abap`, 13 tests, risk level harmless): the row cap, the delivery
  classes a read covers, name checks and quoting, and the refusals of read, ddic_describe,
  retest_scope, transport_info and dependencies. Test tables are picked from the DDIC, not named, so
  they run on any ABAP system. The bootstrap installs them after the class is active and empties the
  include again if it does not activate, so the tests never block the engine. 13 of 13 pass on S4
  (S/4HANA, SAP_BASIS 816) and on CAR (non-S/4 retail, SAP_BASIS 757); on CAR the governed describe,
  read and img_search of POS DTA customizing match direct mode (field texts added).
- Phase 2 is complete: 18 tools in governed mode. Left for later: the background-job scope for 7.40
  systems (see the release-floor note), and phases 2.5, 3 and 4.

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

### Tool groups and full retest (2026-11-19)

- The server's 66 tools are registered as 13 group tools with an `action` each (toolGroups.ts):
  reads and writes in separate groups, the action list filtered by mode, tier and data switch,
  per-action argument checks, old names in texts rewritten; `ABAP_MCP_TOOLS=legacy` keeps the old
  surface. 70 800 instead of 96 400 characters of tool definitions.
- Live matrix, every action of every group on CAR and S4 in both modes (writes as dry runs or on
  throwaway `$TMP` objects; transport release not run): CAR direct 82 pass, S4 direct 78 pass,
  CAR governed 30 pass, S4 governed 25 pass (the rest not offered in governed mode). Fixed on the
  way: see commit 3abca70. Known edge: deleting a package in the same ADT session that created it
  answers "is already locked" (SAP keeps the creating session's lock); a new session deletes it.

## Read-only ABAP in governed mode (2026-11-20, engine 0.11.0)

The user chose to keep code reading in governed mode instead of leaving all code work to SAP's ADT
MCP server. ZCL_MCP_ABAP_ENGINE (optional class, installed with the engine) answers abap_search,
abap_info, abap_source, abap_where_used, abap_versions, abap_package, abap_text_elements,
abap_inactive, abap_tables, abap_syntax and abap_dumps. It reads the repository (TADIR, READ REPORT,
cl_oo_factory for class source, WBCROSSGT/CROSS/WBCROSSI, VRSD, DWINACTIV, text pools, SNAP) and runs
SYNTAX-CHECK, which saves nothing; nothing in it writes. Every object is checked against S_DEVELOP
display (ACTVT 03) for its type, name and package; other users' dumps need S_DEVELOP display for
DEBUG. In governed mode the fourteen ABAP read tools keep their parameters (ADT URLs are turned into
type and name) and get engine-backed handlers (src/tools/abapEngineRead.ts). Through the gateway the
reads are a second MCP server (docs/gateway/zmcp_abap.openapi.json), because one server takes at most
30 tools. Writing, activating and deleting code stay with SAP's ADT MCP server.

Tested on CAR: every action called in SAP; the fourteen tools in both modes side by side
(scripts/abapread/compare.ts); the gateway chain 11/11 in both Cloud Connector modes with three ABAP
scenarios. Not yet on S4 (unreachable during the test). Limits: where-used depends on SAP's
cross-reference index; the syntax check reports the first error, and checks a supplied source for
executable programs only (other objects: the stored version).

Tested on S4 on 2026-11-21 as well: engine installed, the fourteen tools match between the modes
(two expected differences: a package that does not exist is reported as such instead of as empty,
and dumps cover the last 7 days by default), the gateway chain 11/11 in both Cloud Connector modes.

## Governed by default, direct renamed legacy-adt (2026-11-21, 2.1, engine 0.11.1)

With code reading in place, governed mode covers the daily work outside code changes, so it is the
default for new installs. Direct mode is now called legacy-adt: it still works and is still tested,
but it is the route for sandboxes and one's own development systems, not the recommended setup.

- `serverMode()` returns `governed` when nothing is set; `legacy-adt` and the old name `direct`
  select the ADT mode. An installation that relied on the old default sets `"mode": "legacy-adt"`.
- In governed mode the shared HTTP server still needs per-user logon on every connection (rule 4);
  stdio runs as its own user and is exempt. The startup message names the connections that stop it.
- The Claude Desktop extension asks for the mode in its install form, default governed.
- The engine documents itself in SAP: a comment block at the top of ZCL_MCP_CUST_ENGINE covers what
  it is, who it runs as, its operations, the authorizations it checks, how writes work and how to
  install, check, upgrade and remove it, with the GitHub repository for the rest. The other engine
  objects describe their own part and point to it. Engine 0.11.1 carries only that documentation;
  installed on CAR through abapGit (round trip identical) and on S4 through ADT.
