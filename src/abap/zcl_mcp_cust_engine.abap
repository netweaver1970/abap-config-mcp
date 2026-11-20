CLASS zcl_mcp_cust_engine DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.
    CONSTANTS c_version TYPE string VALUE '{{ENGINE_VERSION}}'.

  PRIVATE SECTION.
    TYPES: ty_tabkey_tt TYPE STANDARD TABLE OF trobj_name WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_request,
             operation        TYPE string,
             table            TYPE string,
             key_field        TYPE string,
             source_key       TYPE string,
             target_key       TYPE string,
             transport        TYPE string,
             only_missing     TYPE abap_bool,
             commit           TYPE abap_bool,
             max_rows         TYPE i,
             record_transport TYPE abap_bool,  " default true for C/G/E; false = direct write
             view_name        TYPE string,     " maintenance object (view or table) resolved by the MCP layer
             transport_object TYPE string,     " 'VDAT' | 'TABU' | 'CDAT' — recorded transport object type
             cluster_name     TYPE string,     " view cluster (when transport_object='CDAT'); data writes through view_name
             run_id           TYPE c LENGTH 22, " for operation 'status' — poll a prior async write
             structure_id     TYPE string,     " img_index_read: IMG tree id (default root)
             language         TYPE string,     " img_index_read: 1-char SPRAS (default sy-langu)
             keyword          TYPE string,     " img_index_read: case-insensitive substring filter on node TEXT
             create_transport TYPE abap_bool,  " write: mint a new Customizing request when no TRANSPORT given
             transport_text   TYPE string,     " write: short text for the engine-created Customizing request (optional)
             action           TYPE string,     " write/delete: '' / 'INS' = upsert ; 'DEL' = delete via the view ; org_copy: 'COPY' / 'DELE'
             org_unit         TYPE string,     " org_copy: org-key DOMAIN (BUKRS, WERKS, VKORG, VTWEG, SPART, EKORG, …)
             values_json      TYPE string,     " write: JSON array of {FIELD,VALUE} overrides applied to every planned row
             rows_json        TYPE string,     " create: JSON array of rows, each row a JSON array of {FIELD,VALUE} (full key + data)
             items_json       TYPE string,     " listing: JSON array of {PRODUCT,ASSORTMENT,DATE_FROM,DATE_TO} listing items
             extras_json      TYPE string,     " create (internal): JSON array of {ROW,FIELD,VALUE} — view fields outside the base table
             from_trkorr      TYPE string,     " transport_move: source task (TASK) — OBJECTS takes each entry's own TRKORR
             to_trkorr        TYPE string,     " transport_move: target request or task
             objects_json     TYPE string,     " transport_move OBJECTS: JSON array of {TRKORR,PGMID,OBJECT,OBJ_NAME}
             owner            TYPE string,     " transports: only this user's requests
             owner_tasks      TYPE abap_bool,  " transports: also requests in which OWNER has a task
             trfunction       TYPE string,     " transports: request kinds, e.g. 'W' or 'KW' (default K, W, T, C)
             statuses         TYPE string,     " transports: request statuses, e.g. 'DL' (default) or 'RNO'
             client           TYPE string,     " transports: only requests created in this client (E070C)
             with_objects     TYPE abap_bool,  " transports: include each request's objects (its tasks' too)
             pgmid            TYPE string,     " transport_info: R3TR (default)
             obj_type         TYPE string,     " transport_info: TADIR object type, e.g. PROG, CLAS
             obj_name         TYPE string,     " transport_info: object name
             tables_json      TYPE string,     " retest_scope: JSON array of the copier's table names (counted after the rest of customizing)
             only             TYPE string,     " retest_scope: 'customizing' | 'application' | '' (all)
             budget_ms        TYPE i,          " retest_scope: stop starting counts after this many ms (default 25000, max 120000)
           END OF ty_request.

    " Field override for handle_write: applied to each planned row after the
    " key swap, so a copy can land with corrected values (name, currency, …)
    " — or, with SOURCE_KEY = TARGET_KEY + ONLY_MISSING='', patch a row in place.
    TYPES: BEGIN OF ty_field_value,
             field TYPE string,
             value TYPE string,
           END OF ty_field_value,
           ty_field_value_tt TYPE STANDARD TABLE OF ty_field_value WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_batch_result,
             ok           TYPE abap_bool,
             rows_written TYPE i,
             e071k_count  TYPE i,
             transport    TYPE string,   " export transport (org copy reports its request)
             run_id       TYPE c LENGTH 22,
             pending      TYPE abap_bool,
           END OF ty_batch_result.

    " Result the batch writer (ZMCP_CUST_WRITE) EXPORTs to INDX(ZR); both
    " submit_batch_write and handle_status IMPORT it (matched by component name).
    TYPES: BEGIN OF ty_jres,
             status       TYPE string,
             rows_written TYPE i,
             e071k_count  TYPE i,
             transport    TYPE string,   " org copy reports the request it recorded onto
             messages     TYPE stringtab,
           END OF ty_jres.

    " Job handle EXPORTed to INDX(ZJ) by every submit_* right after JOB_CLOSE, so
    " handle_status can cross-check TBTCO and tell running / queued / aborted /
    " unknown apart (instead of a blanket 'pending' that also means 'cancelled'
    " and 'never existed'). cdate/ctime anchor the retention sweep.
    TYPES: BEGIN OF ty_jhandle,
             jobname   TYPE btcjob,
             jobcount  TYPE btcjobcnt,
             run_kind  TYPE string,      " 'WRITE' | 'ORGCOPY' | 'LISTING'
             table     TYPE string,
             transport TYPE string,
             cdate     TYPE d,
             ctime     TYPE t,
           END OF ty_jhandle.

    TYPES: BEGIN OF ty_response,
             status       TYPE string,
             operation    TYPE string,
             version      TYPE string,
             dry_run      TYPE abap_bool,
             table        TYPE string,
             rows_planned TYPE i,
             rows_written TYPE i,
             transport    TYPE string,
             messages     TYPE stringtab,
             data_json    TYPE string,
             run_id       TYPE c LENGTH 22,  " set when status='pending' so the client can poll
           END OF ty_response.

    " Client change-recording capability, read from T000 for sy-mandt.  Decides
    " whether a customizing change is auto-recorded onto a transport (CCCORACTIV
    " for client-dependent objects, CCNOCLIIND for cross-client ones) or written
    " directly without recording — so the engine routes record-vs-direct the way
    " SCC4 configures the client, instead of assuming C/G/E always records.
    TYPES: BEGIN OF ty_client_caps,
             category TYPE t000-cccategory,
             coractiv TYPE t000-cccoractiv,
             nocliind TYPE t000-ccnocliind,
             records  TYPE abap_bool,   " automatic recording active (CCCORACTIV='1')
             changes  TYPE abap_bool,   " client-dependent changes permitted at all
             text     TYPE string,      " human-readable CCCORACTIV meaning
           END OF ty_client_caps.

    " Environment/capability probe — what THIS box actually offers, so the
    " caller (and the engine itself) can adapt instead of assuming a release.
    " Returned by handle_ping as data_json. Feature flags are probed live
    " (FUNCTION_EXISTS / TSTC), never hardcoded per release.
    TYPES: BEGIN OF ty_env,
             SYSID        TYPE sy-sysid,
             CLIENT       TYPE sy-mandt,
             SAPRL        TYPE sy-saprl,          " SAP_BASIS short release (e.g. 758)
             SAP_BASIS    TYPE string,            " CVERS SAP_BASIS release
             S4CORE       TYPE string,            " CVERS S4CORE release ('' on non-S/4)
             IS_S4        TYPE abap_bool,
             CLIENT_ROLE  TYPE t000-cccategory,   " SCC4 client category C/T/P/…
             HAS_ORG_COPY TYPE abap_bool,         " ECOP_ORG_UNITS_IN_THE_DARK present
             HAS_CTS_TASK TYPE abap_bool,         " TRINT_INSERT_NEW_COMM present
             HAS_MC_GUI   TYPE abap_bool,         " tcode LTMC present (migration cockpit GUI)
           END OF ty_env.

    " ddic_describe: one field of the root table, with its data element text
    " and its check table / check field (DD03L + DD04T + DD05S).
    TYPES: BEGIN OF ty_dd_field,
             fieldname  TYPE string,
             keyflag    TYPE string,
             rollname   TYPE string,
             domname    TYPE string,
             datatype   TYPE string,
             leng       TYPE string,
             decimals   TYPE string,
             position   TYPE string,
             checktable TYPE string,
             checkfield TYPE string,
             ddtext     TYPE string,
           END OF ty_dd_field,
           ty_dd_field_tt TYPE STANDARD TABLE OF ty_dd_field WITH DEFAULT KEY.

    " ddic_describe result: the resolved maintenance object (same rules as the
    " MCP server's resolveMaint) plus the root table's DDIC metadata and the
    " client's recording settings. Metadata only, never table rows.
    TYPES: BEGIN OF ty_ddic_desc,
             input             TYPE string,
             is_view           TYPE abap_bool,
             view              TYPE string,
             variant           TYPE string,
             root_table        TYPE string,
             text_table        TYPE string,
             tables            TYPE string_table,
             func_group        TYPE string,
             maint_type        TYPE string,
             maint_tcode       TYPE string,
             img_activity      TYPE string,
             img_activity_text TYPE string,
             auth_group        TYPE string,
             object_type       TYPE string,
             cluster           TYPE string,
             devclass          TYPE string,
             switch_id         TYPE string,
             maint_object      TYPE string,
             record_object     TYPE string,
             transport_object  TYPE string,
             transport_name    TYPE string,
             tabclass          TYPE string,
             contflag          TYPE string,
             clidep            TYPE string,
             mainflag          TYPE string,
             ddtext            TYPE string,
             fields            TYPE ty_dd_field_tt,
             client            TYPE string,
             cccategory        TYPE string,
             cccoractiv        TYPE string,
             ccnocliind        TYPE string,
           END OF ty_ddic_desc.

    " transports: one request with its tasks and (optionally) its objects.
    TYPES: BEGIN OF ty_tr_obj,
             pgmid    TYPE string,
             object   TYPE string,
             obj_name TYPE string,
           END OF ty_tr_obj,
           ty_tr_obj_tt TYPE STANDARD TABLE OF ty_tr_obj WITH DEFAULT KEY,
           BEGIN OF ty_tr_task,
             trkorr     TYPE string,
             as4user    TYPE string,
             trfunction TYPE string,
             trstatus   TYPE string,
           END OF ty_tr_task,
           ty_tr_task_tt TYPE STANDARD TABLE OF ty_tr_task WITH DEFAULT KEY,
           BEGIN OF ty_tr_req,
             trkorr       TYPE string,
             trfunction   TYPE string,
             trstatus     TYPE string,
             as4user      TYPE string,
             as4date      TYPE string,
             tarsystem    TYPE string,
             client       TYPE string,
             text         TYPE string,
             tasks        TYPE ty_tr_task_tt,
             objects      TYPE ty_tr_obj_tt,
             objects_more TYPE abap_bool,
           END OF ty_tr_req,
           ty_tr_req_tt TYPE STANDARD TABLE OF ty_tr_req WITH DEFAULT KEY.

    " transport_info: how a change to one repository object is transported.
    TYPES: BEGIN OF ty_tr_info,
             pgmid           TYPE string,
             obj_type        TYPE string,
             obj_name        TYPE string,
             exists          TYPE abap_bool,
             devclass        TYPE string,
             ctext           TYPE string,
             transport_layer TYPE string,
             target          TYPE string,
             records         TYPE abap_bool,
             lock_request    TYPE string,
             lock_task       TYPE string,
             lock_user       TYPE string,
             requests        TYPE ty_tr_req_tt,
           END OF ty_tr_info.

    " retest_scope: one table keyed on the org-unit domain, with its counts.
    TYPES: BEGIN OF ty_scope_tab,
             tab        TYPE string,
             field      TYPE string,
             cls        TYPE string,
             counted    TYPE abap_bool,
             src        TYPE i,
             tgt        TYPE i,
             unreadable TYPE abap_bool,
             noauth     TYPE abap_bool,
             text       TYPE string,
           END OF ty_scope_tab,
           ty_scope_tab_tt TYPE STANDARD TABLE OF ty_scope_tab WITH DEFAULT KEY,
           BEGIN OF ty_scope,
             domain     TYPE string,
             candidates TYPE i,
             truncated  TYPE abap_bool,
             counted    TYPE i,
             elapsed_ms TYPE i,
             batched    TYPE abap_bool,      " counted eight tables per statement (ZCL_MCP_SCOPE_BATCH installed)
             tables     TYPE ty_scope_tab_tt,
           END OF ty_scope.

    " dependencies (transport_move's facts).
    TYPES: BEGIN OF ty_mv_req,
             trkorr     TYPE string,
             trfunction TYPE string,
             trstatus   TYPE string,
             strkorr    TYPE string,
             as4user    TYPE string,
             tarsystem  TYPE string,
             client     TYPE string,
             text       TYPE string,
           END OF ty_mv_req,
           ty_mv_req_tt TYPE STANDARD TABLE OF ty_mv_req WITH DEFAULT KEY,
           BEGIN OF ty_mv_entry,
             trkorr   TYPE string,
             pgmid    TYPE string,
             object   TYPE string,
             obj_name TYPE string,
             lockflag TYPE string,
           END OF ty_mv_entry,
           ty_mv_entry_tt TYPE STANDARD TABLE OF ty_mv_entry WITH DEFAULT KEY,
           BEGIN OF ty_mv_func,
             fgroup   TYPE string,
             funcname TYPE string,
           END OF ty_mv_func,
           ty_mv_func_tt TYPE STANDARD TABLE OF ty_mv_func WITH DEFAULT KEY,
           BEGIN OF ty_mv_facts,
             covered        TYPE string_table,
             requests       TYPE ty_mv_req_tt,
             entries        TYPE ty_mv_entry_tt,
             entries_more   TYPE abap_bool,
             functions      TYPE ty_mv_func_tt,
           END OF ty_mv_facts,
           BEGIN OF ty_mv_obj,
             name TYPE string,
             type TYPE string,
           END OF ty_mv_obj,
           ty_mv_obj_tt TYPE STANDARD TABLE OF ty_mv_obj WITH DEFAULT KEY,
           BEGIN OF ty_mv_wu,
             name     TYPE string,
             used     TYPE string_table,
             includes TYPE string_table,
           END OF ty_mv_wu,
           ty_mv_wu_tt TYPE STANDARD TABLE OF ty_mv_wu WITH DEFAULT KEY,
           BEGIN OF ty_mv_holder,
             name          TYPE string,
             trkorr        TYPE string,
             trstatus      TYPE string,
             strkorr       TYPE string,
             as4user       TYPE string,
             parent_user   TYPE string,
           END OF ty_mv_holder,
           ty_mv_holder_tt TYPE STANDARD TABLE OF ty_mv_holder WITH DEFAULT KEY.

    CONSTANTS: c_mv_max_entries TYPE i VALUE 20000,
               c_mv_max_objects TYPE i VALUE 100,
               c_mv_max_names   TYPE i VALUE 2000.

    CONSTANTS: c_scope_max_candidates TYPE i VALUE 8000,
               c_scope_default_ms     TYPE i VALUE 25000,
               c_scope_max_ms         TYPE i VALUE 120000.

    CONSTANTS: c_tr_max_requests TYPE i VALUE 500,
               c_tr_max_with_obj TYPE i VALUE 100,
               c_tr_max_objects  TYPE i VALUE 500.

    CONSTANTS: c_read_default_rows TYPE i VALUE 200,
               c_read_max_rows     TYPE i VALUE 1000,
               c_max_fields        TYPE i VALUE 1000.

    METHODS handle_whoami
      IMPORTING io_server      TYPE REF TO if_http_server
      RETURNING VALUE(rs_resp) TYPE ty_response.
    CLASS-METHODS auth_method_name
      RETURNING VALUE(rv) TYPE string.
    METHODS handle_ping
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Rows of one customizing table (delivery class C, G or E only), optionally
    "! where one field equals one value. maxRows defaults to 200, capped at 1000;
    "! display authorization (S_TABU_DIS, else S_TABU_NAM) is checked first.
    "! DATA_JSON = {"COLUMNS":[...],"ROWS":[...],"MORE":bool}.
    METHODS handle_read
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! DDIC metadata of a table or maintenance view: the resolved maintenance
    "! object (view, base tables, text table, maintenance function group, IMG
    "! activity, view cluster, transport object), the root table's fields, keys,
    "! data elements, domains and check tables, its delivery class and client
    "! dependency, and the client's recording settings (T000). No table rows.
    METHODS handle_ddic_describe
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Transport requests from the CTS tables (E070/E07T/E070C/E071): open
    "! requests by default, optionally one user's (and those they have a task in),
    "! one kind, one client, with tasks and objects. TRANSPORT = look up one
    "! request (a task gives its request). Capped at 500 requests, objects for the
    "! newest 100 (500 each). Needs S_TRANSPRT display.
    METHODS handle_transports
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! For one repository object: its package and whether changes are recorded,
    "! the open request holding it, and the user's open workbench requests that
    "! go to the package's transport target. Read-only; needs S_TRANSPRT display.
    METHODS handle_transport_info
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Retest scope of an org-unit copy: the client-dependent transparent tables
    "! with a key field on the org-unit domain (customizing C/G/E and application
    "! A, at most 8000 key fields per group), and for each the number of rows for
    "! the source and the target key, counted in priority order (customizing the
    "! copier leaves alone, then the copier's tables, then application data) until
    "! the time budget is spent. COUNTS ONLY, never rows; a table the user may not
    "! display (S_TABU_DIS, else S_TABU_NAM) is not counted.
    METHODS handle_retest_scope
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! transport_move's facts, read-only, S_TRANSPRT display. ACTION:
    "!   FACTS      for FROM_TRKORR and TO_TRKORR: both requests (a task gives its
    "!              request), the tasks of each request, their object entries (at
    "!              most 20000) and the function modules of every function group
    "!              among the entries. COVERED lists the numbers it answers for.
    "!   WHERE_USED for OBJECTS_JSON [{NAME,TYPE}] (CLAS/INTF/PROG/FUGR, at most
    "!              100): what each uses (where-used index, function modules
    "!              resolved to their group) and the includes that use it.
    "!   HOLDERS    for OBJECTS_JSON [{NAME}] (at most 2000): the open tasks and
    "!              requests holding R3TR entries of those names.
    METHODS handle_dependencies
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Hand a bw_* request to ZCL_MCP_BW_ENGINE=>HANDLE (dynamic: the BW class is
    "! optional and installed only where BW exists); a JSON error when it is absent.
    METHODS dispatch_bw
      IMPORTING iv_body        TYPE string
                iv_operation   TYPE string
      RETURNING VALUE(rv_json) TYPE string.
    "! abap_* operations: the read-only ABAP class ZCL_MCP_ABAP_ENGINE, called dynamically.
    METHODS dispatch_abap
      IMPORTING iv_body        TYPE string
                iv_operation   TYPE string
      RETURNING VALUE(rv_json) TYPE string.

    "! S_TRANSPRT display (activity 03) for any request type.
    METHODS may_display_transports
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    "! Resolve the maintenance object for a table or view name (the rules of the
    "! MCP server's resolveMaint, so both modes agree).
    METHODS resolve_maint
      IMPORTING iv_name        TYPE string
                iv_language    TYPE sy-langu
      RETURNING VALUE(rs_desc) TYPE ty_ddic_desc.

    "! Display authorization for a table: S_TABU_DIS on its authorization group
    "! (auth_group), else S_TABU_NAM on its name (how SE16/SM30 decide).
    METHODS may_display
      IMPORTING iv_table     TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    "! The read row cap: 0 or less gives the default, more than the maximum gives the maximum.
    CLASS-METHODS clamp_rows
      IMPORTING iv_requested   TYPE i
      RETURNING VALUE(rv_rows) TYPE i.

    "! True for the delivery classes a governed read may cover (C, G, E).
    CLASS-METHODS is_customizing_class
      IMPORTING iv_contflag    TYPE clike
      RETURNING VALUE(rv_ok)   TYPE abap_bool.

    METHODS handle_write
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Create rows from explicit field/value maps (full key, no source row) and
    "! write them through the same recorded view-runtime path as handle_write.
    "! Unlike handle_write (a single-key copy), this supports composite keys and
    "! distinct per-row values — e.g. storage locations (WERKS+LGORT+LGOBE).
    METHODS handle_create
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Shared commit machinery for a built plan: delivery-class routing, client
    "! capability + S_TABU_DIS check, transport resolution, then the recorded
    "! batch-job write (view runtime) or direct MODIFY. Used by both the copy
    "! (handle_write) and the explicit-row (handle_create) plan builders.
    METHODS commit_plan
      IMPORTING is_req  TYPE ty_request
                ir_plan TYPE REF TO data
      CHANGING  cs_resp TYPE ty_response.

    "! True if a row with the given key already exists in the table (key fields
    "! read from DD03L; CLNT forced to sy-mandt). Used by handle_create's
    "! ONLY_MISSING to skip rows that are already present.
    METHODS row_exists
      IMPORTING iv_table     TYPE string
                ir_row       TYPE REF TO data
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    "! Retail listing: list articles into assortments via SAP's listing engine
    "! (EXECUTE_LISTING_ART_ASSORT_RFC, determine_data=X so the articles are
    "! extended to the assortment's assigned sites + WLK1 conditions written).
    METHODS handle_listing
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    METHODS handle_delete
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    METHODS handle_selftest
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    METHODS handle_status
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    METHODS handle_img_index_read
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Server-side IMG activity search: a full CUS_IMGACT scan with LIKE over the
    "! title TEXT *and* the activity id (so component acronyms — e.g. TSW, only
    "! present in SIMG_OIJ_TSW_* ids, not the functional titles — are found),
    "! joined to CUS_ACTOBJ. Open SQL LIKE has none of the ADT Data-Preview
    "! endpoint's restrictions, so no 200-row alphabetical-window truncation.
    METHODS handle_img_search
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Best-effort live progress for a still-running batch job: the first BGD work
    "! process of the job's user, with its current program/action/table (headless
    "! SM50). Turns a bare 'running' into 'still working: RADBTDDF reading DD02L'.
    METHODS job_progress_note
      RETURNING VALUE(rv_note) TYPE string.

    "! The error lines of a job's log (message types E/A/X), so an aborted run
    "! says why instead of "check SM37".
    METHODS job_log_errors
      IMPORTING iv_jobname  TYPE btcjob
                iv_jobcount TYPE btcjobcnt
      CHANGING  ct_messages TYPE stringtab.

    "! Age out finished/aborted run artifacts (INDX ZJ/ZR/ZP) whose job handle is
    "! older than the retention window — results stay re-readable for a while
    "! (a lost HTTP response must not destroy the outcome) but don't accumulate.
    METHODS cleanup_stale_runs.

    "! EXPORT the job handle (name/count/kind/timestamp) to INDX(ZJ) keyed by
    "! run_id, so handle_status can cross-check TBTCO. Called by every submit_*
    "! right after JOB_CLOSE succeeds.
    METHODS write_job_handle
      IMPORTING iv_run_id    TYPE c
                iv_jobname   TYPE btcjob
                iv_jobcount  TYPE btcjobcnt
                iv_kind      TYPE string
                iv_table     TYPE string OPTIONAL
                iv_transport TYPE string OPTIONAL.

    METHODS handle_hana_memory
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! ABAP application-server memory & box-health snapshot: key kernel profile
    "! parameters (PHYS_MEMSIZE, extended memory, heap, roll/paging, buffers,
    "! work-process counts) read via C_SAPGPARAM — basis-only, portable to any
    "! ABAP box. Complements handle_hana_memory (the DB side).
    METHODS handle_abap_memory
      RETURNING VALUE(rs_resp) TYPE ty_response.

    "! Copy or delete a whole organizational unit (company code, plant, sales
    "! org, channel, division, purchasing org, …) including ALL its dependent
    "! customizing, via SAP's standard entity copier — the same engine behind
    "! EC01/EC02/EC04 — executed without dialog (ECOP_ORG_UNITS_IN_THE_DARK).
    METHODS handle_org_copy
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    " Move object entries between requests/tasks (TR_MOVE_OBJECTS, with SAP's own
    " test mode on a dry run), or reassign a whole task to another request
    " (TR_REASSIGN_TASK). The MCP layer plans and checks; this only executes.
    METHODS handle_transport_move
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

    METHODS sy_message_text
      RETURNING VALUE(rv_text) TYPE string.

    METHODS run_hana_sql
      IMPORTING iv_tag   TYPE string
                iv_sql   TYPE string
      CHANGING  ct_lines TYPE stringtab.

    METHODS is_valid_name
      IMPORTING iv_name       TYPE string
      RETURNING VALUE(rv_ok)  TYPE abap_bool.

    "! Escape single quotes for safe interpolation into a dynamic WHERE.
    METHODS esc_quote
      IMPORTING iv_val        TYPE string
      RETURNING VALUE(rv_val) TYPE string.

    METHODS delivery_class
      IMPORTING iv_table        TYPE string
      RETURNING VALUE(rv_flag)  TYPE dd02l-contflag.

    "! Read the current client's change/transport capability from T000.
    METHODS client_caps
      RETURNING VALUE(rs_caps) TYPE ty_client_caps.

    "! True if a function module is installed on this system (TFDIR lookup) —
    "! the guard for calling non-kernel FMs that may be absent on a given release.
    METHODS fm_exists
      IMPORTING iv_fm        TYPE rs38l_fnam
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    "! Probe what this box offers (release/components + live feature flags) so
    "! callers adapt to the environment instead of assuming a release.
    METHODS probe_environment
      RETURNING VALUE(rs_env) TYPE ty_env.

    "! True if IV_TABLE is client-dependent (has MANDT as a key field), so its
    "! recording is governed by CCCORACTIV; false for cross-client (CCNOCLIIND).
    METHODS is_client_dependent
      IMPORTING iv_table       TYPE string
      RETURNING VALUE(rv_flag) TYPE abap_bool.

    "! Decide whether a customizing change to IV_TABLE may proceed in this client
    "! and whether the SM30 runtime will record it onto a transport.  EV_BLOCKED
    "! = the client forbids the change; EV_RECORDS = expect transport recording
    "! (false → write directly, no transport).  EV_REASON carries the message.
    METHODS eval_client_change
      IMPORTING iv_table    TYPE string
      EXPORTING ev_blocked  TYPE abap_bool
                ev_records  TYPE abap_bool
                ev_reason   TYPE string.

    METHODS auth_group
      IMPORTING iv_table        TYPE string
      RETURNING VALUE(rv_group) TYPE tddat-cclass.

    METHODS build_tabkey
      IMPORTING iv_table        TYPE string
                ir_row          TYPE REF TO data
      RETURNING VALUE(rv_key)   TYPE trobj_name.

    METHODS submit_batch_write
      IMPORTING is_req         TYPE ty_request
                ir_plan        TYPE REF TO data
                it_keys        TYPE ty_tabkey_tt
      CHANGING  ct_messages    TYPE stringtab
      RETURNING VALUE(rs_res)  TYPE ty_batch_result.

    "! Run the entity copier (ECOP_ORG_UNITS_IN_THE_DARK) in a background job so
    "! its dialog-bound check/aftercopy steps behave batch-safe instead of
    "! aborting in the ICF context. Same INDX(ZP/ZR)+poll contract as
    "! submit_batch_write; returns pending+run_id if the job outlives the poll.
    METHODS submit_org_copy
      IMPORTING is_req         TYPE ty_request
      CHANGING  ct_messages    TYPE stringtab
      RETURNING VALUE(rs_res)  TYPE ty_batch_result.

    "! Run the retail listing engine (EXECUTE_LISTING_ART_ASSORT_RFC) in a
    "! background job so the dialog messages it issues (e.g. WM 028) are logged
    "! instead of aborting in the HTTP/ICF context. iv_items_json is the
    "! serialized WINT_LISTING_ITEM_TAB. Same INDX(ZP/ZR)+poll contract as
    "! submit_org_copy; returns pending+run_id if the job outlives the poll.
    METHODS submit_listing
      IMPORTING iv_items_json  TYPE string
      CHANGING  ct_messages    TYPE stringtab
      RETURNING VALUE(rs_res)  TYPE ty_batch_result.

    "! Create a modifiable Customizing request (TRFUNCTION 'W') owned by the
    "! current user. Customizing view data (R3TR VDAT) can only be recorded into
    "! a customizing request, not a workbench one. Returns the request trkorr
    "! (to report/release) and the customizing task trkorr (the corr_number to
    "! record objects on). Both empty on failure.
    METHODS create_cust_transport
      IMPORTING iv_text    TYPE as4text
      EXPORTING ev_request TYPE trkorr
                ev_task    TYPE trkorr.

    "! Resolve the task to record onto for a caller-supplied transport.
    "! If IV_TRANSPORT is a task, returns it (and its parent request). If it is a
    "! request, returns the current user's modifiable task under it — creating one
    "! (TRINT_INSERT_NEW_COMM) when the user has none, so a supplied request the
    "! user has no task in still records cleanly. EV_MSG set on failure.
    METHODS ensure_user_task
      IMPORTING iv_transport TYPE trkorr
      EXPORTING ev_task      TYPE trkorr
                ev_request   TYPE trkorr
                ev_created   TYPE abap_bool
                ev_msg       TYPE string.

ENDCLASS.



CLASS zcl_mcp_cust_engine IMPLEMENTATION.

  METHOD if_http_extension~handle_request.
    DATA: ls_req   TYPE ty_request,
          ls_resp  TYPE ty_response,
          lv_body  TYPE string,
          lv_xbody TYPE xstring,
          lv_out   TYPE string.

    " Always write a response — wrap everything so an unhandled exception
    " cannot produce an empty body (ICF silently returns 200 on handler abort).
    TRY.

        " Read POST body: get_data() → UTF-8 decode is more reliable than
        " get_cdata() in many ICF configurations; fall back to get_cdata().
        lv_xbody = server->request->get_data( ).
        IF lv_xbody IS NOT INITIAL.
          TRY.
              lv_body = cl_abap_codepage=>convert_from(
                          source   = lv_xbody
                          codepage = '4110' ).   " 4110 = UTF-8
            CATCH cx_root.
              lv_body = server->request->get_cdata( ).
          ENDTRY.
        ELSE.
          lv_body = server->request->get_cdata( ).
        ENDIF.

        " Deserialize request JSON
        TRY.
            /ui2/cl_json=>deserialize(
              EXPORTING json        = lv_body
                        pretty_name = /ui2/cl_json=>pretty_mode-none
              CHANGING  data        = ls_req ).
          CATCH cx_root INTO DATA(lx_parse).
            ls_resp-status = 'error'.
            APPEND |Cannot parse JSON body: { lx_parse->get_text( ) }|
              TO ls_resp-messages.
            APPEND |Raw body (first 200): { substring( val = lv_body
                       off = 0
                       len = nmin( val1 = 200 val2 = strlen( lv_body ) ) ) }|
              TO ls_resp-messages.
        ENDTRY.

        " One path per action (POST /sap/bc/zmcp_cust/<operation>), for an OpenAPI description
        " with one operation per action, as SAP's MCP gateway turns each operation into a tool.
        " A body that names its operation wins; the path names it when the body does not.
        IF ls_resp-status <> 'error' AND ls_req-operation IS INITIAL.
          DATA(lv_path_op) = to_lower( condense( replace( val = server->request->get_header_field( '~path_info' )
                                                          sub = `/` with = `` occ = 0 ) ) ).
          IF lv_path_op IS NOT INITIAL AND is_valid_name( to_upper( lv_path_op ) ) = abap_true.
            ls_req-operation = lv_path_op.
            " the BW class reads the operation from the body
            DATA(lv_trimmed) = condense( lv_body ).
            IF lv_trimmed IS INITIAL OR lv_trimmed = `{}`.
              lv_body = |\{"operation":"{ lv_path_op }"\}|.
            ELSE.
              lv_body = replace( val = lv_body sub = `{` with = |\{"operation":"{ lv_path_op }",| ).
            ENDIF.
          ENDIF.
        ENDIF.

        " BW operations (bw_*) go to the optional class ZCL_MCP_BW_ENGINE, called
        " dynamically so this class never depends on BW: it gets the raw request and
        " answers with a complete JSON response of the same shape.
        IF ls_resp-status <> 'error' AND to_lower( ls_req-operation ) CP 'bw_*'.
          lv_out = dispatch_bw( iv_body = lv_body iv_operation = ls_req-operation ).
        ENDIF.

        " Read-only ABAP operations (abap_*, but not abap_memory) go to ZCL_MCP_ABAP_ENGINE.
        IF ls_resp-status <> 'error' AND lv_out IS INITIAL AND to_lower( ls_req-operation ) CP 'abap_*'
        AND to_lower( ls_req-operation ) <> 'abap_memory'.
          lv_out = dispatch_abap( iv_body = lv_body iv_operation = ls_req-operation ).
        ENDIF.

        " Dispatch
        IF ls_resp-status <> 'error' AND lv_out IS INITIAL.
          CASE to_lower( ls_req-operation ).
            WHEN 'ping'.     ls_resp = handle_ping( ).
            WHEN 'whoami'.   ls_resp = handle_whoami( server ).
            WHEN 'read'.     ls_resp = handle_read( ls_req ).
            WHEN 'ddic_describe'. ls_resp = handle_ddic_describe( ls_req ).
            WHEN 'transports'.     ls_resp = handle_transports( ls_req ).
            WHEN 'transport_info'. ls_resp = handle_transport_info( ls_req ).
            WHEN 'retest_scope'.   ls_resp = handle_retest_scope( ls_req ).
            WHEN 'dependencies'.   ls_resp = handle_dependencies( ls_req ).
            WHEN 'write'.    ls_resp = handle_write( ls_req ).
            WHEN 'create'.   ls_resp = handle_create( ls_req ).
            WHEN 'listing'.  ls_resp = handle_listing( ls_req ).
            WHEN 'delete'.   ls_resp = handle_delete( ls_req ).
            WHEN 'selftest'. ls_resp = handle_selftest( ls_req ).
            WHEN 'status'.   ls_resp = handle_status( ls_req ).
            WHEN 'img_index_read'. ls_resp = handle_img_index_read( ls_req ).
            WHEN 'img_search'.     ls_resp = handle_img_search( ls_req ).
            WHEN 'hana_memory'.    ls_resp = handle_hana_memory( ).
            WHEN 'abap_memory'.    ls_resp = handle_abap_memory( ).
            WHEN 'org_copy'.       ls_resp = handle_org_copy( ls_req ).
            WHEN 'transport_move'. ls_resp = handle_transport_move( ls_req ).
            WHEN OTHERS.
              ls_resp-status = 'error'.
              APPEND |Unknown operation: '{ ls_req-operation }'|
                TO ls_resp-messages.
          ENDCASE.
        ENDIF.

        IF lv_out IS INITIAL.
          ls_resp-version = c_version.

          " Serialize response
          /ui2/cl_json=>serialize(
            EXPORTING data        = ls_resp
                      pretty_name = /ui2/cl_json=>pretty_mode-none
            RECEIVING r_json      = lv_out ).
        ENDIF.

      CATCH cx_root INTO DATA(lx_all).
        " Last-resort: any unhandled exception → hand-built JSON error.
        " Include the raise position — for errors thrown deep inside standard
        " FMs (e.g. a popup attempted in a GUI-less context) the position is
        " the only way to identify the offender.
        DATA lv_msg TYPE string.
        lx_all->get_source_position(
          IMPORTING program_name = DATA(lv_xprog)
                    include_name = DATA(lv_xincl)
                    source_line  = DATA(lv_xline) ).
        lv_msg = |{ lx_all->get_text( ) } [raised at { lv_xprog }/{ lv_xincl } line { lv_xline }]|.
        REPLACE ALL OCCURRENCES OF '"' IN lv_msg WITH '\"'.
        CONCATENATE '{"STATUS":"error","VERSION":"' c_version
                    '","MESSAGES":["' lv_msg '"]}' INTO lv_out.
    ENDTRY.

    " Safety net: should never be empty after the above, but guard anyway
    IF lv_out IS INITIAL.
      CONCATENATE '{"STATUS":"error","VERSION":"' c_version
                  '","MESSAGES":["Handler returned no output"]}' INTO lv_out.
    ENDIF.

    server->response->set_content_type( 'application/json; charset=utf-8' ).
    server->response->set_cdata( lv_out ).
    server->response->set_status( code = 200 reason = 'OK' ).
  ENDMETHOD.


  METHOD auth_method_name.
    rv = SWITCH #( cl_http_server=>if_http_server~authentication_method
           WHEN if_http_server=>authmethod_basic       THEN `basic authentication`
           WHEN if_http_server=>authmethod_certificate THEN `X.509 client certificate`
           WHEN if_http_server=>authmethod_sso         THEN `SAP logon ticket`
           WHEN if_http_server=>authmethod_saml        THEN `SAML`
           WHEN if_http_server=>authmethod_assertion   THEN `assertion ticket`
           WHEN if_http_server=>authmethod_oauth       THEN `OAuth`
           WHEN if_http_server=>authmethod_service     THEN `service user of the SICF node`
           WHEN if_http_server=>authmethod_none        THEN `none`
           ELSE |method { cl_http_server=>if_http_server~authentication_method }| ).
  ENDMETHOD.


  METHOD handle_whoami.
    " Who SAP sees and how the caller logged on: the check for principal propagation.
    " Reads nothing from the database.
    rs_resp-status    = 'ok'.
    rs_resp-operation = 'whoami'.
    rs_resp-version   = c_version.
    DATA(lv_tls) = xsdbool( cl_http_server=>if_http_server~ssl_active <> 0 ).
    APPEND |{ sy-uname } on { sy-sysid }/{ sy-mandt }, logged on by { auth_method_name( ) }| &&
           |{ COND string( WHEN lv_tls = abap_true THEN `, over TLS` ELSE `, without TLS` ) }| TO rs_resp-messages.
    rs_resp-data_json = |\{"USER":"{ sy-uname }","CLIENT":"{ sy-mandt }","SYSTEM":"{ sy-sysid }",| &&
                        |"AUTH_METHOD":{ cl_http_server=>if_http_server~authentication_method },"AUTH":"{ auth_method_name( ) }",| &&
                        |"TLS":{ COND string( WHEN lv_tls = abap_true THEN `true` ELSE `false` ) },| &&
                        |"REMOTE_ADDR":"{ io_server->request->get_header_field( '~remote_addr' ) }"\}|.
  ENDMETHOD.


  METHOD handle_ping.
    rs_resp-status    = 'ok'.
    rs_resp-operation = 'ping'.
    rs_resp-version   = c_version.
    " sy-uname shows who SAP thinks is calling: the check for per-user logon and principal propagation.
    APPEND |MCP Customizing Engine alive on { sy-sysid } client { sy-mandt }, running as user { sy-uname }| &&
           |, logged on by { auth_method_name( ) }| TO rs_resp-messages.

    " Read-on-connect: surface the client's change/transport capability so the
    " caller knows up front whether customizing changes here are recorded onto a
    " transport, written without recording, or forbidden (T000/SCC4).
    DATA(ls_caps) = client_caps( ).
    APPEND |Client { sy-mandt }: category '{ ls_caps-category }', | &&
           |client-dependent changes = { ls_caps-text } (CCCORACTIV='{ ls_caps-coractiv }'), | &&
           |cross-client/repository CCNOCLIIND='{ ls_caps-nocliind }'|
      TO rs_resp-messages.
    APPEND COND string(
      WHEN ls_caps-changes = abap_false
        THEN '→ customizing changes are BLOCKED in this client'
      WHEN ls_caps-records = abap_true
        THEN '→ client-dependent customizing changes are auto-recorded onto a transport'
      ELSE '→ client-dependent customizing changes are written WITHOUT transport recording' )
      TO rs_resp-messages.

    " Environment/capability probe so the caller adapts to THIS box (release +
    " live feature flags) instead of assuming a release. Full struct in data_json.
    DATA(ls_env) = probe_environment( ).
    APPEND |Environment: { ls_env-sysid } SAP_BASIS { ls_env-sap_basis } | &&
           COND string( WHEN ls_env-is_s4 = abap_true
                          THEN |/ S4CORE { ls_env-s4core }|
                          ELSE |(non-S/4)| ) &&
           |; features: org_copy={ ls_env-has_org_copy } cts_task={ ls_env-has_cts_task } | &&
           |migration_cockpit_gui(LTMC)={ ls_env-has_mc_gui }|
      TO rs_resp-messages.
    /ui2/cl_json=>serialize(
      EXPORTING data        = ls_env
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD run_hana_sql.
    " Native ADBC query against HANA SYS.M_* monitoring views — these are not
    " visible to Open SQL, so we use cl_sql_statement.  Each query returns a
    " single VARCHAR column (concatenated in SQL); rows are appended verbatim
    " with a leading tag so the caller can group them.  Read-only and safe.
    DATA lt TYPE TABLE OF string.
    TRY.
        DATA(lo) = NEW cl_sql_statement( )->execute_query( iv_sql ).
        lo->set_param_table( REF #( lt ) ).
        lo->next_package( ).
        lo->close( ).
        LOOP AT lt INTO DATA(lv).
          APPEND |{ iv_tag } { lv }| TO ct_lines.
        ENDLOOP.
        IF lt IS INITIAL.
          APPEND |{ iv_tag } (none)| TO ct_lines.
        ENDIF.
      CATCH cx_sql_exception INTO DATA(lx).
        APPEND |{ iv_tag } ERR { lx->get_text( ) }| TO ct_lines.
    ENDTRY.
  ENDMETHOD.


  METHOD handle_abap_memory.
    " Read key ABAP kernel memory / box-health parameters via C_SAPGPARAM
    " (effective runtime values). Portable: C_SAPGPARAM is a kernel call on
    " every ABAP box. Read-only.
    TYPES: BEGIN OF ty_p,
             name  TYPE string,
             value TYPE string,
           END OF ty_p.
    DATA: lt_p     TYPE STANDARD TABLE OF ty_p,
          ls_p     TYPE ty_p,
          lt_names TYPE STANDARD TABLE OF string,
          lv_name  TYPE c LENGTH 80,
          lv_v     TYPE c LENGTH 255.

    rs_resp-operation = 'abap_memory'.
    rs_resp-version   = c_version.

    lt_names = VALUE #(
      ( `PHYS_MEMSIZE` )
      ( `em/initial_size_MB` ) ( `em/global_area_MB` ) ( `em/blocksize_KB` ) ( `em/address_space_MB` )
      ( `abap/heap_area_total` ) ( `abap/heap_area_dia` ) ( `abap/heap_area_nondia` )
      ( `abap/heaplimit` ) ( `abap/swap_reserve` )
      ( `ztta/roll_area` ) ( `ztta/roll_first` ) ( `ztta/roll_extension` )
      ( `ztta/roll_extension_dia` ) ( `ztta/roll_extension_nondia` )
      ( `rdisp/ROLL_MAXFS` ) ( `rdisp/ROLL_SHM` ) ( `rdisp/PG_MAXFS` ) ( `rdisp/PG_SHM` )
      ( `abap/buffersize` ) ( `zcsa/table_buffer_area` ) ( `zcsa/db_max_buftab` )
      ( `rsdb/ntab/ftabsize` ) ( `rsdb/ntab/entrycount` )
      ( `rdisp/wp_no_dia` ) ( `rdisp/wp_no_btc` ) ( `rdisp/wp_no_upd` )
      ( `rdisp/wp_no_enq` ) ( `rdisp/wp_no_spo` ) ( `rdisp/wp_max_no` )
      ( `rdisp/max_wprun_time` ) ( `ztta/max_memreq_MB` ) ).

    LOOP AT lt_names INTO DATA(lv_n).
      lv_name = lv_n.
      CLEAR lv_v.
      CALL 'C_SAPGPARAM' ID 'NAME'  FIELD lv_name
                         ID 'VALUE' FIELD lv_v.                 "#EC CI_CCALL
      ls_p-name  = lv_n.
      ls_p-value = lv_v.
      APPEND ls_p TO lt_p.
    ENDLOOP.

    " ── Live usage (ST02 backend): EM / heap / roll / paging high-water ───────
    " SAPTUNE_GET_SUMMARY_STATISTIC + its EMSTATUSAG/HPSTATUSAG/RLPG_STAT
    " structures are basis (ST02), present on every ABAP box.
    DATA: ls_em   TYPE emstatusag,
          ls_hp   TYPE hpstatusag,
          ls_roll TYPE rlpg_stat,
          ls_page TYPE rlpg_stat.
    CALL FUNCTION 'SAPTUNE_GET_SUMMARY_STATISTIC'
      IMPORTING
        roll_area             = ls_roll
        paging_area           = ls_page
        extended_memory_usage = ls_em
        heap_memory_usage     = ls_hp
      EXCEPTIONS
        OTHERS                = 1.
    IF sy-subrc = 0.
      APPEND VALUE #( name = 'usage:EM_USED'      value = |{ ls_em-used }| )       TO lt_p.
      APPEND VALUE #( name = 'usage:EM_ALLOCATED' value = |{ ls_em-allocated }| )  TO lt_p.
      APPEND VALUE #( name = 'usage:EM_TOTAL'     value = |{ ls_em-total }| )      TO lt_p.
      APPEND VALUE #( name = 'usage:HEAP_USED'    value = |{ ls_hp-used }| )       TO lt_p.
      APPEND VALUE #( name = 'usage:HEAP_TOTAL'   value = |{ ls_hp-total }| )      TO lt_p.
      APPEND VALUE #( name = 'usage:ROLL_MAXUSED' value = |{ ls_roll-max_used }| ) TO lt_p.
      APPEND VALUE #( name = 'usage:ROLL_SIZE'    value = |{ ls_roll-area_size }| ) TO lt_p.
      APPEND VALUE #( name = 'usage:PAGE_MAXUSED' value = |{ ls_page-max_used }| ) TO lt_p.
      APPEND VALUE #( name = 'usage:PAGE_SIZE'    value = |{ ls_page-area_size }| ) TO lt_p.
    ELSE.
      APPEND VALUE #( name = 'usage:NOTE'
                      value = |SAPTUNE_GET_SUMMARY_STATISTIC unavailable (subrc { sy-subrc })| ) TO lt_p.
    ENDIF.

    rs_resp-status = 'ok'.
    APPEND |Read { lines( lt_p ) } ABAP memory parameters + live usage| TO rs_resp-messages.
    /ui2/cl_json=>serialize(
      EXPORTING data        = lt_p
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD handle_hana_memory.
    " Diagnose HANA memory pressure on the tenant this ABAP system runs on:
    " host RAM/swap, per-service usage, top heap allocators, largest loaded
    " column tables, row store, plan cache, and the configured allocation limit.
    " All numbers in GB (MB for table list).  data_json = JSON array of strings.
    rs_resp-status    = 'ok'.
    rs_resp-operation = 'hana_memory'.
    rs_resp-version   = c_version.

    DATA lt_lines TYPE stringtab.

    run_hana_sql(
      EXPORTING
        iv_tag = 'HOST'
        iv_sql = `SELECT 'host=' || HOST || ' phys_used=' || ` &&
                 `TO_DECIMAL(USED_PHYSICAL_MEMORY/1073741824,10,1) || 'G_of_' || ` &&
                 `TO_DECIMAL((USED_PHYSICAL_MEMORY+FREE_PHYSICAL_MEMORY)/1073741824,10,1) || ` &&
                 `'G swap_used=' || TO_DECIMAL(USED_SWAP_SPACE/1073741824,10,1) || ` &&
                 `'G db_alloc_lim=' || TO_DECIMAL(ALLOCATION_LIMIT/1073741824,10,1) || ` &&
                 `'G db_used=' || TO_DECIMAL(INSTANCE_TOTAL_MEMORY_USED_SIZE/1073741824,10,1) || ` &&
                 `'G db_peak=' || TO_DECIMAL(INSTANCE_TOTAL_MEMORY_PEAK_USED_SIZE/1073741824,10,1) || 'G' ` &&
                 `FROM SYS.M_HOST_RESOURCE_UTILIZATION`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'SVC'
        iv_sql = `SELECT 'svc=' || SERVICE_NAME || ' used=' || ` &&
                 `TO_DECIMAL(TOTAL_MEMORY_USED_SIZE/1073741824,10,1) || 'G lim=' || ` &&
                 `TO_DECIMAL(EFFECTIVE_ALLOCATION_LIMIT/1073741824,10,1) || 'G heap=' || ` &&
                 `TO_DECIMAL(HEAP_MEMORY_USED_SIZE/1073741824,10,1) || 'G' ` &&
                 `FROM SYS.M_SERVICE_MEMORY ORDER BY TOTAL_MEMORY_USED_SIZE DESC`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'HEAP'
        iv_sql = `SELECT TOP 12 CATEGORY || ' ' || ` &&
                 `TO_DECIMAL(EXCLUSIVE_SIZE_IN_USE/1073741824,10,2) || 'G' ` &&
                 `FROM SYS.M_HEAP_MEMORY WHERE EXCLUSIVE_SIZE_IN_USE > 1073741824 ` &&
                 `ORDER BY EXCLUSIVE_SIZE_IN_USE DESC`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'CS'
        iv_sql = `SELECT TOP 12 SCHEMA_NAME || '.' || TABLE_NAME || ' ' || ` &&
                 `TO_DECIMAL(MEMORY_SIZE_IN_TOTAL/1048576,10,0) || 'MB' ` &&
                 `FROM SYS.M_CS_TABLES ORDER BY MEMORY_SIZE_IN_TOTAL DESC`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'TOT'
        iv_sql = `SELECT 'loaded_cs=' || ` &&
                 `TO_DECIMAL(SUM(MEMORY_SIZE_IN_TOTAL)/1073741824,10,1) || 'G over ' || ` &&
                 `COUNT(*) || ' tables' FROM SYS.M_CS_TABLES WHERE LOADED <> 'NO'`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'RS'
        iv_sql = `SELECT 'rowstore=' || TO_DECIMAL(SUM(ALLOCATED_FIXED_PART_SIZE + ` &&
                 `ALLOCATED_VARIABLE_PART_SIZE)/1073741824,10,1) || 'G' FROM SYS.M_RS_TABLES`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'PLAN'
        iv_sql = `SELECT 'plan_cache_used=' || TO_DECIMAL(CACHED_PLAN_SIZE/1073741824,10,1) || ` &&
                 `'G_of_' || TO_DECIMAL(PLAN_CACHE_CAPACITY/1073741824,10,1) || 'G' ` &&
                 `FROM SYS.M_SQL_PLAN_CACHE_OVERVIEW`
      CHANGING ct_lines = lt_lines ).

    run_hana_sql(
      EXPORTING
        iv_tag = 'GAL'
        iv_sql = `SELECT 'layer=' || LAYER_NAME || ' ' || KEY || '=' || VALUE ` &&
                 `FROM SYS.M_INIFILE_CONTENTS WHERE FILE_NAME = 'global.ini' ` &&
                 `AND SECTION = 'memorymanager' AND KEY = 'global_allocation_limit'`
      CHANGING ct_lines = lt_lines ).

    rs_resp-rows_planned = lines( lt_lines ).
    /ui2/cl_json=>serialize(
      EXPORTING data        = lt_lines
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD handle_org_copy.
    " ORG_UNIT is the org-key DOMAIN name (BUKRS, WERKS, VKORG, VTWEG, SPART,
    " EKORG, LGORT, CACCD, VSTEL, LGNUM, …).  ACTION 'COPY' duplicates
    " SOURCE_KEY → TARGET_KEY (the copier raises if the target already exists);
    " 'DELE' removes the unit in SOURCE_KEY.  COMMIT='' = dry run: report the
    " dependent-table set the copier would process, write nothing.
    rs_resp-operation = 'org_copy'.
    rs_resp-version   = c_version.

    " ECOP types resolved dynamically so the class compiles on non-ECOP systems
    " (e.g. CAR); the FM-existence guard below returns cleanly there.
    DATA: lv_org_unit TYPE domname,
          lv_action   TYPE c LENGTH 4,
          lv_source   TYPE c LENGTH 30,
          lv_target   TYPE c LENGTH 30.

    lv_org_unit = to_upper( is_req-org_unit ).
    lv_action   = COND #( WHEN to_upper( is_req-action ) = 'DELE'
                          THEN 'DELE' ELSE 'COPY' ).
    lv_source   = is_req-source_key.
    lv_target   = is_req-target_key.
    rs_resp-table   = lv_org_unit.
    rs_resp-dry_run = COND #( WHEN is_req-commit = abap_true
                              THEN abap_false ELSE abap_true ).

    IF lv_org_unit IS INITIAL OR lv_source IS INITIAL
       OR ( lv_action = 'COPY' AND lv_target IS INITIAL ).
      rs_resp-status = 'error'.
      APPEND `org_copy needs ORG_UNIT (domain, e.g. BUKRS), SOURCE_KEY and TARGET_KEY; for ACTION='DELE' SOURCE_KEY is the unit to delete`
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Environment guard: the EC entity copier isn't on every system (a stripped
    " ABAP platform without Enterprise Controlling won't have it). Probe first so
    " we return a clear message instead of a short-dump on the CALL FUNCTION.
    IF fm_exists( 'ECOP_ORG_UNITS_IN_THE_DARK' ) = abap_false
       OR fm_exists( 'ECOP_GET_TABLES_TO_ORGUNIT' ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |org_copy is not available on this system: the standard entity copier | &&
             |(ECOP_ORG_UNITS_IN_THE_DARK) is not installed here| TO rs_resp-messages.
      RETURN.
    ENDIF.

    " ── Dry run: validate the org unit + report its description ─────────────
    " (The dependent-table enumeration used ECOP-only structures; resolving the
    " org unit dynamically keeps this portable. The exact table count is still
    " reported on the actual commit.)
    IF is_req-commit = abap_false.
      DATA: lr_orgunit TYPE REF TO data,
            lv_desc    TYPE string.
      FIELD-SYMBOLS: <orgunit> TYPE any,
                     <desc>    TYPE any.
      TRY.
          CREATE DATA lr_orgunit TYPE ('ECOP_ORGUNIT').
          ASSIGN lr_orgunit->* TO <orgunit>.
        CATCH cx_root INTO DATA(lx_eco).
          rs_resp-status = 'error'.
          APPEND |ECOP entity-copier types not available on this system: { lx_eco->get_text( ) }|
            TO rs_resp-messages.
          RETURN.
      ENDTRY.
      CALL FUNCTION 'ECOP_GET_TABLES_TO_ORGUNIT'
        EXPORTING
          pv_org_unit       = lv_org_unit
          pv_flag_no_dialog = 'X'
        CHANGING
          ps_orgunit        = <orgunit>
        EXCEPTIONS
          invalid_org_unit     = 1
          no_tables_to_orgunit = 2
          OTHERS               = 3.
      IF sy-subrc <> 0.
        rs_resp-status = 'error'.
        APPEND |Org unit '{ lv_org_unit }' is not registered for entity copy (subrc { sy-subrc })|
          TO rs_resp-messages.
        RETURN.
      ENDIF.
      ASSIGN COMPONENT 'DESCRIPTION' OF STRUCTURE <orgunit> TO <desc>.
      IF sy-subrc = 0.
        lv_desc = <desc>.
      ENDIF.

      " The dependent tables the copier would process: ECOP_GET_TABLES_TO_ORGUNIT
      " fills PS_ORGUNIT-TABLES (and -EXTTABLES), references to ECOP_TABLES_TAB
      " (rows ECOP_TAB2DOMAIN: TABNAME, DDTEXT). Read generically, so the class
      " still compiles where ECOP is absent. Without this every dry run reported
      " 0 tables (seen for WERKS).
      TYPES: BEGIN OF ty_deptab,
               tabname TYPE string,
               text    TYPE string,
             END OF ty_deptab.
      DATA: lt_deptabs TYPE STANDARD TABLE OF ty_deptab WITH DEFAULT KEY,
            lr_tabs    TYPE REF TO data.
      " The components are typed REF TO ECOP_TABLES_TAB: a field symbol typed
      " REF TO data refuses them (ASSIGN_TYPE_CONFLICT), a widening move takes them.
      FIELD-SYMBOLS: <tref> TYPE any,
                     <tabs> TYPE ANY TABLE,
                     <trow> TYPE any,
                     <tnam> TYPE any,
                     <ttxt> TYPE any.
      LOOP AT VALUE stringtab( ( `TABLES` ) ( `EXTTABLES` ) ) INTO DATA(lv_comp).
        ASSIGN COMPONENT lv_comp OF STRUCTURE <orgunit> TO <tref>.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        TRY.
            lr_tabs = <tref>.
          CATCH cx_root.
            CONTINUE.
        ENDTRY.
        IF lr_tabs IS NOT BOUND.
          CONTINUE.
        ENDIF.
        ASSIGN lr_tabs->* TO <tabs>.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        LOOP AT <tabs> ASSIGNING <trow>.
          ASSIGN COMPONENT 'TABNAME' OF STRUCTURE <trow> TO <tnam>.
          CHECK sy-subrc = 0 AND <tnam> IS NOT INITIAL.
          READ TABLE lt_deptabs TRANSPORTING NO FIELDS WITH KEY tabname = CONV string( <tnam> ).
          CHECK sy-subrc <> 0.
          APPEND VALUE #( tabname = <tnam> ) TO lt_deptabs ASSIGNING FIELD-SYMBOL(<dt>).
          ASSIGN COMPONENT 'DDTEXT' OF STRUCTURE <trow> TO <ttxt>.
          IF sy-subrc = 0.
            <dt>-text = <ttxt>.
          ENDIF.
        ENDLOOP.
      ENDLOOP.
      rs_resp-rows_planned = lines( lt_deptabs ).
      IF lt_deptabs IS NOT INITIAL.
        rs_resp-data_json = /ui2/cl_json=>serialize( data = lt_deptabs pretty_name = /ui2/cl_json=>pretty_mode-none ).
      ENDIF.

      rs_resp-status = 'ok'.
      IF lv_action = 'DELE'.
        APPEND |DRY RUN — delete '{ lv_desc }' ({ lv_org_unit }) { lv_source } | &&
               |— { lines( lt_deptabs ) } dependent table(s); commit to delete the org unit's entries in them|
          TO rs_resp-messages.
      ELSE.
        APPEND |DRY RUN — copy '{ lv_desc }' ({ lv_org_unit }): { lv_source } → { lv_target } | &&
               |— { lines( lt_deptabs ) } dependent table(s); commit to copy the org unit with its dependent customizing|
          TO rs_resp-messages.
      ENDIF.
      RETURN.
    ENDIF.

    " ── Governance: the entity copier ALWAYS records onto a request it determines
    " itself (ECOP's own export request) — it cannot be told to record into a
    " caller-supplied request (IMPORT_TR_REQUEST is a different, import-scenario
    " input). So in a recording client it will mint a fresh Customizing request;
    " require the CREATE_TRANSPORT opt-in as an explicit acknowledgment of that.
    DATA(ls_caps) = client_caps( ).
    IF ls_caps-records = abap_true AND is_req-create_transport = abap_false.
      rs_resp-status = 'error'.
      APPEND `The org copier mints its OWN Customizing request (it cannot record into a request you supply). Set CREATE_TRANSPORT=X to acknowledge and let it create one.`
        TO rs_resp-messages.
      RETURN.
    ENDIF.
    " ── Commit: run the copier in a BACKGROUND JOB so its check/aftercopy FMs
    " run with sy-batch='X'. There a GUI MESSAGE I is logged (not popped) and the
    " dialog-bound number-range step is skipped, instead of raising mid-copy the
    " way they do in the synchronous ICF handler context. If the job outlives the
    " short poll it returns pending + run_id; the caller then polls 'status'.
    DATA(ls_res) = submit_org_copy(
      EXPORTING is_req      = is_req
      CHANGING  ct_messages = rs_resp-messages ).

    IF ls_res-pending = abap_true.
      rs_resp-status = 'pending'.
      rs_resp-run_id = ls_res-run_id.
      APPEND |Org copy running as a background job — run_id { ls_res-run_id } (poll customizing_status)|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF ls_res-ok = abap_false.
      rs_resp-status = 'error'.   " submit_org_copy already appended the failure detail
      RETURN.
    ENDIF.

    rs_resp-status       = 'ok'.
    rs_resp-transport    = ls_res-transport.
    rs_resp-rows_written = ls_res-rows_written.
    rs_resp-rows_planned = ls_res-rows_written.
  ENDMETHOD.


  METHOD handle_read.
    DATA: lr_tab   TYPE REF TO data,
          lv_where TYPE string,
          lv_max   TYPE i,
          lv_fetch TYPE i,
          lv_cut   TYPE i,
          lv_more  TYPE abap_bool,
          lv_rows  TYPE string,
          lv_cols  TYPE string,
          lv_tab   TYPE tabname,
          lv_fld   TYPE fieldname,
          lv_grp   TYPE tddat-cclass,
          lv_flag  TYPE abap_bool,
          lt_dfies TYPE ddfields.
    FIELD-SYMBOLS <tab> TYPE STANDARD TABLE.

    rs_resp-operation = 'read'.
    rs_resp-table     = to_upper( is_req-table ).

    IF is_valid_name( is_req-table ) = abap_false
    OR ( is_req-key_field IS NOT INITIAL AND is_valid_name( is_req-key_field ) = abap_false ).
      rs_resp-status = 'error'.
      APPEND |Reading stopped: '{ is_req-table }' / '{ is_req-key_field }' is not a valid DDIC name. | &&
             |Give a table name such as T001W and, for a filter, one of its fields.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_tab = rs_resp-table.

    " A database table of delivery class C, G or E, nothing else: the engine has
    " no generic SELECT, so it cannot become a pathway for application data.
    SELECT SINGLE tabclass, contflag FROM dd02l
      WHERE tabname = @lv_tab AND as4local = 'A'
      INTO @DATA(ls_dd02).
    IF sy-subrc <> 0.
      rs_resp-status = 'error'.
      APPEND |Reading { lv_tab } stopped: there is no active table of that name. | &&
             |Check the name, or run customizing_describe to find the table behind a view.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF ls_dd02-tabclass <> 'TRANSP' AND ls_dd02-tabclass <> 'CLUSTER' AND ls_dd02-tabclass <> 'POOL'.
      rs_resp-status = 'error'.
      APPEND |Reading { lv_tab } stopped: it is a { ls_dd02-tabclass }, not a database table. | &&
             |Read the table it is built on (customizing_describe names it).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF is_customizing_class( ls_dd02-contflag ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Reading { lv_tab } stopped: it has delivery class '{ ls_dd02-contflag }', and this read covers | &&
             |customizing only (delivery class C, G or E). Read application data through SAP's released APIs.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF may_display( rs_resp-table ) = abap_false.
      lv_grp = auth_group( rs_resp-table ).
      rs_resp-status = 'error'.
      APPEND |Reading { lv_tab } stopped: you are not authorized to display it (S_TABU_DIS for group { lv_grp }, | &&
             |or S_TABU_NAM for the table, activity 03). Ask for the authorization, or read a table you may display.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF is_req-key_field IS NOT INITIAL.
      lv_fld = to_upper( is_req-key_field ).
      SELECT SINGLE @abap_true FROM dd03l
        WHERE tabname = @lv_tab AND fieldname = @lv_fld AND as4local = 'A'
        INTO @lv_flag.
      IF sy-subrc <> 0.
        rs_resp-status = 'error'.
        APPEND |Reading { lv_tab } stopped: it has no field { lv_fld }. | &&
               |Filter on one of its fields (customizing_describe lists them).| TO rs_resp-messages.
        RETURN.
      ENDIF.
      lv_where = |{ lv_fld } = '{ esc_quote( is_req-source_key ) }'|.
    ENDIF.

    lv_max   = clamp_rows( is_req-max_rows ).
    lv_fetch = lv_max + 1.

    TRY.
        CREATE DATA lr_tab TYPE STANDARD TABLE OF (lv_tab).
        ASSIGN lr_tab->* TO <tab>.
      CATCH cx_root INTO DATA(lx_ce).
        rs_resp-status = 'error'.
        APPEND |Cannot type table { lv_tab }: { lx_ce->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    TRY.
        IF lv_where IS NOT INITIAL.
          SELECT * FROM (lv_tab) UP TO lv_fetch ROWS
            INTO TABLE <tab>
            WHERE (lv_where)
            ORDER BY PRIMARY KEY.
        ELSE.
          SELECT * FROM (lv_tab) UP TO lv_fetch ROWS
            INTO TABLE <tab>
            ORDER BY PRIMARY KEY.
        ENDIF.
      CATCH cx_root INTO DATA(lx_sel).
        rs_resp-status = 'error'.
        APPEND |SELECT failed: { lx_sel->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    IF lines( <tab> ) > lv_max.
      lv_more = abap_true.
      lv_cut  = lv_max + 1.
      DELETE <tab> FROM lv_cut.
      APPEND |First { lv_max } rows of { lv_tab }; there are more. Narrow the filter, or raise maxRows (at most { c_read_max_rows }).|
        TO rs_resp-messages.
    ENDIF.

    " Column order from the DDIC (includes flattened), so an empty result still has columns.
    TRY.
        DATA(lo_struct) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_name( lv_tab ) ).
        lo_struct->get_ddic_field_list( RECEIVING p_field_list = lt_dfies EXCEPTIONS OTHERS = 1 ).
      CATCH cx_root.
        CLEAR lt_dfies.
    ENDTRY.
    LOOP AT lt_dfies INTO DATA(ls_dfies).
      IF lv_cols IS NOT INITIAL.
        lv_cols = lv_cols && `,`.
      ENDIF.
      lv_cols = lv_cols && |"{ ls_dfies-fieldname }"|.
    ENDLOOP.

    /ui2/cl_json=>serialize(
      EXPORTING data        = <tab>
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = lv_rows ).
    IF lv_rows IS INITIAL.
      lv_rows = `[]`.
    ENDIF.

    rs_resp-status       = 'ok'.
    rs_resp-rows_planned = lines( <tab> ).
    rs_resp-data_json    = |\{"COLUMNS":[{ lv_cols }],"ROWS":{ lv_rows },"MORE":{
                              COND string( WHEN lv_more = abap_true THEN `true` ELSE `false` ) }\}|.
  ENDMETHOD.


  METHOD handle_ddic_describe.
    DATA: lv_lang TYPE sy-langu,
          lv_grp  TYPE tddat-cclass.

    rs_resp-operation = 'ddic_describe'.
    rs_resp-table     = to_upper( is_req-table ).

    IF is_valid_name( is_req-table ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Describing stopped: '{ is_req-table }' is not a valid DDIC name. | &&
             |Give a table or maintenance view name such as T001W or V_T001W.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    lv_lang = COND #( WHEN is_req-language IS NOT INITIAL THEN to_upper( is_req-language ) ELSE 'E' ).
    DATA(ls_desc) = resolve_maint( iv_name = rs_resp-table iv_language = lv_lang ).

    IF ls_desc-root_table IS INITIAL.
      rs_resp-status = 'error'.
      APPEND |Describing { rs_resp-table } stopped: there is no active table or view of that name. | &&
             |Check the name, or find the object with img_search.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF may_display( ls_desc-root_table ) = abap_false.
      lv_grp = auth_group( ls_desc-root_table ).
      rs_resp-status = 'error'.
      APPEND |Describing { rs_resp-table } stopped: you are not authorized to display { ls_desc-root_table } | &&
             |(S_TABU_DIS for group { lv_grp }, or S_TABU_NAM for the table, activity 03). Ask for the authorization.|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    rs_resp-status = 'ok'.
    /ui2/cl_json=>serialize(
      EXPORTING data        = ls_desc
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD resolve_maint.
    TYPES: BEGIN OF ty_cand,
             len  TYPE i,
             name TYPE tabname,
           END OF ty_cand.
    DATA: lv_obj       TYPE tabname,
          lv_view      TYPE tabname,
          lv_root      TYPE tabname,
          lv_maint     TYPE tabname,
          lv_single    TYPE abap_bool,
          lv_has_maint TYPE abap_bool,
          lv_flag      TYPE abap_bool,
          lv_bastab    TYPE tvdir-bastab,
          lv_vroot     TYPE dd25l-roottab,
          lv_vcl       TYPE vclstruc-vclname,
          lv_act_name  TYPE string,
          lt_cand      TYPE STANDARD TABLE OF ty_cand WITH DEFAULT KEY,
          lt_tabs      TYPE STANDARD TABLE OF tabname WITH DEFAULT KEY,
          lt_members   TYPE STANDARD TABLE OF tabname WITH DEFAULT KEY,
          lv_primpos   TYPE dd05s-primpos,
          lt_ckeys     TYPE STANDARD TABLE OF fieldname WITH DEFAULT KEY.

    lv_obj = to_upper( iv_name ).
    rs_desc-input = lv_obj.

    " 1. Is the input itself a view?
    SELECT SINGLE viewname, roottab FROM dd25l
      WHERE viewname = @lv_obj AND as4local = 'A'
      INTO @DATA(ls_dd25).
    IF sy-subrc = 0.
      lv_view = lv_obj.
      lv_root = COND #( WHEN ls_dd25-roottab IS NOT INITIAL THEN ls_dd25-roottab ELSE lv_obj ).
      SELECT tabname FROM dd26s
        WHERE viewname = @lv_view AND as4local = 'A'
        ORDER BY tabpos
        INTO TABLE @lt_tabs.
    ELSE.
      " 2. A table: the maintenance views ROOTED on it (DD25L-ROOTTAB), shortest
      "    name first; the first of the 12 shortest that has a maintenance dialog.
      lv_root = lv_obj.
      SELECT viewname FROM dd25l
        WHERE roottab = @lv_obj AND aggtype = 'V' AND as4local = 'A'
        INTO TABLE @DATA(lt_rooted).
      LOOP AT lt_rooted INTO DATA(ls_rooted) WHERE viewname <> lv_obj.
        APPEND VALUE #( len = strlen( ls_rooted-viewname ) name = ls_rooted-viewname ) TO lt_cand.
      ENDLOOP.
      SORT lt_cand BY len name.
      DELETE ADJACENT DUPLICATES FROM lt_cand COMPARING name.
      LOOP AT lt_cand INTO DATA(ls_cand) FROM 1 TO 12.
        SELECT SINGLE @abap_true FROM tvdir WHERE tabname = @ls_cand-name INTO @lv_flag.
        IF sy-subrc = 0.
          lv_view = ls_cand-name.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_view IS NOT INITIAL.
        SELECT SINGLE roottab FROM dd25l WHERE viewname = @lv_view AND as4local = 'A' INTO @lv_vroot.
        lv_root = COND #( WHEN lv_vroot IS NOT INITIAL THEN lv_vroot ELSE lv_obj ).
        SELECT tabname FROM dd26s
          WHERE viewname = @lv_view AND as4local = 'A'
          ORDER BY tabpos
          INTO TABLE @lt_tabs.
      ELSE.
        " 3. No view: is the table its own single-table maintenance object?
        SELECT SINGLE bastab FROM tvdir WHERE tabname = @lv_obj INTO @lv_bastab.
        IF sy-subrc = 0 AND lv_bastab = abap_true.
          lv_single = abap_true.
        ENDIF.
      ENDIF.
    ENDIF.

    " A view variant (VIEWCLASS 'V') is maintained through the view it is a variant of.
    IF lv_view IS NOT INITIAL.
      SELECT SINGLE viewclass, roottab FROM dd25l
        WHERE viewname = @lv_view AND as4local = 'A'
        INTO @DATA(ls_vc).
      IF sy-subrc = 0 AND ls_vc-viewclass = 'V' AND ls_vc-roottab IS NOT INITIAL.
        SELECT SINGLE @abap_true FROM tvdir WHERE tabname = @ls_vc-roottab INTO @lv_flag.
        IF sy-subrc = 0.
          rs_desc-variant = lv_view.
          lv_view = ls_vc-roottab.
          CLEAR lv_vroot.
          SELECT SINGLE roottab FROM dd25l WHERE viewname = @lv_view AND as4local = 'A' INTO @lv_vroot.
          lv_root = COND #( WHEN lv_vroot IS NOT INITIAL THEN lv_vroot ELSE lv_view ).
          CLEAR lt_tabs.
          SELECT tabname FROM dd26s
            WHERE viewname = @lv_view AND as4local = 'A'
            ORDER BY tabpos
            INTO TABLE @lt_tabs.
        ENDIF.
      ENDIF.
    ENDIF.

    LOOP AT lt_tabs INTO DATA(lv_t).
      APPEND CONV string( lv_t ) TO rs_desc-tables.
    ENDLOOP.
    IF rs_desc-tables IS INITIAL.
      APPEND CONV string( lv_root ) TO rs_desc-tables.
    ENDIF.

    " Text table, as the DDIC defines one: the first member (not the root) whose
    " foreign key to the root table has the cardinality TEXT (DD08L-FRKART).
    LOOP AT lt_tabs INTO lv_t WHERE table_line <> lv_root.
      SELECT SINGLE @abap_true FROM dd08l
        WHERE tabname = @lv_t AND checktable = @lv_root AND frkart = 'TEXT' AND as4local = 'A'
        INTO @lv_flag.
      IF sy-subrc = 0.
        rs_desc-text_table = lv_t.
        EXIT.
      ENDIF.
    ENDLOOP.

    " Maintenance dialog (TVDIR) of the maintenance object.
    IF lv_view IS NOT INITIAL.
      lv_maint = lv_view.
    ELSEIF lv_single = abap_true.
      lv_maint = lv_obj.
    ENDIF.
    IF lv_maint IS NOT INITIAL.
      SELECT SINGLE area, type, devclass FROM tvdir WHERE tabname = @lv_maint INTO @DATA(ls_tvdir).
      IF sy-subrc = 0.
        lv_has_maint       = abap_true.
        rs_desc-func_group = ls_tvdir-area.
        rs_desc-maint_type = ls_tvdir-type.
        rs_desc-devclass   = ls_tvdir-devclass.
      ENDIF.
    ENDIF.

    " Switch Framework gating of that package, for information. SFW_PACKAGE is
    " read dynamically: a release without it still activates this class.
    IF rs_desc-devclass IS NOT INITIAL.
      TRY.
          SELECT SINGLE switch_id FROM ('SFW_PACKAGE')
            WHERE devclass = @rs_desc-devclass
            INTO @rs_desc-switch_id.
        CATCH cx_sy_dynamic_osql_error.
          CLEAR rs_desc-switch_id.
      ENDTRY.
    ENDIF.

    " View-cluster membership (VCLSTRUC); a variant counts as the member the cluster names.
    IF rs_desc-variant IS NOT INITIAL.
      APPEND CONV tabname( rs_desc-variant ) TO lt_members.
    ENDIF.
    IF lv_view IS NOT INITIAL.
      APPEND lv_view TO lt_members.
    ENDIF.
    LOOP AT lt_members INTO DATA(lv_member).
      CLEAR lv_vcl.
      SELECT SINGLE vclname FROM vclstruc WHERE object = @lv_member INTO @lv_vcl.
      IF lv_vcl IS NOT INITIAL.
        rs_desc-cluster = lv_vcl.
        EXIT.
      ENDIF.
    ENDLOOP.

    " IMG activity wiring (CUS_ACTOBJ) and its title (CUS_IMGACT).
    lv_act_name = COND #( WHEN rs_desc-cluster IS NOT INITIAL THEN rs_desc-cluster
                          WHEN lv_maint IS NOT INITIAL        THEN CONV string( lv_maint )
                          ELSE CONV string( lv_root ) ).
    SELECT SINGLE act_id, objecttype, tcode FROM cus_actobj
      WHERE objectname = @lv_act_name
      INTO @DATA(ls_act).
    IF sy-subrc = 0.
      rs_desc-img_activity = ls_act-act_id.
      rs_desc-object_type  = ls_act-objecttype.
      rs_desc-maint_tcode  = ls_act-tcode.
      SELECT SINGLE text FROM cus_imgact
        WHERE spras = @iv_language AND activity = @ls_act-act_id
        INTO @rs_desc-img_activity_text.
      IF sy-subrc <> 0 AND iv_language <> 'E'.
        SELECT SINGLE text FROM cus_imgact
          WHERE spras = 'E' AND activity = @ls_act-act_id
          INTO @rs_desc-img_activity_text.
      ENDIF.
    ENDIF.

    SELECT SINGLE cclass FROM tddat WHERE tabname = @lv_root INTO @rs_desc-auth_group.

    " What the headless write drives and records, and the official transport object.
    IF lv_has_maint = abap_true.
      rs_desc-maint_object = lv_maint.
    ENDIF.
    rs_desc-record_object = COND #( WHEN rs_desc-maint_object IS INITIAL THEN ``
                                    WHEN rs_desc-cluster IS NOT INITIAL  THEN `CDAT`
                                    WHEN lv_view IS NOT INITIAL          THEN `VDAT`
                                    ELSE `TABU` ).
    IF rs_desc-cluster IS NOT INITIAL.
      rs_desc-transport_object = `CDAT`.
      rs_desc-transport_name   = rs_desc-cluster.
    ELSEIF lv_view IS NOT INITIAL.
      rs_desc-transport_object = `VDAT`.
      rs_desc-transport_name   = lv_view.
    ELSE.
      rs_desc-transport_object = `TABU`.
      rs_desc-transport_name   = lv_root.
    ENDIF.
    rs_desc-is_view    = xsdbool( lv_view IS NOT INITIAL ).
    rs_desc-view       = lv_view.
    rs_desc-root_table = lv_root.

    " Root table: flags, text, fields with data element text and check table.
    SELECT SINGLE tabclass, contflag, clidep, mainflag FROM dd02l
      WHERE tabname = @lv_root AND as4local = 'A'
      INTO @DATA(ls_dd02).
    IF sy-subrc <> 0 AND lv_view IS INITIAL.
      CLEAR rs_desc-root_table.        " neither a view nor a table of that name
      RETURN.
    ENDIF.
    rs_desc-tabclass = ls_dd02-tabclass.
    rs_desc-contflag = ls_dd02-contflag.
    rs_desc-clidep   = ls_dd02-clidep.
    rs_desc-mainflag = ls_dd02-mainflag.
    SELECT SINGLE ddtext FROM dd02t
      WHERE tabname = @lv_root AND ddlanguage = @iv_language AND as4local = 'A'
      INTO @rs_desc-ddtext.

    SELECT fieldname, keyflag, rollname, domname, datatype, leng, decimals, position, checktable
      FROM dd03l
      WHERE tabname = @lv_root AND as4local = 'A' AND fieldname NOT LIKE '.%'
      ORDER BY position
      INTO TABLE @DATA(lt_dd03)
      UP TO @c_max_fields ROWS.
    LOOP AT lt_dd03 INTO DATA(ls_dd03).
      APPEND INITIAL LINE TO rs_desc-fields ASSIGNING FIELD-SYMBOL(<f>).
      <f>-fieldname  = ls_dd03-fieldname.
      <f>-keyflag    = ls_dd03-keyflag.
      <f>-rollname   = ls_dd03-rollname.
      <f>-domname    = ls_dd03-domname.
      <f>-datatype   = ls_dd03-datatype.
      <f>-leng       = ls_dd03-leng.
      <f>-decimals   = ls_dd03-decimals.
      <f>-position   = ls_dd03-position.
      <f>-checktable = ls_dd03-checktable.
      IF ls_dd03-rollname IS NOT INITIAL.
        SELECT SINGLE ddtext FROM dd04t
          WHERE rollname = @ls_dd03-rollname AND ddlanguage = @iv_language AND as4local = 'A'
          INTO @<f>-ddtext.
      ENDIF.
      " Check field: DD05S gives the field's position in the check table's
      " primary key (PRIMPOS); the check field is the key field at that position.
      IF ls_dd03-checktable IS NOT INITIAL AND ls_dd03-checktable <> '*'.
        CLEAR lv_primpos.
        SELECT SINGLE primpos FROM dd05s
          WHERE tabname = @lv_root AND fieldname = @ls_dd03-fieldname
            AND fortable = @lv_root AND forkey = @ls_dd03-fieldname AND as4local = 'A'
          INTO @lv_primpos.
        IF lv_primpos > 0.
          SELECT fieldname FROM dd03l
            WHERE tabname = @ls_dd03-checktable AND keyflag = 'X' AND as4local = 'A'
              AND fieldname NOT LIKE '.%'
            ORDER BY position
            INTO TABLE @lt_ckeys.
          READ TABLE lt_ckeys INDEX lv_primpos INTO DATA(lv_ckey).
          IF sy-subrc = 0.
            <f>-checkfield = lv_ckey.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDLOOP.

    DATA(ls_caps) = client_caps( ).
    rs_desc-client     = sy-mandt.
    rs_desc-cccategory = ls_caps-category.
    rs_desc-cccoractiv = ls_caps-coractiv.
    rs_desc-ccnocliind = ls_caps-nocliind.
  ENDMETHOD.


  METHOD handle_retest_scope.
    TYPES: BEGIN OF ty_key,
             tabname   TYPE dd03l-tabname,
             fieldname TYPE dd03l-fieldname,
             position  TYPE dd03l-position,
             contflag  TYPE dd02l-contflag,
           END OF ty_key,
           BEGIN OF ty_cnt,
             k TYPE string,
             n TYPE i,
           END OF ty_cnt,
           BEGIN OF ty_grp,
             cclass TYPE tddat-cclass,
             ok     TYPE abap_bool,
           END OF ty_grp,
           BEGIN OF ty_name,
             tabname TYPE tabname,
           END OF ty_name.
    DATA: ls_scope   TYPE ty_scope,
          lt_keys    TYPE STANDARD TABLE OF ty_key WITH DEFAULT KEY,
          lt_app     TYPE STANDARD TABLE OF ty_key WITH DEFAULT KEY,
          lt_cnt     TYPE STANDARD TABLE OF ty_cnt WITH DEFAULT KEY,
          lt_grp     TYPE HASHED TABLE OF ty_grp WITH UNIQUE KEY cclass,
          lt_names   TYPE STANDARD TABLE OF ty_name WITH DEFAULT KEY,
          lt_copied  TYPE string_table,
          lt_order   TYPE STANDARD TABLE OF i WITH DEFAULT KEY,
          lv_dom     TYPE dd03l-domname,
          lv_src     TYPE string,
          lv_tgt     TYPE string,
          lv_budget  TYPE i,
          lv_t0      TYPE i,
          lv_now     TYPE i,
          lv_fields  TYPE string,
          lv_where   TYPE string,
          lv_group   TYPE string,
          lv_tab     TYPE tabname,
          lv_cls     TYPE tddat-cclass,
          lv_pass    TYPE i.
    FIELD-SYMBOLS <t> TYPE ty_scope_tab.

    rs_resp-operation = 'retest_scope'.
    IF is_valid_name( is_req-org_unit ) = abap_false OR is_req-source_key IS INITIAL OR is_req-target_key IS INITIAL.
      rs_resp-status = 'error'.
      APPEND |Counting the retest scope stopped: give the org-unit domain (for example WERKS), a source key and a target key; | &&
             |got '{ is_req-org_unit }', '{ is_req-source_key }', '{ is_req-target_key }'.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_dom = to_upper( is_req-org_unit ).
    ls_scope-domain = lv_dom.
    lv_src = esc_quote( is_req-source_key ).
    lv_tgt = esc_quote( is_req-target_key ).
    lv_budget = COND #( WHEN is_req-budget_ms <= 0             THEN c_scope_default_ms
                        WHEN is_req-budget_ms > c_scope_max_ms THEN c_scope_max_ms
                        ELSE is_req-budget_ms ).
    GET RUN TIME FIELD lv_t0.

    " 1. Tables with a KEY field on the domain: client-dependent, transparent, active.
    "    Customizing and application classes separately, so neither cuts the other off.
    SELECT a~tabname, a~fieldname, a~position, b~contflag FROM dd03l AS a
      INNER JOIN dd02l AS b ON b~tabname = a~tabname AND b~as4local = a~as4local AND b~as4vers = a~as4vers
      WHERE a~domname = @lv_dom AND a~keyflag = 'X' AND a~as4local = 'A'
        AND b~tabclass = 'TRANSP' AND b~clidep = 'X' AND b~contflag IN ('C','G','E')
      ORDER BY a~tabname, a~position
      INTO TABLE @lt_keys
      UP TO @c_scope_max_candidates ROWS.
    IF lines( lt_keys ) >= c_scope_max_candidates.
      ls_scope-truncated = abap_true.
    ENDIF.
    SELECT a~tabname, a~fieldname, a~position, b~contflag FROM dd03l AS a
      INNER JOIN dd02l AS b ON b~tabname = a~tabname AND b~as4local = a~as4local AND b~as4vers = a~as4vers
      WHERE a~domname = @lv_dom AND a~keyflag = 'X' AND a~as4local = 'A'
        AND b~tabclass = 'TRANSP' AND b~clidep = 'X' AND b~contflag = 'A'
      ORDER BY a~tabname, a~position
      INTO TABLE @lt_app
      UP TO @c_scope_max_candidates ROWS.
    IF lines( lt_app ) >= c_scope_max_candidates.
      ls_scope-truncated = abap_true.
    ENDIF.
    APPEND LINES OF lt_app TO lt_keys.

    " First key field on the domain per table (each group arrives sorted by table and position).
    DATA lv_prev TYPE dd03l-tabname.
    LOOP AT lt_keys INTO DATA(ls_key).
      IF ls_key-tabname = lv_prev.
        CONTINUE.
      ENDIF.
      lv_prev = ls_key-tabname.
      IF is_valid_name( CONV string( ls_key-tabname ) ) = abap_false
      OR is_valid_name( CONV string( ls_key-fieldname ) ) = abap_false.
        CONTINUE.
      ENDIF.
      APPEND VALUE #( tab = ls_key-tabname field = ls_key-fieldname cls = ls_key-contflag ) TO ls_scope-tables.
    ENDLOOP.
    ls_scope-candidates = lines( ls_scope-tables ).

    " 2. Display authorization per table: S_TABU_DIS per group (checked once), else S_TABU_NAM.
    LOOP AT ls_scope-tables ASSIGNING <t>.
      APPEND VALUE #( tabname = <t>-tab ) TO lt_names.
    ENDLOOP.
    IF lt_names IS NOT INITIAL.
      SELECT tabname, cclass FROM tddat
        FOR ALL ENTRIES IN @lt_names
        WHERE tabname = @lt_names-tabname
        INTO TABLE @DATA(lt_tddat).
      SORT lt_tddat BY tabname.
    ENDIF.
    LOOP AT ls_scope-tables ASSIGNING <t>.
      lv_tab = <t>-tab.
      READ TABLE lt_tddat INTO DATA(ls_tddat) WITH KEY tabname = lv_tab BINARY SEARCH.
      lv_cls = COND #( WHEN sy-subrc = 0 AND ls_tddat-cclass IS NOT INITIAL THEN ls_tddat-cclass ELSE '&NC&' ).
      READ TABLE lt_grp INTO DATA(ls_grp) WITH TABLE KEY cclass = lv_cls.
      IF sy-subrc <> 0.
        AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
          ID 'DICBERCLS' FIELD lv_cls
          ID 'ACTVT'     FIELD '03'.
        ls_grp = VALUE #( cclass = lv_cls ok = xsdbool( sy-subrc = 0 ) ).
        INSERT ls_grp INTO TABLE lt_grp.
      ENDIF.
      IF ls_grp-ok = abap_false.
        AUTHORITY-CHECK OBJECT 'S_TABU_NAM'
          ID 'ACTVT' FIELD '03'
          ID 'TABLE' FIELD lv_tab.
        IF sy-subrc <> 0.
          <t>-noauth = abap_true.
        ENDIF.
      ENDIF.
    ENDLOOP.

    " 3. Order: customizing the copier leaves alone, then the copier's own tables,
    "    then application data ('customizing' / 'application' count only that part).
    IF is_req-tables_json IS NOT INITIAL.
      TRY.
          /ui2/cl_json=>deserialize( EXPORTING json = is_req-tables_json CHANGING data = lt_copied ).
        CATCH cx_root.
          CLEAR lt_copied.
      ENDTRY.
      LOOP AT lt_copied ASSIGNING FIELD-SYMBOL(<c>).
        <c> = to_upper( <c> ).
      ENDLOOP.
      SORT lt_copied.
    ENDIF.
    DO 3 TIMES.
      lv_pass = sy-index.
      IF ( is_req-only = 'application' AND lv_pass <> 3 ) OR ( is_req-only = 'customizing' AND lv_pass = 3 ).
        CONTINUE.
      ENDIF.
      LOOP AT ls_scope-tables ASSIGNING <t>.
        DATA(lv_row) = sy-tabix.
        READ TABLE lt_copied TRANSPORTING NO FIELDS WITH KEY table_line = <t>-tab BINARY SEARCH.
        DATA(lv_is_copied) = xsdbool( sy-subrc = 0 ).
        IF ( lv_pass = 1 AND <t>-cls <> 'A' AND lv_is_copied = abap_false )
        OR ( lv_pass = 2 AND lv_is_copied = abap_true )
        OR ( lv_pass = 3 AND <t>-cls = 'A' AND lv_is_copied = abap_false ).
          APPEND lv_row TO lt_order.
        ENDIF.
      ENDLOOP.
    ENDDO.

    " 4. Count until the budget is spent: eight tables per statement through the
    "    optional class ZCL_MCP_SCOPE_BATCH (a UNION ALL of eight dynamic branches,
    "    SAP_BASIS 7.50+), called dynamically so this class keeps its 7.40 floor;
    "    without it, or for a batch that fails, one table per statement (which also
    "    finds the table that cannot be read).
    TYPES: BEGIN OF ty_branch,
             f TYPE string,
             t TYPE string,
             w TYPE string,
             g TYPE string,
           END OF ty_branch.
    TYPES: BEGIN OF ty_ucnt,
             b TYPE i,
             k TYPE string,
             n TYPE i,
           END OF ty_ucnt.
    DATA: lt_pending TYPE STANDARD TABLE OF i WITH DEFAULT KEY,
          lt_ucnt    TYPE STANDARD TABLE OF ty_ucnt WITH DEFAULT KEY,
          lt_br      TYPE STANDARD TABLE OF ty_branch WITH DEFAULT KEY,
          lv_bi      TYPE i,
          lv_batched TYPE abap_bool,
          lv_batch_ok TYPE abap_bool VALUE abap_true,
          lv_any_batch TYPE abap_bool.
    DATA(lv_k_src) = condense( is_req-source_key ).
    DATA(lv_k_tgt) = condense( is_req-target_key ).
    DATA(lv_left) = lines( lt_order ).

    LOOP AT lt_order INTO DATA(lv_ix).
      lv_left = lv_left - 1.
      READ TABLE ls_scope-tables ASSIGNING <t> INDEX lv_ix.
      IF <t>-noauth = abap_true.
        <t>-counted    = abap_true.
        <t>-unreadable = abap_true.
      ELSE.
        APPEND lv_ix TO lt_pending.
      ENDIF.
      IF lines( lt_pending ) < 8 AND lv_left > 0.
        CONTINUE.
      ENDIF.
      GET RUN TIME FIELD lv_now.
      IF ( lv_now - lv_t0 ) / 1000 >= lv_budget.
        EXIT.
      ENDIF.

      CLEAR: lt_br, lv_batched.
      LOOP AT lt_pending INTO DATA(lv_p).
        lv_bi = sy-tabix.
        READ TABLE ls_scope-tables ASSIGNING <t> INDEX lv_p.
        APPEND VALUE #( f = |{ lv_bi } AS B, { <t>-field } AS K, COUNT(*) AS N|
                        t = <t>-tab
                        w = |{ <t>-field } IN ('{ lv_src }','{ lv_tgt }')|
                        g = <t>-field ) TO lt_br.
      ENDLOOP.
      IF lines( lt_br ) = 8 AND lv_batch_ok = abap_true.
        CLEAR lt_ucnt.
        TRY.
            CALL METHOD ('ZCL_MCP_SCOPE_BATCH')=>('COUNT8')
              EXPORTING it_branches = lt_br
              IMPORTING et_counts   = lt_ucnt.
            lv_batched   = abap_true.
            lv_any_batch = abap_true.
            LOOP AT lt_pending INTO lv_p.
              lv_bi = sy-tabix.
              READ TABLE ls_scope-tables ASSIGNING <t> INDEX lv_p.
              <t>-counted = abap_true.
              LOOP AT lt_ucnt INTO DATA(ls_u) WHERE b = lv_bi.
                IF condense( ls_u-k ) = lv_k_src.
                  <t>-src = ls_u-n.
                ENDIF.
                IF condense( ls_u-k ) = lv_k_tgt.
                  <t>-tgt = ls_u-n.
                ENDIF.
              ENDLOOP.
              ls_scope-counted = ls_scope-counted + 1.
            ENDLOOP.
          CATCH cx_sy_dyn_call_error.
            " Not installed (below 7.50, or not deployed): one table at a time from here on.
            lv_batch_ok = abap_false.
            lv_batched  = abap_false.
          CATCH cx_root.
            lv_batched = abap_false.
        ENDTRY.
      ENDIF.

      IF lv_batched = abap_false.
        " Fewer than eight left, or the batch failed: one table per statement.
        LOOP AT lt_pending INTO lv_p.
          READ TABLE ls_scope-tables ASSIGNING <t> INDEX lv_p.
          lv_fields = |{ <t>-field } AS K, COUNT(*) AS N|.
          lv_where  = |{ <t>-field } IN ('{ lv_src }','{ lv_tgt }')|.
          lv_group  = <t>-field.
          CLEAR lt_cnt.
          TRY.
              SELECT (lv_fields) FROM (<t>-tab)
                WHERE (lv_where)
                GROUP BY (lv_group)
                INTO CORRESPONDING FIELDS OF TABLE @lt_cnt.
              <t>-counted = abap_true.
              LOOP AT lt_cnt INTO DATA(ls_cnt).
                IF condense( ls_cnt-k ) = lv_k_src.
                  <t>-src = ls_cnt-n.
                ENDIF.
                IF condense( ls_cnt-k ) = lv_k_tgt.
                  <t>-tgt = ls_cnt-n.
                ENDIF.
              ENDLOOP.
            CATCH cx_root.
              <t>-counted    = abap_true.
              <t>-unreadable = abap_true.
          ENDTRY.
          ls_scope-counted = ls_scope-counted + 1.
        ENDLOOP.
      ENDIF.
      CLEAR lt_pending.
    ENDLOOP.

    " 5. Short texts for the tables that have rows (the ones a report lists by name).
    CLEAR lt_names.
    LOOP AT ls_scope-tables ASSIGNING <t> WHERE src > 0 OR tgt > 0.
      APPEND VALUE #( tabname = <t>-tab ) TO lt_names.
    ENDLOOP.
    IF lt_names IS NOT INITIAL.
      SELECT tabname, ddtext FROM dd02t
        FOR ALL ENTRIES IN @lt_names
        WHERE tabname = @lt_names-tabname AND ddlanguage = 'E' AND as4local = 'A'
        INTO TABLE @DATA(lt_txt).
      LOOP AT lt_txt INTO DATA(ls_txt).
        READ TABLE ls_scope-tables ASSIGNING <t> WITH KEY tab = ls_txt-tabname.
        IF sy-subrc = 0.
          <t>-text = ls_txt-ddtext.
        ENDIF.
      ENDLOOP.
    ENDIF.

    GET RUN TIME FIELD lv_now.
    ls_scope-elapsed_ms = ( lv_now - lv_t0 ) / 1000.
    ls_scope-batched    = lv_any_batch.
    rs_resp-status       = 'ok'.
    rs_resp-rows_planned = ls_scope-counted.
    /ui2/cl_json=>serialize(
      EXPORTING data        = ls_scope
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD handle_dependencies.
    TYPES: BEGIN OF ty_id,
             trkorr TYPE e070-trkorr,
           END OF ty_id,
           BEGIN OF ty_nm,
             name TYPE e071-obj_name,
           END OF ty_nm.
    DATA: lt_ids    TYPE STANDARD TABLE OF ty_id WITH DEFAULT KEY,
          lt_fam    TYPE STANDARD TABLE OF ty_id WITH DEFAULT KEY,
          lt_objs   TYPE ty_mv_obj_tt,
          lt_nm     TYPE STANDARD TABLE OF ty_nm WITH DEFAULT KEY,
          lv_id     TYPE e070-trkorr,
          lv_fetch  TYPE i.

    rs_resp-operation = 'dependencies'.
    IF may_display_transports( ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Reading the transport requests stopped: you are not authorized to display them (S_TRANSPRT, activity 03). | &&
             |Ask for the authorization.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    CASE to_upper( is_req-action ).
      WHEN 'FACTS'.
        DATA ls_facts TYPE ty_mv_facts.
        " The two numbers, their requests, and every task of those requests.
        LOOP AT VALUE string_table( ( is_req-from_trkorr ) ( is_req-to_trkorr ) ) INTO DATA(lv_in).
          IF lv_in IS INITIAL.
            CONTINUE.
          ENDIF.
          lv_id = to_upper( lv_in ).
          APPEND CONV string( lv_id ) TO ls_facts-covered.
          APPEND VALUE #( trkorr = lv_id ) TO lt_fam.
          SELECT SINGLE strkorr FROM e070 WHERE trkorr = @lv_id INTO @DATA(lv_par).
          IF sy-subrc = 0 AND lv_par IS NOT INITIAL.
            APPEND VALUE #( trkorr = lv_par ) TO lt_fam.
            APPEND CONV string( lv_par ) TO ls_facts-covered.
          ENDIF.
        ENDLOOP.
        SORT lt_fam BY trkorr.
        DELETE ADJACENT DUPLICATES FROM lt_fam COMPARING trkorr.
        lt_ids = lt_fam.
        IF lt_fam IS NOT INITIAL.
          SELECT trkorr FROM e070
            FOR ALL ENTRIES IN @lt_fam
            WHERE strkorr = @lt_fam-trkorr
            APPENDING TABLE @lt_ids.
        ENDIF.
        SORT lt_ids BY trkorr.
        DELETE ADJACENT DUPLICATES FROM lt_ids COMPARING trkorr.
        LOOP AT lt_ids INTO DATA(ls_id).
          IF NOT line_exists( ls_facts-covered[ table_line = CONV string( ls_id-trkorr ) ] ).
            APPEND CONV string( ls_id-trkorr ) TO ls_facts-covered.
          ENDIF.
        ENDLOOP.
        IF lt_ids IS NOT INITIAL.
          SELECT trkorr, trfunction, trstatus, strkorr, as4user, tarsystem FROM e070
            FOR ALL ENTRIES IN @lt_ids
            WHERE trkorr = @lt_ids-trkorr
            INTO TABLE @DATA(lt_hdr).
          SELECT trkorr, client FROM e070c
            FOR ALL ENTRIES IN @lt_ids
            WHERE trkorr = @lt_ids-trkorr
            INTO TABLE @DATA(lt_cli).
          SELECT trkorr, langu, as4text FROM e07t
            FOR ALL ENTRIES IN @lt_ids
            WHERE trkorr = @lt_ids-trkorr
            INTO TABLE @DATA(lt_txt).
          LOOP AT lt_hdr INTO DATA(ls_hdr).
            APPEND INITIAL LINE TO ls_facts-requests ASSIGNING FIELD-SYMBOL(<rq>).
            <rq>-trkorr = ls_hdr-trkorr. <rq>-trfunction = ls_hdr-trfunction. <rq>-trstatus = ls_hdr-trstatus.
            <rq>-strkorr = ls_hdr-strkorr. <rq>-as4user = ls_hdr-as4user. <rq>-tarsystem = ls_hdr-tarsystem.
            READ TABLE lt_cli INTO DATA(ls_cli) WITH KEY trkorr = ls_hdr-trkorr.
            IF sy-subrc = 0.
              <rq>-client = ls_cli-client.
            ENDIF.
            " First text found, as the server's own reading takes it.
            READ TABLE lt_txt INTO DATA(ls_txt) WITH KEY trkorr = ls_hdr-trkorr.
            IF sy-subrc = 0.
              <rq>-text = ls_txt-as4text.
            ENDIF.
          ENDLOOP.
          lv_fetch = c_mv_max_entries + 1.
          DATA lr_ids TYPE RANGE OF e071-trkorr.
          LOOP AT lt_ids INTO ls_id.
            APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_id-trkorr ) TO lr_ids.
          ENDLOOP.
          SELECT trkorr, pgmid, object, obj_name, lockflag FROM e071
            WHERE trkorr IN @lr_ids
            ORDER BY trkorr, as4pos
            INTO TABLE @DATA(lt_e071)
            UP TO @lv_fetch ROWS.
          IF lines( lt_e071 ) > c_mv_max_entries.
            ls_facts-entries_more = abap_true.
            DATA(lv_cut) = c_mv_max_entries + 1.
            DELETE lt_e071 FROM lv_cut.
          ENDIF.
          LOOP AT lt_e071 INTO DATA(ls_e).
            APPEND VALUE #( trkorr = ls_e-trkorr pgmid = ls_e-pgmid object = ls_e-object
                            obj_name = ls_e-obj_name lockflag = ls_e-lockflag ) TO ls_facts-entries.
            IF ls_e-pgmid = 'R3TR' AND ls_e-object = 'FUGR'.
              APPEND VALUE #( name = ls_e-obj_name ) TO lt_nm.
            ENDIF.
          ENDLOOP.
          " Function modules of each function group on the requests (TFDIR-PNAME = SAPL<group>).
          SORT lt_nm BY name.
          DELETE ADJACENT DUPLICATES FROM lt_nm COMPARING name.
          LOOP AT lt_nm INTO DATA(ls_nm).
            DATA(lv_pname) = CONV tfdir-pname( |SAPL{ ls_nm-name }| ).
            SELECT funcname FROM tfdir WHERE pname = @lv_pname INTO TABLE @DATA(lt_fn) UP TO 500 ROWS.
            LOOP AT lt_fn INTO DATA(ls_fn).
              APPEND VALUE #( fgroup = ls_nm-name funcname = ls_fn-funcname ) TO ls_facts-functions.
            ENDLOOP.
          ENDLOOP.
        ENDIF.
        rs_resp-status = 'ok'.
        /ui2/cl_json=>serialize( EXPORTING data = ls_facts pretty_name = /ui2/cl_json=>pretty_mode-none
                                 RECEIVING r_json = rs_resp-data_json ).

      WHEN 'WHERE_USED'.
        DATA lt_wu TYPE ty_mv_wu_tt.
        TRY.
            /ui2/cl_json=>deserialize( EXPORTING json = is_req-objects_json pretty_name = /ui2/cl_json=>pretty_mode-none
                                       CHANGING data = lt_objs ).
          CATCH cx_root.
            CLEAR lt_objs.
        ENDTRY.
        IF lines( lt_objs ) > c_mv_max_objects.
          rs_resp-status = 'error'.
          APPEND |The dependency check stopped: { lines( lt_objs ) } objects, at most { c_mv_max_objects } at a time.| TO rs_resp-messages.
          RETURN.
        ENDIF.
        LOOP AT lt_objs INTO DATA(ls_o).
          DATA(lv_name) = to_upper( ls_o-name ).
          DATA(lv_type) = to_upper( ls_o-type ).
          IF is_valid_name( lv_name ) = abap_false.
            CONTINUE.
          ENDIF.
          APPEND INITIAL LINE TO lt_wu ASSIGNING FIELD-SYMBOL(<w>).
          <w>-name = lv_name.
          " Includes of the object: a program is its own include, a function group's start with L<group>,
          " a class's or interface's are the name padded with '=' to 30 characters.
          DATA(lv_incpat) = SWITCH string( lv_type
            WHEN 'PROG' THEN lv_name
            WHEN 'FUGR' THEN |L{ lv_name }%|
            ELSE |{ lv_name }{ repeat( val = `=` occ = 30 - strlen( lv_name ) ) }%| ).
          " What it uses: WBCROSSGT names (the part before '\'), function modules (CROSS 'F') resolved to their group.
          SELECT name FROM wbcrossgt WHERE include LIKE @lv_incpat INTO TABLE @DATA(lt_wb) UP TO 1000 ROWS.
          IF lv_type = 'FUGR'.
            DATA(lv_sapl) = |SAPL{ lv_name }|.
            SELECT name FROM wbcrossgt WHERE include = @lv_sapl APPENDING TABLE @lt_wb UP TO 500 ROWS.
          ENDIF.
          LOOP AT lt_wb INTO DATA(ls_wb).
            SPLIT ls_wb-name AT '\' INTO DATA(lv_head) DATA(lv_rest).
            APPEND condense( lv_head ) TO <w>-used.
          ENDLOOP.
          SELECT name FROM cross WHERE type = 'F' AND include LIKE @lv_incpat INTO TABLE @DATA(lt_cf) UP TO 500 ROWS.
          LOOP AT lt_cf INTO DATA(ls_cf).
            IF ls_cf-name(1) <> 'Z' AND ls_cf-name(1) <> 'Y' AND ls_cf-name(1) <> '/'.
              CONTINUE.
            ENDIF.
            SELECT SINGLE pname FROM tfdir WHERE funcname = @ls_cf-name INTO @DATA(lv_fpname).
            IF sy-subrc = 0 AND lv_fpname(4) = 'SAPL'.
              APPEND CONV string( lv_fpname+4 ) TO <w>-used.
            ENDIF.
          ENDLOOP.
          SORT <w>-used.
          DELETE ADJACENT DUPLICATES FROM <w>-used.
          " What uses it: includes referring to it, and for a function group the includes calling its modules.
          DATA(lv_namepat) = |{ lv_name }\\%|.
          SELECT include FROM wbcrossgt WHERE name = @lv_name OR name LIKE @lv_namepat INTO TABLE @DATA(lt_inc) UP TO 1000 ROWS.
          IF lv_type = 'FUGR'.
            DATA(lv_gpname) = CONV tfdir-pname( |SAPL{ lv_name }| ).
            SELECT funcname FROM tfdir WHERE pname = @lv_gpname INTO TABLE @DATA(lt_gf) UP TO 500 ROWS.
            IF lt_gf IS NOT INITIAL.
              SELECT include FROM cross
                FOR ALL ENTRIES IN @lt_gf
                WHERE type = 'F' AND name = @lt_gf-funcname
                APPENDING TABLE @lt_inc.
            ENDIF.
          ENDIF.
          LOOP AT lt_inc INTO DATA(ls_inc).
            APPEND condense( CONV string( ls_inc-include ) ) TO <w>-includes.
          ENDLOOP.
          SORT <w>-includes.
          DELETE ADJACENT DUPLICATES FROM <w>-includes.
        ENDLOOP.
        rs_resp-status = 'ok'.
        /ui2/cl_json=>serialize( EXPORTING data = lt_wu pretty_name = /ui2/cl_json=>pretty_mode-none
                                 RECEIVING r_json = rs_resp-data_json ).

      WHEN 'HOLDERS'.
        DATA lt_hold TYPE ty_mv_holder_tt.
        TRY.
            /ui2/cl_json=>deserialize( EXPORTING json = is_req-objects_json pretty_name = /ui2/cl_json=>pretty_mode-none
                                       CHANGING data = lt_objs ).
          CATCH cx_root.
            CLEAR lt_objs.
        ENDTRY.
        IF lines( lt_objs ) > c_mv_max_names.
          rs_resp-status = 'error'.
          APPEND |The dependency check stopped: { lines( lt_objs ) } names, at most { c_mv_max_names } at a time.| TO rs_resp-messages.
          RETURN.
        ENDIF.
        LOOP AT lt_objs INTO ls_o.
          APPEND VALUE #( name = to_upper( ls_o-name ) ) TO lt_nm.
        ENDLOOP.
        IF lt_nm IS NOT INITIAL.
          SELECT e~obj_name, e~trkorr, h~trstatus, h~strkorr, h~as4user FROM e071 AS e
            INNER JOIN e070 AS h ON h~trkorr = e~trkorr
            FOR ALL ENTRIES IN @lt_nm
            WHERE e~pgmid = 'R3TR' AND e~obj_name = @lt_nm-name
            INTO TABLE @DATA(lt_h).
          LOOP AT lt_h INTO DATA(ls_h).
            APPEND INITIAL LINE TO lt_hold ASSIGNING FIELD-SYMBOL(<h>).
            <h>-name = ls_h-obj_name. <h>-trkorr = ls_h-trkorr. <h>-trstatus = ls_h-trstatus.
            <h>-strkorr = ls_h-strkorr. <h>-as4user = ls_h-as4user.
            IF ls_h-strkorr IS NOT INITIAL.
              SELECT SINGLE as4user FROM e070 WHERE trkorr = @ls_h-strkorr INTO @<h>-parent_user.
            ENDIF.
          ENDLOOP.
        ENDIF.
        rs_resp-status = 'ok'.
        /ui2/cl_json=>serialize( EXPORTING data = lt_hold pretty_name = /ui2/cl_json=>pretty_mode-none
                                 RECEIVING r_json = rs_resp-data_json ).

      WHEN OTHERS.
        rs_resp-status = 'error'.
        APPEND |The dependency facts stopped: ACTION must be FACTS, WHERE_USED or HOLDERS; got '{ is_req-action }'.| TO rs_resp-messages.
    ENDCASE.
  ENDMETHOD.


  METHOD dispatch_bw.
    DATA ls_err TYPE ty_response.
    TRY.
        CALL METHOD ('ZCL_MCP_BW_ENGINE')=>('HANDLE')
          EXPORTING iv_json     = iv_body
                    iv_version  = c_version
          RECEIVING rv_json     = rv_json.
        RETURN.
      CATCH cx_sy_dyn_call_error.
        APPEND |{ iv_operation } stopped: the BW part of the engine (class ZCL_MCP_BW_ENGINE) is not installed on this system. | &&
               |Install it with the engine (it is installed where BW exists), then run bw_capabilities.| TO ls_err-messages.
      CATCH cx_root INTO DATA(lx).
        APPEND |{ iv_operation } stopped: { lx->get_text( ) }| TO ls_err-messages.
    ENDTRY.
    ls_err-status    = 'error'.
    ls_err-operation = iv_operation.
    ls_err-version   = c_version.
    /ui2/cl_json=>serialize( EXPORTING data = ls_err pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rv_json ).
  ENDMETHOD.


  METHOD dispatch_abap.
    DATA ls_err TYPE ty_response.
    TRY.
        CALL METHOD ('ZCL_MCP_ABAP_ENGINE')=>('HANDLE')
          EXPORTING iv_json     = iv_body
                    iv_version  = c_version
          RECEIVING rv_json     = rv_json.
        RETURN.
      CATCH cx_sy_dyn_call_error.
        APPEND |{ iv_operation } stopped: the read-only ABAP part of the engine (class ZCL_MCP_ABAP_ENGINE) is not installed on this system. | &&
               |Install or update the engine (abapGit, transport, or customizing_engine_bootstrap).| TO ls_err-messages.
      CATCH cx_root INTO DATA(lx).
        APPEND |{ iv_operation } stopped: { lx->get_text( ) }| TO ls_err-messages.
    ENDTRY.
    ls_err-status    = 'error'.
    ls_err-operation = iv_operation.
    ls_err-version   = c_version.
    /ui2/cl_json=>serialize( EXPORTING data = ls_err pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rv_json ).
  ENDMETHOD.


  METHOD may_display_transports.
    AUTHORITY-CHECK OBJECT 'S_TRANSPRT'
      ID 'TTYPE' DUMMY
      ID 'ACTVT' FIELD '03'.
    rv_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.


  METHOD handle_transports.
    TYPES: BEGIN OF ty_hdr,
             trkorr     TYPE e070-trkorr,
             trfunction TYPE e070-trfunction,
             trstatus   TYPE e070-trstatus,
             as4user    TYPE e070-as4user,
             as4date    TYPE e070-as4date,
             tarsystem  TYPE e070-tarsystem,
           END OF ty_hdr.
    DATA: lt_hdr     TYPE STANDARD TABLE OF ty_hdr WITH DEFAULT KEY,
          lt_more    TYPE STANDARD TABLE OF ty_hdr WITH DEFAULT KEY,
          lr_status  TYPE RANGE OF e070-trstatus,
          lr_fn      TYPE RANGE OF e070-trfunction,
          lr_owner   TYPE RANGE OF e070-as4user,
          lv_tr      TYPE e070-trkorr,
          lv_owner   TYPE e070-as4user,
          lv_fetch   TYPE i,
          lv_more    TYPE abap_bool,
          lv_off     TYPE i,
          lv_char    TYPE c LENGTH 1,
          lt_reqs    TYPE ty_tr_req_tt.

    rs_resp-operation = 'transports'.
    IF may_display_transports( ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Listing transport requests stopped: you are not authorized to display them (S_TRANSPRT, activity 03). | &&
             |Ask for the authorization.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Statuses (default modifiable: D, L) and kinds (default K, W, T, C), one character each.
    DATA(lv_st) = COND string( WHEN is_req-statuses IS NOT INITIAL THEN to_upper( is_req-statuses ) ELSE `DL` ).
    DO strlen( lv_st ) TIMES.
      lv_off = sy-index - 1.
      lv_char = lv_st+lv_off(1).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_char ) TO lr_status.
    ENDDO.
    DATA(lv_fns) = COND string( WHEN is_req-trfunction IS NOT INITIAL THEN to_upper( is_req-trfunction ) ELSE `KWTC` ).
    DO strlen( lv_fns ) TIMES.
      lv_off = sy-index - 1.
      lv_char = lv_fns+lv_off(1).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_char ) TO lr_fn.
    ENDDO.
    IF is_req-owner IS NOT INITIAL.
      lv_owner = to_upper( is_req-owner ).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_owner ) TO lr_owner.
    ENDIF.
    lv_fetch = c_tr_max_requests + 1.

    IF is_req-transport IS NOT INITIAL.
      " One request; a task gives its request.
      lv_tr = to_upper( is_req-transport ).
      SELECT SINGLE strkorr FROM e070 WHERE trkorr = @lv_tr INTO @DATA(lv_parent).
      IF sy-subrc = 0.
        IF lv_parent IS NOT INITIAL.
          lv_tr = lv_parent.
        ENDIF.
        SELECT trkorr, trfunction, trstatus, as4user, as4date, tarsystem FROM e070
          WHERE trkorr = @lv_tr
          INTO CORRESPONDING FIELDS OF TABLE @lt_hdr.
      ENDIF.
    ELSE.
      SELECT trkorr, trfunction, trstatus, as4user, as4date, tarsystem FROM e070
        WHERE strkorr = @space AND trstatus IN @lr_status AND trfunction IN @lr_fn AND as4user IN @lr_owner
        ORDER BY trkorr DESCENDING
        INTO CORRESPONDING FIELDS OF TABLE @lt_hdr
        UP TO @lv_fetch ROWS.
      " A lead's request the user works in: the user owns a task under it.
      IF lv_owner IS NOT INITIAL AND is_req-owner_tasks = abap_true.
        SELECT DISTINCT strkorr FROM e070
          WHERE as4user = @lv_owner AND strkorr <> @space AND trstatus IN @lr_status
          INTO TABLE @DATA(lt_parents).
        IF lt_parents IS NOT INITIAL.
          SELECT trkorr, trfunction, trstatus, as4user, as4date, tarsystem FROM e070
            FOR ALL ENTRIES IN @lt_parents
            WHERE trkorr = @lt_parents-strkorr AND trstatus IN @lr_status AND trfunction IN @lr_fn
            INTO CORRESPONDING FIELDS OF TABLE @lt_more.
          LOOP AT lt_more INTO DATA(ls_more).
            IF NOT line_exists( lt_hdr[ trkorr = ls_more-trkorr ] ).
              APPEND ls_more TO lt_hdr.
            ENDIF.
          ENDLOOP.
        ENDIF.
      ENDIF.
      SORT lt_hdr BY trkorr DESCENDING.
    ENDIF.

    IF lt_hdr IS INITIAL.
      rs_resp-status    = 'ok'.
      rs_resp-data_json = `[]`.
      RETURN.
    ENDIF.

    " Client each request was created in (E070C); filter on it when asked.
    SELECT trkorr, client FROM e070c
      FOR ALL ENTRIES IN @lt_hdr
      WHERE trkorr = @lt_hdr-trkorr
      INTO TABLE @DATA(lt_cli).
    IF is_req-client IS NOT INITIAL.
      LOOP AT lt_cli INTO DATA(ls_cli) WHERE client IS NOT INITIAL AND client <> is_req-client.
        DELETE lt_hdr WHERE trkorr = ls_cli-trkorr.
      ENDLOOP.
    ENDIF.

    IF lines( lt_hdr ) > c_tr_max_requests.
      lv_more = abap_true.
      lv_off  = c_tr_max_requests + 1.
      DELETE lt_hdr FROM lv_off.
      APPEND |First { c_tr_max_requests } requests, newest first; there are more. Narrow by owner or status.| TO rs_resp-messages.
    ENDIF.
    IF lt_hdr IS INITIAL.
      rs_resp-status    = 'ok'.
      rs_resp-data_json = `[]`.
      RETURN.
    ENDIF.

    SELECT trkorr, langu, as4text FROM e07t
      FOR ALL ENTRIES IN @lt_hdr
      WHERE trkorr = @lt_hdr-trkorr
      INTO TABLE @DATA(lt_txt).
    SELECT trkorr, strkorr, as4user, trfunction, trstatus FROM e070
      FOR ALL ENTRIES IN @lt_hdr
      WHERE strkorr = @lt_hdr-trkorr
      INTO TABLE @DATA(lt_tasks).
    SORT lt_tasks BY strkorr trkorr.

    LOOP AT lt_hdr INTO DATA(ls_hdr).
      DATA(lv_idx) = sy-tabix.
      APPEND INITIAL LINE TO lt_reqs ASSIGNING FIELD-SYMBOL(<r>).
      <r>-trkorr     = ls_hdr-trkorr.
      <r>-trfunction = ls_hdr-trfunction.
      <r>-trstatus   = ls_hdr-trstatus.
      <r>-as4user    = ls_hdr-as4user.
      <r>-as4date    = ls_hdr-as4date.
      <r>-tarsystem  = ls_hdr-tarsystem.
      READ TABLE lt_cli INTO ls_cli WITH KEY trkorr = ls_hdr-trkorr.
      IF sy-subrc = 0.
        <r>-client = ls_cli-client.
      ENDIF.
      " Text: English when there, else any language (as the server's listing does).
      LOOP AT lt_txt INTO DATA(ls_txt) WHERE trkorr = ls_hdr-trkorr.
        IF <r>-text IS INITIAL OR ls_txt-langu = 'E'.
          <r>-text = ls_txt-as4text.
        ENDIF.
      ENDLOOP.
      LOOP AT lt_tasks INTO DATA(ls_task) WHERE strkorr = ls_hdr-trkorr.
        APPEND VALUE #( trkorr = ls_task-trkorr as4user = ls_task-as4user
                        trfunction = ls_task-trfunction trstatus = ls_task-trstatus ) TO <r>-tasks.
      ENDLOOP.

      IF is_req-with_objects = abap_true AND lv_idx <= c_tr_max_with_obj.
        DATA lr_keys TYPE RANGE OF e071-trkorr.
        CLEAR lr_keys.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_hdr-trkorr ) TO lr_keys.
        LOOP AT <r>-tasks INTO DATA(ls_t).
          APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_t-trkorr ) TO lr_keys.
        ENDLOOP.
        DATA(lv_ofetch) = c_tr_max_objects + 1.
        SELECT DISTINCT pgmid, object, obj_name FROM e071
          WHERE trkorr IN @lr_keys
          ORDER BY pgmid, object, obj_name
          INTO TABLE @DATA(lt_obj)
          UP TO @lv_ofetch ROWS.
        IF lines( lt_obj ) > c_tr_max_objects.
          <r>-objects_more = abap_true.
          lv_off = c_tr_max_objects + 1.
          DELETE lt_obj FROM lv_off.
        ENDIF.
        LOOP AT lt_obj INTO DATA(ls_obj).
          APPEND VALUE #( pgmid = ls_obj-pgmid object = ls_obj-object obj_name = ls_obj-obj_name ) TO <r>-objects.
        ENDLOOP.
      ENDIF.
    ENDLOOP.

    rs_resp-status       = 'ok'.
    rs_resp-rows_planned = lines( lt_reqs ).
    /ui2/cl_json=>serialize(
      EXPORTING data        = lt_reqs
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD handle_transport_info.
    DATA: ls_info    TYPE ty_tr_info,
          lv_type    TYPE tadir-object,
          lv_name    TYPE tadir-obj_name,
          lv_pat     TYPE e071-obj_name,
          lv_target  TYPE tcerele-consys,
          lv_layer   TYPE tcetral-translayer,
          lv_dev     TYPE tdevc-devclass.

    rs_resp-operation = 'transport_info'.
    IF may_display_transports( ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Reading the transport information stopped: you are not authorized to display transport requests | &&
             |(S_TRANSPRT, activity 03). Ask for the authorization.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    ls_info-pgmid    = COND #( WHEN is_req-pgmid IS NOT INITIAL THEN to_upper( is_req-pgmid ) ELSE `R3TR` ).
    ls_info-obj_type = to_upper( is_req-obj_type ).
    ls_info-obj_name = to_upper( is_req-obj_name ).
    IF ls_info-pgmid <> 'R3TR' OR strlen( ls_info-obj_type ) <> 4 OR ls_info-obj_name IS INITIAL
    OR strlen( ls_info-obj_name ) > 120.
      rs_resp-status = 'error'.
      APPEND |Reading the transport information stopped: give an object as R3TR, a four-letter type and a name | &&
             |(for example R3TR PROG ZREPORT); got '{ ls_info-pgmid } { ls_info-obj_type } { ls_info-obj_name }'.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_type = ls_info-obj_type.
    lv_name = ls_info-obj_name.

    " Package, and whether its changes are recorded (KORRFLAG; a $ package never records).
    SELECT SINGLE devclass FROM tadir
      WHERE pgmid = 'R3TR' AND object = @lv_type AND obj_name = @lv_name
      INTO @lv_dev.
    ls_info-exists = xsdbool( sy-subrc = 0 ).
    ls_info-devclass = lv_dev.
    IF lv_dev IS NOT INITIAL.
      SELECT SINGLE korrflag, pdevclass FROM tdevc WHERE devclass = @lv_dev INTO @DATA(ls_dev).
      ls_info-records = xsdbool( ls_dev-korrflag = abap_true AND lv_dev(1) <> '$' ).
      SELECT SINGLE ctext FROM tdevct WHERE devclass = @lv_dev AND spras = @sy-langu INTO @ls_info-ctext.
      IF sy-subrc <> 0.
        SELECT SINGLE ctext FROM tdevct WHERE devclass = @lv_dev AND spras = 'E' INTO @ls_info-ctext.
      ENDIF.
      IF ls_info-records = abap_true AND fm_exists( 'TR_GET_TRANSPORT_TARGET' ) = abap_true.
        CALL FUNCTION 'TR_GET_TRANSPORT_TARGET'
          EXPORTING
            iv_development_class = lv_dev
          IMPORTING
            ev_target            = lv_target
            ev_layer             = lv_layer
          EXCEPTIONS
            OTHERS               = 1.
        IF sy-subrc = 0.
          ls_info-target          = lv_target.
          ls_info-transport_layer = lv_layer.
        ENDIF.
      ENDIF.
    ENDIF.

    " The open request holding it: an open task or request whose object list has
    " it (for a class also its LIMU parts, which carry the class name first).
    SELECT e~trkorr, h~strkorr, h~as4user FROM e071 AS e
      INNER JOIN e070 AS h ON h~trkorr = e~trkorr
      WHERE e~pgmid = 'R3TR' AND e~object = @lv_type AND e~obj_name = @lv_name
        AND h~trstatus IN ('D','L')
      INTO TABLE @DATA(lt_lock).
    IF lt_lock IS INITIAL AND ( lv_type = 'CLAS' OR lv_type = 'INTF' ).
      lv_pat = |{ lv_name }%|.
      SELECT e~trkorr, h~strkorr, h~as4user FROM e071 AS e
        INNER JOIN e070 AS h ON h~trkorr = e~trkorr
        WHERE e~pgmid = 'LIMU' AND e~obj_name LIKE @lv_pat
          AND h~trstatus IN ('D','L')
        INTO TABLE @lt_lock.
    ENDIF.
    READ TABLE lt_lock INTO DATA(ls_lock) INDEX 1.
    IF sy-subrc = 0.
      IF ls_lock-strkorr IS NOT INITIAL.
        ls_info-lock_request = ls_lock-strkorr.
        ls_info-lock_task    = ls_lock-trkorr.
      ELSE.
        ls_info-lock_request = ls_lock-trkorr.
      ENDIF.
      ls_info-lock_user = ls_lock-as4user.
    ENDIF.

    " The user's open workbench requests (own, or with an own task) to the package's target.
    IF ls_info-records = abap_true.
      SELECT trkorr, as4user, tarsystem FROM e070
        WHERE strkorr = @space AND trfunction = 'K' AND trstatus = 'D' AND as4user = @sy-uname
        INTO TABLE @DATA(lt_req).
      SELECT DISTINCT strkorr FROM e070
        WHERE as4user = @sy-uname AND strkorr <> @space AND trstatus = 'D'
        INTO TABLE @DATA(lt_par).
      IF lt_par IS NOT INITIAL.
        SELECT trkorr, as4user, tarsystem FROM e070
          FOR ALL ENTRIES IN @lt_par
          WHERE trkorr = @lt_par-strkorr AND trfunction = 'K' AND trstatus = 'D'
          APPENDING TABLE @lt_req.
      ENDIF.
      SORT lt_req BY trkorr DESCENDING.
      DELETE ADJACENT DUPLICATES FROM lt_req COMPARING trkorr.
      LOOP AT lt_req INTO DATA(ls_req).
        IF lv_target IS NOT INITIAL AND ls_req-tarsystem <> lv_target
        AND NOT ls_req-tarsystem CP |{ lv_target }.*|.
          CONTINUE.
        ENDIF.
        APPEND INITIAL LINE TO ls_info-requests ASSIGNING FIELD-SYMBOL(<q>).
        <q>-trkorr     = ls_req-trkorr.
        <q>-as4user    = ls_req-as4user.
        <q>-tarsystem  = ls_req-tarsystem.
        <q>-trfunction = 'K'.
        <q>-trstatus   = 'D'.
        SELECT SINGLE as4text FROM e07t WHERE trkorr = @ls_req-trkorr AND langu = 'E' INTO @<q>-text.
        IF sy-subrc <> 0.
          SELECT SINGLE as4text FROM e07t WHERE trkorr = @ls_req-trkorr INTO @<q>-text.
        ENDIF.
        IF lines( ls_info-requests ) >= c_tr_max_with_obj.
          EXIT.
        ENDIF.
      ENDLOOP.
    ENDIF.

    rs_resp-status = 'ok'.
    /ui2/cl_json=>serialize(
      EXPORTING data        = ls_info
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD may_display.
    DATA lv_name  TYPE tabname.
    DATA lv_group TYPE tddat-cclass.
    lv_group = auth_group( iv_table ).
    AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
      ID 'DICBERCLS' FIELD lv_group
      ID 'ACTVT'     FIELD '03'.
    IF sy-subrc = 0.
      rv_ok = abap_true.
      RETURN.
    ENDIF.
    lv_name = to_upper( iv_table ).
    AUTHORITY-CHECK OBJECT 'S_TABU_NAM'
      ID 'ACTVT' FIELD '03'
      ID 'TABLE' FIELD lv_name.
    rv_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.


  METHOD clamp_rows.
    rv_rows = COND #( WHEN iv_requested <= 0               THEN c_read_default_rows
                      WHEN iv_requested > c_read_max_rows  THEN c_read_max_rows
                      ELSE iv_requested ).
  ENDMETHOD.


  METHOD is_customizing_class.
    rv_ok = xsdbool( iv_contflag = 'C' OR iv_contflag = 'G' OR iv_contflag = 'E' ).
  ENDMETHOD.


  METHOD handle_write.
    DATA: lr_src      TYPE REF TO data,
          lr_tgt      TYPE REF TO data,
          lr_plan     TYPE REF TO data,
          lr_new      TYPE REF TO data,
          lr_one      TYPE REF TO data,
          lv_where    TYPE string,
          lv_flag     TYPE dd02l-contflag,
          lv_nk       TYPE trobj_name,
          lt_tgt_keys TYPE ty_tabkey_tt.
    FIELD-SYMBOLS: <src>  TYPE STANDARD TABLE,
                   <tgt>  TYPE STANDARD TABLE,
                   <plan> TYPE STANDARD TABLE,
                   <row>  TYPE any,
                   <new>  TYPE any,
                   <one>  TYPE any,
                   <t>    TYPE any,
                   <key>  TYPE any.

    rs_resp-operation = 'write'.
    rs_resp-table     = is_req-table.
    rs_resp-transport = is_req-transport.
    rs_resp-dry_run   = COND #( WHEN is_req-commit = abap_true
                                THEN abap_false ELSE abap_true ).

    " ── Guard rails ─────────────────────────────────────────────────────────
    IF is_valid_name( is_req-table ) = abap_false
    OR is_valid_name( is_req-key_field ) = abap_false.
      rs_resp-status = 'error'.
      APPEND 'Invalid table or key field name' TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF is_req-source_key IS INITIAL OR is_req-target_key IS INITIAL.
      rs_resp-status = 'error'.
      APPEND 'SOURCE_KEY and TARGET_KEY are both required' TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Delivery class is needed only for the dry-run wording here; the full
    " routing/auth/transport logic now lives in commit_plan (shared with
    " handle_create) and runs at commit time.
    lv_flag = delivery_class( is_req-table ).

    " ── Read source + target ────────────────────────────────────────────────
    TRY.
        CREATE DATA lr_src  TYPE STANDARD TABLE OF (is_req-table).
        CREATE DATA lr_tgt  TYPE STANDARD TABLE OF (is_req-table).
        CREATE DATA lr_plan TYPE STANDARD TABLE OF (is_req-table).
        ASSIGN lr_src->*  TO <src>.
        ASSIGN lr_tgt->*  TO <tgt>.
        ASSIGN lr_plan->* TO <plan>.
      CATCH cx_root INTO DATA(lx_ce).
        rs_resp-status = 'error'.
        APPEND |Cannot type table { is_req-table }: { lx_ce->get_text( ) }|
          TO rs_resp-messages.
        RETURN.
    ENDTRY.

    lv_where = |{ is_req-key_field } = '{ esc_quote( is_req-source_key ) }'|.
    SELECT * FROM (is_req-table) INTO TABLE <src> WHERE (lv_where).
    lv_where = |{ is_req-key_field } = '{ esc_quote( is_req-target_key ) }'|.
    SELECT * FROM (is_req-table) INTO TABLE <tgt> WHERE (lv_where).

    " Field overrides: VALUES_JSON = [{"FIELD":"NAME1","VALUE":"…"},…] is
    " applied to every planned row after the key swap, so a copy lands with
    " corrected values; with SOURCE_KEY = TARGET_KEY and ONLY_MISSING='' this
    " patches an existing row in place through the same recorded write path.
    DATA lt_overrides TYPE ty_field_value_tt.
    IF is_req-values_json IS NOT INITIAL.
      TRY.
          /ui2/cl_json=>deserialize(
            EXPORTING json        = is_req-values_json
                      pretty_name = /ui2/cl_json=>pretty_mode-none
            CHANGING  data        = lt_overrides ).
        CATCH cx_root INTO DATA(lx_vj).
          rs_resp-status = 'error'.
          APPEND |Cannot parse VALUES_JSON: { lx_vj->get_text( ) }| TO rs_resp-messages.
          RETURN.
      ENDTRY.
      LOOP AT lt_overrides INTO DATA(ls_chk).
        IF is_valid_name( ls_chk-field ) = abap_false.
          rs_resp-status = 'error'.
          APPEND |Invalid override field name '{ ls_chk-field }'| TO rs_resp-messages.
          RETURN.
        ENDIF.
      ENDLOOP.
    ENDIF.

    " ── Build the plan ──────────────────────────────────────────────────────
    " Pre-compute the KEY of every existing target row, so only_missing can skip
    " by key (not by full-row equality — that would clobber target rows whose
    " non-key values differ).  Keys are built with the same DDIC-aware builder
    " used for transport recording, so the comparison is exact.
    IF is_req-only_missing = abap_true.
      LOOP AT <tgt> ASSIGNING <t>.
        CREATE DATA lr_one LIKE <t>.
        ASSIGN lr_one->* TO <one>.
        <one> = <t>.
        APPEND build_tabkey( iv_table = is_req-table ir_row = lr_one ) TO lt_tgt_keys.
      ENDLOOP.
    ENDIF.

    LOOP AT <src> ASSIGNING <row>.
      CREATE DATA lr_new LIKE LINE OF <plan>.
      ASSIGN lr_new->* TO <new>.
      <new> = <row>.

      ASSIGN COMPONENT is_req-key_field OF STRUCTURE <new> TO <key>.
      IF sy-subrc <> 0.
        rs_resp-status = 'error'.
        APPEND |Key field { is_req-key_field } not found in { is_req-table }|
          TO rs_resp-messages.
        RETURN.
      ENDIF.
      <key> = is_req-target_key.

      LOOP AT lt_overrides INTO DATA(ls_ov).
        ASSIGN COMPONENT to_upper( ls_ov-field ) OF STRUCTURE <new>
          TO FIELD-SYMBOL(<ov>).
        IF sy-subrc <> 0.
          rs_resp-status = 'error'.
          APPEND |Override field { ls_ov-field } not found in { is_req-table }|
            TO rs_resp-messages.
          RETURN.
        ENDIF.
        TRY.
            <ov> = ls_ov-value.
          CATCH cx_root.
            rs_resp-status = 'error'.
            APPEND |Override { ls_ov-field } = '{ ls_ov-value }' does not convert to the field type|
              TO rs_resp-messages.
            RETURN.
        ENDTRY.
      ENDLOOP.

      IF is_req-only_missing = abap_true.
        " Key-only existence check: skip if the target already has this key.
        CREATE DATA lr_one LIKE <new>.
        ASSIGN lr_one->* TO <one>.
        <one> = <new>.
        lv_nk = build_tabkey( iv_table = is_req-table ir_row = lr_one ).
        READ TABLE lt_tgt_keys TRANSPORTING NO FIELDS
          WITH KEY table_line = lv_nk.
        IF sy-subrc = 0.
          CONTINUE.
        ENDIF.
      ENDIF.

      APPEND <new> TO <plan>.
    ENDLOOP.

    rs_resp-rows_planned = lines( <plan> ).

    " ── Dry run ─────────────────────────────────────────────────────────────
    IF is_req-commit = abap_false.
      rs_resp-status = 'ok'.
      IF lv_flag = 'A'.
        APPEND |DRY RUN — { rs_resp-rows_planned } row(s) planned (class A: direct write, no transport)|
          TO rs_resp-messages.
      ELSE.
        APPEND |DRY RUN — { rs_resp-rows_planned } row(s) planned|
          TO rs_resp-messages.
      ENDIF.
      /ui2/cl_json=>serialize(
        EXPORTING data        = <plan>
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        RECEIVING r_json      = rs_resp-data_json ).
      RETURN.
    ENDIF.

    " ── Commit ──────────────────────────────────────────────────────────────
    IF rs_resp-rows_planned = 0.
      rs_resp-status = 'ok'.
      APPEND 'Nothing to write — target already complete' TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Shared commit machinery (routing, auth, transport resolution, recorded
    " batch-job write or direct MODIFY). Same path used by handle_create.
    commit_plan( EXPORTING is_req  = is_req
                           ir_plan = lr_plan
                 CHANGING  cs_resp = rs_resp ).
  ENDMETHOD.


  METHOD commit_plan.
    " Writes the already-built plan in IR_PLAN (a table typed as IS_REQ-TABLE)
    " through the recorded view runtime (C/G/E in a recording client) or a direct
    " MODIFY (class A, a non-recording client, or RECORD_TRANSPORT=false). Sets
    " CS_RESP status/rows_written/transport and appends messages. Assumes the
    " caller already handled dry-run and the empty-plan case.
    DATA: lr_one TYPE REF TO data,
          lv_grp TYPE tddat-cclass,
          lv_enq TYPE rstable-tabname,
          lv_flag TYPE dd02l-contflag,
          lt_keys TYPE ty_tabkey_tt.
    FIELD-SYMBOLS: <plan> TYPE STANDARD TABLE,
                   <row>  TYPE any,
                   <one>  TYPE any.

    ASSIGN ir_plan->* TO <plan>.

    " ── Delivery-class routing + client capability ───────────────────────────
    lv_flag = delivery_class( is_req-table ).
    DATA lv_do_record TYPE abap_bool.
    DATA lv_cl_norecord TYPE abap_bool.
    DATA lv_autocreate TYPE abap_bool.
    CASE lv_flag.
      WHEN 'C' OR 'G' OR 'E'.
        lv_do_record = COND abap_bool(
          WHEN is_req-record_transport = abap_false THEN abap_false ELSE abap_true ).
        eval_client_change(
          EXPORTING iv_table   = is_req-table
          IMPORTING ev_blocked = DATA(lv_cl_blocked)
                    ev_records = DATA(lv_cl_records)
                    ev_reason  = DATA(lv_cl_reason) ).
        IF lv_cl_blocked = abap_true.
          cs_resp-status = 'error'.
          APPEND lv_cl_reason TO cs_resp-messages.
          RETURN.
        ENDIF.
        IF lv_do_record = abap_true AND lv_cl_records = abap_false.
          IF is_req-transport IS NOT INITIAL.
            cs_resp-status = 'error'.
            APPEND |{ lv_cl_reason } — omit TRANSPORT| TO cs_resp-messages.
            RETURN.
          ENDIF.
          lv_cl_norecord = abap_true.
          APPEND lv_cl_reason TO cs_resp-messages.
        ENDIF.
        lv_autocreate = COND abap_bool(
          WHEN lv_do_record = abap_true AND lv_cl_norecord = abap_false
                                        AND is_req-transport IS INITIAL
                                        AND is_req-create_transport = abap_true
          THEN abap_true ELSE abap_false ).
        IF lv_do_record = abap_true AND lv_cl_norecord = abap_false
                                    AND is_req-transport IS INITIAL
                                    AND is_req-create_transport = abap_false.
          cs_resp-status = 'error'.
          APPEND 'No TRANSPORT supplied. Record into an existing open request (preferred), or set CREATE_TRANSPORT=X to mint a new Customizing request.'
            TO cs_resp-messages.
          RETURN.
        ENDIF.
        IF lv_do_record = abap_false AND is_req-transport IS NOT INITIAL.
          cs_resp-status = 'error'.
          APPEND 'TRANSPORT must be omitted when RECORD_TRANSPORT=false (direct-write mode)'
            TO cs_resp-messages.
          RETURN.
        ENDIF.
      WHEN 'A'.
        IF is_req-transport IS NOT INITIAL.
          cs_resp-status = 'error'.
          APPEND |{ is_req-table } is delivery class A: TRANSPORT not applicable — omit it|
            TO cs_resp-messages.
          RETURN.
        ENDIF.
        lv_do_record = abap_false.
      WHEN 'S' OR 'W' OR 'L'.
        cs_resp-status = 'error'.
        APPEND |Delivery class '{ lv_flag }': system/temp/local tables are not supported|
          TO cs_resp-messages.
        RETURN.
      WHEN OTHERS.
        cs_resp-status = 'error'.
        APPEND |Delivery class '{ lv_flag }': C/G/E/A supported; S/W/L refused|
          TO cs_resp-messages.
        RETURN.
    ENDCASE.

    lv_grp = auth_group( is_req-table ).
    AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
      ID 'DICBERCLS' FIELD lv_grp
      ID 'ACTVT'     FIELD '02'.
    IF sy-subrc <> 0.
      cs_resp-status = 'error'.
      APPEND |Not authorized: S_TABU_DIS / { lv_grp } / 02|
        TO cs_resp-messages.
      RETURN.
    ENDIF.

    " Build tabkeys for all planned rows (needed for both paths)
    LOOP AT <plan> ASSIGNING <row>.
      CREATE DATA lr_one LIKE <row>.
      ASSIGN lr_one->* TO <one>.
      <one> = <row>.
      APPEND build_tabkey( iv_table = is_req-table ir_row = lr_one ) TO lt_keys.
    ENDLOOP.

    IF lv_do_record = abap_true.
      " ── Batch-job path: job handles ENQUEUE/TR_OBJECTS_INSERT/MODIFY/COMMIT ──
      DATA(ls_wreq) = is_req.
      DATA: lv_utask    TYPE trkorr,
            lv_ureq     TYPE trkorr,
            lv_tcreated TYPE abap_bool,
            lv_tmsg     TYPE string.
      IF lv_autocreate = abap_true.
        DATA(lv_tr_text) = COND as4text(
          WHEN is_req-transport_text IS NOT INITIAL
            THEN CONV as4text( is_req-transport_text )
          WHEN is_req-source_key IS NOT INITIAL
            THEN |MCP cust { is_req-table } { is_req-source_key }->{ is_req-target_key }|
          ELSE |MCP cust create { is_req-table }| ).
        create_cust_transport(
          EXPORTING iv_text    = lv_tr_text
          IMPORTING ev_request = DATA(lv_req)
                    ev_task    = DATA(lv_task) ).
        IF lv_req IS INITIAL.
          cs_resp-status = 'error'.
          APPEND 'Could not create a Customizing request (TR_INSERT_REQUEST_WITH_TASKS failed)'
            TO cs_resp-messages.
          RETURN.
        ENDIF.
        ls_wreq-transport = lv_task.
        cs_resp-transport = lv_req.
        APPEND |Created Customizing request { lv_req } (task { lv_task })| TO cs_resp-messages.

      ELSEIF is_req-transport IS NOT INITIAL.
        ensure_user_task(
          EXPORTING iv_transport = CONV trkorr( is_req-transport )
          IMPORTING ev_task      = lv_utask
                    ev_request   = lv_ureq
                    ev_created   = lv_tcreated
                    ev_msg       = lv_tmsg ).
        IF lv_tmsg IS NOT INITIAL.
          cs_resp-status = 'error'.
          APPEND lv_tmsg TO cs_resp-messages.
          RETURN.
        ENDIF.
        ls_wreq-transport = lv_utask.
        cs_resp-transport = lv_ureq.
        IF lv_tcreated = abap_true.
          APPEND |Created customizing task { lv_utask } for { sy-uname } under request { lv_ureq }|
            TO cs_resp-messages.
        ENDIF.
      ENDIF.

      DATA ls_br TYPE ty_batch_result.
      CALL METHOD me->submit_batch_write
        EXPORTING
          is_req    = ls_wreq
          ir_plan   = ir_plan
          it_keys   = lt_keys
        CHANGING
          ct_messages = cs_resp-messages
        RECEIVING
          rs_res    = ls_br.

      IF ls_br-pending = abap_true.
        cs_resp-status = 'pending'.
        cs_resp-run_id = ls_br-run_id.
        APPEND |Job submitted — run_id { ls_br-run_id } (poll customizing_status)|
          TO cs_resp-messages.
      ELSEIF ls_br-ok = abap_true.
        cs_resp-status       = 'ok'.
        cs_resp-rows_written = ls_br-rows_written.
        IF lv_cl_norecord = abap_true.
          APPEND |Written { ls_br-rows_written } row(s) via the view runtime (client { sy-mandt } records no transport)|
            TO cs_resp-messages.
        ELSE.
          APPEND |Written { ls_br-rows_written } row(s) → { cs_resp-transport } ({ ls_br-e071k_count } E071K entries)|
            TO cs_resp-messages.
        ENDIF.
      ELSE.
        cs_resp-status = 'error'.
      ENDIF.
    ELSE.
      " ── Direct-write path: class A or explicit RECORD_TRANSPORT=false ────────
      lv_enq = to_upper( is_req-table ).
      CALL FUNCTION 'ENQUEUE_E_TABLE'
        EXPORTING
          mode_rstable = 'E'
          tabname      = lv_enq
        EXCEPTIONS
          foreign_lock   = 1
          system_failure = 2
          OTHERS         = 3.
      IF sy-subrc <> 0.
        cs_resp-status = 'error'.
        APPEND |ENQUEUE failed for { is_req-table } (subrc { sy-subrc })|
          TO cs_resp-messages.
        RETURN.
      ENDIF.

      TRY.
          MODIFY (is_req-table) FROM TABLE <plan>.
          cs_resp-rows_written = sy-dbcnt.
          COMMIT WORK AND WAIT.
          cs_resp-status = 'ok'.
          APPEND |Written { cs_resp-rows_written } row(s) (direct, no transport)|
            TO cs_resp-messages.
        CATCH cx_root INTO DATA(lx_wr).
          ROLLBACK WORK.
          cs_resp-status = 'error'.
          APPEND |Commit failed: { lx_wr->get_text( ) }| TO cs_resp-messages.
      ENDTRY.

      CALL FUNCTION 'DEQUEUE_E_TABLE'
        EXPORTING mode_rstable = 'E' tabname = lv_enq.
    ENDIF.
  ENDMETHOD.


  METHOD handle_create.
    " Build a plan of rows from explicit field/value maps (full key, no source)
    " and commit it through the shared commit_plan path. Supports composite keys
    " and distinct per-row values — what the single-key copy (handle_write) can't.
    DATA: lr_plan TYPE REF TO data,
          lr_new  TYPE REF TO data,
          lv_flag TYPE dd02l-contflag.
    FIELD-SYMBOLS: <plan> TYPE STANDARD TABLE,
                   <new>  TYPE any,
                   <fld>  TYPE any.

    " rows_json = JSON array of rows; each row a JSON array of {FIELD,VALUE}.
    TYPES: ty_prow  TYPE STANDARD TABLE OF ty_field_value WITH DEFAULT KEY.
    DATA lt_rows TYPE STANDARD TABLE OF ty_prow WITH DEFAULT KEY.

    " Fields the maintenance view has and the base table does not — a text
    " table's description, typically. They cannot live in the base-table plan,
    " so they travel beside it, keyed by plan row, and the writer puts them into
    " the view entry.
    TYPES: BEGIN OF ty_extra,
             row   TYPE i,
             field TYPE string,
             value TYPE string,
           END OF ty_extra.
    DATA: lt_extras  TYPE STANDARD TABLE OF ty_extra WITH DEFAULT KEY,
          lt_rowx    TYPE STANDARD TABLE OF ty_extra WITH DEFAULT KEY,
          lr_view    TYPE REF TO data,
          ls_req     TYPE ty_request.
    FIELD-SYMBOLS <view> TYPE any.
    ls_req = is_req.
    IF is_req-view_name IS NOT INITIAL.
      TRY.
          CREATE DATA lr_view TYPE (is_req-view_name).
          ASSIGN lr_view->* TO <view>.
        CATCH cx_root.
          CLEAR lr_view.
      ENDTRY.
    ENDIF.

    rs_resp-operation = 'create'.
    rs_resp-table     = is_req-table.
    rs_resp-transport = is_req-transport.
    rs_resp-dry_run   = COND #( WHEN is_req-commit = abap_true
                                THEN abap_false ELSE abap_true ).

    IF is_valid_name( is_req-table ) = abap_false.
      rs_resp-status = 'error'.
      APPEND 'Invalid table name' TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF is_req-rows_json IS INITIAL.
      rs_resp-status = 'error'.
      APPEND 'ROWS_JSON is required (a JSON array of rows, each an array of {FIELD,VALUE})'
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json        = is_req-rows_json
                    pretty_name = /ui2/cl_json=>pretty_mode-none
          CHANGING  data        = lt_rows ).
      CATCH cx_root INTO DATA(lx_rj).
        rs_resp-status = 'error'.
        APPEND |Cannot parse ROWS_JSON: { lx_rj->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.
    IF lines( lt_rows ) = 0.
      rs_resp-status = 'error'.
      APPEND 'ROWS_JSON contained no rows' TO rs_resp-messages.
      RETURN.
    ENDIF.

    TRY.
        CREATE DATA lr_plan TYPE STANDARD TABLE OF (is_req-table).
        ASSIGN lr_plan->* TO <plan>.
      CATCH cx_root INTO DATA(lx_ce).
        rs_resp-status = 'error'.
        APPEND |Cannot type table { is_req-table }: { lx_ce->get_text( ) }|
          TO rs_resp-messages.
        RETURN.
    ENDTRY.

    " ── Build each row from its field/value pairs ─────────────────────────────
    LOOP AT lt_rows INTO DATA(lt_fields).
      CREATE DATA lr_new LIKE LINE OF <plan>.
      ASSIGN lr_new->* TO <new>.
      CLEAR <new>.
      CLEAR lt_rowx.
      LOOP AT lt_fields INTO DATA(ls_fv).
        IF is_valid_name( ls_fv-field ) = abap_false.
          rs_resp-status = 'error'.
          APPEND |Invalid field name '{ ls_fv-field }'| TO rs_resp-messages.
          RETURN.
        ENDIF.
        ASSIGN COMPONENT to_upper( ls_fv-field ) OF STRUCTURE <new> TO <fld>.
        IF sy-subrc <> 0.
          IF lr_view IS BOUND.
            ASSIGN COMPONENT to_upper( ls_fv-field ) OF STRUCTURE <view> TO <fld>.
            IF sy-subrc = 0.
              APPEND VALUE #( field = to_upper( ls_fv-field ) value = ls_fv-value ) TO lt_rowx.
              CONTINUE.
            ENDIF.
          ENDIF.
          rs_resp-status = 'error'.
          APPEND |Field { ls_fv-field } not found in { is_req-table }| &&
                 COND string( WHEN lr_view IS BOUND THEN | or its maintenance view { is_req-view_name }| ) TO rs_resp-messages.
          RETURN.
        ENDIF.
        TRY.
            <fld> = ls_fv-value.
          CATCH cx_root.
            rs_resp-status = 'error'.
            APPEND |Value '{ ls_fv-value }' for { ls_fv-field } does not convert to the field type|
              TO rs_resp-messages.
            RETURN.
        ENDTRY.
      ENDLOOP.

      " ONLY_MISSING: skip rows whose key already exists (idempotent create)
      IF is_req-only_missing = abap_true.
        IF row_exists( iv_table = is_req-table ir_row = lr_new ) = abap_true.
          CONTINUE.
        ENDIF.
      ENDIF.

      APPEND <new> TO <plan>.
      LOOP AT lt_rowx INTO DATA(ls_rx).
        ls_rx-row = lines( <plan> ).
        APPEND ls_rx TO lt_extras.
      ENDLOOP.
    ENDLOOP.

    rs_resp-rows_planned = lines( <plan> ).
    IF lt_extras IS NOT INITIAL.
      /ui2/cl_json=>serialize(
        EXPORTING data        = lt_extras
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        RECEIVING r_json      = ls_req-extras_json ).
    ENDIF.
    lv_flag = delivery_class( is_req-table ).

    " ── Dry run ───────────────────────────────────────────────────────────────
    IF is_req-commit = abap_false.
      rs_resp-status = 'ok'.
      APPEND |DRY RUN — { rs_resp-rows_planned } row(s) planned| TO rs_resp-messages.
      /ui2/cl_json=>serialize(
        EXPORTING data        = <plan>
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        RECEIVING r_json      = rs_resp-data_json ).
      RETURN.
    ENDIF.

    IF rs_resp-rows_planned = 0.
      rs_resp-status = 'ok'.
      APPEND 'Nothing to create — all rows already present' TO rs_resp-messages.
      RETURN.
    ENDIF.

    commit_plan( EXPORTING is_req  = ls_req
                           ir_plan = lr_plan
                 CHANGING  cs_resp = rs_resp ).
  ENDMETHOD.


  METHOD row_exists.
    DATA: lt_fields TYPE STANDARD TABLE OF dd03l,
          lv_tab    TYPE tabname,
          lv_where  TYPE string,
          lv_cnt    TYPE i.
    FIELD-SYMBOLS: <row> TYPE any,
                   <fld> TYPE any.

    ASSIGN ir_row->* TO <row>.
    lv_tab = to_upper( iv_table ).

    SELECT fieldname datatype FROM dd03l
      INTO CORRESPONDING FIELDS OF TABLE lt_fields
      WHERE tabname  = lv_tab
        AND as4local = 'A'
        AND keyflag  = 'X'
        AND fieldname NOT LIKE '.%'
      ORDER BY position.

    LOOP AT lt_fields INTO DATA(ls_f).
      IF ls_f-datatype = 'CLNT'.
        CONTINUE.   " client handled implicitly by the SELECT
      ENDIF.
      ASSIGN COMPONENT ls_f-fieldname OF STRUCTURE <row> TO <fld>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      DATA(lv_cond) = |{ ls_f-fieldname } = '{ esc_quote( CONV string( <fld> ) ) }'|.
      IF lv_where IS INITIAL.
        lv_where = lv_cond.
      ELSE.
        lv_where = |{ lv_where } AND { lv_cond }|.
      ENDIF.
    ENDLOOP.

    IF lv_where IS INITIAL.
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    SELECT COUNT(*) FROM (lv_tab) INTO lv_cnt WHERE (lv_where).
    rv_ok = COND #( WHEN lv_cnt > 0 THEN abap_true ELSE abap_false ).
  ENDMETHOD.


  METHOD handle_listing.
    " List articles into assortments via SAP's listing engine. items_json =
    " JSON array of {PRODUCT,ASSORTMENT,DATE_FROM,DATE_TO}. determine_data='X'
    " extends each article to the assortment's assigned sites + writes WLK1.
    " Retail-only type (WINT_LISTING_ITEM_TAB) and the FM are resolved
    " DYNAMICALLY, so this class still activates on non-retail systems (e.g. CAR);
    " fm_exists guards the actual call there. No static retail-type references.
    TYPES: BEGIN OF ty_item_in,
             product    TYPE c LENGTH 40,
             assortment TYPE c LENGTH 10,
             date_from  TYPE c LENGTH 8,
             date_to    TYPE c LENGTH 8,
           END OF ty_item_in.
    DATA: lt_in    TYPE STANDARD TABLE OF ty_item_in WITH DEFAULT KEY,
          lr_items TYPE REF TO data,
          lr_line  TYPE REF TO data,
          lv_matnr TYPE matnr.
    FIELD-SYMBOLS: <items> TYPE STANDARD TABLE,
                   <line>  TYPE any,
                   <fld>   TYPE any.

    rs_resp-operation = 'listing'.
    rs_resp-dry_run   = COND #( WHEN is_req-commit = abap_true THEN abap_false ELSE abap_true ).

    IF fm_exists( 'EXECUTE_LISTING_ART_ASSORT_RFC' ) = abap_false.
      rs_resp-status = 'error'.
      APPEND 'Listing engine FM EXECUTE_LISTING_ART_ASSORT_RFC not installed on this box (not an IS-Retail system)'
        TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF is_req-items_json IS INITIAL.
      rs_resp-status = 'error'.
      APPEND 'ITEMS_JSON is required (array of {PRODUCT,ASSORTMENT,DATE_FROM,DATE_TO})'
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json        = is_req-items_json
                    pretty_name = /ui2/cl_json=>pretty_mode-none
          CHANGING  data        = lt_in ).
      CATCH cx_root INTO DATA(lx_ij).
        rs_resp-status = 'error'.
        APPEND |Cannot parse ITEMS_JSON: { lx_ij->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    TRY.
        CREATE DATA lr_items TYPE ('WINT_LISTING_ITEM_TAB').
        ASSIGN lr_items->* TO <items>.
      CATCH cx_root INTO DATA(lx_ty).
        rs_resp-status = 'error'.
        APPEND |Listing item type WINT_LISTING_ITEM_TAB not available: { lx_ty->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    LOOP AT lt_in INTO DATA(ls_in).
      CREATE DATA lr_line LIKE LINE OF <items>.
      ASSIGN lr_line->* TO <line>.
      CLEAR <line>.
      ASSIGN COMPONENT 'PRODUCT' OF STRUCTURE <line> TO <fld>.
      IF sy-subrc = 0.
        " Use the MATERIAL number conversion (not plain ALPHA): a classic numeric
        " article is stored 18-char zero-padded (e.g. 000000000000000156), NOT
        " left-padded across the full 40-char MATNR field. Plain ALPHA on c40
        " yields 38 zeros + 156, which never matches MARA → cl_listing_app
        " get_product_data finds nothing → WM 028 → job abort.
        CLEAR lv_matnr.
        CALL FUNCTION 'CONVERSION_EXIT_MATN1_INPUT'
          EXPORTING input  = ls_in-product
          IMPORTING output = lv_matnr
          EXCEPTIONS OTHERS = 1.
        <fld> = COND #( WHEN sy-subrc = 0 THEN lv_matnr ELSE |{ ls_in-product ALPHA = IN }| ).
      ENDIF.
      ASSIGN COMPONENT 'ASSORTMENT' OF STRUCTURE <line> TO <fld>.
      IF sy-subrc = 0. <fld> = ls_in-assortment. ENDIF.
      ASSIGN COMPONENT 'DATE_FROM' OF STRUCTURE <line> TO <fld>.
      IF sy-subrc = 0. <fld> = COND #( WHEN ls_in-date_from IS INITIAL THEN sy-datum ELSE ls_in-date_from ). ENDIF.
      ASSIGN COMPONENT 'DATE_TO' OF STRUCTURE <line> TO <fld>.
      IF sy-subrc = 0. <fld> = COND #( WHEN ls_in-date_to IS INITIAL THEN '99991231' ELSE ls_in-date_to ). ENDIF.
      ASSIGN COMPONENT 'LISTING_ALLOWED' OF STRUCTURE <line> TO <fld>.
      IF sy-subrc = 0. <fld> = 'X'. ENDIF.
      APPEND <line> TO <items>.
    ENDLOOP.

    rs_resp-rows_planned = lines( <items> ).

    IF is_req-commit = abap_false.
      rs_resp-status = 'ok'.
      APPEND |DRY RUN — { rs_resp-rows_planned } listing item(s) prepared (set commit to execute)|
        TO rs_resp-messages.
      /ui2/cl_json=>serialize(
        EXPORTING data        = <items>
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        RECEIVING r_json      = rs_resp-data_json ).
      RETURN.
    ENDIF.

    " ── Commit: run the listing engine in a BACKGROUND JOB. Synchronously in the
    " ICF/HTTP context the FM aborts with "Message <type> WM 028 cannot be
    " processed in plugin mode HTTP" — it issues dialog messages that the HTTP
    " plugin can't display. Under sy-batch='X' those are logged, not popped, so
    " the listing completes. If the job outlives the short poll it returns
    " pending + run_id and the caller polls 'status' (same contract as org_copy).
    DATA lv_items_json TYPE string.
    /ui2/cl_json=>serialize(
      EXPORTING data        = <items>
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = lv_items_json ).

    DATA(ls_res) = submit_listing(
      EXPORTING iv_items_json = lv_items_json
      CHANGING  ct_messages   = rs_resp-messages ).

    IF ls_res-pending = abap_true.
      rs_resp-status = 'pending'.
      rs_resp-run_id = ls_res-run_id.
      APPEND |Listing running as a background job — run_id { ls_res-run_id } (poll customizing_status)|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF ls_res-ok = abap_false.
      rs_resp-status = 'error'.   " submit_listing already appended the failure detail
      RETURN.
    ENDIF.

    rs_resp-status       = 'ok'.
    rs_resp-rows_written = ls_res-rows_written.
    APPEND |Listed { rs_resp-rows_planned } article/assortment item(s) (segments determined + WLK1 written)|
      TO rs_resp-messages.
  ENDMETHOD.


  METHOD handle_delete.
    " SM30-standard delete: remove the entry/entries whose KEY_FIELD = TARGET_KEY
    " through the maintenance-view runtime (VIEW_MAINTENANCE_SINGLE_ENTRY action
    " 'DEL'), recording the deletion onto a Customizing transport — exactly as
    " deleting the row in SM30 does.  No manual table or E071K surgery.
    DATA: lr_plan  TYPE REF TO data,
          lr_one   TYPE REF TO data,
          lv_where TYPE string,
          lv_flag  TYPE dd02l-contflag,
          lv_grp   TYPE tddat-cclass,
          lt_keys  TYPE ty_tabkey_tt.
    FIELD-SYMBOLS: <plan> TYPE STANDARD TABLE,
                   <row>  TYPE any,
                   <one>  TYPE any.

    rs_resp-operation = 'delete'.
    rs_resp-table     = is_req-table.
    rs_resp-transport = is_req-transport.
    rs_resp-dry_run   = COND #( WHEN is_req-commit = abap_true
                                THEN abap_false ELSE abap_true ).

    " ── Guard rails ─────────────────────────────────────────────────────────
    IF is_valid_name( is_req-table ) = abap_false
    OR is_valid_name( is_req-key_field ) = abap_false.
      rs_resp-status = 'error'.
      APPEND 'Invalid table or key field name' TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF is_req-target_key IS INITIAL.
      rs_resp-status = 'error'.
      APPEND 'TARGET_KEY (the entry to delete) is required' TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Delete runs through the SM30 view runtime, so a maintenance view is required.
    IF is_req-view_name IS INITIAL.
      rs_resp-status = 'error'.
      APPEND |No maintenance view resolved for { is_req-table } — SM30-standard delete not available|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    " ── Delivery class: recorded customizing only ───────────────────────────
    lv_flag = delivery_class( is_req-table ).
    CASE lv_flag.
      WHEN 'C' OR 'G' OR 'E'.
        DATA(lv_do_record) = COND abap_bool(
          WHEN is_req-record_transport = abap_false THEN abap_false ELSE abap_true ).
        IF lv_do_record = abap_false.
          rs_resp-status = 'error'.
          APPEND 'Delete is supported only as a transport-recorded customizing change (RECORD_TRANSPORT must stay true)'
            TO rs_resp-messages.
          RETURN.
        ENDIF.

        " Client capability (T000/SCC4): non-recording client → the deletion goes
        " through the SM30 view runtime but isn't recorded onto a transport; a
        " "no changes" client forbids it.  (See handle_write for the rationale.)
        DATA lv_cl_norecord TYPE abap_bool.
        eval_client_change(
          EXPORTING iv_table   = is_req-table
          IMPORTING ev_blocked = DATA(lv_cl_blocked)
                    ev_records = DATA(lv_cl_records)
                    ev_reason  = DATA(lv_cl_reason) ).
        IF lv_cl_blocked = abap_true.
          rs_resp-status = 'error'.
          APPEND lv_cl_reason TO rs_resp-messages.
          RETURN.
        ENDIF.
        IF lv_cl_records = abap_false.
          IF is_req-transport IS NOT INITIAL.
            rs_resp-status = 'error'.
            APPEND |{ lv_cl_reason } — omit TRANSPORT| TO rs_resp-messages.
            RETURN.
          ENDIF.
          lv_cl_norecord = abap_true.
          APPEND lv_cl_reason TO rs_resp-messages.
        ENDIF.

        IF lv_cl_norecord = abap_false
        AND is_req-commit = abap_true AND is_req-transport IS INITIAL.
          rs_resp-status = 'error'.
          APPEND 'No TRANSPORT supplied. Record the deletion into an existing open Customizing request.'
            TO rs_resp-messages.
          RETURN.
        ENDIF.
      WHEN OTHERS.
        rs_resp-status = 'error'.
        APPEND |Delivery class '{ lv_flag }': delete supported only for recorded customizing (C/G/E)|
          TO rs_resp-messages.
        RETURN.
    ENDCASE.

    lv_grp = auth_group( is_req-table ).
    AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
      ID 'DICBERCLS' FIELD lv_grp
      ID 'ACTVT'     FIELD '02'.
    IF sy-subrc <> 0.
      rs_resp-status = 'error'.
      APPEND |Not authorized: S_TABU_DIS / { lv_grp } / 02| TO rs_resp-messages.
      RETURN.
    ENDIF.

    " ── Read the entries to delete (plan = existing rows for that key) ───────
    TRY.
        CREATE DATA lr_plan TYPE STANDARD TABLE OF (is_req-table).
        ASSIGN lr_plan->* TO <plan>.
      CATCH cx_root INTO DATA(lx_ce).
        rs_resp-status = 'error'.
        APPEND |Cannot type table { is_req-table }: { lx_ce->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    lv_where = |{ is_req-key_field } = '{ esc_quote( is_req-target_key ) }'|.
    SELECT * FROM (is_req-table) INTO TABLE <plan> WHERE (lv_where).
    rs_resp-rows_planned = lines( <plan> ).

    " ── Dry run ─────────────────────────────────────────────────────────────
    IF is_req-commit = abap_false.
      rs_resp-status = 'ok'.
      APPEND |DRY RUN — { rs_resp-rows_planned } row(s) would be deleted via { is_req-view_name }|
        TO rs_resp-messages.
      /ui2/cl_json=>serialize(
        EXPORTING data        = <plan>
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        RECEIVING r_json      = rs_resp-data_json ).
      RETURN.
    ENDIF.

    IF rs_resp-rows_planned = 0.
      rs_resp-status = 'ok'.
      APPEND 'Nothing to delete — no entry with that key' TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Tabkeys for the writer's post-commit recording check
    LOOP AT <plan> ASSIGNING <row>.
      CREATE DATA lr_one LIKE <row>.
      ASSIGN lr_one->* TO <one>.
      <one> = <row>.
      APPEND build_tabkey( iv_table = is_req-table ir_row = lr_one ) TO lt_keys.
    ENDLOOP.

    " ── Recorded delete via the background writer (action 'DEL') ─────────────
    DATA(ls_wreq)  = is_req.
    ls_wreq-action = 'DEL'.
    DATA ls_br TYPE ty_batch_result.
    CALL METHOD me->submit_batch_write
      EXPORTING
        is_req      = ls_wreq
        ir_plan     = lr_plan
        it_keys     = lt_keys
      CHANGING
        ct_messages = rs_resp-messages
      RECEIVING
        rs_res      = ls_br.

    IF ls_br-pending = abap_true.
      rs_resp-status = 'pending'.
      rs_resp-run_id = ls_br-run_id.
      APPEND |Job submitted — run_id { ls_br-run_id } (poll customizing_status)|
        TO rs_resp-messages.
    ELSEIF ls_br-ok = abap_true.
      rs_resp-status       = 'ok'.
      rs_resp-rows_written = ls_br-rows_written.
      IF lv_cl_norecord = abap_true.
        APPEND |Deleted { ls_br-rows_written } row(s) via the view runtime (client { sy-mandt } records no transport)|
          TO rs_resp-messages.
      ELSE.
        APPEND |Deleted { ls_br-rows_written } row(s) → { rs_resp-transport } ({ ls_br-e071k_count } E071K entries)|
          TO rs_resp-messages.
      ENDIF.
    ELSE.
      rs_resp-status = 'error'.
    ENDIF.
  ENDMETHOD.


  METHOD handle_selftest.
    DATA: lr_tab   TYPE REF TO data,
          lr_row   TYPE REF TO data,
          lv_table TYPE string.
    FIELD-SYMBOLS: <tab> TYPE STANDARD TABLE,
                   <row> TYPE any.

    rs_resp-operation = 'selftest'.
    lv_table = COND #( WHEN is_req-table IS NOT INITIAL
                       THEN is_req-table ELSE 'TCURR' ).
    rs_resp-table = lv_table.

    " [1] Dynamic typing
    TRY.
        CREATE DATA lr_tab TYPE STANDARD TABLE OF (lv_table).
        ASSIGN lr_tab->* TO <tab>.
        APPEND |[1] dynamic typing of { lv_table }: OK| TO rs_resp-messages.
      CATCH cx_root INTO DATA(lx1).
        rs_resp-status = 'error'.
        APPEND |[1] dynamic typing FAILED: { lx1->get_text( ) }|
          TO rs_resp-messages.
        RETURN.
    ENDTRY.

    " [2] Sample read
    TRY.
        SELECT * FROM (lv_table) UP TO 1 ROWS INTO TABLE <tab>.
      CATCH cx_root INTO DATA(lx2).
        rs_resp-status = 'error'.
        APPEND |[2] SELECT FAILED: { lx2->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.
    IF lines( <tab> ) = 0.
      rs_resp-status = 'error'.
      APPEND |[2] { lv_table } has no rows — pass TABLE with data|
        TO rs_resp-messages.
      RETURN.
    ENDIF.
    APPEND '[2] sample read: OK' TO rs_resp-messages.

    " [3] build_tabkey
    CREATE DATA lr_row LIKE LINE OF <tab>.
    ASSIGN lr_row->* TO <row>.
    READ TABLE <tab> INDEX 1 INTO <row>.
    DATA(lv_key) = build_tabkey( iv_table = lv_table ir_row = lr_row ).
    IF lv_key IS INITIAL.
      rs_resp-status = 'error'.
      APPEND '[3] build_tabkey returned empty key' TO rs_resp-messages.
      RETURN.
    ENDIF.
    APPEND |[3] build_tabkey: '{ lv_key }'| TO rs_resp-messages.

    " [4] Transport key readiness (no WI_SIMULATION on this release —
    "     TR_OBJECTS_INSERT is called only on real commit, not in selftest)
    IF is_req-transport IS NOT INITIAL.
      APPEND |[4] transport key ready: '{ lv_key }' — recording deferred to commit|
        TO rs_resp-messages.
    ELSE.
      APPEND '[4] skipped (no TRANSPORT supplied)' TO rs_resp-messages.
    ENDIF.

    rs_resp-status    = 'ok'.
    rs_resp-data_json = lv_key.
  ENDMETHOD.


  METHOD is_valid_name.
    DATA lv TYPE string.
    DATA lc TYPE i.
    rv_ok = abap_true.
    lv = to_upper( iv_name ).
    IF lv IS INITIAL OR strlen( lv ) > 30.
      rv_ok = abap_false.
      RETURN.
    ENDIF.
    " Find any character that is NOT A-Z, 0-9, _, /
    FIND FIRST OCCURRENCE OF REGEX '[^A-Z0-9_/]' IN lv MATCH OFFSET DATA(lo).
    IF sy-subrc = 0.
      rv_ok = abap_false.
    ENDIF.
  ENDMETHOD.


  METHOD delivery_class.
    DATA lv_tabname TYPE tabname.
    lv_tabname = to_upper( iv_table ).
    SELECT SINGLE contflag FROM dd02l INTO rv_flag
      WHERE tabname  = lv_tabname
        AND as4local = 'A'.
  ENDMETHOD.


  METHOD client_caps.
    SELECT SINGLE cccategory cccoractiv ccnocliind
      FROM t000 INTO (rs_caps-category, rs_caps-coractiv, rs_caps-nocliind)
      WHERE mandt = sy-mandt.
    " CCCORACTIV: '1' = automatic recording; '' = changes w/o recording;
    " '2' = no changes allowed; '3' = changes w/o recording, no transport.
    rs_caps-records = COND #( WHEN rs_caps-coractiv = '1' THEN abap_true ELSE abap_false ).
    rs_caps-changes = COND #( WHEN rs_caps-coractiv = '2' THEN abap_false ELSE abap_true ).
    rs_caps-text = SWITCH string( rs_caps-coractiv
      WHEN '1' THEN 'automatic recording of changes'
      WHEN '2' THEN 'no changes allowed'
      WHEN '3' THEN 'changes without automatic recording, no transport'
      ELSE          'changes without automatic recording' ).
  ENDMETHOD.


  METHOD fm_exists.
    SELECT SINGLE @abap_true FROM tfdir INTO @rv_ok
      WHERE funcname = @iv_fm.
  ENDMETHOD.


  METHOD probe_environment.
    rs_env-sysid       = sy-sysid.
    rs_env-client      = sy-mandt.
    rs_env-saprl       = sy-saprl.
    SELECT SINGLE release FROM cvers INTO @rs_env-sap_basis WHERE component = 'SAP_BASIS'.
    SELECT SINGLE release FROM cvers INTO @rs_env-s4core    WHERE component = 'S4CORE'.
    rs_env-is_s4       = boolc( rs_env-s4core IS NOT INITIAL ).
    rs_env-client_role = client_caps( )-category.
    " Feature flags — probed live, so the engine reports (and the AI adapts to)
    " what THIS box actually has rather than assuming any release baseline.
    rs_env-has_org_copy = fm_exists( 'ECOP_ORG_UNITS_IN_THE_DARK' ).
    rs_env-has_cts_task = fm_exists( 'TRINT_INSERT_NEW_COMM' ).
    SELECT SINGLE @abap_true FROM tstc INTO @rs_env-has_mc_gui WHERE tcode = 'LTMC'.
  ENDMETHOD.


  METHOD is_client_dependent.
    DATA lv_tabname TYPE tabname.
    lv_tabname = to_upper( iv_table ).
    SELECT SINGLE @abap_true FROM dd03l INTO @rv_flag
      WHERE tabname  = @lv_tabname
        AND fieldname = 'MANDT'
        AND keyflag   = 'X'
        AND as4local  = 'A'.
  ENDMETHOD.


  METHOD eval_client_change.
    DATA(ls_caps) = client_caps( ).
    IF is_client_dependent( iv_table ) = abap_true.
      " Client-dependent customizing → governed by CCCORACTIV.
      CASE ls_caps-coractiv.
        WHEN '1'.
          ev_records = abap_true.
        WHEN '2'.
          ev_blocked = abap_true.
          ev_reason  = |Client { sy-mandt }: no changes allowed (T000-CCCORACTIV='2')|.
        WHEN OTHERS.   " '' or '3' — changes allowed but not recorded
          ev_records = abap_false.
          ev_reason  = |Client { sy-mandt } is set to '{ ls_caps-text }' | &&
                       |(CCCORACTIV='{ ls_caps-coractiv }') — the change is written but not recorded onto a transport|.
      ENDCASE.
    ELSE.
      " Cross-client (client-independent) customizing → governed by CCNOCLIIND.
      " Such changes ARE recorded when allowed; blocked by '1'/'3'.
      IF ls_caps-nocliind = '1' OR ls_caps-nocliind = '3'.
        ev_blocked = abap_true.
        ev_reason  = |Client { sy-mandt }: cross-client customizing changes are blocked (T000-CCNOCLIIND='{ ls_caps-nocliind }')|.
      ELSE.
        ev_records = abap_true.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD auth_group.
    DATA lv_tabname TYPE tabname.
    lv_tabname = to_upper( iv_table ).
    SELECT SINGLE cclass FROM tddat INTO rv_group
      WHERE tabname = lv_tabname.
    IF rv_group IS INITIAL.
      rv_group = '&NC&'.
    ENDIF.
  ENDMETHOD.


  METHOD esc_quote.
    rv_val = iv_val.
    REPLACE ALL OCCURRENCES OF '''' IN rv_val WITH ''''''.
  ENDMETHOD.


  METHOD build_tabkey.
    " Build the flat E071K TABKEY exactly as the transport layer expects:
    " key fields in DDIC position order, each occupying its full DDIC length,
    " concatenated with NO separators and trailing blanks preserved.  The
    " client field comes first for client-dependent tables and is forced to the
    " current client.  Values are taken in their internal/character form (a
    " plain move into a CHAR buffer), which is correct for CLNT/CHAR/NUMC/DATS
    " key fields (incl. TCURR-GDATU, an inverted NUMC8 date).
    DATA: lt_fields  TYPE STANDARD TABLE OF dd03l,
          ls_field   TYPE dd03l,
          lv_tabname TYPE tabname,
          lv_key     TYPE string,
          lv_buf     TYPE c LENGTH 256,
          lv_len     TYPE i.
    FIELD-SYMBOLS: <row> TYPE any,
                   <fld> TYPE any.

    ASSIGN ir_row->* TO <row>.
    lv_tabname = to_upper( iv_table ).

    SELECT fieldname position leng datatype FROM dd03l
      INTO CORRESPONDING FIELDS OF TABLE lt_fields
      WHERE tabname  = lv_tabname
        AND as4local = 'A'
        AND keyflag  = 'X'
        AND fieldname NOT LIKE '.%'      " skip .INCLUDE / structure pseudo-rows
      ORDER BY position.

    LOOP AT lt_fields INTO ls_field.
      CLEAR lv_buf.
      IF ls_field-datatype = 'CLNT'.
        lv_buf = sy-mandt.               " client field → current client
      ELSE.
        ASSIGN COMPONENT ls_field-fieldname OF STRUCTURE <row> TO <fld>.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        lv_buf = <fld>.                  " internal char form, left-justified
      ENDIF.

      lv_len = ls_field-leng.
      IF lv_len > 256.
        lv_len = 256.
      ENDIF.

      " Concatenate at the field's full DDIC length, preserving trailing blanks
      CONCATENATE lv_key lv_buf(lv_len) INTO lv_key RESPECTING BLANKS.
    ENDLOOP.

    rv_key = lv_key.
  ENDMETHOD.


  METHOD handle_status.
    " Poll a prior async write by run_id.  Honest, idempotent lifecycle:
    "   ZR (result) present   → terminal: return it and KEEP it (a lost HTTP
    "                            response must not destroy the outcome); drop the
    "                            bulky ZP params only.
    "   no ZR, ZJ handle → TBTCO: R=running, Y/P/S=queued, A=aborted,
    "                            F-without-result=aborted (dumped mid-run).
    "   no ZR, no ZJ          → genuinely unknown/expired (NOT 'still running').
    " cleanup_stale_runs ages ZJ/ZR/ZP out so results stay re-readable a while
    " without accumulating.  handle_status never deletes ZJ/ZR — only cleanup does.
    DATA: ls_jres TYPE ty_jres,
          ls_jh   TYPE ty_jhandle.
    rs_resp-operation = 'status'.
    rs_resp-run_id    = is_req-run_id.

    IF is_req-run_id IS INITIAL.
      rs_resp-status = 'error'.
      APPEND 'run_id is required for operation status' TO rs_resp-messages.
      RETURN.
    ENDIF.

    cleanup_stale_runs( ).

    " 1) Terminal result present — return it idempotently (do NOT delete ZR).
    IMPORT data = ls_jres FROM DATABASE indx(ZR) ID is_req-run_id.
    IF sy-subrc = 0.
      rs_resp-status       = ls_jres-status.
      rs_resp-rows_written = ls_jres-rows_written.
      rs_resp-transport    = ls_jres-transport.   " org copy reports its export request
      LOOP AT ls_jres-messages INTO DATA(lv_m).
        APPEND lv_m TO rs_resp-messages.
      ENDLOOP.
      DELETE FROM DATABASE indx(ZP) ID is_req-run_id.   " params no longer needed
      RETURN.
    ENDIF.

    " 2) No result yet — consult the job handle + TBTCO.
    IMPORT data = ls_jh FROM DATABASE indx(ZJ) ID is_req-run_id.
    IF sy-subrc <> 0.
      rs_resp-status = 'unknown'.
      APPEND |run_id { is_req-run_id } is unknown or expired — no job handle and no result. | &&
             |If it finished long ago its result may have aged out; otherwise the run_id is wrong.|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    DATA lv_jstat TYPE btcstatus.
    SELECT SINGLE status FROM tbtco INTO @lv_jstat
      WHERE jobname = @ls_jh-jobname AND jobcount = @ls_jh-jobcount.
    IF sy-subrc <> 0.
      rs_resp-status = 'pending'.
      APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } is scheduled (not yet in TBTCO)|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    CASE lv_jstat.
      WHEN 'R'.                       " active / running
        rs_resp-status = 'running'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } is RUNNING (active, TBTCO 'R'). | &&
               |{ job_progress_note( ) }| TO rs_resp-messages.
      WHEN 'Y' OR 'P' OR 'S'.         " ready / scheduled / released → waiting for a WP
        rs_resp-status = 'pending'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } is queued (TBTCO '{ lv_jstat }'), | &&
               |waiting for a free background work process| TO rs_resp-messages.
      WHEN 'A'.                       " aborted / cancelled
        rs_resp-status = 'aborted'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } was ABORTED (cancelled or failed, | &&
               |TBTCO 'A') — no result was written.| TO rs_resp-messages.
        job_log_errors( EXPORTING iv_jobname = ls_jh-jobname iv_jobcount = ls_jh-jobcount
                        CHANGING  ct_messages = rs_resp-messages ).
      WHEN 'F'.                       " finished but wrote no ZR result → dumped mid-run
        rs_resp-status = 'aborted'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } FINISHED (TBTCO 'F') but produced no | &&
               |result — it likely dumped mid-run. Check ST22.| TO rs_resp-messages.
        job_log_errors( EXPORTING iv_jobname = ls_jh-jobname iv_jobcount = ls_jh-jobcount
                        CHANGING  ct_messages = rs_resp-messages ).
      WHEN OTHERS.
        rs_resp-status = 'pending'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } TBTCO status '{ lv_jstat }'|
          TO rs_resp-messages.
    ENDCASE.
  ENDMETHOD.


  METHOD job_log_errors.
    DATA: lt_log   TYPE STANDARD TABLE OF tbtc5,
          lv_found TYPE abap_bool.
    CALL FUNCTION 'BP_JOBLOG_READ'
      EXPORTING  jobcount  = iv_jobcount
                 jobname   = iv_jobname
      TABLES     joblogtbl = lt_log
      EXCEPTIONS OTHERS    = 1.
    IF sy-subrc <> 0.
      APPEND `(The job log could not be read — see SM37.)` TO ct_messages.
      RETURN.
    ENDIF.
    LOOP AT lt_log INTO DATA(ls_log) WHERE msgtype CA 'EAX'.
      " 00564 "Job canceled after system exception …" only repeats the outcome.
      CHECK NOT ( ls_log-msgid = '00' AND ls_log-msgno = '564' ).
      APPEND |Job log: { ls_log-msgid }{ ls_log-msgno } { ls_log-text }| TO ct_messages.
      lv_found = abap_true.
    ENDLOOP.
    IF lv_found = abap_false.
      APPEND `The job log names no error — see SM37 / ST22.` TO ct_messages.
    ENDIF.
  ENDMETHOD.


  METHOD job_progress_note.
    " Best-effort: the current program/action/table of the job's background WP,
    " so a long 'running' shows it is progressing (a different program each poll)
    " rather than wedged.  WP_REPORT reflects the *currently executing* unit
    " (often a called SAP program, not ZMCP_CUST_WRITE), so match by user+type.
    DATA lt_wp TYPE STANDARD TABLE OF wpinfo.
    CALL FUNCTION 'TH_WPINFO'
      TABLES     wplist = lt_wp
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    DATA lv_rep TYPE string.
    LOOP AT lt_wp INTO DATA(ls_wp)
        WHERE wp_typ = 'BGD' AND wp_bname = sy-uname AND wp_istatus = 4.  " 4 = running
      lv_rep = ls_wp-wp_report.
      REPLACE ALL OCCURRENCES OF '=' IN lv_rep WITH ''.   " CL_...===CP → CL_...CP
      rv_note = |Progressing — currently { lv_rep } | &&
                COND string( WHEN ls_wp-wp_action IS NOT INITIAL
                             THEN |({ ls_wp-wp_action }{ COND string( WHEN ls_wp-wp_table IS NOT INITIAL
                                                                      THEN | { ls_wp-wp_table }| ) }) | )
                && |after { ls_wp-wp_eltime }s|.
      RETURN.
    ENDLOOP.
  ENDMETHOD.


  METHOD cleanup_stale_runs.
    " Sweep INDX ZJ (job handles) — the age anchor — and drop the run's ZJ/ZR/ZP
    " once its handle is older than the retention window (6 h same day, or any
    " earlier day). Handful of runs per session, so this is cheap.
    DATA: lt_srt TYPE STANDARD TABLE OF indx-srtfd,
          ls_jh  TYPE ty_jhandle.
    SELECT srtfd FROM indx INTO TABLE @lt_srt WHERE relid = 'ZJ'.
    LOOP AT lt_srt INTO DATA(lv_srt).
      IMPORT data = ls_jh FROM DATABASE indx(ZJ) ID lv_srt.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      IF ls_jh-cdate < sy-datum
         OR ( ls_jh-cdate = sy-datum AND ( sy-uzeit - ls_jh-ctime ) > 21600 ).
        DELETE FROM DATABASE indx(ZJ) ID lv_srt.
        DELETE FROM DATABASE indx(ZR) ID lv_srt.
        DELETE FROM DATABASE indx(ZP) ID lv_srt.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD write_job_handle.
    DATA ls_jh TYPE ty_jhandle.
    ls_jh-jobname   = iv_jobname.
    ls_jh-jobcount  = iv_jobcount.
    ls_jh-run_kind  = iv_kind.
    ls_jh-table     = iv_table.
    ls_jh-transport = iv_transport.
    ls_jh-cdate     = sy-datum.
    ls_jh-ctime     = sy-uzeit.
    EXPORT data = ls_jh TO DATABASE indx(ZJ) ID iv_run_id.
  ENDMETHOD.


  METHOD handle_img_search.
    " Full CUS_IMGACT scan with a server-side LIKE over BOTH the title TEXT and
    " the activity id, joined to CUS_ACTOBJ for the maintenance object. Open SQL
    " LIKE is unrestricted here (the ADT Data-Preview endpoint's LIKE ban and its
    " 200-row alphabetical window do not apply), so component-acronym searches
    " (e.g. 'TSW' → SIMG_OIJ_TSW_*, whose functional titles never say 'TSW') work.
    DATA: lv_lang TYPE spras,
          lv_pat  TYPE string,
          lv_kw   TYPE string,
          lv_max  TYPE i.
    rs_resp-operation = 'img_search'.
    rs_resp-version   = c_version.

    lv_kw = to_upper( is_req-keyword ).
    IF lv_kw IS INITIAL.
      rs_resp-status = 'error'.
      APPEND 'img_search needs a keyword' TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_lang = COND #( WHEN is_req-language IS NOT INITIAL THEN is_req-language(1) ELSE 'E' ).
    lv_max  = COND #( WHEN is_req-max_rows > 0 THEN is_req-max_rows ELSE 200 ).

    " Escape LIKE metacharacters in the keyword (ESCAPE '#'), then wrap with %.
    lv_pat = lv_kw.
    REPLACE ALL OCCURRENCES OF '#' IN lv_pat WITH '##'.
    REPLACE ALL OCCURRENCES OF '%' IN lv_pat WITH '#%'.
    REPLACE ALL OCCURRENCES OF '_' IN lv_pat WITH '#_'.
    CONCATENATE '%' lv_pat '%' INTO lv_pat.

    TYPES: BEGIN OF ty_hit,
             activity   TYPE cus_imgact-activity,
             text       TYPE cus_imgact-text,
             objecttype TYPE cus_actobj-objecttype,
             objectname TYPE cus_actobj-objectname,
             tcode      TYPE cus_actobj-tcode,
           END OF ty_hit.
    DATA lt_hit TYPE STANDARD TABLE OF ty_hit.

    TRY.
        SELECT a~activity, a~text, o~objecttype, o~objectname, o~tcode
          FROM cus_imgact AS a
          LEFT OUTER JOIN cus_actobj AS o ON o~act_id = a~activity
          WHERE a~spras = @lv_lang
            AND ( upper( a~text ) LIKE @lv_pat ESCAPE '#'
               OR a~activity      LIKE @lv_pat ESCAPE '#' )
          ORDER BY a~activity
          INTO CORRESPONDING FIELDS OF TABLE @lt_hit
          UP TO @lv_max ROWS.
      CATCH cx_sy_open_sql_db INTO DATA(lx_sql).
        rs_resp-status = 'error'.
        APPEND |img_search SQL failed: { lx_sql->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    rs_resp-status       = 'ok'.
    rs_resp-rows_planned = lines( lt_hit ).
    APPEND |Found { lines( lt_hit ) } IMG activit{ COND string( WHEN lines( lt_hit ) = 1 THEN 'y' ELSE 'ies' ) }| &&
           | matching '{ lv_kw }' (title or activity id, full CUS_IMGACT scan)|
      TO rs_resp-messages.
    IF lines( lt_hit ) >= lv_max.
      APPEND |Result capped at { lv_max } rows — raise max_rows or narrow the keyword for the rest|
        TO rs_resp-messages.
    ENDIF.
    rs_resp-data_json = /ui2/cl_json=>serialize(
      data        = lt_hit
      pretty_name = /ui2/cl_json=>pretty_mode-none ).
  ENDMETHOD.


  METHOD handle_img_index_read.
    " Read the STREE/SHI IMG search text index (INDX_HSRCH cluster, built by
    " RS_SHI10_TEXTINDEX_UPDATE) for a structure_id, filter node titles by
    " keyword, and reconstruct each hit's IMG breadcrumb from the structure
    " hierarchy — all in one ABAP IMPORT.  One read of the root structure
    " covers the entire SAP Reference IMG.  Area-agnostic: no per-area code.
    TYPES: BEGIN OF ty_hit,
             text         TYPE string,
             node_id      TYPE string,
             extension    TYPE string,
             structure_id TYPE string,
             path         TYPE string,
           END OF ty_hit.
    DATA: lt_txt  TYPE STANDARD TABLE OF hier_srctx,
          lt_chl  TYPE STANDARD TABLE OF hier_ctree,
          lt_gen  TYPE STANDARD TABLE OF ttreesrch,
          lt_hits TYPE STANDARD TABLE OF ty_hit,
          lt_tmap TYPE SORTED TABLE OF hier_srctx WITH NON-UNIQUE KEY id node_id,
          lt_pmap TYPE SORTED TABLE OF hier_ctree WITH NON-UNIQUE KEY child_id,
          lv_sid  TYPE ttree-id,
          lv_lang TYPE sy-langu,
          lv_imp  TYPE sy-langu,
          lv_disp TYPE sy-langu,
          lv_max  TYPE i,
          lv_kw   TYPE string,
          lv_cnt  TYPE i.

    rs_resp-operation = 'img_index_read'.

    lv_sid  = COND #( WHEN is_req-structure_id IS NOT INITIAL
                      THEN is_req-structure_id
                      ELSE '368DDFAB3AB96CCFE10000009B38F976' ).
    lv_lang = COND #( WHEN is_req-language IS NOT INITIAL
                      THEN is_req-language(1) ELSE sy-langu ).
    lv_max  = COND #( WHEN is_req-max_rows > 0 THEN is_req-max_rows ELSE 50 ).
    lv_kw   = to_upper( is_req-keyword ).
    rs_resp-table = lv_sid.

    " Which language generations exist for this tree? (TTREESRCH directory)
    SELECT * FROM ttreesrch INTO TABLE lt_gen WHERE tree_id = lv_sid.
    IF lines( lt_gen ) = 0.
      rs_resp-status = 'no_index'.
      APPEND |No STREE text index for structure { lv_sid } — caller should fall back to raw IMG tables|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Pick the generation to IMPORT: requested language if generated, else
    " prefer E, then D, then whatever exists.  The blob holds ALL languages
    " regardless, so the area only has to be a valid existing generation.
    lv_imp = lv_lang.
    READ TABLE lt_gen TRANSPORTING NO FIELDS WITH KEY spras = lv_imp.
    IF sy-subrc <> 0.
      READ TABLE lt_gen INTO DATA(ls_gen) WITH KEY spras = 'E'.
      IF sy-subrc <> 0.
        READ TABLE lt_gen INTO ls_gen WITH KEY spras = 'D'.
      ENDIF.
      IF sy-subrc <> 0.
        READ TABLE lt_gen INTO ls_gen INDEX 1.
      ENDIF.
      lv_imp = ls_gen-spras.
    ENDIF.

    " IMPORT the chosen generation. The cluster area must be a 2-char literal,
    " so branch per language (generated WHEN list, mirroring SAPLSHI10).
    DATA lv_got TYPE abap_bool.
    TRY.
        CASE lv_imp.
{{HSRCH_AREA_CASES}}
          WHEN OTHERS.
        ENDCASE.
      CATCH cx_root INTO DATA(lx).
        rs_resp-status = 'error'.
        APPEND |HSRCH IMPORT failed (lang { lv_imp }): { lx->get_text( ) }|
          TO rs_resp-messages.
        RETURN.
    ENDTRY.
    IF lv_got = abap_false.
      rs_resp-status = 'no_index'.
      APPEND |No HSRCH area mapping for language '{ lv_imp }' — fall back to raw IMG tables|
        TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF lines( lt_txt ) = 0.
      rs_resp-status = 'error'.
      APPEND |HSRCH cluster empty for { lv_sid } lang { lv_imp } (rc={ sy-subrc })|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    " Display language: requested if present in the blob, else the import lang
    lv_disp = lv_lang.
    READ TABLE lt_txt TRANSPORTING NO FIELDS WITH KEY spras = lv_disp.
    IF sy-subrc <> 0.
      lv_disp = lv_imp.
      APPEND |Requested language '{ lv_lang }' not indexed; showing '{ lv_disp }'|
        TO rs_resp-messages.
    ENDIF.

    " Lookup tables for breadcrumb reconstruction
    LOOP AT lt_txt INTO DATA(ls_m) WHERE spras = lv_disp.
      INSERT ls_m INTO TABLE lt_tmap.
    ENDLOOP.
    lt_pmap = lt_chl.

    " Collect keyword hits + breadcrumb path
    LOOP AT lt_txt INTO DATA(ls_h) WHERE spras = lv_disp.
      DATA(lv_up) = to_upper( ls_h-text ).
      IF lv_kw IS NOT INITIAL AND lv_up NS lv_kw.
        CONTINUE.
      ENDIF.

      " Walk structures upward: hit lives in structure ls_h-id; find the
      " child_structures row whose CHILD_ID = current structure to get the
      " parent structure (ID) + the anchor node (CHILD_NODE) it hangs under.
      DATA: lv_cs   TYPE hier_treeg,
            lv_path TYPE string.
      lv_cs   = ls_h-id.
      lv_path = ls_h-text.
      DO 30 TIMES.
        READ TABLE lt_pmap INTO DATA(ls_p) WITH KEY child_id = lv_cs.
        IF sy-subrc <> 0.
          EXIT.
        ENDIF.
        READ TABLE lt_tmap INTO DATA(ls_pt)
          WITH KEY id = ls_p-id node_id = ls_p-child_node.
        IF sy-subrc = 0 AND ls_pt-text IS NOT INITIAL.
          lv_path = ls_pt-text && | > | && lv_path.
        ENDIF.
        IF ls_p-id = lv_cs.
          EXIT.
        ENDIF.
        lv_cs = ls_p-id.
      ENDDO.

      APPEND VALUE ty_hit( text         = ls_h-text
                           node_id      = ls_h-node_id
                           extension    = ls_h-extension
                           structure_id = ls_h-id
                           path         = lv_path ) TO lt_hits.
      lv_cnt = lv_cnt + 1.
      IF lv_cnt >= lv_max.
        EXIT.
      ENDIF.
    ENDLOOP.

    rs_resp-rows_planned = lv_cnt.
    rs_resp-status       = 'ok'.
    APPEND |source=STREE index gen_date={ lt_gen[ 1 ]-gen_date } gen_lang={ lv_imp } | &&
           |disp_lang={ lv_disp } nodes={ lines( lt_txt ) } hits={ lv_cnt }|
      TO rs_resp-messages.
    rs_resp-data_json = /ui2/cl_json=>serialize(
      data        = lt_hits
      pretty_name = /ui2/cl_json=>pretty_mode-none ).
  ENDMETHOD.


  METHOD submit_batch_write.
    " Runs the write LUW in a background job (sy-batch='X') to allow
    " TR_OBJECTS_INSERT to execute headlessly.  Communicates via INDX cluster
    " table areas ZP (params in) and ZR (result out), keyed by 22-char run_id.
    " Polls up to 25 s; returns pending=true + run_id if job not done in time.
    " MUST match the report's ty_params field-for-field and in the SAME ORDER:
    " EXPORT/IMPORT ... TO/FROM DATABASE assigns the structure POSITIONALLY, not
    " by component name. submit_org_copy and ZMCP_CUST_WRITE share this layout.
    TYPES: BEGIN OF ty_params,
             op               TYPE string,   " '' = write ; 'ORGCOPY' = entity copier
             table_name       TYPE string,
             view_name        TYPE string,   " maintenance object ('' = direct table write)
             transport_object TYPE string,   " 'VDAT' | 'TABU' | 'CDAT'
             cluster_name     TYPE string,   " view cluster (transport_object='CDAT')
             transport        TYPE string,
             action           TYPE string,   " '' / 'INS' = upsert ; 'DEL' = delete
             plan_json        TYPE string,
             tabkeys_json     TYPE string,
             org_unit         TYPE string,   " org-copy only
             source_orgunit   TYPE string,
             target_orgunit   TYPE string,
             extras_json      TYPE string,   " view fields outside the base table, per plan row (appended: layout is positional)
           END OF ty_params.

    DATA: ls_params   TYPE ty_params,
          ls_jres     TYPE ty_jres,
          lv_run_id   TYPE c LENGTH 22,
          lv_jobname  TYPE btcjob,
          lv_jobcount TYPE btcjobcnt.
    FIELD-SYMBOLS <plan> TYPE STANDARD TABLE.

    " Generate unique run_id
    TRY.
        lv_run_id = cl_system_uuid=>create_uuid_c22_static( ).
      CATCH cx_uuid_error.
        CONCATENATE sy-mandt sy-datum sy-uzeit INTO lv_run_id.
    ENDTRY.

    " Serialize plan and tabkeys to JSON for the batch report
    ASSIGN ir_plan->* TO <plan>.
    /ui2/cl_json=>serialize(
      EXPORTING data        = <plan>
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = ls_params-plan_json ).
    /ui2/cl_json=>serialize(
      EXPORTING data        = it_keys
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = ls_params-tabkeys_json ).
    ls_params-extras_json = is_req-extras_json.
    ls_params-op               = ''.   " write path (≠ 'ORGCOPY')
    ls_params-table_name       = is_req-table.
    ls_params-view_name        = is_req-view_name.
    ls_params-transport_object = is_req-transport_object.
    ls_params-cluster_name     = is_req-cluster_name.
    ls_params-transport        = is_req-transport.
    ls_params-action           = is_req-action.

    " Write params to INDX before the job starts
    EXPORT data = ls_params TO DATABASE indx(ZP) ID lv_run_id.

    " Open job, register step, close (start immediately)
    lv_jobname = 'ZMCP_CUST_WRITE'.
    CALL FUNCTION 'JOB_OPEN'
      EXPORTING  jobname         = lv_jobname
      IMPORTING  jobcount        = lv_jobcount
      EXCEPTIONS cant_create_job = 1
                 OTHERS          = 2.
    IF sy-subrc <> 0.
      APPEND |JOB_OPEN failed (subrc { sy-subrc }) — cannot schedule batch writer|
        TO ct_messages.
      DELETE FROM DATABASE indx(ZP) ID lv_run_id.
      RETURN.
    ENDIF.

    SUBMIT zmcp_cust_write WITH p_runid = lv_run_id
      VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.

    CALL FUNCTION 'JOB_CLOSE'
      EXPORTING jobname               = lv_jobname
                jobcount              = lv_jobcount
                strtimmed             = 'X'
      EXCEPTIONS cant_start_immediate = 1
                 invalid_starttime    = 2
                 OTHERS               = 3.
    IF sy-subrc <> 0.
      APPEND |JOB_CLOSE failed (subrc { sy-subrc }) — job may not start|
        TO ct_messages.
      DELETE FROM DATABASE indx(ZP) ID lv_run_id.
      RETURN.
    ENDIF.

    " Record the job handle so handle_status can cross-check TBTCO (running /
    " queued / aborted) rather than reporting a blanket 'pending'.
    write_job_handle( iv_run_id    = lv_run_id
                      iv_jobname   = lv_jobname
                      iv_jobcount  = lv_jobcount
                      iv_kind      = 'WRITE'
                      iv_table     = is_req-table
                      iv_transport = is_req-transport ).

    " Short initial poll (catches the common fast-job case without a second
    " round-trip).  If the job isn't done in time, return pending + run_id and
    " let the caller poll via operation 'status' — this keeps the write call
    " well under the HTTP/MCP timeouts instead of block-waiting the full job.
    DATA lv_done TYPE abap_bool VALUE abap_false.
    DO 8 TIMES.
      WAIT UP TO 1 SECONDS.
      IMPORT data = ls_jres FROM DATABASE indx(ZR) ID lv_run_id.
      IF sy-subrc = 0.
        lv_done = abap_true.
        EXIT.
      ENDIF.
    ENDDO.

    IF lv_done = abap_false.
      rs_res-pending = abap_true.
      rs_res-run_id  = lv_run_id.
      APPEND |Batch job still running after 8 s — run_id { lv_run_id }|
        TO ct_messages.
      RETURN.
    ENDIF.

    DELETE FROM DATABASE indx(ZR) ID lv_run_id.

    LOOP AT ls_jres-messages INTO DATA(lv_m).
      APPEND lv_m TO ct_messages.
    ENDLOOP.

    IF ls_jres-status = 'ok'.
      rs_res-ok           = abap_true.
      rs_res-rows_written = ls_jres-rows_written.
      rs_res-e071k_count  = ls_jres-e071k_count.
    ENDIF.
  ENDMETHOD.


  METHOD submit_org_copy.
    " Same job/INDX/poll contract as submit_batch_write, but the params drive the
    " report's op='ORGCOPY' branch (ECOP_ORG_UNITS_IN_THE_DARK in batch). No plan
    " or tabkeys — the copier resolves its own dependent-table set.
    " MUST match the report's ty_params field-for-field and in the SAME ORDER —
    " EXPORT/IMPORT ... TO/FROM DATABASE is positional (see submit_batch_write).
    TYPES: BEGIN OF ty_params,
             op               TYPE string,
             table_name       TYPE string,
             view_name        TYPE string,
             transport_object TYPE string,
             cluster_name     TYPE string,
             transport        TYPE string,
             action           TYPE string,   " 'COPY' / 'DELE'
             plan_json        TYPE string,
             tabkeys_json     TYPE string,
             org_unit         TYPE string,
             source_orgunit   TYPE string,
             target_orgunit   TYPE string,
             extras_json      TYPE string,   " view fields outside the base table, per plan row (appended: layout is positional)
           END OF ty_params.

    DATA: ls_params   TYPE ty_params,
          ls_jres     TYPE ty_jres,
          lv_run_id   TYPE c LENGTH 22,
          lv_jobname  TYPE btcjob,
          lv_jobcount TYPE btcjobcnt.

    TRY.
        lv_run_id = cl_system_uuid=>create_uuid_c22_static( ).
      CATCH cx_uuid_error.
        CONCATENATE sy-mandt sy-datum sy-uzeit INTO lv_run_id.
    ENDTRY.

    ls_params-op             = 'ORGCOPY'.
    ls_params-transport      = is_req-transport.
    ls_params-action         = COND #( WHEN to_upper( is_req-action ) = 'DELE'
                                       THEN 'DELE' ELSE 'COPY' ).
    ls_params-org_unit       = to_upper( is_req-org_unit ).
    ls_params-source_orgunit = is_req-source_key.
    ls_params-target_orgunit = is_req-target_key.

    EXPORT data = ls_params TO DATABASE indx(ZP) ID lv_run_id.

    lv_jobname = 'ZMCP_CUST_WRITE'.
    CALL FUNCTION 'JOB_OPEN'
      EXPORTING  jobname         = lv_jobname
      IMPORTING  jobcount        = lv_jobcount
      EXCEPTIONS cant_create_job = 1
                 OTHERS          = 2.
    IF sy-subrc <> 0.
      APPEND |JOB_OPEN failed (subrc { sy-subrc }) — cannot schedule the org copier|
        TO ct_messages.
      DELETE FROM DATABASE indx(ZP) ID lv_run_id.
      RETURN.
    ENDIF.

    SUBMIT zmcp_cust_write WITH p_runid = lv_run_id
      VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.

    CALL FUNCTION 'JOB_CLOSE'
      EXPORTING jobname               = lv_jobname
                jobcount              = lv_jobcount
                strtimmed             = 'X'
      EXCEPTIONS cant_start_immediate = 1
                 invalid_starttime    = 2
                 OTHERS               = 3.
    IF sy-subrc <> 0.
      APPEND |JOB_CLOSE failed (subrc { sy-subrc }) — job may not start|
        TO ct_messages.
      DELETE FROM DATABASE indx(ZP) ID lv_run_id.
      RETURN.
    ENDIF.

    write_job_handle( iv_run_id    = lv_run_id
                      iv_jobname   = lv_jobname
                      iv_jobcount  = lv_jobcount
                      iv_kind      = 'ORGCOPY'
                      iv_transport = is_req-transport ).

    " A whole-org-unit copy can run for a while; poll briefly, else hand back the
    " run_id so the caller polls via operation 'status' (keeps us under timeouts).
    DATA lv_done TYPE abap_bool VALUE abap_false.
    DO 8 TIMES.
      WAIT UP TO 1 SECONDS.
      IMPORT data = ls_jres FROM DATABASE indx(ZR) ID lv_run_id.
      IF sy-subrc = 0.
        lv_done = abap_true.
        EXIT.
      ENDIF.
    ENDDO.

    IF lv_done = abap_false.
      rs_res-pending = abap_true.
      rs_res-run_id  = lv_run_id.
      RETURN.
    ENDIF.

    DELETE FROM DATABASE indx(ZR) ID lv_run_id.

    LOOP AT ls_jres-messages INTO DATA(lv_m).
      APPEND lv_m TO ct_messages.
    ENDLOOP.

    IF ls_jres-status = 'ok'.
      rs_res-ok           = abap_true.
      rs_res-rows_written = ls_jres-rows_written.
      rs_res-e071k_count  = ls_jres-e071k_count.
      rs_res-transport    = ls_jres-transport.
    ENDIF.
  ENDMETHOD.


  METHOD submit_listing.
    " Same job/INDX/poll contract as submit_org_copy, but the params drive the
    " report's op='LISTING' branch (EXECUTE_LISTING_ART_ASSORT_RFC in batch).
    " The serialized WINT_LISTING_ITEM_TAB rides in plan_json; no tabkeys/org
    " fields. MUST match the report's ty_params field-for-field and in the SAME
    " ORDER — EXPORT/IMPORT ... TO/FROM DATABASE is positional.
    TYPES: BEGIN OF ty_params,
             op               TYPE string,
             table_name       TYPE string,
             view_name        TYPE string,
             transport_object TYPE string,
             cluster_name     TYPE string,
             transport        TYPE string,
             action           TYPE string,
             plan_json        TYPE string,
             tabkeys_json     TYPE string,
             org_unit         TYPE string,
             source_orgunit   TYPE string,
             target_orgunit   TYPE string,
             extras_json      TYPE string,   " view fields outside the base table, per plan row (appended: layout is positional)
           END OF ty_params.

    DATA: ls_params   TYPE ty_params,
          ls_jres     TYPE ty_jres,
          lv_run_id   TYPE c LENGTH 22,
          lv_jobname  TYPE btcjob,
          lv_jobcount TYPE btcjobcnt.

    TRY.
        lv_run_id = cl_system_uuid=>create_uuid_c22_static( ).
      CATCH cx_uuid_error.
        CONCATENATE sy-mandt sy-datum sy-uzeit INTO lv_run_id.
    ENDTRY.

    ls_params-op        = 'LISTING'.
    ls_params-plan_json = iv_items_json.   " serialized WINT_LISTING_ITEM_TAB

    EXPORT data = ls_params TO DATABASE indx(ZP) ID lv_run_id.

    lv_jobname = 'ZMCP_CUST_WRITE'.
    CALL FUNCTION 'JOB_OPEN'
      EXPORTING  jobname         = lv_jobname
      IMPORTING  jobcount        = lv_jobcount
      EXCEPTIONS cant_create_job = 1
                 OTHERS          = 2.
    IF sy-subrc <> 0.
      APPEND |JOB_OPEN failed (subrc { sy-subrc }) — cannot schedule the listing engine|
        TO ct_messages.
      DELETE FROM DATABASE indx(ZP) ID lv_run_id.
      RETURN.
    ENDIF.

    SUBMIT zmcp_cust_write WITH p_runid = lv_run_id
      VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.

    CALL FUNCTION 'JOB_CLOSE'
      EXPORTING jobname               = lv_jobname
                jobcount              = lv_jobcount
                strtimmed             = 'X'
      EXCEPTIONS cant_start_immediate = 1
                 invalid_starttime    = 2
                 OTHERS               = 3.
    IF sy-subrc <> 0.
      APPEND |JOB_CLOSE failed (subrc { sy-subrc }) — job may not start|
        TO ct_messages.
      DELETE FROM DATABASE indx(ZP) ID lv_run_id.
      RETURN.
    ENDIF.

    write_job_handle( iv_run_id   = lv_run_id
                      iv_jobname  = lv_jobname
                      iv_jobcount = lv_jobcount
                      iv_kind     = 'LISTING' ).

    DATA lv_done TYPE abap_bool VALUE abap_false.
    DO 8 TIMES.
      WAIT UP TO 1 SECONDS.
      IMPORT data = ls_jres FROM DATABASE indx(ZR) ID lv_run_id.
      IF sy-subrc = 0.
        lv_done = abap_true.
        EXIT.
      ENDIF.
    ENDDO.

    IF lv_done = abap_false.
      rs_res-pending = abap_true.
      rs_res-run_id  = lv_run_id.
      RETURN.
    ENDIF.

    DELETE FROM DATABASE indx(ZR) ID lv_run_id.

    LOOP AT ls_jres-messages INTO DATA(lv_m).
      APPEND lv_m TO ct_messages.
    ENDLOOP.

    IF ls_jres-status = 'ok'.
      rs_res-ok           = abap_true.
      rs_res-rows_written = ls_jres-rows_written.
    ENDIF.
  ENDMETHOD.


  METHOD create_cust_transport.
    DATA: ls_hdr   TYPE trwbo_request_header,
          lt_tasks TYPE trwbo_request_headers,
          lt_users TYPE scts_users,
          ls_user  TYPE scts_user.
    " A task is only created for users passed in it_users; without it the
    " request has no task and objects can't be recorded the SM30 way.
    ls_user-user = sy-uname.
    APPEND ls_user TO lt_users.
    CALL FUNCTION 'TR_INSERT_REQUEST_WITH_TASKS'
      EXPORTING
        iv_type           = 'W'           " W = customizing request
        iv_text           = iv_text
        iv_owner          = sy-uname
        it_users          = lt_users
      IMPORTING
        es_request_header = ls_hdr
        et_task_headers   = lt_tasks
      EXCEPTIONS
        insert_failed     = 1
        enqueue_failed    = 2
        OTHERS            = 3.
    IF sy-subrc <> 0.
      RETURN.   " ev_request/ev_task stay empty → caller errors out
    ENDIF.
    ev_request = ls_hdr-trkorr.
    " Objects are recorded on the user's customizing task, not the request head
    READ TABLE lt_tasks INTO DATA(ls_task) INDEX 1.
    ev_task = COND #( WHEN sy-subrc = 0 THEN ls_task-trkorr ELSE ls_hdr-trkorr ).
  ENDMETHOD.


  METHOD ensure_user_task.
    CLEAR: ev_task, ev_request, ev_created, ev_msg.

    SELECT SINGLE strkorr, trfunction FROM e070
      INTO @DATA(ls_hdr)
      WHERE trkorr = @iv_transport.
    IF sy-subrc <> 0.
      ev_msg = |Transport { iv_transport } does not exist|.
      RETURN.
    ENDIF.

    " Already a task → record onto it; report its parent request.
    IF ls_hdr-strkorr IS NOT INITIAL.
      ev_task    = iv_transport.
      ev_request = ls_hdr-strkorr.
      RETURN.
    ENDIF.

    " A request → find the current user's modifiable task under it.
    ev_request = iv_transport.
    SELECT trkorr FROM e070
      INTO TABLE @DATA(lt_tasks)
      UP TO 1 ROWS
      WHERE strkorr  = @iv_transport
        AND as4user  = @sy-uname
        AND trstatus = 'D'.
    IF lt_tasks IS NOT INITIAL.
      ev_task = lt_tasks[ 1 ].
      RETURN.   " user already owns a task here
    ENDIF.

    " No task for this user → create one (customizing task 'Q' under a 'W'
    " request, dev/correction 'S' under a workbench request).
    IF fm_exists( 'TRINT_INSERT_NEW_COMM' ) = abap_false.
      ev_msg = |Cannot create a task under { iv_transport }: TRINT_INSERT_NEW_COMM | &&
               |is not available on this release — supply a transport you already own a task in|.
      RETURN.
    ENDIF.
    DATA(lv_tf) = COND e070-trfunction( WHEN ls_hdr-trfunction = 'W' THEN 'Q' ELSE 'S' ).
    DATA lv_text TYPE e07t-as4text.
    lv_text = |MCP task ({ sy-uname })|.
    CALL FUNCTION 'TRINT_INSERT_NEW_COMM'
      EXPORTING
        wi_strkorr    = iv_transport
        wi_trfunction = lv_tf
        wi_kurztext   = lv_text
        iv_username   = sy-uname
      IMPORTING
        we_trkorr     = ev_task
      EXCEPTIONS
        OTHERS        = 1.
    IF sy-subrc <> 0 OR ev_task IS INITIAL.
      CLEAR ev_task.
      ev_msg = |Could not create a task under { iv_transport } (subrc { sy-subrc })|.
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    ev_created = abap_true.
  ENDMETHOD.

  METHOD sy_message_text.
    IF sy-msgid IS INITIAL.
      RETURN.
    ENDIF.
    DATA lv_text TYPE string.
    MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_text.
    rv_text = |{ sy-msgid }{ sy-msgno }: { lv_text }|.
  ENDMETHOD.


  METHOD handle_transport_move.
    TYPES: BEGIN OF ty_move_obj,
             trkorr   TYPE trkorr,
             pgmid    TYPE pgmid,
             object   TYPE trobjtype,
             obj_name TYPE trobj_name,
           END OF ty_move_obj,
           ty_move_obj_tt TYPE STANDARD TABLE OF ty_move_obj WITH DEFAULT KEY.

    DATA lv_to   TYPE trkorr.
    DATA lv_test TYPE abap_bool.

    rs_resp-operation = 'transport_move'.
    rs_resp-version   = c_version.
    lv_to   = to_upper( is_req-to_trkorr ).
    lv_test = xsdbool( is_req-commit <> abap_true ).
    rs_resp-dry_run   = lv_test.
    rs_resp-transport = lv_to.

    IF lv_to IS INITIAL.
      rs_resp-status = 'error'.
      APPEND `No target request (TO_TRKORR) given.` TO rs_resp-messages.
      RETURN.
    ENDIF.

    CASE to_upper( is_req-action ).

      WHEN 'TASK'.
        DATA lv_task TYPE trkorr.
        lv_task = to_upper( is_req-from_trkorr ).
        IF lv_test = abap_true.
          rs_resp-status = 'ok'.
          APPEND |Test: task { lv_task } → request { lv_to }. SAP has no test mode for reassigning a task; | &&
                 |it checks at commit.| TO rs_resp-messages.
          RETURN.
        ENDIF.
        CALL FUNCTION 'TR_REASSIGN_TASK'
          EXPORTING
            iv_dialog              = abap_false
          CHANGING
            cv_task                = lv_task
            cv_new_request         = lv_to
          EXCEPTIONS
            no_authorization       = 1
            enqueue_failure        = 2
            db_access_error        = 3
            invalid_request        = 4
            invalid_task           = 5
            shared_objects         = 6
            action_aborted_by_user = 7
            OTHERS                 = 8.
        IF sy-subrc <> 0.
          DATA(lv_task_rc) = sy-subrc.
          DATA(lv_task_msg) = sy_message_text( ).
          ROLLBACK WORK.
          rs_resp-status = 'error'.
          APPEND |TR_REASSIGN_TASK rc { lv_task_rc }{ COND string( WHEN lv_task_msg IS NOT INITIAL THEN | — { lv_task_msg }| ) }|
            TO rs_resp-messages.
          RETURN.
        ENDIF.
        COMMIT WORK AND WAIT.
        rs_resp-status = 'ok'.
        rs_resp-rows_written = 1.
        APPEND |Task { lv_task } now belongs to request { lv_to }.| TO rs_resp-messages.

      WHEN 'OBJECTS'.
        DATA lt_objs TYPE ty_move_obj_tt.
        TRY.
            /ui2/cl_json=>deserialize( EXPORTING json = is_req-objects_json
                                                 pretty_name = /ui2/cl_json=>pretty_mode-none
                                       CHANGING  data = lt_objs ).
          CATCH cx_root INTO DATA(lx_json).
            rs_resp-status = 'error'.
            APPEND |Cannot read OBJECTS_JSON: { lx_json->get_text( ) }| TO rs_resp-messages.
            RETURN.
        ENDTRY.
        IF lt_objs IS INITIAL.
          rs_resp-status = 'error'.
          APPEND `No objects to move.` TO rs_resp-messages.
          RETURN.
        ENDIF.

        DATA lt_sources TYPE STANDARD TABLE OF trkorr WITH DEFAULT KEY.
        LOOP AT lt_objs ASSIGNING FIELD-SYMBOL(<ls_o>).
          <ls_o>-trkorr = to_upper( <ls_o>-trkorr ).
          COLLECT <ls_o>-trkorr INTO lt_sources.
        ENDLOOP.

        DATA lv_failed TYPE abap_bool.
        LOOP AT lt_sources INTO DATA(lv_src).
          DATA(lt_keys) = VALUE ty_move_obj_tt( FOR o IN lt_objs WHERE ( trkorr = lv_src ) ( o ) ).
          DATA lt_e071 TYPE tr_objects.
          CLEAR lt_e071.
          SELECT * FROM e071 INTO TABLE @lt_e071
            FOR ALL ENTRIES IN @lt_keys
            WHERE trkorr   = @lv_src
              AND pgmid    = @lt_keys-pgmid
              AND object   = @lt_keys-object
              AND obj_name = @lt_keys-obj_name.
          IF lines( lt_e071 ) <> lines( lt_keys ).
            lv_failed = abap_true.
            APPEND |{ lv_src }: { lines( lt_keys ) } entries asked, { lines( lt_e071 ) } found in E071 — | &&
                   |the request changed since it was read.| TO rs_resp-messages.
            CONTINUE.
          ENDIF.

          DATA ls_from TYPE trwbo_request.
          DATA ls_to   TYPE trwbo_request_header.
          CLEAR: ls_from, ls_to.
          ls_from-h-trkorr = lv_src.
          ls_to-trkorr     = lv_to.
          CALL FUNCTION 'TR_MOVE_OBJECTS'
            EXPORTING
              it_e071                      = lt_e071
              iv_suppress_dialog           = abap_true
              iv_testmode                  = lv_test
            CHANGING
              cs_request_from              = ls_from
              cs_request_to_header         = ls_to
            EXCEPTIONS
              database_access_error        = 1
              no_authorization             = 2
              request_from_other_system    = 3
              request_already_released     = 4
              wrong_source_client          = 5
              user_not_owner               = 6
              no_move_of_corr_entry        = 7
              object_entry_doesnt_exist    = 8
              duplicate_entry              = 9
              empty_lockkey                = 10
              foreign_lock                 = 11
              request_types_not_consistent = 12
              canceled_by_user             = 13
              OTHERS                       = 14.
          IF sy-subrc <> 0.
            DATA(lv_rc) = sy-subrc.
            DATA(lv_msg) = sy_message_text( ).
            lv_failed = abap_true.
            APPEND |{ lv_src } → { lv_to }: TR_MOVE_OBJECTS rc { lv_rc }| &&
                   |{ COND string( WHEN lv_msg IS NOT INITIAL THEN | — { lv_msg }| ) }| TO rs_resp-messages.
          ELSE.
            rs_resp-rows_planned = rs_resp-rows_planned + lines( lt_e071 ).
            APPEND |{ lv_src } → { lv_to }: { lines( lt_e071 ) } entr{ COND string( WHEN lines( lt_e071 ) = 1 THEN `y` ELSE `ies` ) } | &&
                   |{ COND string( WHEN lv_test = abap_true AND lines( lt_e071 ) = 1 THEN `passes SAP's test move`
                                   WHEN lv_test = abap_true THEN `pass SAP's test move` ELSE `moved` ) }.| TO rs_resp-messages.
          ENDIF.
        ENDLOOP.

        IF lv_failed = abap_true OR lv_test = abap_true.
          ROLLBACK WORK.
        ELSE.
          COMMIT WORK AND WAIT.
          rs_resp-rows_written = rs_resp-rows_planned.
        ENDIF.
        rs_resp-status = COND #( WHEN lv_failed = abap_true THEN 'error' ELSE 'ok' ).
        IF lv_failed = abap_true AND lv_test = abap_false.
          APPEND `Nothing was moved: every group is rolled back when one fails.` TO rs_resp-messages.
        ENDIF.

      WHEN OTHERS.
        rs_resp-status = 'error'.
        APPEND |Unknown action '{ is_req-action }' — expected OBJECTS or TASK.| TO rs_resp-messages.
    ENDCASE.
  ENDMETHOD.

ENDCLASS.