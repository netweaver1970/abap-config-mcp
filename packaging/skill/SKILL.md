---
name: sap-abap
description: Work in SAP systems through the abap-config-mcp tools — ABAP development over ADT (search, read, write, activate, ATC, unit tests, debug, transports, where-used, dumps), table data queries, and SPRO/IMG customizing through the in-system SM30/SM34 engine with governed transport recording. Use whenever the user mentions SAP, ABAP, S/4HANA, ECC, IS-Retail/CAR, ADT, SE80/SE11/SE16/SE10/SM30/SPRO/ST22, transports, Z-objects, customizing, or asks about data in an SAP table.
---

# SAP ABAP & Customizing (abap-config-mcp)

The tools come from the **abap-config-mcp** server (58 tools). They act in a real SAP
system **as the SAP user of the chosen connection** — SAP authorizations are the real
control, but treat every write as a change to a shared system.

## Before the first call

1. Call `connected_systems` — it lists the configured systems (ids like `DEV`, `CAR`, `S4`).
   Pass that id as `connectionId` on every later call when more than one is configured.
2. If the tools are missing or `connected_systems` fails, the server has no configuration.
   Walk the user through [references/setup.md](references/setup.md) — never ask them to
   paste a password into the chat; they put it in the config file or the install form.
3. If calls fail with a session/CSRF/"not logged on" error, call `force_relogin` once,
   then retry.

## Ground rules

- **DEV → UAT only for writes.** If a connection id, URL or client looks like
  Production (`PRD`, `PROD`, `P01`…, or the user says so), stay read-only: reading code,
  where-used, ST22 dumps and table comparisons only.
- **Confirm before anything irreversible or shared:** releasing or deleting a transport,
  `delete_abap_object`, `customizing_apply` with `commit: true`, `org_copy`,
  `engine_deploy` / `customizing_engine_bootstrap` (they install ABAP into the box),
  `abap_debug_set_variable`. Show what will happen first (dry run, plan, diff).
- **Transports are the user's choice.** Tools that record onto a transport resolve it
  in this order: a `transport` you pass → the request SAP already has the object locked
  in → `createTransport: true` → the transport this work item already uses → the single
  open request of the right kind, otherwise the tool **asks**. Relay that question to the
  user; never invent a transport number. Group related work with `workItem` (a ticket
  number or short name) so it lands on one request. `$TMP` objects need no transport.
- **Read before you write.** Fetch the current source (`get_abap_object_lines`), change
  it, `syntax_check`, then write and activate. Never write source you have not read in
  this conversation.
- The available tool surface may be capped by `ABAP_MCP_MAX_TIER` (0 = read-only,
  1 = + governed customizing, 2 = everything). A missing write tool is deliberate — say
  so rather than working around it.

## Workflows

**Change ABAP code**
`search_abap_objects` → `get_abap_object_info` → `get_abap_object_lines` →
`get_transport_for_object` → `write_abap_object_source` (locks automatically) →
`syntax_check` / `run_atc_analysis` → `abap_activate` → `run_unit_tests`.
If activation fails, read the errors, fix, write again — do not leave inactive objects;
`check_inactive_objects` shows leftovers. New objects: `create_abap_object` (package +
transport), then the same loop. Run a console class with `abap_run_class`
(`IF_OO_ADT_CLASSRUN`).

**Find data when the table name is unknown**
`search_database_tables` (by description — works for IS-Retail, Z/Y tables) →
`describe_database_table` → `execute_data_query` (Open SQL with `UP TO n ROWS`) or
`read_table_contents`. Always limit rows.

**Investigate a problem**
`analyze_dump` (ST22) → `get_abap_object_lines` around the failing line → `where_used` →
`version_history` to see what changed recently.

**Transports**
`list_all_transports` (all users, with objects) → `manage_transport_requests`
(`details`, `create`, `change_owner`, `release`, `delete` — confirm the last two).

**Debug**
`abap_debug_set_breakpoint` → `abap_debug_session` (listen) → the user triggers the
program in SAP → `abap_debug_stack` / `abap_debug_variable` / `abap_debug_step` →
`abap_debug_delete_breakpoint` when done.

**Customizing / IMG (SPRO)** — see [references/customizing-engine.md](references/customizing-engine.md)
1. `img_search` to find the IMG activity and its tables/views.
2. `customizing_describe` → `customizing_read` → `customizing_diff` between org-unit keys.
3. `customizing_plan_change`, then `customizing_apply` **without** `commit` (dry run).
   Show the user the rows. Only after a yes: `commit: true`.
4. Commits run as a background job: poll `customizing_status(runId)` until done.
5. The engine must be installed in the box: `customizing_engine_ping` checks version and
   client capabilities; if missing or stale, ask before `customizing_engine_bootstrap`.
Writes go through the standard SM30/SM34 view runtime, so FK checks, change documents
and transport recording happen as in a manual change.

## Troubleshooting

| Symptom | Do |
|---|---|
| Session/CSRF errors, sudden 401/403 after idle | `force_relogin`, retry once |
| "User is currently editing" / lock errors | `unlock_abap_object`, then write again |
| `read_table_contents` WHERE clause fails (400) | use `execute_data_query` instead |
| Authorization error | it is SAP's answer for this user — report it, don't retry |
| Tool says the change may already be applied | read the current state before re-running |

Full per-tool parameters: [references/tools.md](references/tools.md).
Risk tiers and in-system objects: [references/tiers.md](references/tiers.md).
