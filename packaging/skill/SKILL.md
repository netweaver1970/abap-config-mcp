---
name: sap-abap
description: Work in SAP systems through the abap-config-mcp tools — ABAP development over ADT (search, read, write, activate, ATC, unit tests, debug, transports, where-used, dumps), BW modelling objects, table data queries, and SPRO/IMG customizing through the in-system SM30/SM34 engine with governed transport recording. Use whenever the user mentions SAP, ABAP, S/4HANA, ECC, BW/4HANA, IS-Retail/CAR, ADT, SE80/SE11/SE16/SE10/SM30/SPRO/ST22, transports, Z-objects, customizing, or asks about data in an SAP table.
---

# SAP ABAP & Customizing (abap-config-mcp)

The tools come from the **abap-config-mcp** server: 13 tools, one per area, each with an
`action` parameter. Reads and writes are separate tools (`abap` / `abap_write`,
`transport` / `transport_write`, `customizing` / `customizing_write`, `bw` / `bw_write`).
A call names the action and its parameters, for example
`customizing(action: "read", objectName: "V_T001W", connectionId: "S4")`.

The tools act in a real SAP system **as the SAP user of the chosen connection**. SAP
authorizations are the real control, but treat every write as a change to a shared system.

## Before the first call

1. Call `sap_system(action: "systems")`. It lists the configured systems (ids like `DEV`, `CAR`, `S4`).
   Pass that id as `connectionId` on every later call when more than one is configured.
2. If the tools are missing or that call fails, the server has no configuration.
   Walk the user through [references/setup.md](references/setup.md). Never ask them to
   paste a password into the chat; they put it in the config file or the install form.
3. If calls fail with a session/CSRF/"not logged on" error, call `admin(action: "relogin")`
   once, then retry.

## Ground rules

- **DEV → UAT only for writes.** If a connection id, URL or client looks like
  Production (`PRD`, `PROD`, `P01`…, or the user says so), stay read-only: reading code,
  where-used, ST22 dumps and table comparisons only.
- **Confirm before anything irreversible or shared:** releasing or deleting a transport,
  `abap_write(action: "delete")`, `customizing_write` with `commit: true`,
  `customizing_write(action: "org_copy")`, `bw_write(action: "delete")`,
  `admin(action: "engine_install")` / `admin(action: "engine_deploy")` (they install ABAP
  into the box), `abap_debug(action: "set_variable")`. Show what will happen first (dry
  run, plan, diff).
- **Transports are the user's choice.** Tools that record onto a transport resolve it
  in this order: a transport you pass → the request SAP already has the object locked
  in → `createTransport: true` → the transport this work item already uses → the single
  open request of the right kind, otherwise the tool **asks**. Relay that question to the
  user; never invent a transport number. Group related work with `workItem` (a ticket
  number or short name) so it lands on one request. `$TMP` objects need no transport.
- **Read before you write.** Fetch the current source (`abap(action: "source")`), change
  it, check it with `abap_test(action: "syntax")`, then write and activate. Never write
  source you have not read in this conversation.
- The tool surface may be capped by `ABAP_MCP_MAX_TIER` (0 = read-only, 1 = + governed
  customizing, 2 = everything). An action missing from a tool's list is deliberate: say
  so rather than working around it.

## Workflows

**Change ABAP code**
`abap(action: "search")` → `abap(action: "info")` → `abap(action: "source")` →
`transport(action: "for_object")` → `abap_write(action: "write")` (locks automatically) →
`abap_test(action: "syntax")` / `abap_test(action: "atc")` → `abap_write(action: "activate")` →
`abap_test(action: "unit")`.
If activation fails, read the errors, fix, write again. Don't leave inactive objects;
`abap(action: "inactive")` shows leftovers. New objects: `abap_write(action: "create")`
(package + transport), then the same loop. Run a console class (`IF_OO_ADT_CLASSRUN`) with
`abap_debug(action: "run_class")`.

**Find data when the table name is unknown**
`abap(action: "tables")` (by description; works for IS-Retail, Z/Y tables) →
`abap(action: "table")` → `data(action: "query")` (Open SQL with `UP TO n ROWS`) or
`data(action: "rows")`. Always limit rows. The `data` tool is off unless the server runs with
`ABAP_MCP_DATA_TOOLS=1` (SAP API Policy FAQ v1.3, question 33); if it is missing, say so
rather than working around it.

**Investigate a problem**
`sap_system(action: "dumps")` (ST22) → `abap(action: "source")` around the failing line →
`abap(action: "where_used")` → `abap(action: "versions")` to see what changed recently.

**Transports**
`transport(action: "list")` (all users, with objects) → `transport(action: "details")` →
`transport_write(action: "create" | "change_owner" | "release" | "delete")`. Confirm the last
two. `transport_write(action: "move")` moves objects between requests with a dependency check.

**Debug**
`abap_debug(action: "set_breakpoint")` → `abap_debug(action: "listen")` → the user triggers the
program in SAP → `abap_debug(action: "stack")` / `abap_debug(action: "variable")` /
`abap_debug(action: "step")` → `abap_debug(action: "delete_breakpoint")` when done.

**BW modelling objects**
`bw(action: "capabilities")` → `bw(action: "list")` / `bw(action: "read")` /
`bw(action: "where_used")`. Changes: `bw_write(action: "create" | "change")`, then
`bw_write(action: "activate")`; they record onto a transport like ABAP objects.

**Customizing / IMG (SPRO)**: see [references/customizing-engine.md](references/customizing-engine.md)
1. `customizing(action: "search")` to find the IMG activity and its tables/views.
2. `customizing(action: "describe")` → `customizing(action: "read")` →
   `customizing(action: "diff")` between org-unit keys.
3. `customizing(action: "plan")`, then `customizing_write(action: "copy")` **without**
   `commit` (dry run). Show the user the rows. Only after a yes: `commit: true`.
4. Commits run as a background job: poll `customizing(action: "status")` with the `runId`
   until done.
5. The engine must be installed in the box: `admin(action: "engine_ping")` checks version
   and client capabilities; if it is missing or stale, ask before
   `admin(action: "engine_install")`.
Writes go through the standard SM30/SM34 view runtime, so FK checks, change documents
and transport recording happen as in a manual change.

## Troubleshooting

| Symptom | Do |
|---|---|
| Session/CSRF errors, sudden 401/403 after idle | `admin(action: "relogin")`, retry once |
| "User is currently editing" / lock errors | `abap_write(action: "unlock")`, then write again |
| `data(action: "rows")` WHERE clause fails (400) | use `data(action: "query")` instead |
| Authorization error | it is SAP's answer for this user: report it, don't retry |
| Tool says the change may already be applied | read the current state before re-running |

Full per-tool parameters: [references/tools.md](references/tools.md).
Risk tiers and in-system objects: [references/tiers.md](references/tiers.md).
