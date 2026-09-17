REPORT zmcp_cust_write NO STANDARD PAGE HEADING.

" LOWER CASE is essential: the run_id is a mixed-case UUID (cl_system_uuid
" create_uuid_c22).  Without it the selection-screen parameter upper-cases the
" value, so this report can't find its own INDX(ZP) params (engine wrote them in
" mixed case) and the engine can't find this report's INDX(ZR) result.
PARAMETERS: p_runid TYPE c LENGTH 22 LOWER CASE.

TYPES: BEGIN OF ty_params,
         op               TYPE string,   " '' / 'WRITE' = table/view write ; 'ORGCOPY' = entity copier
         table_name       TYPE string,
         view_name        TYPE string,   " maintenance object ('' = direct table write)
         transport_object TYPE string,   " 'VDAT' (view) | 'TABU' (single table) | 'CDAT' (view cluster)
         cluster_name     TYPE string,   " view cluster name (transport_object='CDAT')
         transport        TYPE string,
         action           TYPE string,   " write: '' / 'INS' / 'DEL' ; org copy: 'COPY' / 'DELE'
         plan_json        TYPE string,
         tabkeys_json     TYPE string,
         " ── org-copy mode (op='ORGCOPY') ─────────────────────────────────────
         org_unit         TYPE string,   " ECOP org-unit type (BUKRS/WERKS/VKORG/…)
         source_orgunit   TYPE string,
         target_orgunit   TYPE string,
         extras_json      TYPE string,   " view fields outside the base table: [{ROW,FIELD,VALUE}] (appended: layout is positional)
       END OF ty_params.

TYPES ty_refs TYPE STANDARD TABLE OF REF TO data WITH DEFAULT KEY.
TYPES: BEGIN OF ty_extra,
         row   TYPE i,
         field TYPE string,
         value TYPE string,
       END OF ty_extra,
       ty_extras TYPE STANDARD TABLE OF ty_extra WITH DEFAULT KEY.

TYPES: BEGIN OF ty_result,
         status       TYPE string,
         rows_written TYPE i,
         e071k_count  TYPE i,
         transport    TYPE string,   " export transport (org copy reports the request it recorded onto)
         messages     TYPE stringtab,
       END OF ty_result.

START-OF-SELECTION.
  DATA: ls_params TYPE ty_params,
        ls_result TYPE ty_result,
        lv_runid  TYPE c LENGTH 22.

  lv_runid = p_runid.

  IMPORT data = ls_params FROM DATABASE indx(ZP) ID lv_runid.
  IF sy-subrc <> 0.
    ls_result-status = 'error'.
    APPEND 'Params not found in INDX — run_id may be stale or job started too early'
      TO ls_result-messages.
    EXPORT data = ls_result TO DATABASE indx(ZR) ID lv_runid.
    RETURN.
  ENDIF.

  IF ls_params-op = 'ORGCOPY'.
    PERFORM run_org_copy   USING ls_params CHANGING ls_result.
  ELSEIF ls_params-op = 'LISTING'.
    PERFORM run_listing    USING ls_params CHANGING ls_result.
  ELSEIF ls_params-view_name IS NOT INITIAL.
    PERFORM write_via_view USING ls_params CHANGING ls_result.
  ELSE.
    PERFORM write_direct   USING ls_params CHANGING ls_result.
  ENDIF.

  EXPORT data = ls_result TO DATABASE indx(ZR) ID lv_runid.
  " Clean up params now that the job is done
  DELETE FROM DATABASE indx(ZP) ID lv_runid.

*&---------------------------------------------------------------------*
*&  Entity copier in a background job (op='ORGCOPY').
*&  Runs ECOP_ORG_UNITS_IN_THE_DARK with sy-batch='X', so the check /
*&  aftercopy FMs that pop a GUI message (e.g. FI_ECOP_BUKRS_AFTERCOPY)
*&  or call a dialog screen (NUMBER_RANGE_SUBOBJECT_COPY → CALL SCREEN
*&  300) behave batch-safe — MESSAGE I is logged, dialog steps are
*&  skipped — instead of aborting the copy mid-flight the way they do in
*&  the synchronous ICF handler context.
*&---------------------------------------------------------------------*
FORM run_org_copy
  USING    is_params TYPE ty_params
  CHANGING cs_result TYPE ty_result.

  " ECOP types resolved dynamically so this report compiles on non-ECOP systems
  " (e.g. CAR); the ORGCOPY branch only ever runs on a box that has the copier.
  DATA: lv_org_unit TYPE domname,
        lv_action   TYPE c LENGTH 4,
        lv_source   TYPE c LENGTH 30,
        lv_target   TYPE c LENGTH 30,
        lv_imp_req  TYPE trkorr,
        lv_exp_req  TYPE trkorr,
        lv_exp_task TYPE trkorr,
        lv_rc       TYPE sy-subrc,
        lv_descr    TYPE dd03p-scrtext_m,
        lv_orgout   TYPE domname,
        lr_tablist  TYPE REF TO data,
        lv_keys     TYPE i,
        lv_exc      TYPE string.
  FIELD-SYMBOLS <tablist> TYPE ANY TABLE.

  TRY.
      CREATE DATA lr_tablist TYPE ('ECOPT_TDD02L').
      ASSIGN lr_tablist->* TO <tablist>.
    CATCH cx_root.
      cs_result-status = 'error'.
      APPEND 'ECOP entity-copier types not available on this system' TO cs_result-messages.
      RETURN.
  ENDTRY.

  lv_org_unit = to_upper( is_params-org_unit ).
  lv_action   = to_upper( is_params-action ).
  lv_source   = is_params-source_orgunit.
  lv_target   = is_params-target_orgunit.
  lv_imp_req  = is_params-transport.

  CALL FUNCTION 'ECOP_ORG_UNITS_IN_THE_DARK'
    EXPORTING
      org_unit          = lv_org_unit
      action            = lv_action
      import_tr_request = lv_imp_req
      source_orgunit    = lv_source
      target_orgunit    = lv_target
      commit_work       = 'X'
    IMPORTING
      return_code       = lv_rc
      description       = lv_descr
      org_unit          = lv_orgout
      export_tr_request = lv_exp_req
      export_tr_task    = lv_exp_task
      ev_tablist        = <tablist>
    EXCEPTIONS
      no_valid_orgunit           = 1
      no_valid_action            = 2
      no_tables                  = 3
      db_error_on_insert         = 4
      db_error_on_delete         = 5
      no_tr_request              = 6
      transport_error            = 7
      no_authorization           = 8
      unallowed_user             = 9
      locking_error              = 10
      wrong_category             = 11
      source_unit_does_not_exist = 12
      target_unit_exists         = 13
      global_check_failed        = 14
      invalid_orgtype            = 15
      no_double_orgunit_type     = 16
      no_modifications_allowed   = 17
      no_transports_allowed      = 18
      OTHERS                     = 19.
  IF sy-subrc <> 0.
    lv_exc = SWITCH string( sy-subrc
      WHEN 6  THEN `no_tr_request — the entity copier could not obtain a transport request to record onto (set createTransport)`
      WHEN 8  THEN `no_authorization`
      WHEN 10 THEN `locking_error — org unit locked by another user`
      WHEN 12 THEN `source_unit_does_not_exist`
      WHEN 13 THEN `target_unit_exists — the copier never overwrites; delete the target first or pick a new key`
      WHEN 14 THEN `global_check_failed — an application check vetoed the copy`
      ELSE         |subrc { sy-subrc }| ).
    cs_result-status = 'error'.
    APPEND |ECOP_ORG_UNITS_IN_THE_DARK failed: { lv_exc }| TO cs_result-messages.
    RETURN.
  ENDIF.

  " ECOP committed internally (commit_work='X'); confirm the LUW is hardened.
  COMMIT WORK AND WAIT.

  cs_result-status    = 'ok'.
  cs_result-transport = lv_exp_req.
  IF lv_exp_task IS NOT INITIAL.
    SELECT COUNT(*) FROM e071k INTO @lv_keys WHERE trkorr = @lv_exp_task.
  ENDIF.
  cs_result-rows_written = lv_keys.
  cs_result-e071k_count  = lv_keys.
  APPEND |{ lv_action } '{ lv_descr }' ({ lv_org_unit }): { lv_source } → { lv_target }|
    TO cs_result-messages.
  APPEND |{ lines( <tablist> ) } dependent tables processed by the entity copier (batch sy-batch='{ sy-batch }')|
    TO cs_result-messages.
  APPEND |Transport { lv_exp_req } / task { lv_exp_task } — { lv_keys } object keys on the task|
    TO cs_result-messages.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Retail listing engine in a background job (op='LISTING').
*&  Runs EXECUTE_LISTING_ART_ASSORT_RFC with sy-batch='X', so the dialog
*&  messages it issues (e.g. WM 028) are logged instead of aborting with
*&  "cannot be processed in plugin mode HTTP" the way they do in the
*&  synchronous ICF handler context. WINT_LISTING_ITEM_TAB is resolved
*&  dynamically and the FM is called by literal name (runtime-resolved),
*&  so this report still activates on non-retail boxes (e.g. CAR).
*&---------------------------------------------------------------------*
FORM run_listing
  USING    is_params TYPE ty_params
  CHANGING cs_result TYPE ty_result.

  DATA: lr_all    TYPE REF TO data,
        lr_sub    TYPE REF TO data,
        lt_prods  TYPE STANDARD TABLE OF matnr,
        lv_prod   TYPE matnr,
        lv_total  TYPE i,
        lv_fmfail TYPE i,
        lv_before TYPE i,
        lv_after  TYPE i,
        lv_delta  TYPE i,
        lv_tstart TYPE sy-uzeit.
  FIELD-SYMBOLS: <all>  TYPE STANDARD TABLE,
                 <sub>  TYPE STANDARD TABLE,
                 <line> TYPE any,
                 <pf>   TYPE any.

  lv_tstart = sy-uzeit.

  TRY.
      CREATE DATA lr_all TYPE ('WINT_LISTING_ITEM_TAB').
      ASSIGN lr_all->* TO <all>.
      CREATE DATA lr_sub TYPE ('WINT_LISTING_ITEM_TAB').
      ASSIGN lr_sub->* TO <sub>.
    CATCH cx_root.
      cs_result-status = 'error'.
      APPEND 'Listing item type WINT_LISTING_ITEM_TAB not available (not an IS-Retail system)'
        TO cs_result-messages.
      RETURN.
  ENDTRY.

  TRY.
      /ui2/cl_json=>deserialize(
        EXPORTING json        = is_params-plan_json
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        CHANGING  data        = <all> ).
    CATCH cx_root INTO DATA(lx).
      cs_result-status = 'error'.
      APPEND |Cannot parse listing items: { lx->get_text( ) }| TO cs_result-messages.
      RETURN.
  ENDTRY.

  lv_total = lines( <all> ).
  IF lv_total = 0.
    cs_result-status = 'error'.
    APPEND 'No listing items to process' TO cs_result-messages.
    RETURN.
  ENDIF.

  " EXECUTE_LISTING_ART_ASSORT_RFC lists ONE article at a time: get_instance(iv_product)
  " builds the single/generic-article lister + product family for that product, and
  " raises WM 028 ("material does not exist") if iv_product is blank. So group the
  " items by PRODUCT and call the FM once per article, passing that article's rows.
  LOOP AT <all> ASSIGNING <line>.
    ASSIGN COMPONENT 'PRODUCT' OF STRUCTURE <line> TO <pf>.
    IF sy-subrc = 0. APPEND <pf> TO lt_prods. ENDIF.
  ENDLOOP.
  SORT lt_prods. DELETE ADJACENT DUPLICATES FROM lt_prods.

  " Truthful outcome: count the listing conditions (WLK1) BEFORE, so we can report
  " how many were actually written — the FM returns subrc 0 even when every item is
  " rejected (it logs the reason to the application log instead of failing).
  PERFORM count_wlk1 USING lt_prods CHANGING lv_before.

  LOOP AT lt_prods INTO lv_prod.
    CLEAR <sub>.
    LOOP AT <all> ASSIGNING <line>.
      ASSIGN COMPONENT 'PRODUCT' OF STRUCTURE <line> TO <pf>.
      IF sy-subrc = 0 AND <pf> = lv_prod.
        APPEND <line> TO <sub>.
      ENDIF.
    ENDLOOP.

    CALL FUNCTION 'EXECUTE_LISTING_ART_ASSORT_RFC'
      EXPORTING
        it_products_assort       = <sub>
        iv_product               = lv_prod
        iv_all_assort            = space
        iv_recheck               = 'X'
        iv_determine_data        = 'X'
        iv_selection_string      = space
        iv_include_local_assorts = 'X'
      EXCEPTIONS
        fatal_error              = 1
        OTHERS                   = 2.
    IF sy-subrc <> 0.
      lv_fmfail = lv_fmfail + 1.
      APPEND |Article { lv_prod ALPHA = OUT }: listing FM fatal_error (subrc { sy-subrc })|
        TO cs_result-messages.
    ENDIF.
  ENDLOOP.

  COMMIT WORK AND WAIT.

  PERFORM count_wlk1 USING lt_prods CHANGING lv_after.
  lv_delta = lv_after - lv_before.

  " Surface the per-item messages the listing engine wrote to its application log
  " (object 'W' / subobject 'W_LISTERR') during this run — e.g. WM 006 "enter
  " listing procedure", WM 057 invalid assortment — so a rejection is never hidden
  " behind a clean FM return.
  PERFORM read_listing_log USING lv_tstart CHANGING cs_result.

  cs_result-rows_written = lv_delta.
  cs_result-status       = COND #( WHEN lv_delta > 0 THEN 'ok' ELSE 'error' ).
  APPEND |Listing FM ran for { lines( lt_prods ) } article(s) in batch (sy-batch='{ sy-batch }'); | &&
         |{ lv_delta } WLK1 listing condition(s) written| &&
         COND string( WHEN lv_fmfail > 0 THEN |; { lv_fmfail } article(s) hit a fatal FM error| ELSE `` ) &&
         COND string( WHEN lv_delta = 0 THEN ` — NOTHING listed; see listing-log messages above` ELSE `` )
    TO cs_result-messages.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Count retail listing conditions (WLK1) for the given articles.
*&
*&  WLK1 exists only on an ERP/Retail box.  It is accessed DYNAMICALLY (and
*&  guarded) so this report still COMPILES on systems that don't have it in the
*&  ABAP Dictionary — e.g. SAP CAR, where WLK1 is replicated in by SLT into a
*&  separate DB schema and is not a DDIC table.  A static `FROM wlk1` made the
*&  whole report unactivatable there, taking the customizing writer down with
*&  the retail-listing feature.  On a box without WLK1 the count stays 0 and the
*&  listing op simply reports nothing written (it is never invoked there anyway).
*&---------------------------------------------------------------------*
FORM count_wlk1
  USING    it_prods TYPE STANDARD TABLE
  CHANGING cv_count TYPE i.

  DATA: lv_list  TYPE string,
        lv_where TYPE string.
  FIELD-SYMBOLS <p> TYPE any.

  CLEAR cv_count.
  IF it_prods IS INITIAL.
    RETURN.
  ENDIF.

  LOOP AT it_prods ASSIGNING <p>.
    IF lv_list IS INITIAL.
      lv_list = |'{ <p> }'|.
    ELSE.
      lv_list = |{ lv_list }, '{ <p> }'|.
    ENDIF.
  ENDLOOP.
  lv_where = |ARTNR IN ( { lv_list } )|.

  TRY.
      SELECT COUNT(*) FROM ('WLK1') INTO @cv_count WHERE (lv_where).
    CATCH cx_root.
      CLEAR cv_count.   " table absent on this box (e.g. CAR) — nothing to count
  ENDTRY.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Read the listing application log (object 'W' / subobject 'W_LISTERR')
*&  written by EXECUTE_LISTING_ART_ASSORT_RFC during this run, and surface
*&  the error/abort/warning messages — so a rejection (e.g. WM 006 "enter
*&  listing procedure", WM 057 invalid assortment) is never hidden behind
*&  the FM's clean subrc-0 return. Scoped by user + today + this run's start
*&  time. BAL FMs are basis (present on every box).
*&---------------------------------------------------------------------*
FORM read_listing_log
  USING    iv_tstart TYPE sy-uzeit
  CHANGING cs_result TYPE ty_result.

  DATA: ls_fil   TYPE bal_s_lfil,
        lt_hdr    TYPE balhdr_t,
        lt_msgh  TYPE bal_t_msgh,
        ls_msg   TYPE bal_s_msg,
        lv_txt   TYPE string,
        lv_key   TYPE string,
        lt_seen  TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line,
        lv_shown TYPE i,
        lv_errs  TYPE i.

  ls_fil-object    = VALUE #( ( sign = 'I' option = 'EQ' low = 'W' ) ).
  ls_fil-subobject = VALUE #( ( sign = 'I' option = 'EQ' low = 'W_LISTERR' ) ).
  ls_fil-aluser    = VALUE #( ( sign = 'I' option = 'EQ' low = sy-uname ) ).
  ls_fil-aldate    = VALUE #( ( sign = 'I' option = 'EQ' low = sy-datum ) ).
  ls_fil-altime    = VALUE #( ( sign = 'I' option = 'BT' low = iv_tstart high = '235959' ) ).

  CALL FUNCTION 'BAL_DB_SEARCH'
    EXPORTING  i_s_log_filter = ls_fil
    IMPORTING  e_t_log_header = lt_hdr
    EXCEPTIONS log_not_found  = 1
               OTHERS         = 2.
  IF sy-subrc <> 0 OR lt_hdr IS INITIAL.
    RETURN.   " no listing log for this run
  ENDIF.

  CALL FUNCTION 'BAL_DB_LOAD'
    EXPORTING  i_t_log_header    = lt_hdr
    EXCEPTIONS no_logs_specified = 1
               log_not_found     = 2
               OTHERS            = 3.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

  CALL FUNCTION 'BAL_GLB_SEARCH_MSG'
    IMPORTING  e_t_msg_handle = lt_msgh
    EXCEPTIONS msg_not_found  = 1
               OTHERS         = 2.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

  LOOP AT lt_msgh INTO DATA(ls_msgh).
    CALL FUNCTION 'BAL_LOG_MSG_READ'
      EXPORTING  i_s_msg_handle = ls_msgh
      IMPORTING  e_s_msg        = ls_msg
      EXCEPTIONS OTHERS         = 1.
    IF sy-subrc <> 0.
      CONTINUE.
    ENDIF.
    IF ls_msg-msgty NA 'EAWX'.   " surface problems only; skip success/info
      CONTINUE.
    ENDIF.
    IF ls_msg-msgty CA 'EA'.
      lv_errs = lv_errs + 1.
    ENDIF.
    lv_key = |{ ls_msg-msgid }{ ls_msg-msgno }{ ls_msg-msgv1 }{ ls_msg-msgv2 }|.
    READ TABLE lt_seen TRANSPORTING NO FIELDS WITH KEY table_line = lv_key.
    IF sy-subrc = 0.
      CONTINUE.   " de-dupe identical per-item messages
    ENDIF.
    INSERT lv_key INTO TABLE lt_seen.
    IF lv_shown < 25.
      CLEAR lv_txt.
      MESSAGE ID ls_msg-msgid TYPE 'I' NUMBER ls_msg-msgno
        WITH ls_msg-msgv1 ls_msg-msgv2 ls_msg-msgv3 ls_msg-msgv4 INTO lv_txt.
      APPEND |listing-log { ls_msg-msgty } { ls_msg-msgid }{ ls_msg-msgno }: { lv_txt }|
        TO cs_result-messages.
      lv_shown = lv_shown + 1.
    ENDIF.
  ENDLOOP.

  IF lv_shown >= 25.
    APPEND `…(more listing-log messages truncated)` TO cs_result-messages.
  ENDIF.
  IF lv_errs > 0.
    APPEND |{ lv_errs } distinct error/abort message(s) in the listing log — listing rejected for those items|
      TO cs_result-messages.
  ENDIF.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Proper customizing write through the maintenance view runtime.
*&  Records R3TR VDAT <view> (base + text table) on the transport.
*&
*&  The view runtime writes WITHOUT transport (no_transport='X'); the keys
*&  are then recorded by record_headless. Never hand corr_number to the view
*&  runtime: it records through TR_OBJECTS_INSERT, which hardcodes
*&  iv_with_dialog='X', and in dialog mode CTS also runs switch-BC-set
*&  recording (TRINT_OBJECTS_CHECK_AND_INSERT, "call_scpr_transport") on any
*&  client with an active switch. On an industry-solution system that is
*&  every client, the BC-set content is over a million rows, and for a view
*&  in a switched package that recording ran for hours (2026-07-07,
*&  2026-09-03). Mode 'D' (insert, no dialog) skips it.
*&---------------------------------------------------------------------*
FORM write_via_view
  USING    is_params TYPE ty_params
  CHANGING cs_result TYPE ty_result.

  DATA: lr_plan   TYPE REF TO data,
        lr_entry  TYPE REF TO data,
        lv_view   TYPE dd02v-tabname,
        lv_trkorr TYPE trkorr,
        lv_corr   TYPE trkorr,
        lv_action TYPE c LENGTH 4,
        lv_trobj  TYPE e071-object,
        lv_count  TYPE i,
        lv_msg    TYPE string.
  FIELD-SYMBOLS: <plan>  TYPE STANDARD TABLE,
                 <row>   TYPE any,
                 <entry> TYPE any.

  lv_view   = to_upper( is_params-view_name ).
  lv_trkorr = is_params-transport.
  " Transport object the SM30 runtime records: VDAT (view) or TABU (single table)
  lv_trobj  = to_upper( is_params-transport_object ).
  IF lv_trobj IS INITIAL.
    lv_trobj = 'VDAT'.
  ENDIF.
  " 'DEL' = delete existing entries (mimics the SM30 'delete row' path); anything
  " else = insert-or-update.  Both go through VIEW_MAINTENANCE_SINGLE_ENTRY so the
  " full view runtime (FK checks, events, change docs, transport recording) runs.
  DATA(lv_is_del) = COND abap_bool(
    WHEN to_upper( is_params-action ) = 'DEL' THEN abap_true ELSE abap_false ).

  " Every write goes through the view runtime without transport; the keys of
  " what was written are recorded afterwards, headlessly, as the SM30/SM34
  " save would record them (VDAT/TABU header + TABU keys, or CDAT header +
  " member TABU keys). See the FORM header.
  DATA(lv_is_cdat) = COND abap_bool( WHEN lv_trobj = 'CDAT' THEN abap_true ELSE abap_false ).
  DATA: lv_no_transp TYPE tvdir-flag VALUE 'X',
        lv_corr_in   TYPE trkorr,
        lt_written   TYPE ty_refs,
        lt_extras    TYPE ty_extras,
        lv_row       TYPE i.
  FIELD-SYMBOLS <xfld> TYPE any.

  IF is_params-extras_json IS NOT INITIAL.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json        = is_params-extras_json
                    pretty_name = /ui2/cl_json=>pretty_mode-none
          CHANGING  data        = lt_extras ).
      CATCH cx_root INTO DATA(lx_xj).
        cs_result-status = 'error'.
        APPEND |View-field deserialization failed: { lx_xj->get_text( ) }| TO cs_result-messages.
        RETURN.
    ENDTRY.
  ENDIF.

  " Deserialize the plan (rows typed as the BASE table)
  TRY.
      CREATE DATA lr_plan TYPE STANDARD TABLE OF (is_params-table_name).
      ASSIGN lr_plan->* TO <plan>.
      /ui2/cl_json=>deserialize(
        EXPORTING json        = is_params-plan_json
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        CHANGING  data        = <plan> ).
    CATCH cx_root INTO DATA(lx_de).
      cs_result-status = 'error'.
      APPEND |Plan deserialization failed: { lx_de->get_text( ) }| TO cs_result-messages.
      RETURN.
  ENDTRY.

  " One view-structured work area to feed VIEW_MAINTENANCE_SINGLE_ENTRY
  TRY.
      CREATE DATA lr_entry TYPE (lv_view).
      ASSIGN lr_entry->* TO <entry>.
    CATCH cx_root INTO DATA(lx_ce).
      cs_result-status = 'error'.
      APPEND |Cannot type view { lv_view }: { lx_ce->get_text( ) }| TO cs_result-messages.
      RETURN.
  ENDTRY.

  LOOP AT <plan> ASSIGNING <row>.
    lv_row = lv_row + 1.
    CLEAR <entry>.
    " Base-table fields (incl. the remapped key) carry over by name; view fields
    " outside the base table (a text table's description) come from the extras,
    " and the view runtime writes them for sy-langu.
    MOVE-CORRESPONDING <row> TO <entry>.
    LOOP AT lt_extras INTO DATA(ls_x) WHERE row = lv_row.
      ASSIGN COMPONENT ls_x-field OF STRUCTURE <entry> TO <xfld>.
      IF sy-subrc <> 0.
        cs_result-status = 'error'.
        APPEND |Field { ls_x-field } is not in view { lv_view }| TO cs_result-messages.
        RETURN.
      ENDIF.
      <xfld> = ls_x-value.
    ENDLOOP.

    " ── Delete path ─────────────────────────────────────────────────────────
    " The work area's key identifies the entry; action 'DEL' removes it across the
    " whole view (base + text) and records the deletion onto the transport, exactly
    " as deleting the row in SM30 does.  entry_not_found → already gone (idempotent).
    IF lv_is_del = abap_true.
      lv_action = 'DEL'.
      CLEAR lv_corr.
      CALL FUNCTION 'VIEW_MAINTENANCE_SINGLE_ENTRY'
        EXPORTING
          action                     = lv_action
          corr_number                = lv_corr_in
          view_name                  = lv_view
          no_warning_for_clientindep = 'X'
          no_transport               = lv_no_transp
          suppressdialog             = 'X'
        IMPORTING
          corr_number                = lv_corr
        CHANGING
          entry                      = <entry>
        EXCEPTIONS
          entry_already_exists       = 1
          entry_not_found            = 2
          foreign_lock               = 3
          invalid_action             = 4
          no_clientindependent_auth  = 5
          no_upd_auth                = 6
          no_show_auth               = 7
          OTHERS                     = 9.
      IF sy-subrc = 2.
        APPEND |Entry already absent — skipped| TO cs_result-messages.
        CONTINUE.
      ENDIF.
      IF sy-subrc <> 0.
        ROLLBACK WORK.
        cs_result-status = 'error'.
        APPEND |VIEW_MAINTENANCE_SINGLE_ENTRY DEL failed (subrc { sy-subrc } { sy-msgid }{ sy-msgno } { sy-msgv1 })|
          TO cs_result-messages.
        RETURN.
      ENDIF.
      cs_result-rows_written = cs_result-rows_written + 1.
      PERFORM keep_entry USING <entry> CHANGING lt_written.
      CONTINUE.
    ENDIF.

    " New target keys → INSERT; if the row already exists, fall back to UPDATE.
    lv_action = 'INS'.
    CLEAR lv_corr.
    CALL FUNCTION 'VIEW_MAINTENANCE_SINGLE_ENTRY'
      EXPORTING
        action                     = lv_action
        corr_number                = lv_corr_in
        view_name                  = lv_view
        no_warning_for_clientindep = 'X'
        no_transport               = lv_no_transp
        suppressdialog             = 'X'
      IMPORTING
        corr_number                = lv_corr
      CHANGING
        entry                      = <entry>
      EXCEPTIONS
        entry_already_exists       = 1
        entry_not_found            = 2
        foreign_lock               = 3
        invalid_action             = 4
        no_clientindependent_auth  = 5
        no_upd_auth                = 6
        no_show_auth               = 7
        OTHERS                     = 9.

    IF sy-subrc = 1.
      " Already there → update it instead
      lv_action = 'UPD'.
      CALL FUNCTION 'VIEW_MAINTENANCE_SINGLE_ENTRY'
        EXPORTING
          action                     = lv_action
          corr_number                = lv_corr_in
          view_name                  = lv_view
          no_warning_for_clientindep = 'X'
          no_transport               = lv_no_transp
          suppressdialog             = 'X'
        IMPORTING
          corr_number                = lv_corr
        CHANGING
          entry                      = <entry>
        EXCEPTIONS
          OTHERS                     = 9.
    ENDIF.

    IF sy-subrc <> 0.
      ROLLBACK WORK.
      cs_result-status = 'error'.
      APPEND |VIEW_MAINTENANCE_SINGLE_ENTRY { lv_action } failed (subrc { sy-subrc } { sy-msgid }{ sy-msgno } { sy-msgv1 })|
        TO cs_result-messages.
      RETURN.
    ENDIF.

    cs_result-rows_written = cs_result-rows_written + 1.
    PERFORM keep_entry USING <entry> CHANGING lt_written.
  ENDLOOP.

  " Record what was written onto the request BEFORE the commit, so the keys are
  " persisted together with the data (CTS records through its update task).
  IF lv_trkorr IS NOT INITIAL AND cs_result-rows_written > 0.
    PERFORM record_headless USING is_params lv_trkorr lv_view lt_written CHANGING cs_result.
    IF cs_result-status = 'error'.
      ROLLBACK WORK.
      RETURN.
    ENDIF.
  ENDIF.

  COMMIT WORK AND WAIT.

  cs_result-status = 'ok'.
  DATA(lv_verb) = COND string( WHEN lv_is_del = abap_true THEN 'Deleted' ELSE 'Wrote' ).

  " No transport → the change ran through the view runtime in a client that does
  " not auto-record (T000-CCCORACTIV ≠ '1').  There is nothing to verify on a
  " request; report the unrecorded write plainly rather than chasing E071K.
  IF lv_trkorr IS INITIAL.
    lv_msg = |{ lv_verb } { cs_result-rows_written } row(s) via { lv_view } (client { sy-mandt } records no transport)|.
    APPEND lv_msg TO cs_result-messages.
    RETURN.
  ENDIF.

  " Post-commit sanity check: confirm the SM30 runtime recorded the row keys.
  " A VDAT/view write lands as: E071 header R3TR VDAT <view> + E071K key rows
  " R3TR TABU <member table> <tabkey> (one per touched table+language). We count
  " the E071K TABU keys for the BASE table — the substantive "row recorded"
  " evidence. CTS records onto the user's TASK under the request, not the request
  " header, so we look across the request AND all its tasks (E070-STRKORR).
  DATA: lt_korr TYPE RANGE OF trkorr,
        lv_btab TYPE e071k-objname.
  lv_btab = to_upper( is_params-table_name ).
  APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_trkorr ) TO lt_korr.
  SELECT trkorr FROM e070 WHERE strkorr = @lv_trkorr INTO TABLE @DATA(lt_tasks).
  LOOP AT lt_tasks INTO DATA(ls_task).
    APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_task-trkorr ) TO lt_korr.
  ENDLOOP.
  SELECT COUNT(*) INTO @lv_count FROM e071k
    WHERE trkorr IN @lt_korr
      AND pgmid   = 'R3TR'
      AND object  = 'TABU'
      AND objname = @lv_btab.
  cs_result-e071k_count = lv_count.

  DATA(lv_hdr) = COND string( WHEN lv_is_cdat = abap_true
                              THEN |R3TR CDAT { to_upper( is_params-cluster_name ) }|
                              ELSE |R3TR { lv_trobj } { lv_view }| ).
  IF lv_count > 0.
    lv_msg = |{ lv_verb } { cs_result-rows_written } row(s) via { lv_view } → { lv_trkorr } ({ lv_hdr }; { lv_count } R3TR TABU { lv_btab } key(s) recorded)|.
  ELSE.
    lv_msg = |{ lv_verb } { cs_result-rows_written } row(s) via { lv_view }, but no R3TR TABU { lv_btab } keys were recorded on { lv_trkorr } or its tasks — check the request is a modifiable Customizing request|.
  ENDIF.
  APPEND lv_msg TO cs_result-messages.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Keep a copy of a written view entry for key recording after the loop.
*&---------------------------------------------------------------------*
FORM keep_entry
  USING    is_entry   TYPE any
  CHANGING ct_written TYPE ty_refs.
  DATA lr_copy TYPE REF TO data.
  FIELD-SYMBOLS <copy> TYPE any.
  CREATE DATA lr_copy LIKE is_entry.
  ASSIGN lr_copy->* TO <copy>.
  <copy> = is_entry.
  APPEND lr_copy TO ct_written.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Record written entries onto the request, headlessly, the way the
*&  SM30/SM34 save records them:
*&    VDAT  → R3TR VDAT <view>    + R3TR TABU <table> <key> per view table
*&    TABU  → R3TR TABU <table>   + the same keys
*&    CDAT  → R3TR CDAT <cluster> + R3TR TABU <member table> <key>
*&  Keys are built from the DDIC key fields of each table in the view
*&  (DD26S/DD03L): client from sy-mandt, a language key from the entry or
*&  sy-langu, everything else from the entry (blank is a valid key value).
*&  A table whose key fields are not all in the entry (a lookup table joined
*&  for a text) is not a maintained table and is skipped, as SM30 does.
*&
*&  TRINT_OBJECTS_CHECK_AND_INSERT with iv_with_dialog='D' — insert into
*&  the given request, no dialog. ' ' and 'R' only check and insert nothing;
*&  'X' (what TR_OBJECTS_INSERT forces) inserts through the dialog and is the
*&  only mode that runs the switch-BC-set recording that ran for hours on
*&  switched-package views (see write_via_view).
*&---------------------------------------------------------------------*
FORM record_headless
  USING    is_params  TYPE ty_params
           iv_trkorr  TYPE trkorr
           iv_view    TYPE dd02v-tabname
           it_written TYPE ty_refs
  CHANGING cs_result  TYPE ty_result.

  TYPES: BEGIN OF ty_keyfield,
           tabname   TYPE dd03l-tabname,
           fieldname TYPE dd03l-fieldname,
           position  TYPE dd03l-position,
           datatype  TYPE dd03l-datatype,
           leng      TYPE dd03l-leng,
         END OF ty_keyfield.

  DATA: lt_ko200    TYPE tredt_objects,
        lt_e071k    TYPE tredt_keys,
        lt_tables   TYPE STANDARD TABLE OF dd26s-tabname,
        lt_keyf     TYPE STANDARD TABLE OF ty_keyfield,
        lv_trobj    TYPE e071-object,
        lv_master   TYPE e071k-mastername,
        lv_mtype    TYPE e071k-mastertype,
        lv_order    TYPE trkorr,
        lv_task     TYPE trkorr,
        lv_tabkey   TYPE e071k-tabkey,
        lv_off      TYPE i,
        lv_complete TYPE abap_bool,
        lv_val      TYPE c LENGTH 255,
        lr_entry    TYPE REF TO data.
  FIELD-SYMBOLS: <entry> TYPE any,
                 <field> TYPE any.

  lv_trobj = to_upper( is_params-transport_object ).
  IF lv_trobj IS INITIAL.
    lv_trobj = 'VDAT'.
  ENDIF.

  CASE lv_trobj.
    WHEN 'CDAT'.
      lv_master = to_upper( is_params-cluster_name ).
      lv_mtype  = 'CDAT'.
    WHEN 'TABU'.
      lv_master = to_upper( is_params-table_name ).
      lv_mtype  = 'TABU'.
    WHEN OTHERS.
      lv_master = iv_view.
      lv_mtype  = 'VDAT'.
  ENDCASE.

  APPEND VALUE #( pgmid = 'R3TR' object = lv_trobj obj_name = lv_master objfunc = 'K' ) TO lt_ko200.

  " The tables whose keys are recorded: the view's tables, or the one table.
  IF lv_trobj = 'TABU'.
    APPEND lv_master TO lt_tables.
  ELSE.
    SELECT tabname FROM dd26s WHERE viewname = @iv_view ORDER BY tabpos INTO TABLE @lt_tables.
    IF lt_tables IS INITIAL.
      APPEND to_upper( is_params-table_name ) TO lt_tables.
    ENDIF.
  ENDIF.

  SELECT tabname, fieldname, position, datatype, leng FROM dd03l
    FOR ALL ENTRIES IN @lt_tables
    WHERE tabname = @lt_tables-table_line AND keyflag = 'X' AND as4local = 'A'
    INTO TABLE @lt_keyf.
  SORT lt_keyf BY tabname position.

  LOOP AT lt_tables INTO DATA(lv_tab).
    LOOP AT it_written INTO lr_entry.
      ASSIGN lr_entry->* TO <entry>.
      CLEAR lv_tabkey.
      lv_off = 0.
      lv_complete = abap_true.
      LOOP AT lt_keyf INTO DATA(ls_kf) WHERE tabname = lv_tab.
        CLEAR lv_val.
        IF ls_kf-datatype = 'CLNT'.
          lv_val = sy-mandt.
        ELSE.
          " A key field the entry does not have means a table this view only
          " reads (a lookup joined for its text): not maintained, skipped. A
          " key field that is there but blank is a real key value (a blank
          " storage location), except a language, which the runtime fills.
          ASSIGN COMPONENT ls_kf-fieldname OF STRUCTURE <entry> TO <field>.
          IF sy-subrc = 0 AND ( <field> IS NOT INITIAL OR ls_kf-datatype <> 'LANG' ).
            lv_val = <field>.
          ELSEIF ls_kf-datatype = 'LANG'.
            lv_val = sy-langu.
          ELSE.
            lv_complete = abap_false.
            EXIT.
          ENDIF.
        ENDIF.
        IF lv_off + ls_kf-leng > 120.
          lv_complete = abap_false.
          EXIT.
        ENDIF.
        lv_tabkey+lv_off(ls_kf-leng) = lv_val.
        lv_off = lv_off + ls_kf-leng.
      ENDLOOP.
      IF lv_complete = abap_false.
        EXIT.   " not a maintained table of this view: next table
      ENDIF.
      APPEND VALUE #( pgmid = 'R3TR' object = 'TABU' objname = lv_tab tabkey = lv_tabkey
                      mastertype = lv_mtype mastername = lv_master ) TO lt_e071k.
    ENDLOOP.
  ENDLOOP.

  IF lt_e071k IS INITIAL.
    cs_result-status = 'error'.
    APPEND |No table key of { iv_view } could be built from the written entries; nothing recorded on { iv_trkorr }|
      TO cs_result-messages.
    RETURN.
  ENDIF.

  CALL FUNCTION 'TRINT_OBJECTS_CHECK_AND_INSERT'
    EXPORTING
      iv_order              = iv_trkorr
      iv_with_dialog        = 'D'
      iv_no_show_option     = 'X'
      iv_no_standard_editor = 'X'
      iv_no_ps              = 'X'
    IMPORTING
      ev_order              = lv_order
      ev_task               = lv_task
    CHANGING
      ct_ko200              = lt_ko200
      ct_e071k              = lt_e071k
    EXCEPTIONS
      OTHERS                = 1.
  IF sy-subrc <> 0.
    cs_result-status = 'error'.
    APPEND |Recording { lv_trobj } { lv_master } onto { iv_trkorr } refused: { sy-msgid }{ sy-msgno } { sy-msgv1 } { sy-msgv2 } { sy-msgv3 } { sy-msgv4 }|
      TO cs_result-messages.
    RETURN.
  ENDIF.
  APPEND |Recorded R3TR { lv_trobj } { lv_master } + { lines( lt_e071k ) } R3TR TABU key(s) onto { lv_order } (task { lv_task })|
    TO cs_result-messages.
ENDFORM.

*&---------------------------------------------------------------------*
*&  Direct table write (class A application data / no maintenance view).
*&  No transport recording.
*&---------------------------------------------------------------------*
FORM write_direct
  USING    is_params TYPE ty_params
  CHANGING cs_result TYPE ty_result.

  DATA: lr_plan    TYPE REF TO data,
        lv_tabname TYPE e071-obj_name,
        lv_enq     TYPE rstable-tabname,
        lv_msg     TYPE string,
        lt_written TYPE ty_refs,
        lv_trkorr  TYPE trkorr,
        lv_noview  TYPE dd02v-tabname.
  FIELD-SYMBOLS: <plan> TYPE STANDARD TABLE,
                 <prow> TYPE any.

  lv_tabname = to_upper( is_params-table_name ).
  lv_enq     = lv_tabname.

  TRY.
      CREATE DATA lr_plan TYPE STANDARD TABLE OF (is_params-table_name).
      ASSIGN lr_plan->* TO <plan>.
      /ui2/cl_json=>deserialize(
        EXPORTING json        = is_params-plan_json
                  pretty_name = /ui2/cl_json=>pretty_mode-none
        CHANGING  data        = <plan> ).
    CATCH cx_root INTO DATA(lx_de).
      cs_result-status = 'error'.
      APPEND |Plan deserialization failed: { lx_de->get_text( ) }| TO cs_result-messages.
      RETURN.
  ENDTRY.

  CALL FUNCTION 'ENQUEUE_E_TABLE'
    EXPORTING
      mode_rstable = 'E'
      tabname      = lv_enq
    EXCEPTIONS
      foreign_lock   = 1
      system_failure = 2
      OTHERS         = 3.
  IF sy-subrc <> 0.
    cs_result-status = 'error'.
    APPEND |ENQUEUE failed (subrc { sy-subrc })| TO cs_result-messages.
    RETURN.
  ENDIF.

  TRY.
      MODIFY (is_params-table_name) FROM TABLE <plan>.
      cs_result-rows_written = sy-dbcnt.
      " A table with no maintenance view, written with a transport: record its
      " row keys as R3TR TABU, as the dedicated transaction would (CUNI: T006*).
      IF is_params-transport IS NOT INITIAL.
        LOOP AT <plan> ASSIGNING <prow>.
          PERFORM keep_entry USING <prow> CHANGING lt_written.
        ENDLOOP.
        lv_trkorr = is_params-transport.
        PERFORM record_headless USING is_params lv_trkorr lv_noview lt_written CHANGING cs_result.
        IF cs_result-status = 'error'.
          ROLLBACK WORK.
          cs_result-rows_written = 0.
          CALL FUNCTION 'DEQUEUE_E_TABLE'
            EXPORTING mode_rstable = 'E' tabname = lv_enq.
          RETURN.
        ENDIF.
      ENDIF.
      COMMIT WORK AND WAIT.
      cs_result-status = 'ok'.
      " Count the keys now on the request and its tasks, as the view path does.
      IF is_params-transport IS NOT INITIAL.
        DATA: lt_dkorr TYPE RANGE OF trkorr,
              lv_dkeys TYPE i.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_trkorr ) TO lt_dkorr.
        SELECT trkorr FROM e070 WHERE strkorr = @lv_trkorr INTO TABLE @DATA(lt_dtasks).
        LOOP AT lt_dtasks INTO DATA(ls_dtask).
          APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_dtask-trkorr ) TO lt_dkorr.
        ENDLOOP.
        SELECT COUNT(*) INTO @lv_dkeys FROM e071k
          WHERE trkorr IN @lt_dkorr AND pgmid = 'R3TR' AND object = 'TABU' AND objname = @lv_tabname.
        cs_result-e071k_count = lv_dkeys.
      ENDIF.
      lv_msg = COND #( WHEN is_params-transport IS INITIAL
                       THEN |Wrote { cs_result-rows_written } row(s) to { lv_tabname } (direct, no transport)|
                       ELSE |Wrote { cs_result-rows_written } row(s) to { lv_tabname } (direct) → { is_params-transport }| ).
      APPEND lv_msg TO cs_result-messages.
    CATCH cx_root INTO DATA(lx_wr).
      ROLLBACK WORK.
      cs_result-status = 'error'.
      APPEND |Direct write exception: { lx_wr->get_text( ) }| TO cs_result-messages.
  ENDTRY.

  CALL FUNCTION 'DEQUEUE_E_TABLE'
    EXPORTING mode_rstable = 'E' tabname = lv_enq.
ENDFORM.
