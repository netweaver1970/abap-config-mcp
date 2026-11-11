# Risk tiers — what this server can do, and how to gate it

The MCP tool surface is split into three risk tiers so a deployment exposes only
what corporate security accepts. Set **`ABAP_MCP_MAX_TIER`** (`0` | `1` | `2`) to
cap the exposed surface; tools above the ceiling are not registered at all.

| Ceiling | Exposes | Typical use |
|---|---|---|
| `0` | Tier 0 only | **Production** — read-only diagnostics / box health |
| `1` | Tier 0 + 1 | Production config support (governed customizing writes) |
| `2` (default / unset) | everything | **Development** |

Classification lives in [`src/tools/riskTiers.ts`](../src/tools/riskTiers.ts);
gating is a registration-layer proxy in `registerAllTools`. **Unclassified tools
default to Tier 2** (fail-safe — a new tool is never silently exposed on a
restricted server). A unit test (`tests/riskTiers.test.ts`) pins the behaviour.

## Tier 0 — read-only / diagnostics (safe for Production)
System-management reads only — no data, config, or repository change.
`hana_memory_report`, `abap_memory_report`, `analyze_dump`, `connected_systems`,
`force_relogin`, `adt_discovery`, `search_abap_objects`, `search_abap_object_lines`,
`browse_package`, `get_abap_object_info`, `get_abap_object_lines`,
`get_abap_batch_lines`, `where_used`, `version_history`, `check_inactive_objects`,
`syntax_check`, `run_atc_analysis`, `get_text_elements`, `get_transport_for_object`,
`list_all_transports`, `execute_data_query`, `read_table_contents`,
`describe_database_table`, `search_database_tables`, `customizing_read`,
`customizing_describe`, `customizing_diff`, `img_search`, `customizing_engine_ping`,
`customizing_status`.

## Tier 1 — config / data writes (approvable with scrutiny)
Customizing/data changes through the standard SM30 view runtime + transport
recording; **no ABAP source creation**.
`customizing_apply`, `customizing_create`, `customizing_plan_change`, `org_copy`,
`retail_listing`, `manage_transport_requests`, `transport_move`, `customizing_selftest` *(can
auto-deploy the engine class, so it is not pure-read)*.

## Tier 2 — repository / code writes, execution, debug (Development only)
Creates/changes ABAP repository objects, runs code, drives the debugger — the
"pushing code to the server" surface. **Do not expose against Production.**
`create_abap_object`, `write_abap_object_source`, `delete_abap_object`,
`abap_activate`, `abap_activate_multiple`, `create_package`, `create_test_include`,
`set_text_elements`, `lock_abap_object`, `unlock_abap_object`, `run_unit_tests`,
`customizing_engine_bootstrap`, `customizing_engine_cleanup`, and all `abap_debug_*`.

## In-system ABAP: transported, not pushed
The MCP also installs in-system ABAP (the customizing/diagnostic engine). For
Production these objects should reach the box via **normal CTS transport**, not
the MCP's `customizing_engine_bootstrap` push (which is a Tier-2, Dev-only
convenience). They are therefore split so the low-risk part can ship and be
approved on its own:

| In-system object | Package | Tier | Prod transport |
|---|---|---|---|
| `ZCL_MCP_DIAG` (+ SICF `/sap/bc/zmcp_diag`) — ping/env, `hana_memory`, `abap_memory`, customizing read, IMG read | `ZMCP_DIAG` | 0 | ✅ Ship via CTS; standalone box-health value |
| `ZCL_MCP_CUST_ENGINE` + `ZMCP_CUST_WRITE` — customizing writes, org copy, listing | `ZMCP_CUST` | 1 | With scrutiny |
| repo/code writes | — (MCP client-side via ADT) | 2 | Never transported |

Build with a transportable Z package + Workbench request (the bootstrap tool
accepts `packageName` + `transport`) so the diagnostic engine flows Dev→Prod
through CTS, governed by corporate transport approval — independent of the MCP.

### Transportability is a choice — `engine_deploy`
Which in-system units are transportable is **per-connection config** (not a fixed
tier rule), managed by the **`engine_deploy`** tool:
- Run with **no unit** → first-run setup prompt (or current status) listing the
  units (`diag` Tier 0, `cust` Tier 1) and how to deploy each.
- `engine_deploy unit:"diag" transportable:true package:"ZMCP_DIAG" transport:"<req>"`
  → creates the unit in a Workbench Z package on a transport (CTS to Prod).
- `engine_deploy unit:"cust" transportable:false` → deploys to `$TMP` (Dev-only).
- **Flip later**: re-run for any unit (including a higher-tier one) to promote it
  to transportable with a new package/transport.

Config persists in `engine-deploy.json` (git-ignored — it holds env-specific
package/transport). The unit's SICF node is registered **automatically** as part
of the deploy: `engine_deploy` generates a one-shot installer report that calls
`cl_icf_tree=>if_icf_tree~insert_node` (the *create* API — `change_node` only
modifies an existing node, raising `SHTTP/061` otherwise) and runs it headlessly
via a `RISK LEVEL HARMLESS` AUnit test whose `COMMIT WORK AND WAIT` hardens to
the DB. The node lands in the unit's package, so a transportable unit's SICF
node travels with the class. Re-running is idempotent (`node_already_existing`
falls back to `change_node` to refresh the handler/active flag).

### Connected-target awareness (no failed calls)
`capabilities.ts` derives a per-connection snapshot from the engine's ping/env
probe (engine deployed? version, isS4, ECOP/CTS/LTMC) and caches it. Tools
pre-flight against it (`requireCaps`) and refuse cleanly — e.g. `org_copy` says
"not available" on a box without the ECOP entity copier (CAR) instead of calling
the engine and failing.
