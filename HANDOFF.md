# Customizing Engine — Handoff & Findings

> ## ⏩ LATEST (2026-09-18) — v1.11.0: one SAP session per conversation
> **Every MCP session now has its own stateful ADT session per SAP connection**, so its SAP locks are its
> own. Before, one shared session meant `force_relogin` or a reconnect in one conversation released the locks
> of all others. The MCP session id travels by AsyncLocalStorage (`runInSession`, set around every tool
> handler by `wrapServerWithSessionScope` in `tools/index.ts`, innermost so the recovery retry stays in scope);
> `ensureConnected()` keys on connection + session. An ADT session is closed — its locks released — when its
> MCP session ends (transport `onclose`), or after `ABAP_SESSION_EVICT_MS` (default 60 min) without a tool call
> (keep-alive pings do not count). Calls outside any MCP session use a "shared" session (startup warm-up, tests).
>
> Also: `write_abap_object_source` releases its lock after writing (`keepLock: true` keeps it), and write and
> delete reuse a lock the conversation already holds instead of failing "currently editing" on it.
>
> Verified live on S4 with two concurrent MCP sessions: B cannot lock A's object; B's `force_relogin` leaves
> A's lock intact; A's write reuses A's lock; closing A releases the lock and B can lock and delete.
> Consequence for clients: a lock does not carry across MCP sessions. A client that opens a new session per
> call cannot hold a lock between calls (the write tool no longer needs it to).

> ## ⏪ v1.10.0 (2026-09-18): predictable transports, and a tooling review
> **Transport selection** is one rule for every recording write (README → *Transport selection*):
> given transport (checked) → object already locked into a request → `createTransport` → the transport
> already used for this piece of work (`workItem`, else the MCP session; persisted per connection in
> `~/.abap-mcp/transport-memory.json`) → exactly one open request → ask when several → ask/offer
> creation when none. `transportSelection.ts` holds the rule; `transportSql.ts` reads E070/E07T.
> Replaces `transportGovernance.ts`, whose process-global "last transport" was shared by every
> session and lost on restart, and whose customizing path never reused anything.
>
> **Fixed in the review (each seen on S4 this week):**
> - ADT's transport listing returned nothing for a user with 31 open requests → listings read E070/E071.
>   ADT's freestyle SQL has no `LEFT OUTER JOIN` and fails on a line over 255 characters (keep IN lists short).
> - An SQL mistake (HTTP 400) was taken for a degraded session → forced reconnect, which drops the
>   stateful session and **every object lock** → `isRequestError` excludes them; `runSql` no longer retries them.
> - Activation reported success while objects stayed inactive → both activate tools now list what is left.
> - `abap_activate_multiple` failed with "currently editing" on this server's own locks → released first.
> - `run_unit_tests` ran only HARMLESS/SHORT classes by default → all levels and durations.
> - `get_abap_object_lines` on an object URL returned metadata XML → retries `/source/main`.
> - `write_abap_object_source` could report success for a write SAP did not apply → reads back and warns.
> - `unlock_abap_object` required a handle the caller rarely still has → defaults to the held lock.
>
> **Found, not fixed (worth a decision):**
> - ~~One stateful ADT session per SAP connection is shared by every MCP session~~ — fixed in v1.11.0.
> - Session recovery retries *mutating* tools after a reconnect; a write that failed after SAP applied it
>   could be re-sent.
> - `syntax_check` on a function module or include needs the right `mainUrl` and reports false errors
>   otherwise; it is not derived.
> - `customizing_create` direct (`recordTableKeys`) writes report "0 E071K entries" — the writer does not
>   count keys on that path (the keys are recorded; see E071K).
> - `describe_database_table` on a structure answers "Error while processing authorization checks".
> - Parameter names differ between tools for the same thing (`name`/`objectName`/`table`, `url`/`objectUrl`),
>   and a wrong name returns a raw validation dump.
> - A running MCP client keeps the tool schemas it loaded at start: new parameters are invisible until the
>   client reconnects.

> ## ⏩ ALSO 2026-09-17 (later): text elements, and tables without a view
> **`set_text_elements` rewritten (it could not write text symbols at all).** Verified on S4 against a
> throwaway program, class and function group:
> - Every text symbol needs an `@MaxLength:<n>` line before it, or SAP rejects the whole write. The tool
>   now always sends one (default: the text's length).
> - A dictionary-referenced selection text is a bare `@DDICReference` line before the element, sent with an
>   empty text; SAP fills the text from the data element. abap-adt-api expects `@DDICReference:<x>` and could
>   neither read nor write it, so the tool now reads and writes ADT's text format itself.
> - The ADT PUT replaces the whole category — a partial list deleted every other text. Writes now merge by id
>   (`remove` deletes, `replace: true` writes exactly the list).
> - Activating the program does not activate its text elements (they stay as `PROG/PX` in the inactive
>   worklist). The tool now activates the text-element resource itself (`activate: false` to skip).
> - Headings are `LISTHEADER` and `COLUMNHEADER_1..4` (SAP returns them camel-cased); the old description
>   said S/M/L/H.
>
> **`customizing_create` `recordTableKeys: true`** — for a table with no maintenance view (units: T006,
> T006A/B/C, T006_OIB, normally CUNI): writes directly and records the row keys as `R3TR TABU` on the
> transport with the same headless recorder. Opt-in, because it skips the dedicated transaction's checks.
> Note CUNI itself records under `R3TR TDAT CUNI`; the imported keys are the same.

> ## ⏩ LATEST STATUS (2026-09-17)
> **Server v1.9.3 / ABAP engine 0.9.26. Commits into switch-gated IS-Oil views work, recorded,
> in seconds. The refusal (`riskyPackageGuard`) is removed.** The 2026-09-03 block below and
> the 2026-07-07 audit describe the symptom accurately and the cause wrongly: it was never the
> package, the switch state (all three IS-Oil switches are ON), or a cold view.
>
> **Cause.** `VIEW_MAINTENANCE_SINGLE_ENTRY` with a `corr_number` records through
> `TR_OBJECTS_INSERT`, which hardcodes `iv_with_dialog = 'X'`. Only in that mode does
> `TRINT_OBJECTS_CHECK_AND_INSERT` run switch-BC-set recording (`call_scpr_transport`, set when
> `cl_abap_switch=>get_switches_in_use( )` — always true on an industry-solution client). For an
> object in a switched package that is the module chain the audit traced (`CL_BCFG_BCSET_DS_HELPER`,
> `CL_ABAP_SWITCH`, DDIC scans), working through `SCPRVALL` (1.4 M rows on S4). In a background job it
> does not come back; in a dialog context VMSE instead dies on `SAPLSTRD 0352`.
>
> **TRINT's `iv_with_dialog` modes, read from source:** `' '` and `'R'` check only and insert
> nothing (they return subrc 0 — a trap); `'X'` inserts with dialog and BC-set recording; `'D'`
> inserts into the given `iv_order` with no dialog and no BC-set recording.
>
> **Fix (`zmcp_cust_write.abap`).** The view runtime always writes with `no_transport = 'X'`; the
> written entries are kept, and `record_headless` builds the E071K keys for every table of the view
> (DD26S/DD03L key fields; client from `sy-mandt`; a blank key value is valid; a blank language takes
> `sy-langu`; a table whose key fields are not in the entry is a lookup and is skipped) and records
> the `VDAT`/`TABU`/`CDAT` header plus `TABU` keys with `TRINT` mode `'D'`. `record_cdat`
> (`TR_OBJECTS_INSERT`, TK495) is replaced by it.
>
> **Also new: view fields outside the base table.** `customizing_create` rows may now carry fields
> the maintenance view has and the base table does not (a text table's `DESCR`). The planner passes
> them beside the plan (`extras_json`, appended to every `ty_params` layout — positional) and the
> writer puts them into the view entry, so texts are written and recorded with their row.
>
> **Verified on S4, 2026-09-17**, the whole IS-Oil HPM conversion configuration for BetrM onto
> `A4HK900202` / task `A4HK900203`: `V_OIB05`, `V_OIB06`, `V_OIB_RDGRDEF`, `V_OIB_RDGGROUP`,
> `V_OIB01`, `V_OIB04`, `V_OIB_CONV_RDGRP`, `V_OIB02` — 8 VDAT headers, 29 keys including every text
> table, each write seconds. Data re-read from the tables matches. 201 tests pass.
>
> **Not changed:** `resolveMaint` still resolves `switchId` (information only). Cluster members
> still record as the member view (`VDAT`); `CDAT` is now possible headlessly but not switched on.
> The direct-write path ignores view-only fields.

> ## ⏪ STATUS (2026-09-03 — superseded by the block above)
> **Engine v1.9.2.** Read this block first, then the 2026-06-10 block below it, then
> [`docs/customizing-engine.md`](docs/customizing-engine.md) and
> [`docs/audit-2026-07-07-transport-handling.md`](docs/audit-2026-07-07-transport-handling.md) — that audit doc
> already contains the debugger-verified root cause this block builds on.
>
> **★ Headless commits into a switch-gated package's view are now REFUSED up front
> (`riskyPackageGuard`, `src/tools/customizingEngine.ts`; resolver support in
> `resolveMaint`, `src/tools/customizing.ts`).**
>
> Incident: a commit into `TOIJNOM_ST03` (view `V_OIJNOM_ST03`, package `OIJ`, switch
> `OIJ_TSW`) ran `ZMCP_CUST_WRITE` for 27+ minutes on S4 — SM50 cycling the same module
> sequence documented in the 2026-07-07 audit (`CL_BCFG_BCSET_DS_HELPER` →
> `CL_DD_FORKEY_READER`/DD05S → `CL_ABAP_SWITCH` → `SAPLSENA` → `CL_SSCUI_ADAPTATION` →
> `SAPLSVIM` → `RADBTDDF`/DD02L, repeating) — and was cancelled in SM37 with zero rows
> written.
>
> **This is the SAME failure mode as 2026-07-07's `V_TOIJRMOT` (12+ hours, still not
> finished for 4 rows), already root-caused with a debugger** (`wp_detail` / `TH_WPINFO`
> live WP tracing): a headless `VIEW_MAINTENANCE_SINGLE_ENTRY` commit into a view whose
> **package carries a Switch Framework assignment** grinds per-DDIC-object through switch
> evaluation, full DDIC scans, the ST-PI TMWFLOW CTS hook, and BC-Set/SSCUI checks —
> worst on a cold (never-generated) view, never proven to terminate at all. The 2026-06-15
> auto-memory note "20+min SLOW not stuck" was that investigation's premature *first*
> conclusion at the ~20-minute mark; the audit doc's own final verdict, reached hours later
> the same night, supersedes it: "effectively non-terminating." Anything still citing
> "just wait, it's progressing" for this class of write is citing the superseded finding.
>
> **A first version of this guard, built and tested the same evening before this one, gated
> on view-cluster membership instead of package switch-gating — and was wrong.** `V_TOIJRMOT`
> (12h+, the worse of the two hangs) is *not* a cluster member, so a cluster-only guard would
> have missed its entire failure mode. And `/POSDW/GPAP` (2026-06-10) *is* a cluster member,
> in a package with no switch assignment, and recorded in seconds — a cluster-only guard would
> have refused it for nothing. Caught and corrected before that version was ever committed,
> by re-reading this file's own 2026-07-07/07-08 findings instead of trusting a code comment's
> unverified explanation. `resolveMaint` now resolves `TVDIR.DEVCLASS` for the maintenance
> object and cross-checks `SFW_PACKAGE` for a switch assignment on that package — regardless of
> the switch's current on/off/standby state, since the July finding shows the grind happens
> per-DDIC-object either way. Cluster membership, where present, is still named in the refusal
> message for orientation, explicitly marked as not the cause.
>
> Confirmed live on S4 the same night: the guard refuses `TOIJNOM_ST03` in under a second, no
> job spawned, no orphan row (re-queried after refusal: unchanged); a plain non-switch-gated
> view (`V_TVTR`) dry-run is unaffected. `TOIJNOM_ST03`'s actual profile (`BM01`) was built by
> hand in SM34 in the meantime, proving the manual path is reliable for exactly the object that
> hung. 206/206 tests pass (`tests/riskyPackageGuard.test.ts`), covering all four combinations
> of {cluster member, switch-gated package} × {yes, no} against real object names from both
> incidents plus both proven-safe cases.
>
> **STILL OPEN — the deep fix, not attempted tonight:** a genuinely headless CDAT recorder
> *and/or* a way to make the switch-gated-view commit itself terminate reliably, so this class
> of object stops needing a hand-maintained fallback at all. Two named approaches for the CDAT
> half, already scoped in `docs/customizing-engine.md` and `record_cdat`'s own ABAP comment
> (`src/abap/zmcp_cust_write.ts`) — neither addresses the switch-grind directly, so either would
> still need `riskyPackageGuard`'s condition (or a narrower, debugger-confirmed one) until the
> grind itself is understood well enough to route around:
>   1. A direct `TRINT` call with `iv_with_dialog='D'` + `is_api_call-request`, instead of
>      `TR_OBJECTS_INSERT`'s hardcoded `iv_with_dialog='X'` (→ TK495).
>   2. `VIEWCLUSTER_IMPORT` with staged `SLCTR` content.
> The July audit's own fix directions (its §"Fix directions (task #22)") are still open too:
> honest live status via `wp_detail` inside `customizing_status` itself (not just the manual
> diag op), no consume-on-read on the INDX(ZR) result, and evaluating whether the `/SDF/TMWFLOW`
> CTS hook can be disabled on a standalone box with no SolMan attached (pure overhead there).

> ## ⏩ PRIOR STATUS (2026-06-10 — all pushed to master)
> **Engine v0.9.7.** Canonical reference: **[`docs/customizing-engine.md`](docs/customizing-engine.md)** — read
> that first; this file is the debugging saga / findings history. After any TS/ABAP change: rebuild + restart the
> server + **reconnect the MCP client** (catalog is snapshotted at session start; a restart reconnects the
> transport but does not re-list tools).
>
> **★ Transport recording WORKS (was the long-open hard part).** The SM30-runtime rewrite
> (`VIEW_MAINTENANCE_SINGLE_ENTRY`, `suppressdialog='X'`, in a real `sy-batch` background job) records
> `R3TR VDAT <view>` over the full table set. Proven: `/POSDW/TENDTY` `0001 → ZCSH` recorded into a Customizing
> request, E071K post-commit re-check passes. The old TK495 / "0 E071K" was two bugs — recording the wrong object
> (`R3TR TABU` instead of the view's `VDAT`) and a **false-negative verification** (counting E071K on the request
> header, not the task; CTS records onto the task). Both fixed.
>
> **★ SM30-standard DELETE added (v0.9.4).** `customizing_apply action:"delete"` removes the `targetKey` entry via
> `VIEW_MAINTENANCE_SINGLE_ENTRY action='DEL'`, recording the deletion onto the transport like an SM30 row delete
> (no manual table/E071K surgery). Proven: removed `/POSDW/TENDTY 0001/ZCSH` (base + text gone, deletion recorded).
> Note: the SM30 delete keeps the object key (now an absent-row = export-deletion); stripping it = manual SE10, not done.
>
> **Other proven:** direct (untransported) write for sandbox/test data; governed transport selection
> (reuse session request / list open / create-new opt-in); IMG search via the STREE text index + `img_index_read`.
>
> **★ Read-ABAP-from-disk DONE (v0.9.5).** Engine/writer ABAP now lives in `src/abap/*.abap` (single source of
> truth), read at `customizing_engine_bootstrap` time by `loadSource.ts` (substitutes `{{ENGINE_VERSION}}` /
> `{{HSRCH_AREA_CASES}}`). An ABAP-only edit needs NO `npm build` and NO server restart — just re-bootstrap.
> (A tool-SCHEMA change still needs build + restart + MCP reconnect.)
>
> **★ T000 capability read-on-connect DONE (v0.9.6).** The engine reads the client's change/transport capability from
> `T000` (SCC4) and routes record-vs-direct accordingly instead of assuming every C/G/E change records: `CCCORACTIV='1'`
> → recorded; `''`/`'3'` → written through the SM30 view runtime **without** a transport (no false E071K re-check fault);
> `'2'` → refused; cross-client tables gated by `CCNOCLIIND`. `customizing_engine_ping` now surfaces the capability on
> connect. Proven on CAR: ping reports client 600 = `CCCORACTIV='1'` → auto-record; selftest + live `handle_write`
> dry-run clean. (CAR 600 records, so the non-recording branch can't be live-proven — covered by clean activation.)
>
> **★ View-cluster CDAT spike (v0.9.7) — DATA works, true CDAT recording BLOCKED.** Clusters resolve via VCLSTRUC;
> the engine writes member data and records `R3TR VDAT` (member view) + TABU keys → cluster data transports correctly
> (proven: `/POSDW/GPAP 0010→Z999` into CARK900011). True `R3TR CDAT` recording is blocked: the headless key-level
> recorder `TR_OBJECTS_INSERT` hardcodes `iv_with_dialog='X'` → TK495 even in a background job (same dialog wall that
> killed it for VDAT). A dormant `transport_object='CDAT'` writer path (`no_transport` member write + `record_cdat`)
> exists; re-enable only with a headless recorder (TRINT direct-call, or `VIEWCLUSTER_IMPORT` + staged SLCTR content).
> Goal context: full IMG object-type coverage for the NL→Enterprise-Structure builder (see auto-memory).
>
> **Still open:** a genuinely-headless CDAT recorder (above); number-range (NROB/SNUM) writes; the ES-builder
> orchestration layer (NL description → ordered typed customizing steps → dry-run → apply).

Status of the `customizing_*` capability (ICF-based ABAP "Customizing Engine") as validated end-to-end
against system **CAR** (http://sapcar:8001, user BASIS, client 600), 2026-06-09. Written for the fix
session so it can self-test locally instead of relaying through a human.

Source map (this repo):
- `src/abap/zcl_mcp_cust_engine.ts` — engine class `ZCL_MCP_CUST_ENGINE` (ICF handler, JSON in/out)
- `src/abap/zmcp_cust_write.ts` — background batch writer report `ZMCP_CUST_WRITE`
- `src/tools/customizingEngine.ts` — `customizing_engine_bootstrap` / `_ping` / `_selftest`
- `src/tools/customizing.ts` — `customizing_read` / `_describe` / `_diff` / `_plan_change` / `_apply`
- MCP transport / session layer — wherever the streamable-HTTP server + SAP ADT HTTP client live (Brief 3)

SICF: node `/sap/bc/zmcp_cust`, handler `ZCL_MCP_CUST_ENGINE`, must be **active** (one-time, BASIS).

---

## ✅ Proven WORKING end-to-end
- Bootstrap deploy/activate with **update-in-place** (must update if class exists, not just `create`).
- `ping` (version handshake), `selftest` (dynamic typing, sample read, DDIC-aware E071K TABKEY build —
  verified `'600100*EUR  USD  79989898'` for TCURR).
- `customizing_read` on real customizing (`/POSDW/PROF`).
- `customizing_plan_change` / dry-run `customizing_apply` (correct 1-row plan, `0001→9998`).
- Delivery-class **E** allowed (POSDW tables are all E — guard must permit C/G **and E**).
- S_TABU_DIS auth check; ENQUEUE / ROLLBACK / DEQUEUE discipline.
- **Data write itself**: MODIFY+COMMIT created profiles `9998`/`9997` in `/POSDW/PROF` on CAR.
- **Transport recording** (the long-open hard part): `R3TR VDAT <view>` recorded via the SM30 runtime in a
  background job; E071K post-commit re-check passes. _(See LATEST STATUS above.)_
- **Async `apply`** (run_id + `customizing_status`); **governed transport selection**; **SM30-standard delete**.

> The "Open / not yet proven" list and BRIEF 1–3 below are **historical** — the recording, async, and
> connectivity items are all resolved. Kept as the findings/debugging record; current state is in LATEST STATUS
> and [`docs/customizing-engine.md`](docs/customizing-engine.md).

---

## BRIEF 1 — Transport recording must be rock-solid (the hard part)

### Root cause: execution context, not parameters
The engine runs in an **ICF dialog WP with no GUI and `sy-batch` unset**. Any FM that sends a dynpro is fatal
(`"Sending of dynpro … not possible: No window system type specified"`). We proved:
- **`TRINT_OBJECTS_CHECK_AND_INSERT`** (CTS-internal WBO API): satisfiable assert contract but, once
  satisfied, **does NOT persist E071K** — it's compute/validate-for-remote-orchestrator (in-code comment
  "no support for remote WBO API usage"). **Dead end.**
- **`TR_OBJECTS_INSERT`** (documented EXTERNAL interface, **persists**): pops dynpro `SAPLSTRD 0352` in ICF;
  `IV_NO_SHOW_OPTION/IV_NO_STANDARD_EDITOR/IV_NO_PS='X'` do **not** suppress it. Runs headless **only when
  `sy-batch='X'`** (a real background job).

### Correct architecture (implemented in `zmcp_cust_write.ts` — keep it)
Move the mutating LUW into a **background job**. The batch report, as ONE LUW: `ENQUEUE_E_TABLE` → MODIFY →
`TR_OBJECTS_INSERT` (headless under sy-batch) → **verify E071K has the exact keys; if 0 → ROLLBACK the MODIFY**
→ COMMIT/ROLLBACK → DEQUEUE → write result (status/rows_written/e071k_count/messages) to INDX(`ZR`) by run_id.
ICF returns run_id; status tool polls. **Never report success without re-SELECTing E071K** (false-success bit
us twice → untransported change = unacceptable at a customer).

### `TR_OBJECTS_INSERT` signature ON THIS RELEASE (S/4 FOUNDATION) — varies by release!
- IMPORTING: `WI_ORDER` (type **`E070-TRKORR`** — must be TRKORR-typed, NOT string), `IV_NO_PS`,
  `IV_NO_SHOW_OPTION`, `IV_NO_STANDARD_EDITOR`, `IV_EXTERNALID`, `IV_EXTERNALPS`, `IT_E071K_STR`
  (`E071K_STRTYP`), `IT_OBJ_ENTRIES`, `IV_READ_ACTIVITY_FROM_MEMORY`
- TABLES: `WT_E071K` (E071K), `WT_KO200` (KO200), `TT_TADIR` (TADIR)
- EXCEPTIONS: `CANCEL_EDIT_OTHER_ERROR`, `SHOW_ONLY_OTHER_ERROR`
- NOTE: no `WI_SIMULATION`, no `WT_E071` on this release; `TRINT_OBJECTS_INSERT` does **not exist** here.
  **Don't hardcode** — introspect `FUPARAREF`/`RPY_FUNCTIONMODULE_READ` and bind only existing params; type
  each actual to the formal type.

### Delivery-class routing (dd02l-contflag)
- `A` → application data: direct MODIFY+COMMIT, **no** transport (already implemented).
- `C`/`G`/`E` → customizing/control: transport-record via the batch path. (POSDW = all `E`.)
- `S`/`W`/`L` → refuse by default.
- Provide explicit `record_transport:true|false`. Default true for C/G/E; **false enables a sandbox
  direct-write mode** — which is all the POS-sim test-data builder actually needs (sandbox, never transported).

### Acceptance test
Fresh key → `commit=true` → response `ok` AND `E071K` has the key AND `manage_transport_requests details`
shows the object under the task. Forced failure (e.g. released request) → **0 rows written** (data rolled back).
Class-`A` table → direct write, no transport. Ideally run on ≥2 releases.

---

## BRIEF 2 — `customizing_apply` async + 30s timeout
The job-based commit must not block past the 30s tool HTTP timeout. Submit job → return `run_id` < 30s →
`customizing_status(run_id)` reads INDX(`ZR`). Start the job immediately (`STRTIMMED`), ensure a free bg WP.

---

## BRIEF 3 — Connectivity robustness (server-wide; matters most for a self-testing loop)
Two stale-state problems; the 4-min keep-alive fixes neither.

**Mode A — stale MCP transport session (60s `-32001` hang).** Log proof: request arrives on session X, NO
`← tool` response ever produced, client cancels at 60s, a fresh `initialize` serves the same call in 2ms. The
streamable-HTTP session's response channel dies on idle.
Fixes: (1) deliver request/response on the POST's own HTTP response, not only a long-lived SSE stream that dies
on idle; (2) on lost session return spec **`404`** so client re-inits+replays (never bare `400`, never a 60s
hang); (3) server-side per-request watchdog ~10s → fail fast; (4) heartbeat the MCP session + detect dead stream.

**Mode B — intermittent `400`s.** Either MCP `Mcp-Session-Id` expired/forgotten → bare `400` instead of `404`,
and/or SAP ADT CSRF token + `SAP_SESSIONID` cookie expired → ADT `400/403` until refreshed.
Fixes: (5) auto-refresh CSRF+cookie on any `400/401/403`/"CSRF"/"session expired" and **retry once**
transparently; (6) keep-alive must do a real ADT round-trip (cheap GET validating cookie+token), refresh
proactively before SAP HTTP session-timeout; (7) wrap idempotent reads in retry-with-backoff (2-3).
Also: warm-up only primes SAP login then logs "first call will be fast" (false) — drive a full end-to-end MCP
round-trip at startup or don't print it.

**Acceptance:** idle 5-15 min, one call returns <2s with no `-32001`/`400`/manual-retry, repeatedly; a 50-call
read sweep (E071K/TBTCO/tables) completes with ZERO transient failures.

---

## Self-testing without human relay
Run the fix session **locally in this repo** with `mcp__abap__` configured (CAR) in its `.mcp.json`. Then it
edits AND tests. To make the inner loop painless:
- Have `customizing_engine_bootstrap` read the engine/report ABAP from `src/abap/*` at call time so ABAP
  iteration = edit file → `bootstrap` → `ping`/`selftest`/`apply`/`read` (no Node restart). For Node tool-logic
  changes, run the server under a file-watcher / auto-restart, or reconnect the MCP server between iterations.
- Bootstrap loop: `connected_systems` (warm) → `customizing_engine_bootstrap` → `customizing_engine_ping` →
  `customizing_selftest --transport CARK900019` → `customizing_apply … commit=true … transport CARK900019` →
  `customizing_status` → verify `E071K`/`manage_transport_requests details`.

## Sandbox state on CAR (for context)
`/POSDW/PROF` has 5 rows: `0001`(CAD), `ZAF1`(ZAR), `ZEU1`(EUR), `9998`, `9997` — `9998`/`9997` written by
earlier tests but **untransported** (E071K empty). Transport/task **`CARK900019`** (modifiable customizing task,
parent request `CARK900018`) is the test target. POSDW config tables (`/POSDW/PROF`/`RETTY`/`TAXTY`/`TENDTY`/
`TRANTY`) are all delivery class `E`; `/POSDW/STORE` is class `A`.
