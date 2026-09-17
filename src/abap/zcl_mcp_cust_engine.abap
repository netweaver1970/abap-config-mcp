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

    METHODS handle_ping
      RETURNING VALUE(rs_resp) TYPE ty_response.

    METHODS handle_read
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_response.

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

        " Dispatch
        IF ls_resp-status <> 'error'.
          CASE to_lower( ls_req-operation ).
            WHEN 'ping'.     ls_resp = handle_ping( ).
            WHEN 'read'.     ls_resp = handle_read( ls_req ).
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
            WHEN OTHERS.
              ls_resp-status = 'error'.
              APPEND |Unknown operation: '{ ls_req-operation }'|
                TO ls_resp-messages.
          ENDCASE.
        ENDIF.

        ls_resp-version = c_version.

        " Serialize response
        /ui2/cl_json=>serialize(
          EXPORTING data        = ls_resp
                    pretty_name = /ui2/cl_json=>pretty_mode-none
          RECEIVING r_json      = lv_out ).

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


  METHOD handle_ping.
    rs_resp-status    = 'ok'.
    rs_resp-operation = 'ping'.
    rs_resp-version   = c_version.
    APPEND |MCP Customizing Engine alive on { sy-sysid } client { sy-mandt }|
      TO rs_resp-messages.

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
      rs_resp-status = 'ok'.
      APPEND |DRY RUN — { lv_action } '{ lv_desc }' ({ lv_org_unit }): { lv_source } → { lv_target } | &&
             |— commit to copy the org unit with its dependent customizing|
        TO rs_resp-messages.
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
          lv_max   TYPE i.
    FIELD-SYMBOLS <tab> TYPE STANDARD TABLE.

    rs_resp-operation = 'read'.
    rs_resp-table     = is_req-table.

    IF is_valid_name( is_req-table ) = abap_false
    OR is_valid_name( is_req-key_field ) = abap_false.
      rs_resp-status = 'error'.
      APPEND 'Invalid table or key field name' TO rs_resp-messages.
      RETURN.
    ENDIF.

    lv_max = COND i( WHEN is_req-max_rows > 0 THEN is_req-max_rows ELSE 100 ).

    TRY.
        CREATE DATA lr_tab TYPE STANDARD TABLE OF (is_req-table).
        ASSIGN lr_tab->* TO <tab>.
      CATCH cx_root INTO DATA(lx_ce).
        rs_resp-status = 'error'.
        APPEND |Cannot type table { is_req-table }: { lx_ce->get_text( ) }|
          TO rs_resp-messages.
        RETURN.
    ENDTRY.

    TRY.
        IF is_req-source_key IS NOT INITIAL.
          lv_where = |{ is_req-key_field } = '{ esc_quote( is_req-source_key ) }'|.
          SELECT * FROM (is_req-table) UP TO lv_max ROWS
            INTO TABLE <tab>
            WHERE (lv_where).
        ELSE.
          SELECT * FROM (is_req-table) UP TO lv_max ROWS INTO TABLE <tab>.
        ENDIF.
      CATCH cx_root INTO DATA(lx_sel).
        rs_resp-status = 'error'.
        APPEND |SELECT failed: { lx_sel->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.

    rs_resp-status       = 'ok'.
    rs_resp-rows_planned = lines( <tab> ).
    /ui2/cl_json=>serialize(
      EXPORTING data        = <tab>
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
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
               |TBTCO 'A') — no result was written. Check SM37 job log / ST22.| TO rs_resp-messages.
      WHEN 'F'.                       " finished but wrote no ZR result → dumped mid-run
        rs_resp-status = 'aborted'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } FINISHED (TBTCO 'F') but produced no | &&
               |result — it likely dumped mid-run. Check ST22 / SM37 job log.| TO rs_resp-messages.
      WHEN OTHERS.
        rs_resp-status = 'pending'.
        APPEND |Job { ls_jh-jobname }/{ ls_jh-jobcount } TBTCO status '{ lv_jstat }'|
          TO rs_resp-messages.
    ENDCASE.
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

ENDCLASS.