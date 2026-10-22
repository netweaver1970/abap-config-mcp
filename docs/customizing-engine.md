# Customizing Engine

In-system automation for reading, inspecting, and **changing SAP Customizing the
SM30-standard way** — through the maintenance-view runtime, with transport
recording, from an MCP client.

Validated end-to-end against **CAR** (`http://sapcar:8001`, client 600, user
BASIS). Engine **v0.9.7**.

---

## Why it exists

A plain `MODIFY` on a customizing table writes data but bypasses everything SAP
does around it: foreign-key/domain checks, maintenance events, change documents,
authorization, and — critically — **transport recording**. An untransported
customizing change is unacceptable in a real landscape.

The engine instead drives the **generated SM30 runtime**
(`VIEW_MAINTENANCE_SINGLE_ENTRY`, `suppressdialog='X'`) for every change, so the
full view logic runs headlessly and the change is recorded onto a transport as
SAP itself would record it. Copy, insert/update, and delete all go through this
one path.

---

## Architecture

Two ABAP objects + a TypeScript MCP layer, deployed and version-gated automatically.

```
MCP client
   │  customizing_* tools (src/tools/customizing.ts, customizingEngine.ts)
   ▼
ICF handler class  ZCL_MCP_CUST_ENGINE      ← /sap/bc/zmcp_cust  (JSON in/out)
   │  read / describe / diff / plan: synchronous in the handler
   │  write / delete (recorded): submit a background job …
   ▼
Background report  ZMCP_CUST_WRITE  (sy-batch='X')
   │  ENQUEUE → VIEW_MAINTENANCE_SINGLE_ENTRY per row → COMMIT → verify E071K
   ▼
INDX cluster  ZP (params in) / ZR (result out), keyed by a 22-char run_id
```

- **Source of truth (this repo):**
  - `src/abap/zcl_mcp_cust_engine.ts` — ICF handler class `ZCL_MCP_CUST_ENGINE`
    (operations: `ping`, `read`, `write`, `delete`, `selftest`, `status`,
    `img_index_read`).
  - `src/abap/zmcp_cust_write.ts` — background writer report `ZMCP_CUST_WRITE`.
  - `src/tools/customizing.ts` — `customizing_read` / `_describe` / `_diff` /
    `_plan_change`, `img_search`, and `resolveMaint()` (table↔view↔table-set).
  - `src/tools/customizingEngine.ts` — `customizing_apply` / `_status` /
    `_selftest` / `_engine_bootstrap` / `_ping` / `_engine_cleanup`, governed
    transport selection, async polling.

### Why a background job
`TR_OBJECTS_INSERT` and the SM30 transport recording only run headlessly when
`sy-batch='X'`. The ICF handler is a dialog work process, so recorded writes are
submitted as a real background job (`SUBMIT … VIA JOB … STRTIMMED`). Params and
results are exchanged through INDX cluster areas (`ZP`/`ZR`) keyed by a mixed-case
22-char run_id (the writer's `PARAMETERS p_runid` **must** be `LOWER CASE` or it
can't read its own params).

### Async contract
A recorded commit returns quickly. The handler polls ~8 s; if the job isn't done
it returns `STATUS: pending` + `run_id`. `customizing_apply` then polls
`customizing_status` for ~25 s (well under the MCP client's 60 s ceiling). If
still running, it hands back the `run_id` to poll manually.

---

## Delivery-class routing (`dd02l-contflag`)

| Class | Meaning | Behaviour |
|-------|---------|-----------|
| `C` / `G` / `E` | Customizing / control | Transport-recorded via the view runtime (background job). `E` **must** be allowed — all `/POSDW/*` config is class E. |
| `A` | Application data | Direct `MODIFY` + `COMMIT`, **no** transport. Do not pass a transport. (copy only) |
| `S` / `W` / `L` | System / temp / local | Refused. |

`record_transport: false` forces a synchronous direct write (sandbox / test data,
never transported) for C/G/E tables — transport must be omitted in that mode.

S_TABU_DIS (`DICBERCLS`/`ACTVT 02`) is enforced on the target table before any change.

---

## Client-capability routing (`T000` / SCC4)

Delivery class says whether a table *can* be transported; the **client setting**
(`T000`, maintained in SCC4) says whether *this client* actually records changes.
The engine reads it on connect (surfaced by `customizing_engine_ping`) and routes
record-vs-direct per the client — so it never assumes a C/G/E change is recorded
when the client is configured not to.

**Client-dependent tables** (MANDT is a key field) — governed by `CCCORACTIV`:

| `CCCORACTIV` | Meaning | Behaviour |
|---|---|---|
| `1` | Automatic recording of changes | Record onto a transport (background job + E071K re-check). |
| `''` | Changes without automatic recording | Write through the SM30 view runtime **without** a transport; no E071K re-check; a supplied transport is rejected. |
| `3` | Changes w/o recording, no transport | Same as `''` (transports not allowed in this client). |
| `2` | No changes allowed | **Refused.** |

**Cross-client tables** (client-independent customizing) — governed by
`CCNOCLIIND`: `'1'`/`'3'` (cross-client customizing blocked) → **refused**;
otherwise recorded.

Why it matters: the post-commit E071K re-check is the engine's proof that a
recorded change was transported. In a non-recording client the SM30 runtime
writes data but creates no E071K — so without this routing the re-check would
find nothing and the result would misreport a transport fault. The non-recording
path still goes through `VIEW_MAINTENANCE_SINGLE_ENTRY` (SM30-standard, never a
manual MODIFY); it just runs with `corr_number = ''` and skips the re-check.

> CAR client 600 is `CCCORACTIV='1'` (auto-record), so the recorded path is what
> all the CAR end-to-end proofs exercise. The non-recording branch is validated
> by clean activation + the recording path being unchanged when the client
> records — it can't be live-proven without changing a client's SCC4 setting.

---

## Transport object resolution

`resolveMaint(table)` resolves what the SM30 runtime records, on the live schema:

- `DD25L` (view header, `AGGTYPE`, `ROOTTAB`), `DD26S` (view → member tables),
  `CUS_ACTOBJ` (IMG activity → object type/TCODE), `TDDAT` (auth group).
- A maintenance **view** → records `R3TR VDAT <view>` spanning the whole table set
  (base + text tables). E.g. `/POSDW/TENDTY` → view `/POSDW/V_TENDTY` →
  `R3TR VDAT /POSDW/V_TENDTY` covering base + `/POSDW/TENDTYT` text.
- A single-table maintenance → records `R3TR TABU <table>`.
- View-cluster (SM34/`CDAT`) members are driven as the member view (records `VDAT`);
  true headless `CDAT` recording is not attempted.

The post-commit check re-`SELECT`s `E071K` for the recorded `R3TR TABU` base-table
keys **across the request and all its tasks** (CTS records onto the task, not the
request header). **Success is never reported without this re-check** — a false
"recorded" would mean an untransported change.

---

## Governed transport selection

Enterprise landscapes pre-provision transports (CALM/SolMan); the engine never
silently mints or auto-picks one. A recorded commit resolves its transport like so:

- **Explicit `transport`** — used as-is, no prompt. This is the "already chosen for
  this task" case. The value may be a **request** or a **task**: the engine resolves
  the current user's modifiable task under a supplied request (CTS records onto a
  task, not a request head), and **creates one** (`TRINT_INSERT_NEW_COMM`, a `Q`
  customizing task under a `W` request) when the user owns no task there — so a
  request someone else opened still records cleanly. (`ensure_user_task`, engine
  ≥ 0.9.11.)
- **`createTransport: true`** — the engine creates a new request (optionally named
  via `transportText: "<short text>"`; otherwise an auto text). For `org_copy` the
  entity copier mints and names its own request, so `transportText` doesn't apply.
- **Neither given** — the tool returns an **interactive prompt** instead of writing:
  it lists the open modifiable requests of the correct CTS function (flagging the
  one used earlier this session as a suggestion) AND spells out the three create
  paths — engine-auto, engine-named, or "create one in SolMan / SAP Cloud ALM and
  pass its number". The caller re-runs with `transport:` or `createTransport:`.
  The list is scoped to **your own** requests by default (the connection user);
  pass `showAllTransports: true` to list every user's open requests.

So when the user didn't specify a suitable transport up front, they get to choose;
when they did (explicit `transport`), the engine just uses it. CTS function:
`W` = Customizing (client-dependent config, what `customizing_apply`/`org_copy`
write); `K` = Workbench. The shared logic lives in `transportGovernance.ts`
(`buildTransportPrompt`); session memory (`rememberTransport`/`recallTransport`)
only flags the suggested default — it no longer auto-applies.

---

## Tools

### Read / inspect (synchronous)
| Tool | Purpose |
|------|---------|
| `img_search` | Search IMG/SPRO activities. Prefers the STREE text index (`source: STREE index …`), falls back to raw `CUS_IMGACT` (`source: CUS_IMGACT raw …`). |
| `customizing_describe` | Maintenance object, view, full table set, and the `R3TR VDAT`/`TABU` transport object for a table. |
| `customizing_read` | Read customizing rows for an org-unit key. |
| `customizing_diff` | Compare customizing between two org-unit keys. |
| `customizing_plan_change` | Dry-run plan of a copy (rows that would be written). |

### Change (`customizing_apply`)
DRY RUN by default; `commit: true` to apply.

- `action: "copy"` (default) — duplicate rows from `sourceKey` to `targetKey`
  (`onlyMissing: true` by default — skip keys already present in the target).
- `action: "delete"` — remove the entry whose `keyField = targetKey` (no
  `sourceKey`) through `VIEW_MAINTENANCE_SINGLE_ENTRY action='DEL'`, recording the
  deletion onto the transport exactly like deleting the row in SM30. Recorded-only
  (C/G/E, `recordTransport` stays true); idempotent (`entry_not_found` → skip).

> **SM30-standard delete keeps the object key.** Deleting an entry leaves its
> `E071K` key in the request, now pointing at an absent row → it exports a deletion
> on release. The engine does **not** strip the key — that would be the manual SE10
> "delete object from request" action. "Data deleted + deletion recorded" is the
> correct standard end state.

`customizing_status(runId)` polls an async commit/delete by its run_id.

### Lifecycle
| Tool | Purpose |
|------|---------|
| `customizing_engine_bootstrap` | Deploy/update class + report (create or update-in-place) + activate. |
| `customizing_engine_ping` | Version handshake; confirms the SICF service is active; **reads the client's change/transport capability** (`T000`) and reports the record-vs-direct routing; **probes the environment** (engine ≥ 0.9.12) — release/components (`CVERS` SAP_BASIS + S4CORE) and live feature flags (`org_copy`/ECOP, CTS-task/`TRINT_INSERT_NEW_COMM`, Migration-Cockpit GUI `LTMC`) so the caller adapts to *this* box instead of assuming a release. Full struct in `data_json`. |
| `customizing_selftest` | Non-destructive validation (dynamic typing, sample read, TABKEY build; with a transport, simulates recording). Auto-deploys if stale. |
| `customizing_engine_cleanup` | Delete the engine class (SICF node removed manually). |

---

## Deploy & versioning

- One-time (BASIS): create + activate SICF service node `/sap/bc/zmcp_cust` with
  handler `ZCL_MCP_CUST_ENGINE`.
- `ENGINE_VERSION` (in `zcl_mcp_cust_engine.ts`) gates auto-deploy: any
  `customizing_apply`/`_selftest` with `autoDeploy` (default on) re-bootstraps the
  class **and** the writer report in-place when the deployed `c_version` doesn't
  match. **Bump `ENGINE_VERSION` whenever the ABAP source changes**, or the change
  won't redeploy.
- **ABAP-only change:** edit `src/abap/zcl_mcp_cust_engine.abap` /
  `zmcp_cust_write.abap` (the single source of truth — read from disk by
  `loadSource.ts` at bootstrap time, with `{{ENGINE_VERSION}}` /
  `{{HSRCH_AREA_CASES}}` substituted), then call `customizing_engine_bootstrap`.
  **No `npm build`, no server restart.** Bump `ENGINE_VERSION` only if you want
  auto-deploy-on-apply to notice; an explicit bootstrap always redeploys.
- **TS / tool-schema change:** `npm run typecheck && npm run build`, restart the
  server, then **reconnect the MCP client** — Claude Code snapshots the tool
  catalog at session start; a server restart reconnects the transport but does
  **not** re-list tools, so new/changed tool parameters aren't visible until the
  client reconnects. Since 2026-10-22 the server sends `notifications/tools/list_changed`
  once on every new session, as soon as the client opens its GET stream, so a client
  that honours it fetches the list again on its own after a restart; a client that
  opens no GET stream, or ignores the notification, still needs the reconnect.

---

## Proven on CAR
- Bootstrap (update-in-place) + ping + selftest (engine v0.9.6).
- **Client-capability read-on-connect** — `ping` reports client 600 = category `D`,
  `CCCORACTIV='1'` → "client-dependent customizing changes are auto-recorded onto
  a transport"; the live `handle_write` gate runs clean on `/POSDW/TENDTY`.
- Read / describe / diff / plan on `/POSDW/PROF`, `/POSDW/TENDTY`.
- Direct (untransported) write — created `/POSDW/PROF` profiles (sandbox builder path).
- **Transport-recorded copy** — `/POSDW/TENDTY` `0001 → ZCSH` recorded as
  `R3TR VDAT /POSDW/V_TENDTY` (+ text) into a Customizing request; E071K re-check passes.
- **Transport-recorded delete** — `/POSDW/TENDTY` `0001/ZCSH` removed (base + text
  rows gone), deletion recorded into CARK900010/task.
- Governed transport selection (reuse / list / create-new).

## Known limits
- **Delete** requires a maintenance view (it runs through the SM30 view runtime).
  In a recording client it needs a Customizing request; in a non-recording client
  it deletes through the view without one.
- **View clusters (SM34):** the member DATA is written and recorded as `R3TR VDAT`
  (member view) + the `TABU` keys — which transports the cluster data correctly.
  True `R3TR CDAT` (cluster) recording is **not** done: the only headless key-level
  recorder, `TR_OBJECTS_INSERT`, hardcodes `iv_with_dialog='X'` and raises TK495
  ("Action was canceled") even in a background job. A dormant `transport_object='CDAT'`
  path exists in the writer; re-enable only with a headless recorder (TRINT direct-call
  or `VIEWCLUSTER_IMPORT` with staged SLCTR content).
- The non-recording client path (`CCCORACTIV ≠ '1'`) can't be live-proven on CAR
  (client 600 records); see *Client-capability routing*.
