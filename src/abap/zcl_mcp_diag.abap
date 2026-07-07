CLASS zcl_mcp_diag DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

* MCP read-only DIAGNOSTIC engine (Tier 0). Self-contained: depends only on
* basis objects (T000, CVERS, TSTC, TFDIR, SYS.M_* via ADBC, C_SAPGPARAM,
* SAPTUNE). NO repository or customizing writes — safe to transport to and run
* in Production independently of the MCP. Operations: ping, hana_memory,
* abap_memory, wp_detail. Companion endpoint /sap/bc/zmcp_diag.

  PUBLIC SECTION.
    INTERFACES if_http_extension.
    CONSTANTS c_version TYPE string VALUE 'diag-0.9.20'.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_request,
             operation TYPE string,
           END OF ty_request.

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
             run_id       TYPE c LENGTH 22,
           END OF ty_response.

    TYPES: BEGIN OF ty_client_caps,
             category TYPE t000-cccategory,
             coractiv TYPE t000-cccoractiv,
             nocliind TYPE t000-ccnocliind,
             records  TYPE abap_bool,
             changes  TYPE abap_bool,
             text     TYPE string,
           END OF ty_client_caps.

    TYPES: BEGIN OF ty_env,
             SYSID        TYPE sy-sysid,
             CLIENT       TYPE sy-mandt,
             SAPRL        TYPE sy-saprl,
             SAP_BASIS    TYPE string,
             S4CORE       TYPE string,
             IS_S4        TYPE abap_bool,
             CLIENT_ROLE  TYPE t000-cccategory,
             HAS_ORG_COPY TYPE abap_bool,
             HAS_CTS_TASK TYPE abap_bool,
             HAS_MC_GUI   TYPE abap_bool,
           END OF ty_env.

    METHODS handle_ping        RETURNING VALUE(rs_resp) TYPE ty_response.
    METHODS handle_hana_memory RETURNING VALUE(rs_resp) TYPE ty_response.
    METHODS handle_abap_memory RETURNING VALUE(rs_resp) TYPE ty_response.
    METHODS handle_wp_detail   RETURNING VALUE(rs_resp) TYPE ty_response.
    METHODS run_hana_sql IMPORTING iv_tag TYPE string iv_sql TYPE string
                         CHANGING  ct_lines TYPE stringtab.
    METHODS client_caps       RETURNING VALUE(rs_caps) TYPE ty_client_caps.
    METHODS probe_environment RETURNING VALUE(rs_env)  TYPE ty_env.
    METHODS fm_exists IMPORTING iv_fm TYPE rs38l_fnam RETURNING VALUE(rv_ok) TYPE abap_bool.
ENDCLASS.



CLASS zcl_mcp_diag IMPLEMENTATION.

  METHOD if_http_extension~handle_request.
    DATA: ls_req  TYPE ty_request,
          ls_resp TYPE ty_response,
          lv_body TYPE string,
          lv_xbody TYPE xstring,
          lv_out  TYPE string.
    TRY.
        lv_xbody = server->request->get_data( ).
        IF lv_xbody IS NOT INITIAL.
          TRY.
              lv_body = cl_abap_codepage=>convert_from( source = lv_xbody codepage = '4110' ).
            CATCH cx_root.
              lv_body = server->request->get_cdata( ).
          ENDTRY.
        ELSE.
          lv_body = server->request->get_cdata( ).
        ENDIF.
        TRY.
            /ui2/cl_json=>deserialize( EXPORTING json = lv_body
                        pretty_name = /ui2/cl_json=>pretty_mode-none
              CHANGING data = ls_req ).
          CATCH cx_root INTO DATA(lx_parse).
            ls_resp-status = 'error'.
            APPEND |Cannot parse JSON body: { lx_parse->get_text( ) }| TO ls_resp-messages.
        ENDTRY.
        IF ls_resp-status <> 'error'.
          CASE to_lower( ls_req-operation ).
            WHEN 'ping'.        ls_resp = handle_ping( ).
            WHEN 'hana_memory'. ls_resp = handle_hana_memory( ).
            WHEN 'abap_memory'. ls_resp = handle_abap_memory( ).
            WHEN 'wp_detail'.   ls_resp = handle_wp_detail( ).
            WHEN OTHERS.
              ls_resp-status = 'error'.
              APPEND |Unknown operation '{ ls_req-operation }' (read-only DIAG engine: ping/hana_memory/abap_memory/wp_detail)| TO ls_resp-messages.
          ENDCASE.
        ENDIF.
        ls_resp-version = c_version.
        /ui2/cl_json=>serialize( EXPORTING data = ls_resp
                    pretty_name = /ui2/cl_json=>pretty_mode-none
          RECEIVING r_json = lv_out ).
      CATCH cx_root INTO DATA(lx_all).
        DATA lv_msg TYPE string.
        lv_msg = lx_all->get_text( ).
        REPLACE ALL OCCURRENCES OF '"' IN lv_msg WITH '\"'.
        CONCATENATE '{"STATUS":"error","VERSION":"' c_version
                    '","MESSAGES":["' lv_msg '"]}' INTO lv_out.
    ENDTRY.
    IF lv_out IS INITIAL.
      CONCATENATE '{"STATUS":"error","MESSAGES":'
                  '["Handler returned no output"]}' INTO lv_out.
    ENDIF.
    server->response->set_content_type( 'application/json; charset=utf-8' ).
    server->response->set_cdata( lv_out ).
    server->response->set_status( code = 200 reason = 'OK' ).
  ENDMETHOD.


  METHOD handle_ping.
    rs_resp-status    = 'ok'.
    rs_resp-operation = 'ping'.
    rs_resp-version   = c_version.
    APPEND |MCP Diagnostic (read-only) Engine alive on { sy-sysid } client { sy-mandt }|
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
      ( `rdisp/wp_no_vb2` ) ( `rdisp/wp_no_enq` ) ( `rdisp/wp_no_spo` )
      ( `rdisp/wp_max_no` ) ( `rdisp/wp_no_restricted` )
      ( `rdisp/configurable_wp_no` ) ( `rdisp/dynamic_wp_check` )
      ( `rdisp/max_wprun_time` ) ( `rdisp/scheduler/max_wprun_time` )
      ( `ztta/max_memreq_MB` ) ).

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

    " ── Live work-process inventory of the local app server (TH_WPINFO) ───────
    " Profile rdisp/wp_no_* are the CONFIGURED counts; with dynamic WPs / op
    " modes the RUNNING set can differ. Report the actual per-type counts so the
    " sizing recommendation reflects reality. TH_WPINFO is a kernel FM (portable).
    DATA: lt_wp TYPE STANDARD TABLE OF wpinfo.
    TYPES: BEGIN OF ty_wpc,
             typ TYPE wptyp,
             cnt TYPE i,
           END OF ty_wpc.
    DATA: lt_wpc TYPE SORTED TABLE OF ty_wpc WITH UNIQUE KEY typ,
          ls_wpc TYPE ty_wpc.
    CALL FUNCTION 'TH_WPINFO'
      TABLES
        wplist = lt_wp
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc = 0.
      LOOP AT lt_wp INTO DATA(ls_wp).
        " count by the raw kernel WP type code (faithful, no fixed list)
        ls_wpc-typ = ls_wp-wp_typ.
        ls_wpc-cnt = 1.
        COLLECT ls_wpc INTO lt_wpc.
      ENDLOOP.
      LOOP AT lt_wpc INTO ls_wpc.
        APPEND VALUE #( name = |wp_live:{ ls_wpc-typ }| value = |{ ls_wpc-cnt }| ) TO lt_p.
      ENDLOOP.
      APPEND VALUE #( name = 'wp_live:TOTAL' value = |{ lines( lt_wp ) }| ) TO lt_p.
    ELSE.
      APPEND VALUE #( name = 'wp_live:NOTE'
                      value = |TH_WPINFO unavailable (subrc { sy-subrc })| ) TO lt_p.
    ENDIF.

    rs_resp-status = 'ok'.
    APPEND |Read { lines( lt_p ) } ABAP memory parameters + live usage| TO rs_resp-messages.
    /ui2/cl_json=>serialize(
      EXPORTING data        = lt_p
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
  ENDMETHOD.


  METHOD handle_wp_detail.
    " Headless SM50: full TH_WPINFO rows for the local app server — per-WP
    " type/status/wait-reason/semaphore/user/report/action/table. The decisive
    " view when a background job hangs: WP_STATUS + WP_WAITING + WP_SEM +
    " WP_TABLE show WHAT the process is blocked on (enqueue, RFC, DB, update).
    " Read-only kernel FM, portable.
    DATA: lt_wp TYPE STANDARD TABLE OF wpinfo.
    rs_resp-operation = 'wp_detail'.
    rs_resp-version   = c_version.
    CALL FUNCTION 'TH_WPINFO'
      TABLES
        wplist = lt_wp
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc <> 0.
      rs_resp-status = 'error'.
      APPEND |TH_WPINFO unavailable (subrc { sy-subrc })| TO rs_resp-messages.
      RETURN.
    ENDIF.
    rs_resp-status = 'ok'.
    APPEND |{ lines( lt_wp ) } work processes on { sy-host }| TO rs_resp-messages.
    /ui2/cl_json=>serialize(
      EXPORTING data        = lt_wp
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

    " ── CPU + server topology (DB vs AS, co-residency) ────────────────────────
    " The memory invariant only bites because DB and AS share a host; the CPU
    " picture matters the same way. Report the app servers, the host CPU count +
    " current load, HANA's own CPU share, and whether DB & AS are co-resident.
    DATA: lt_srv    TYPE STANDARD TABLE OF msxxlist,
          lv_ashost TYPE string,
          lv_dbhost TYPE string,
          lt_h      TYPE TABLE OF string,
          lv_coloc  TYPE abap_bool.
    CALL FUNCTION 'TH_SERVER_LIST'
      TABLES     list   = lt_srv
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc = 0.
      LOOP AT lt_srv INTO DATA(ls_srv).
        APPEND |AS inst={ ls_srv-name } host={ ls_srv-host }| TO lt_lines.
      ENDLOOP.
      APPEND |AS app_server_count={ lines( lt_srv ) }| TO lt_lines.
    ENDIF.
    lv_ashost = sy-host.

    " logical CPUs of the host (the pool HANA + AS contend for)
    run_hana_sql(
      EXPORTING iv_tag = 'CPUINFO'
        iv_sql = `SELECT KEY || '=' || VALUE FROM SYS.M_HOST_INFORMATION ` &&
                 `WHERE KEY IN ('logical_cpu_count','cpu_threads','cpu_cores','machine_model')`
      CHANGING ct_lines = lt_lines ).

    " most-recent host CPU utilization % (whole box) from the load history
    run_hana_sql(
      EXPORTING iv_tag = 'CPU'
        iv_sql = `SELECT TOP 1 'host_cpu_pct=' || CPU FROM SYS.M_LOAD_HISTORY_HOST ORDER BY TIME DESC`
      CHANGING ct_lines = lt_lines ).

    " HANA's own current CPU% (sum across services) — vs host total = the split
    run_hana_sql(
      EXPORTING iv_tag = 'CPU'
        iv_sql = `SELECT 'hana_cpu_pct=' || TO_DECIMAL(SUM(PROCESS_CPU),10,1) FROM SYS.M_SERVICE_STATISTICS`
      CHANGING ct_lines = lt_lines ).

    " DB host (to compare with the AS host for co-residency)
    TRY.
        DATA(lo_h) = NEW cl_sql_statement( )->execute_query( `SELECT HOST FROM SYS.M_DATABASE` ).
        lo_h->set_param_table( REF #( lt_h ) ).
        lo_h->next_package( ).
        lo_h->close( ).
        READ TABLE lt_h INTO lv_dbhost INDEX 1.
      CATCH cx_sql_exception.
    ENDTRY.
    IF lv_dbhost IS NOT INITIAL.
      lv_coloc = boolc( to_upper( lv_dbhost ) CS to_upper( lv_ashost )
                     OR to_upper( lv_ashost ) CS to_upper( lv_dbhost ) ).
      APPEND |TOPO db_host={ lv_dbhost } as_host={ lv_ashost } co_resident={ lv_coloc }| TO lt_lines.
      IF lv_coloc = abap_true.
        APPEND `TOPO note: single-box appliance — HANA DB and the ABAP app server share the same CPUs and RAM. ` &&
               `Under load they contend: HANA can saturate CPU/caches and starve dialog/batch WPs, and a busy AS steals CPU from HANA. ` &&
               `Compare host_cpu_pct (whole box) with hana_cpu_pct (HANA's share) — the remainder is AS + OS. ` &&
               `Keep HANA global_allocation_limit + AS working memory + OS under physical RAM (the memory invariant) and leave CPU headroom for both.`
          TO lt_lines.
      ENDIF.
    ENDIF.

    rs_resp-rows_planned = lines( lt_lines ).
    /ui2/cl_json=>serialize(
      EXPORTING data        = lt_lines
                pretty_name = /ui2/cl_json=>pretty_mode-none
      RECEIVING r_json      = rs_resp-data_json ).
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


  METHOD fm_exists.
    SELECT SINGLE @abap_true FROM tfdir INTO @rv_ok
      WHERE funcname = @iv_fm.
  ENDMETHOD.

ENDCLASS.
