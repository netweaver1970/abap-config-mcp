# Audit 2026-07-07 — transport handling consistency + the "wedged" transported write

> **RESOLUTION — engine v0.9.22 (2026-07-07), deployed + verified on A4H.** All confirmed
> findings fixed. Status honesty (C1–C3): job handles in INDX(ZJ) + TBTCO cross-check →
> handle_status now returns running / pending(queued) / aborted / unknown, no consume-on-read,
> `job_progress_note` surfaces the live WP phase; new diag op `wp_detail`. img_search (F1–F3):
> new engine `img_search` op (full server-side CUS_IMGACT scan, LIKE over title AND activity id)
> — verified live: 'TSW' now returns **180+** SIMG_OIJ_TSW_*/SIMG_TSW_* activities (was 1); the
> raw ADT fallback now matches the activity id too and flags a partial scan. org_copy (B1–B4):
> transport param dropped, createTransport-only acknowledgment, no rememberTransport of the
> ECOP-minted request, subrc-6 text fixed. Display (D1–D4): "Tables:" relabeled to object-key
> count / "not enumerated on dry run", pending renders no longer show "Rows written: 0" as final.
> E4: resolveMaint `||` fallback + honest "no maintenance view" text. Verified: bogus run_id →
> `unknown`; sync commit ok/error render correctly; 201 unit tests pass. Note: the still-running
> 4 h+ repro job holds the enqueue on V_TOIJRMOT (a direct write to OIJTSWMOT now returns a clean
> "ENQUEUE failed" — more proof it is genuinely working, not dead).

Scope: multi-agent code audit of the transport/write paths (TS tool layer + in-system ABAP
engine) triggered by three live incidents on A4H (2026-07-07):
1. `org_copy` silently ignored an explicitly passed `transport`.
2. `org_copy` displayed nonsense dependent-table counts ("Tables: 0" / "Tables: 1136").
3. A transported `customizing_create` (OIJTSWMOT → view V_TOIJRMOT) "wedged": background job
   Active 14 min, 0 rows, cancelled in SM37; the same rows via `recordTransport:false` were instant.

Method: 5 codebase finders + adversarial verifiers (workflow `abap-mcp-transport-audit`,
34 raw findings) + manual spot-verification of every load-bearing claim + live forensics
(E070/E071/E071K, TBTCO, VBHDR) + a controlled repro with per-WP live tracing (new diag op
`wp_detail`, headless SM50). Raw findings JSON preserved in the session scratchpad.

---

## A. THE HEADLINE — the "wedge" is not a deadlock

**Reproduced under control** (write into the pre-existing request A4HK900192 — hours old,
unlocked): same signature. Live WP tracing (`wp_detail`, TH_WPINFO) then showed the job WP
**progressing** through heavy one-time machinery, not blocked:

| elapsed | executing | doing |
|---|---|---|
| ~11 min | `/SDF/CL_TMW_DB_PROXY` (ST-PI, pkg **/SDF/TMWFLOW**) | SolMan ChaRM/CSOL transport-analytics hook fired by CTS recording |
| ~13 min | `CL_DD_FORKEY_READER` | sequential read **DD05S** (all foreign-key defs) |
| ~15 min | `RADBTDDF` | sequential read **DD25L** (all views) |
| ~18 min | `RADBTDDF` | sequential read **DD02L** (all tables) |
| ~19 min | `CL_ABAP_SWITCH` | Switch Framework state evaluation |
| ~20 min | `SAPLTMW_PROJECT_LOCK` | sequential read **TMW_ADM** (CTS project-lock machinery) |
| ~20.5 min | `SAPLSLGO` / `RADBTDDF` | application log + more DDIC |
| ~24–70+ min | `CL_BCFG_BCSET_DS_HELPER`, `SAPLSCTS_REQUEST_CHECK/SELECTION` (E070), `CL_CTS_GTO_RULE_LAYER`, `CL_BCTOOLS_FEATURE_CONTROL`, `CL_SSCUI_ADAPTATION`, `SAPLSDVI` (DD29L), repeat DDIC cycles | BC-Set capture, CTS request checks, GTO rules, SSCUI adaptation — the full S/4 config-change hook chain, cycling |

**Empirical runtime:** the controlled repro (4 rows) ran **~12 hours and still had not finished**
(WP elapsed 43 210 s at the last sample) — always a different program per sample (never stuck):
cycling Switch-Framework evaluation (`CL_ABAP_SWITCH`), DDIC scans (`RADBTDDF` over
DD02L/DD25L/DD27S/DD08L, `SAPLSDVI` DD29L, `CL_DD_FORKEY_READER` DD05S), CTS checks
(`SAPLSCTS_REQUEST_CHECK/SELECTION`, `SAPLSTRD` over E070), BC-Set capture
(`CL_BCFG_BCSET_DS_HELPER` reading OBJS), lifecycle/landscape hooks (`CL_SBLM_KERNEL_API`,
`/SDF/CL_TMW_TRANS_CHECK`). **Verdict: the transported VMSE path on a cold IS-Oil view is
effectively non-terminating on this box** (12 h+ for 4 rows, holding the V_TOIJRMOT enqueue and a
BGD work process the whole time). The fixes below (honest status, no premature cancel,
direct+record alternatives) are required regardless — and for cold greenfield views the direct
`recordTransport:false` path is the only practical option.

**Root cause:** the first transported `VIEW_MAINTENANCE_SINGLE_ENTRY` on a **cold, never-touched
maintenance view** (greenfield IS-Oil: FG `OIJI` delivered but never loaded/generated on this
appliance) triggers first-load compilation + full DDIC dependency analysis, **plus** the ST-PI
TMWFLOW CTS hook, **plus** Switch Framework evaluation — the view sits in package `OIJ`, whose
switch **`OIJ_TSW` is INACTIVE** (BF `OIL_REVENUE_ACCOUNTING` not yet activated), which the
runtime grinds through per DDIC object. Net: tens of minutes on this box. No enqueue wait, no
update-task backlog (VBHDR empty), no SLT involvement. **The 14-minute SM37 cancel of the first
run was premature** — it aborted a working (if pathologically slow) LUW, which is also why 0 rows
and 0 E071 entries persisted and why transport A4HK900192 was left as an empty orphan.
Corollary: activating `OIL_REVENUE_ACCOUNTING` (planned anyway for the TSW trial) should remove
the switch-evaluation component; the first-touch DDIC + TMW hook components are one-time /
per-transport respectively.

Why nobody sees this interactively: the machinery is one-time-per-view (warm after first
success), and manual SM30 users see *something* on screen and wait; the engine's status
surface said only "pending — job still running, or run_id unknown/expired", indistinguishable
from a hang (finding C1), so a slow first run *reads* as wedged.

**Fix directions (task #22):**
1. **Honest, alive status** — `customizing_status` must cross-check TBTCO (job R/F/A) and, now
   that `wp_detail` exists, can report the WP's current program/table as progress evidence
   ("still working: RADBTDDF reading DD02L").
2. **No consume-on-read** — the INDX(ZR) result is deleted on first read (engine ~1955); keep it
   (TTL) so a lost HTTP response doesn't destroy the outcome; add terminal `aborted` state
   detection via TBTCO.
3. **Set expectations** — first transported write on a cold view: warn "may take 15–30 min
   (one-time view-maintenance generation + ST-PI transport hook)".
4. Optional box-level mitigations: run SGEN for IS-OIL loads; evaluate disabling the
   /SDF/TMWFLOW CTS hook on standalone boxes (no SolMan → pure overhead).

---

## B. Transport propagation (verified in code + live)

| # | Finding | Where | Status |
|---|---|---|---|
| B1 | **org_copy binds the user's `transport` to ECOP's `IMPORT_TR_REQUEST`** — an input for a different purpose; the recording request is ECOP's *output* (`EXPORT_TR_REQUEST`). A passed transport is silently ignored; every commit mints a new W request. Live proof: A4HK900186/188/190 minted despite `transport:'A4HK900184'`. | zmcp_cust_write.abap:106–120 | CONFIRMED |
| B2 | Tool contract + interactive prompt promise "record into an existing W request" for org_copy — impossible to honor (see B1). | customizingEngine.ts (org_copy schema + prompt) | CONFIRMED |
| B3 | org_copy's `createTransport` opt-in is not forwarded to ECOP (the dark copier mints by itself in a recording client); governance gate and reality disagree; error text for subrc 6 claims the copier "won't mint one" — it does. | zcl_mcp_cust_engine.abap:724–733, zmcp_cust_write.abap:145 | CONFIRMED (behavioral proof live) |
| B4 | `rememberTransport` learns the ECOP-minted rogue request → later customizing writes get prompted with a request the user never chose ("session poisoning"). | customizingEngine.ts:628–630 | CONFIRMED |
| B5 | Engine delete path skips `ensure_user_task` — raw user value goes straight to the job as corr_number. | zcl_mcp_cust_engine.abap:~1665 | PLAUSIBLE (verifier didn't run) |
| B6 | Governance asymmetry: workbench (K) writes silently auto-reuse the session's last request; customizing (W) always prompts — one policy doc, two behaviors. | write.ts:62, transportGovernance.ts:7 | PLAUSIBLE |

**Fix:** org_copy — drop/repurpose the `transport` param (document "ECOP always determines its
own request"), stop remembering ECOP-minted requests as session choices, fix subrc-6 text.

## C. Status/run-id lifecycle

| # | Finding | Where | Status |
|---|---|---|---|
| C1 | `customizing_status` cannot distinguish RUNNING / UNKNOWN / DEAD; miss = "pending" forever; no TBTCO cross-check; job handle discarded at submit. | zcl_mcp_cust_engine.abap:1953–1966 | CONFIRMED |
| C2 | Result consumed exactly once (DELETE on first read) — a lost response permanently destroys the outcome. | :1955 | CONFIRMED |
| C3 | Cancelled/crashed job → INDX(ZP) params orphaned, run pending forever, **created transport left as empty orphan** (live: A4HK900192/193). | :1118, report :40–62 | CONFIRMED |
| C4 | `customizing_status` drops the TRANSPORT field / never `rememberTransport`s for late-finishing runs. | customizingEngine.ts:1113 | PLAUSIBLE |
| C5 | UUID-fallback run_id not unique (same-second collision). | zcl_mcp_cust_engine.abap:2161 | PLAUSIBLE (edge) |

## D. Display honesty

| # | Finding | Where | Status |
|---|---|---|---|
| D1 | org_copy dry run prints "Tables: 0 dependent tables in scope" — engine intentionally no longer enumerates on dry run (portability), TS renders the absent field as 0. | engine:679–682 + customizingEngine.ts:645 | CONFIRMED |
| D2 | Commit prints "Tables: N dependent tables in scope" where N = **E071K key count** (engine sets rows_written = E071K count; TS renders ROWS_PLANNED as "tables"). Live: "1136 tables". | zmcp_cust_write.abap:163–166 + ts:645 | CONFIRMED |
| D3 | pending→poll merge copies ROWS_WRITTEN but not ROWS_PLANNED → polled runs show "Tables: 0", in-handler runs "Tables: 1136" — same conflation, two wrong numbers. | customizingEngine.ts:621–622 | CONFIRMED |
| D4 | A commit that stays pending prints "Rows written: 0 / Transport: (none)" as if final. | customizingEngine.ts:844 | PLAUSIBLE |
| D5 | retail_listing success message reports planned count as "WLK1 written" (pre-0.9.21 lesson; delta check added since). | engine:1515 | PARTIALLY ADDRESSED (v0.9.21) |
| D6 | handle_write reports ok "Nothing to write — target already complete" when the SOURCE key doesn't exist. | engine:988 | PLAUSIBLE |

## E. Semantics / governance consistency

| # | Finding | Where | Status |
|---|---|---|---|
| E1 | Tier-1 customizing tools auto-deploy the engine CLASS (a Tier-2 workbench write) by default — tier gating bypass by design. | customizingEngine.ts:701–703 | CONFIRMED (accepted design? document or gate) |
| E2 | Delete-path prompt offers createTransport / recordTransport:false, engine delete handler rejects both. | ts:777 + engine:1601 | PLAUSIBLE |
| E3 | Class-A tables: apply prompts for a transport despite the documented class-A direct behavior. | ts:777 | PLAUSIBLE |
| E4 | `resolveMaint` doesn't fall back to rootTable for the CUS_ACTOBJ lookup → unresolved "(object type ?)" in the T001W error text. | customizing.ts:182 | CONFIRMED (live text shows placeholder) |
| E5 | record_cdat comment says TR_OBJECTS_INSERT "runs headless in batch"; customizingEngine.ts comment says it "raises TK495 even in a background job" — contradictory; CDAT path dormant. | report:568–571 vs ts:715–716 | CONFIRMED contradiction (behavior untested) |

## F. img_search coverage (the "IMG issue")

| # | Finding | Where | Status |
|---|---|---|---|
| F1 | No-namespace path scans only the FIRST `maxResults` (200) rows of CUS_IMGACT **ordered by ACTIVITY**, then filters MCP-side → on S/4 the window is all `/ACCGO/*`; SIMG_OIJ_TSW_* under 'S' never read. Live: 'TSW' → 1 accidental hit. | customizing.ts:339–370 | CONFIRMED (verifier) |
| F2 | Keyword tested against title TEXT only — activity IDs (SIMG_OIJ_TSW_*), OBJECTNAME, TCODE never matched, though already SELECTed. | customizing.ts:370 | CONFIRMED (verifier) |
| F3 | Truncated scan presented as authoritative — no partial-scan warning when hits exist. | customizing.ts:400–417 | CONFIRMED (verifier, one-line fix) |
| F4 | INNER JOIN CUS_ACTOBJ drops doc-only activities; index path limits (6 TTREESRCH entries / 3 trees); language hard-'E'. | customizing.ts:282,338,362 | PLAUSIBLE |

**Fix:** add an engine-side `img_search` op (ABAP `LIKE` with UPPER() on text **and** activity
ID; full-table scan server-side), keep ADT path as paged fallback with an explicit truncation
warning. Immediate mitigation: warn when `scanned.length === max`.

---

## Not run (spend limit): the wedge-root-cause finder agent, most verifiers, the completeness
critic. Verification of PLAUSIBLE rows above = re-read the cited lines before fixing.

## New capability shipped during this audit
`ZCL_MCP_DIAG` **diag-0.9.20**: new read-only op **`wp_detail`** — full TH_WPINFO rows
(headless SM50: per-WP status/wait-reason/semaphore/program/action/table). This is what turned
"wedged, cause unknown" into the phase trace in section A. Deployed on S4.
