CLASS zcl_mcp_bw_engine DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  "! BW part of the MCP engine (optional; installed where BW exists). Reached
  "! through ZCL_MCP_CUST_ENGINE, which hands every bw_* operation to HANDLE.
  "! The engine, its modes, installation and authorizations: see ZCL_MCP_CUST_ENGINE.
  "! Project and full documentation: https://github.com/netweaver1970/abap-config-mcp.
  "!
  "! Works on BW 7.5 (SAP_BW) and BW/4HANA (DW4CORE) without knowing which in
  "! advance: no BW function module, class or DDIC type is referenced statically.
  "! Function modules are called by name after a TFDIR check, structures are
  "! created by name, BW tables are read with dynamic FROM. Object types come
  "! from BW's own registry RSTLOGOPROP (main table, name field, text table), so
  "! list / read / where-used cover every BW object type the system has.
  "!
  "! Writes call BW's own APIs with BW's transport layer switched off (it would
  "! ask for a request in a dialog) and record the objects afterwards with
  "! RS_TR_WRITE_OBJECTS_TO_REQUEST, package and request supplied, no popup.
  PUBLIC SECTION.
    CLASS-METHODS handle
      IMPORTING iv_json        TYPE string
                iv_version     TYPE string
      RETURNING VALUE(rv_json) TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_req,
             operation          TYPE string,
             tlogo              TYPE string,    " BW object type, e.g. IOBJ, ADSO, AREA, HCPR, TRFN, DTPA
             name               TYPE string,
             pattern            TYPE string,    " list: name pattern, * as wildcard
             objvers            TYPE string,    " A (default) or M
             language           TYPE string,
             max_rows           TYPE i,
             commit             TYPE abap_bool,
             activate           TYPE abap_bool,
             transport          TYPE string,    " Workbench request (task or request) to record onto
             package            TYPE string,    " package of a new object ($TMP or a local $ package: no recording)
             details_json       TYPE string,    " IOBJ: BAPI6108 fields
             compounds_json     TYPE string,    " IOBJ: BAPI6108CM rows
             attributes_json    TYPE string,    " IOBJ: BAPI6108AT rows
             navattr_json       TYPE string,    " IOBJ: BAPI6108AN rows
             values_json        TYPE string,    " change: [{FIELD,VALUE}] applied to the current definition
           END OF ty_req.

    TYPES: BEGIN OF ty_resp,
             status    TYPE string,
             operation TYPE string,
             version   TYPE string,
             dry_run   TYPE abap_bool,
             messages  TYPE stringtab,
             data_json TYPE string,
           END OF ty_resp.

    TYPES: BEGIN OF ty_field_value,
             field TYPE string,
             value TYPE string,
           END OF ty_field_value,
           ty_field_value_tt TYPE STANDARD TABLE OF ty_field_value WITH DEFAULT KEY.

    " One operation of one object type, and whether this system can do it.
    TYPES: BEGIN OF ty_cap_op,
             op     TYPE string,
             status TYPE string,     " available | no_api | not_built
             api    TYPE string,
           END OF ty_cap_op,
           ty_cap_op_tt TYPE STANDARD TABLE OF ty_cap_op WITH DEFAULT KEY,
           BEGIN OF ty_cap_type,
             tlogo    TYPE string,
             text     TYPE string,
             tlogotab TYPE string,
             ops      TYPE ty_cap_op_tt,
           END OF ty_cap_type,
           ty_cap_type_tt TYPE STANDARD TABLE OF ty_cap_type WITH DEFAULT KEY,
           BEGIN OF ty_caps,
             line       TYPE string,     " BW4HANA | BW75 | NONE
             sap_bw     TYPE string,
             dw4core    TYPE string,
             transport  TYPE abap_bool,  " RS_TR_WRITE_OBJECTS_TO_REQUEST present
             where_used TYPE abap_bool,  " RSOOBJXREF present
             bw_client  TYPE string,     " the client BW runs in (RS_MANDT_UNIQUE_GET); '' when BW is not set up
             in_bw_client TYPE abap_bool, " this client is BW's client: BW's write APIs can run here
             types      TYPE ty_cap_type_tt,
           END OF ty_caps.

    TYPES: BEGIN OF ty_tlogo,
             tlogo    TYPE string,
             tlogotab TYPE string,
             fieldnm  TYPE string,
             txttab   TYPE string,
             class    TYPE string,
             has_vers TYPE abap_bool,
           END OF ty_tlogo.

    CONSTANTS: c_default_rows TYPE i VALUE 200,
               c_max_rows     TYPE i VALUE 1000.

    CLASS-METHODS bw_capabilities
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_list
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_read
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_where_used
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_create
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_change
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_activate
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS bw_delete
      IMPORTING is_req         TYPE ty_req
      RETURNING VALUE(rs_resp) TYPE ty_resp.

    "! The registry entry of a BW object type (RSTLOGOPROP); tlogo initial when unknown.
    CLASS-METHODS tlogo_info
      IMPORTING iv_tlogo       TYPE string
      RETURNING VALUE(rs_info) TYPE ty_tlogo.
    "! The client BW runs in (RS_MANDT_UNIQUE_GET); '' when BW is not set up on this system.
    CLASS-METHODS bw_client
      RETURNING VALUE(rv_client) TYPE string.
    "! True when BW's write APIs can run in this client; otherwise the three-part refusal is appended.
    CLASS-METHODS writes_possible
      IMPORTING iv_what      TYPE string
      CHANGING  ct_messages  TYPE stringtab
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS fm_exists
      IMPORTING iv_fm        TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS class_exists
      IMPORTING iv_class     TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS table_exists
      IMPORTING iv_table     TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS field_exists
      IMPORTING iv_table     TYPE string
                iv_field     TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS is_valid_name
      IMPORTING iv_name      TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS esc
      IMPORTING iv_val        TYPE string
      RETURNING VALUE(rv_val) TYPE string.
    CLASS-METHODS may_display
      IMPORTING iv_table     TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    "! Create a data object by type name, trying each name in turn (DDIC, then type pool).
    CLASS-METHODS create_by_name
      IMPORTING it_names       TYPE string_table
                iv_table       TYPE abap_bool DEFAULT abap_false
      RETURNING VALUE(rr_data) TYPE REF TO data.
    "! Messages of a BAPIRET2-like table (TYPE, MESSAGE) into the response; true when any is E or A.
    CLASS-METHODS take_bapiret
      IMPORTING it_ret        TYPE ANY TABLE
      CHANGING  ct_messages   TYPE stringtab
      RETURNING VALUE(rv_err) TYPE abap_bool.
    "! Messages of an RS_T_MSG-like table (MSGTY, MSGID, MSGNO, MSGV1..4) into the response.
    CLASS-METHODS take_rsmsg
      IMPORTING it_msg        TYPE ANY TABLE
      CHANGING  ct_messages   TYPE stringtab
      RETURNING VALUE(rv_err) TYPE abap_bool.
    "! The package of an object (TADIR R3TR <tlogo> <name>); '' when it has no entry.
    CLASS-METHODS package_of
      IMPORTING iv_tlogo         TYPE string
                iv_name          TYPE string
      RETURNING VALUE(rv_devclass) TYPE string.
    "! Record objects onto a Workbench request with BW's own function, package supplied (no dialog).
    CLASS-METHODS record_transport
      IMPORTING iv_tlogo     TYPE string
                iv_name      TYPE string
                iv_package   TYPE string
                iv_request   TYPE string
      CHANGING  ct_messages  TYPE stringtab
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS iobj_activate
      IMPORTING iv_name      TYPE string
      CHANGING  ct_messages  TYPE stringtab
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    "! BAPI_IOBJ_GETDETAIL into data objects created by name; false when the InfoObject is not found.
    CLASS-METHODS iobj_get
      IMPORTING iv_name      TYPE string
                iv_objvers   TYPE string
      EXPORTING er_details   TYPE REF TO data
                er_compounds TYPE REF TO data
                er_attrs     TYPE REF TO data
                er_navattrs  TYPE REF TO data
      CHANGING  ct_messages  TYPE stringtab
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS fill_from_json
      IMPORTING iv_json      TYPE string
                ir_data      TYPE REF TO data.
    CLASS-METHODS to_json
      IMPORTING ir_data       TYPE REF TO data
      RETURNING VALUE(rv_json) TYPE string.
ENDCLASS.



CLASS zcl_mcp_bw_engine IMPLEMENTATION.

  METHOD handle.
    DATA: ls_req  TYPE ty_req,
          ls_resp TYPE ty_resp.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_json pretty_name = /ui2/cl_json=>pretty_mode-none
                                   CHANGING data = ls_req ).
        ls_req-tlogo = to_upper( ls_req-tlogo ).
        ls_req-name  = to_upper( ls_req-name ).
        CASE to_lower( ls_req-operation ).
          WHEN 'bw_capabilities'. ls_resp = bw_capabilities( ).
          WHEN 'bw_list'.         ls_resp = bw_list( ls_req ).
          WHEN 'bw_read'.         ls_resp = bw_read( ls_req ).
          WHEN 'bw_where_used'.   ls_resp = bw_where_used( ls_req ).
          WHEN 'bw_create'.       ls_resp = bw_create( ls_req ).
          WHEN 'bw_change'.       ls_resp = bw_change( ls_req ).
          WHEN 'bw_activate'.     ls_resp = bw_activate( ls_req ).
          WHEN 'bw_delete'.       ls_resp = bw_delete( ls_req ).
          WHEN OTHERS.
            ls_resp-status = 'error'.
            APPEND |Unknown operation: '{ ls_req-operation }'| TO ls_resp-messages.
        ENDCASE.
      CATCH cx_root INTO DATA(lx).
        ls_resp-status = 'error'.
        APPEND |{ ls_req-operation } stopped: { lx->get_text( ) }| TO ls_resp-messages.
    ENDTRY.
    ls_resp-operation = ls_req-operation.
    ls_resp-version   = iv_version.
    /ui2/cl_json=>serialize( EXPORTING data = ls_resp pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rv_json ).
  ENDMETHOD.


  METHOD bw_capabilities.
    DATA: ls_caps TYPE ty_caps,
          lt_ops  TYPE ty_cap_op_tt.

    SELECT SINGLE release FROM cvers WHERE component = 'SAP_BW'  INTO @ls_caps-sap_bw.
    SELECT SINGLE release FROM cvers WHERE component = 'DW4CORE' INTO @ls_caps-dw4core.
    ls_caps-line = COND #( WHEN ls_caps-dw4core IS NOT INITIAL THEN `BW4HANA`
                           WHEN ls_caps-sap_bw  IS NOT INITIAL THEN `BW75`
                           ELSE `NONE` ).
    ls_caps-transport  = fm_exists( `RS_TR_WRITE_OBJECTS_TO_REQUEST` ).
    ls_caps-bw_client    = bw_client( ).
    ls_caps-in_bw_client = xsdbool( ls_caps-bw_client IS NOT INITIAL AND ls_caps-bw_client = sy-mandt ).
    ls_caps-where_used = table_exists( `RSOOBJXREF` ).
    IF ls_caps-line = `NONE` OR table_exists( `RSTLOGOPROP` ) = abap_false.
      rs_resp-status = 'ok'.
      APPEND |No BW on this system (neither SAP_BW nor DW4CORE, or no RSTLOGOPROP).| TO rs_resp-messages.
      /ui2/cl_json=>serialize( EXPORTING data = ls_caps pretty_name = /ui2/cl_json=>pretty_mode-none
                               RECEIVING r_json = rs_resp-data_json ).
      RETURN.
    ENDIF.

    " Every object type BW has a main table for: list, read and where-used work generically.
    DATA lv_sel TYPE string VALUE `TLOGO, TLOGOTAB, FIELDNM`.
    TYPES: BEGIN OF ty_p, tlogo TYPE c LENGTH 4, tlogotab TYPE c LENGTH 30, fieldnm TYPE c LENGTH 30, END OF ty_p.
    DATA lt_p TYPE STANDARD TABLE OF ty_p WITH DEFAULT KEY.
    SELECT (lv_sel) FROM ('RSTLOGOPROP') WHERE tlogotab <> @space ORDER BY tlogo INTO CORRESPONDING FIELDS OF TABLE @lt_p.
    LOOP AT lt_p INTO DATA(ls_p) WHERE fieldnm IS NOT INITIAL.
      APPEND INITIAL LINE TO ls_caps-types ASSIGNING FIELD-SYMBOL(<t>).
      <t>-tlogo    = ls_p-tlogo.
      <t>-tlogotab = ls_p-tlogotab.
      CLEAR lt_ops.
      APPEND VALUE #( op = `list`       status = `available` api = |{ ls_p-tlogotab } (RSTLOGOPROP)| ) TO lt_ops.
      APPEND VALUE #( op = `read`       status = `available` api = |{ ls_p-tlogotab } (RSTLOGOPROP)| ) TO lt_ops.
      APPEND VALUE #( op = `where_used` status = COND #( WHEN ls_caps-where_used = abap_true THEN `available` ELSE `no_api` )
                      api = `RSOOBJXREF` ) TO lt_ops.
      IF ls_p-tlogo = 'IOBJ'.
        LOOP AT VALUE string_table( ( `create:BAPI_IOBJ_CREATE` ) ( `change:BAPI_IOBJ_CHANGE` )
                                    ( `activate:BAPI_IOBJ_ACTIVATE_MULTIPLE` ) ( `delete:RSDG_IOBJ_MULTI_DELETE` )
                                    ( `detail:BAPI_IOBJ_GETDETAIL` ) ) INTO DATA(lv_opfm).
          SPLIT lv_opfm AT ':' INTO DATA(lv_op) DATA(lv_fm).
          APPEND VALUE #( op = lv_op api = lv_fm
                          status = COND #( WHEN fm_exists( lv_fm ) = abap_true THEN `available` ELSE `no_api` ) ) TO lt_ops.
        ENDLOOP.
      ELSE.
        LOOP AT VALUE string_table( ( `create` ) ( `change` ) ( `activate` ) ( `delete` ) ) INTO lv_op.
          APPEND VALUE #( op = lv_op status = `not_built` ) TO lt_ops.
        ENDLOOP.
      ENDIF.
      <t>-ops = lt_ops.
    ENDLOOP.

    rs_resp-status = 'ok'.
    /ui2/cl_json=>serialize( EXPORTING data = ls_caps pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rs_resp-data_json ).
  ENDMETHOD.


  METHOD tlogo_info.
    TYPES: BEGIN OF ty_p,
             tlogo    TYPE c LENGTH 4,
             tlogotab TYPE c LENGTH 30,
             fieldnm  TYPE c LENGTH 30,
             txttab   TYPE c LENGTH 30,
             class    TYPE c LENGTH 30,
           END OF ty_p.
    DATA: ls_p   TYPE ty_p,
          lv_sel TYPE string VALUE `TLOGO, TLOGOTAB, FIELDNM, TXTTAB, CLASS`.
    IF is_valid_name( iv_tlogo ) = abap_false OR table_exists( `RSTLOGOPROP` ) = abap_false.
      RETURN.
    ENDIF.
    SELECT SINGLE (lv_sel) FROM ('RSTLOGOPROP') WHERE tlogo = @iv_tlogo INTO CORRESPONDING FIELDS OF @ls_p.
    IF sy-subrc <> 0 OR ls_p-tlogotab IS INITIAL OR ls_p-fieldnm IS INITIAL.
      RETURN.
    ENDIF.
    rs_info-tlogo    = ls_p-tlogo.
    rs_info-tlogotab = ls_p-tlogotab.
    rs_info-fieldnm  = ls_p-fieldnm.
    rs_info-txttab   = ls_p-txttab.
    rs_info-class    = ls_p-class.
    rs_info-has_vers = field_exists( iv_table = rs_info-tlogotab iv_field = `OBJVERS` ).
  ENDMETHOD.


  METHOD bw_list.
    TYPES: BEGIN OF ty_row,
             name TYPE string,
             text TYPE string,
           END OF ty_row.
    DATA: lt_rows  TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY,
          lt_names TYPE string_table,
          lv_where TYPE string,
          lv_max   TYPE i,
          lv_fetch TYPE i,
          lv_pat   TYPE string,
          lv_vers  TYPE string.

    DATA(ls_t) = tlogo_info( is_req-tlogo ).
    IF ls_t-tlogo IS INITIAL.
      rs_resp-status = 'error'.
      APPEND |Listing stopped: '{ is_req-tlogo }' is not a BW object type on this system (RSTLOGOPROP). | &&
             |Run bw_capabilities for the types it has.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF may_display( ls_t-tlogotab ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Listing { ls_t-tlogo } stopped: you are not authorized to display { ls_t-tlogotab } (S_TABU_DIS / S_TABU_NAM, activity 03).|
        TO rs_resp-messages.
      RETURN.
    ENDIF.

    lv_max   = COND #( WHEN is_req-max_rows <= 0 THEN c_default_rows WHEN is_req-max_rows > c_max_rows THEN c_max_rows ELSE is_req-max_rows ).
    lv_fetch = lv_max + 1.
    lv_vers  = COND #( WHEN is_req-objvers IS NOT INITIAL THEN to_upper( is_req-objvers ) ELSE `A` ).
    lv_pat   = COND #( WHEN is_req-pattern IS NOT INITIAL THEN to_upper( is_req-pattern ) ELSE `*` ).
    REPLACE ALL OCCURRENCES OF `*` IN lv_pat WITH `%`.
    lv_where = |{ ls_t-fieldnm } LIKE '{ esc( lv_pat ) }'|.
    IF ls_t-has_vers = abap_true.
      lv_where = |{ lv_where } AND OBJVERS = '{ esc( lv_vers ) }'|.
    ENDIF.

    TRY.
        SELECT DISTINCT (ls_t-fieldnm) FROM (ls_t-tlogotab)
          WHERE (lv_where)
          ORDER BY (ls_t-fieldnm)
          INTO TABLE @lt_names
          UP TO @lv_fetch ROWS.
      CATCH cx_root INTO DATA(lx).
        rs_resp-status = 'error'.
        APPEND |Listing { ls_t-tlogo } stopped: { lx->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.
    IF lines( lt_names ) > lv_max.
      DATA(lv_cut) = lv_max + 1.
      DELETE lt_names FROM lv_cut.
      APPEND |First { lv_max } { ls_t-tlogo } objects; there are more. Narrow the pattern or raise maxRows (at most { c_max_rows }).|
        TO rs_resp-messages.
    ENDIF.

    LOOP AT lt_names INTO DATA(lv_name).
      APPEND VALUE #( name = condense( lv_name ) ) TO lt_rows.
    ENDLOOP.

    " Long texts from the type's text table, when it has the usual LANGU / name / TXTLG fields.
    IF ls_t-txttab IS NOT INITIAL AND lt_rows IS NOT INITIAL
    AND field_exists( iv_table = ls_t-txttab iv_field = ls_t-fieldnm ) = abap_true
    AND field_exists( iv_table = ls_t-txttab iv_field = `TXTLG` ) = abap_true
    AND field_exists( iv_table = ls_t-txttab iv_field = `LANGU` ) = abap_true.
      DATA(lv_lang) = COND sy-langu( WHEN is_req-language IS NOT INITIAL THEN is_req-language ELSE sy-langu ).
      LOOP AT lt_rows ASSIGNING FIELD-SYMBOL(<r>).
        DATA(lv_tw) = |{ ls_t-fieldnm } = '{ esc( <r>-name ) }' AND LANGU = '{ lv_lang }'| &&
                      COND string( WHEN field_exists( iv_table = ls_t-txttab iv_field = `OBJVERS` ) = abap_true
                                   THEN | AND OBJVERS = '{ esc( lv_vers ) }'| ELSE `` ).
        TRY.
            SELECT SINGLE ('TXTLG') FROM (ls_t-txttab) WHERE (lv_tw) INTO @<r>-text.
          CATCH cx_root.
            CLEAR <r>-text.
        ENDTRY.
      ENDLOOP.
    ENDIF.

    rs_resp-status = 'ok'.
    /ui2/cl_json=>serialize( EXPORTING data = lt_rows pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rs_resp-data_json ).
  ENDMETHOD.


  METHOD bw_read.
    DATA: lr_rows  TYPE REF TO data,
          lt_vers  TYPE string_table,
          lv_where TYPE string,
          lv_vers  TYPE string,
          lv_rows  TYPE string,
          lv_det   TYPE string.
    FIELD-SYMBOLS <rows> TYPE STANDARD TABLE.

    DATA(ls_t) = tlogo_info( is_req-tlogo ).
    IF ls_t-tlogo IS INITIAL OR is_valid_name( is_req-name ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Reading stopped: give a BW object type the system has (bw_capabilities lists them) and a valid name; | &&
             |got '{ is_req-tlogo }' '{ is_req-name }'.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF may_display( ls_t-tlogotab ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Reading { ls_t-tlogo } { is_req-name } stopped: you are not authorized to display { ls_t-tlogotab } | &&
             |(S_TABU_DIS / S_TABU_NAM, activity 03).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_vers = COND #( WHEN is_req-objvers IS NOT INITIAL THEN to_upper( is_req-objvers ) ELSE `A` ).

    " Which versions exist (A active, M modified, D delivered, ...).
    IF ls_t-has_vers = abap_true.
      lv_where = |{ ls_t-fieldnm } = '{ esc( is_req-name ) }'|.
      SELECT DISTINCT ('OBJVERS') FROM (ls_t-tlogotab) WHERE (lv_where) INTO TABLE @lt_vers.
      IF lt_vers IS INITIAL.
        rs_resp-status = 'error'.
        APPEND |Reading stopped: there is no { ls_t-tlogo } { is_req-name } on this system. Check the name with bw_list.|
          TO rs_resp-messages.
        RETURN.
      ENDIF.
      lv_where = |{ lv_where } AND OBJVERS = '{ esc( lv_vers ) }'|.
    ELSE.
      lv_where = |{ ls_t-fieldnm } = '{ esc( is_req-name ) }'|.
    ENDIF.

    " The object's rows in its main table (header data, as BW stores it).
    TRY.
        CREATE DATA lr_rows TYPE STANDARD TABLE OF (ls_t-tlogotab).
        ASSIGN lr_rows->* TO <rows>.
        SELECT * FROM (ls_t-tlogotab) WHERE (lv_where) INTO TABLE @<rows> UP TO 50 ROWS.
      CATCH cx_root INTO DATA(lx).
        rs_resp-status = 'error'.
        APPEND |Reading { ls_t-tlogo } { is_req-name } stopped: { lx->get_text( ) }| TO rs_resp-messages.
        RETURN.
    ENDTRY.
    IF <rows> IS INITIAL AND ls_t-has_vers = abap_true.
      APPEND |{ ls_t-tlogo } { is_req-name } has no version { lv_vers }; it has { concat_lines_of( table = lt_vers sep = `, ` ) }.|
        TO rs_resp-messages.
    ENDIF.
    lv_rows = to_json( lr_rows ).

    " InfoObject: the full definition through BW's own read API.
    IF ls_t-tlogo = 'IOBJ' AND <rows> IS NOT INITIAL.
      DATA: lr_d TYPE REF TO data, lr_c TYPE REF TO data, lr_a TYPE REF TO data, lr_n TYPE REF TO data.
      DATA lv_got TYPE abap_bool.
      iobj_get( EXPORTING iv_name = is_req-name iv_objvers = lv_vers
                IMPORTING er_details = lr_d er_compounds = lr_c er_attrs = lr_a er_navattrs = lr_n
                CHANGING  ct_messages = rs_resp-messages
                RECEIVING rv_ok = lv_got ).
      IF lv_got = abap_true.
        lv_det = |,"DETAIL":\{"DETAILS":{ to_json( lr_d ) },"COMPOUNDS":{ to_json( lr_c ) },| &&
                 |"ATTRIBUTES":{ to_json( lr_a ) },"NAVIGATIONATTRIBUTES":{ to_json( lr_n ) }\}|.
      ENDIF.
    ENDIF.

    DATA(lv_pkg) = package_of( iv_tlogo = ls_t-tlogo iv_name = is_req-name ).
    DATA lv_versions TYPE string.
    /ui2/cl_json=>serialize( EXPORTING data = lt_vers pretty_name = /ui2/cl_json=>pretty_mode-none RECEIVING r_json = lv_versions ).
    rs_resp-status    = 'ok'.
    rs_resp-data_json = |\{"TLOGO":"{ ls_t-tlogo }","NAME":"{ is_req-name }","OBJVERS":"{ lv_vers }",| &&
                        |"VERSIONS":{ COND string( WHEN lv_versions IS INITIAL THEN `[]` ELSE lv_versions ) },| &&
                        |"PACKAGE":"{ lv_pkg }","TABLE":"{ ls_t-tlogotab }","ROWS":{ lv_rows }{ lv_det }\}|.
  ENDMETHOD.


  METHOD bw_where_used.
    TYPES: BEGIN OF ty_x,
             tlogo     TYPE c LENGTH 4,
             objnm     TYPE c LENGTH 40,
             tlogo_dep TYPE c LENGTH 4,
             objnm_dep TYPE c LENGTH 40,
             asc_type  TYPE n LENGTH 3,
           END OF ty_x.
    TYPES: BEGIN OF ty_out,
             used_by TYPE STANDARD TABLE OF ty_x WITH DEFAULT KEY,
             uses    TYPE STANDARD TABLE OF ty_x WITH DEFAULT KEY,
           END OF ty_out.
    DATA: ls_out   TYPE ty_out,
          lv_sel   TYPE string VALUE `TLOGO, OBJNM, TLOGO_DEP, OBJNM_DEP, ASC_TYPE`,
          lv_where TYPE string,
          lv_vers  TYPE string.

    IF table_exists( `RSOOBJXREF` ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Where-used stopped: this system has no RSOOBJXREF (BW's where-used table).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF is_valid_name( is_req-tlogo ) = abap_false OR is_valid_name( is_req-name ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Where-used stopped: give a BW object type and name; got '{ is_req-tlogo }' '{ is_req-name }'.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF may_display( `RSOOBJXREF` ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Where-used stopped: you are not authorized to display RSOOBJXREF (S_TABU_DIS / S_TABU_NAM, activity 03).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_vers = COND #( WHEN is_req-objvers IS NOT INITIAL THEN to_upper( is_req-objvers ) ELSE `A` ).

    " Objects that depend on this one (it appears as the dependent side of their entries is the other way round:
    " in RSOOBJXREF, TLOGO/OBJNM uses TLOGO_DEP/OBJNM_DEP).
    lv_where = |TLOGO_DEP = '{ esc( is_req-tlogo ) }' AND OBJNM_DEP = '{ esc( is_req-name ) }' AND OBJVERS = '{ esc( lv_vers ) }'|.
    SELECT (lv_sel) FROM ('RSOOBJXREF') WHERE (lv_where) INTO CORRESPONDING FIELDS OF TABLE @ls_out-used_by UP TO 1000 ROWS.
    lv_where = |TLOGO = '{ esc( is_req-tlogo ) }' AND OBJNM = '{ esc( is_req-name ) }' AND OBJVERS = '{ esc( lv_vers ) }'|.
    SELECT (lv_sel) FROM ('RSOOBJXREF') WHERE (lv_where) INTO CORRESPONDING FIELDS OF TABLE @ls_out-uses UP TO 1000 ROWS.

    rs_resp-status = 'ok'.
    /ui2/cl_json=>serialize( EXPORTING data = ls_out pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rs_resp-data_json ).
  ENDMETHOD.


  METHOD bw_create.
    DATA: lr_det  TYPE REF TO data, lr_cmp TYPE REF TO data, lr_atr TYPE REF TO data, lr_nav TYPE REF TO data,
          lr_ret  TYPE REF TO data, lr_rett TYPE REF TO data,
          lt_ptab TYPE abap_func_parmbind_tab,
          lt_etab TYPE abap_func_excpbind_tab,
          lv_iobj TYPE c LENGTH 30,
          lv_fm   TYPE string.
    FIELD-SYMBOLS: <det> TYPE any, <f> TYPE any, <ret> TYPE any, <rett> TYPE ANY TABLE.

    IF is_req-tlogo <> 'IOBJ'.
      rs_resp-status = 'error'.
      APPEND |Creating stopped: creating { is_req-tlogo } objects is not built yet; this version creates InfoObjects (IOBJ). | &&
             |bw_capabilities shows what each type supports.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA lv_can TYPE abap_bool.
    writes_possible( EXPORTING iv_what = |Creating { is_req-tlogo } { is_req-name }| CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_can ).
    IF lv_can = abap_false.
      rs_resp-status = 'error'.
      RETURN.
    ENDIF.
    lv_fm = `BAPI_IOBJ_CREATE`.
    IF fm_exists( lv_fm ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Creating stopped: this system has no { lv_fm }, which BW uses to create InfoObjects. bw_capabilities shows what it has.|
        TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF is_valid_name( is_req-name ) = abap_false OR strlen( is_req-name ) > 30.
      rs_resp-status = 'error'.
      APPEND |Creating stopped: '{ is_req-name }' is not a valid InfoObject name (letters, digits, _ and a /namespace/, at most 30).|
        TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA(ls_t) = tlogo_info( `IOBJ` ).
    DATA(lv_w) = |{ ls_t-fieldnm } = '{ esc( is_req-name ) }'|.
    DATA lv_exists TYPE string.
    SELECT SINGLE (ls_t-fieldnm) FROM (ls_t-tlogotab) WHERE (lv_w) INTO @lv_exists.
    IF sy-subrc = 0.
      rs_resp-status = 'error'.
      APPEND |Creating stopped: InfoObject { is_req-name } already exists. Change it with bw_change, or pick another name.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    lr_det = create_by_name( VALUE #( ( `BAPI6108` ) ) ).
    lr_cmp = create_by_name( it_names = VALUE #( ( `BAPI6108CM` ) ) iv_table = abap_true ).
    lr_atr = create_by_name( it_names = VALUE #( ( `BAPI6108AT` ) ) iv_table = abap_true ).
    lr_nav = create_by_name( it_names = VALUE #( ( `BAPI6108AN` ) ) iv_table = abap_true ).
    lr_ret = create_by_name( VALUE #( ( `BAPIRET2` ) ) ).
    lr_rett = create_by_name( it_names = VALUE #( ( `BAPIRET2` ) ) iv_table = abap_true ).
    IF lr_det IS NOT BOUND OR lr_ret IS NOT BOUND OR lr_rett IS NOT BOUND.
      rs_resp-status = 'error'.
      APPEND |Creating stopped: the InfoObject BAPI structures (BAPI6108, BAPIRET2) are not on this system.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    " Every field named in DETAILS must be a field of BAPI6108; the JSON reader would drop an unknown one silently.
    ASSIGN lr_det->* TO <det>.
    FIND ALL OCCURRENCES OF REGEX '"([A-Za-z0-9_]+)"\s*:' IN is_req-details_json RESULTS DATA(lt_keys).
    LOOP AT lt_keys INTO DATA(ls_key).
      READ TABLE ls_key-submatches INTO DATA(ls_sub) INDEX 1.
      DATA(lv_key) = to_upper( substring( val = is_req-details_json off = ls_sub-offset len = ls_sub-length ) ).
      ASSIGN COMPONENT lv_key OF STRUCTURE <det> TO <f>.
      IF sy-subrc <> 0.
        rs_resp-status = 'error'.
        APPEND |Creating stopped: { lv_key } is not a field of the InfoObject definition (BAPI6108; texts are TEXTSHORT and TEXTLONG). | &&
               |Nothing was created. Read an existing InfoObject with bw_read to see the fields.| TO rs_resp-messages.
        RETURN.
      ENDIF.
    ENDLOOP.
    fill_from_json( iv_json = is_req-details_json ir_data = lr_det ).
    IF lr_cmp IS BOUND. fill_from_json( iv_json = is_req-compounds_json  ir_data = lr_cmp ). ENDIF.
    IF lr_atr IS BOUND. fill_from_json( iv_json = is_req-attributes_json ir_data = lr_atr ). ENDIF.
    IF lr_nav IS BOUND. fill_from_json( iv_json = is_req-navattr_json    ir_data = lr_nav ). ENDIF.
    ASSIGN lr_det->* TO <det>.
    ASSIGN COMPONENT 'INFOOBJECT' OF STRUCTURE <det> TO <f>.
    IF sy-subrc = 0.
      <f> = is_req-name.
    ENDIF.

    DATA(lv_pkg) = COND string( WHEN is_req-package IS NOT INITIAL THEN to_upper( is_req-package ) ELSE `$TMP` ).
    DATA(lv_local) = xsdbool( lv_pkg(1) = '$' ).
    IF lv_local = abap_false AND is_req-transport IS INITIAL AND is_req-commit = abap_true.
      rs_resp-status = 'error'.
      APPEND |Creating stopped: package { lv_pkg } records changes, and no transport request was given. | &&
             |Name a Workbench request, or use a local package such as $TMP.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF is_req-commit <> abap_true.
      rs_resp-status  = 'ok'.
      rs_resp-dry_run = abap_true.
      APPEND |DRY RUN — InfoObject { is_req-name } would be created in package { lv_pkg }| &&
             COND string( WHEN lv_local = abap_true THEN ` (local, not recorded)` WHEN is_req-transport IS INITIAL THEN ` (records changes: a Workbench request is needed to commit)`
                          ELSE | on request { is_req-transport }| ) &&
             COND string( WHEN is_req-activate = abap_true THEN `, then activated.` ELSE `, as a modified (M) version.` ) TO rs_resp-messages.
      rs_resp-data_json = |\{"DETAILS":{ to_json( lr_det ) }\}|.
      RETURN.
    ENDIF.

    INSERT VALUE #( name = 'DETAILS'    kind = abap_func_exporting value = lr_det ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'INFOOBJECT' kind = abap_func_importing value = REF #( lv_iobj ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'RETURN'     kind = abap_func_importing value = lr_ret ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'RETURNTABLE' kind = abap_func_tables value = lr_rett ) INTO TABLE lt_ptab.
    IF lr_cmp IS BOUND. INSERT VALUE #( name = 'COMPOUNDS'            kind = abap_func_tables value = lr_cmp ) INTO TABLE lt_ptab. ENDIF.
    IF lr_atr IS BOUND. INSERT VALUE #( name = 'ATTRIBUTES'           kind = abap_func_tables value = lr_atr ) INTO TABLE lt_ptab. ENDIF.
    IF lr_nav IS BOUND. INSERT VALUE #( name = 'NAVIGATIONATTRIBUTES' kind = abap_func_tables value = lr_nav ) INTO TABLE lt_ptab. ENDIF.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_etab.
    CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.

    ASSIGN lr_ret->* TO <ret>.
    ASSIGN lr_rett->* TO <rett>.
    DATA lr_one TYPE REF TO data.
    lr_one = create_by_name( it_names = VALUE #( ( `BAPIRET2` ) ) iv_table = abap_true ).
    FIELD-SYMBOLS <one> TYPE STANDARD TABLE.
    ASSIGN lr_one->* TO <one>.
    INSERT <ret> INTO TABLE <one>.
    DATA: lv_e1 TYPE abap_bool, lv_e2 TYPE abap_bool, lv_ok TYPE abap_bool.
    take_bapiret( EXPORTING it_ret = <one>  CHANGING ct_messages = rs_resp-messages RECEIVING rv_err = lv_e1 ).
    take_bapiret( EXPORTING it_ret = <rett> CHANGING ct_messages = rs_resp-messages RECEIVING rv_err = lv_e2 ).
    IF lv_e1 = abap_true OR lv_e2 = abap_true.
      ROLLBACK WORK.
      rs_resp-status = 'error'.
      APPEND |InfoObject { is_req-name } was not created.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    APPEND |InfoObject { is_req-name } created (modified version).| TO rs_resp-messages.

    rs_resp-status = 'ok'.
    IF is_req-activate = abap_true.
      iobj_activate( EXPORTING iv_name = is_req-name CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
      IF lv_ok = abap_false.
        rs_resp-status = 'error'.
      ENDIF.
    ENDIF.
    record_transport( EXPORTING iv_tlogo = `IOBJ` iv_name = is_req-name iv_package = lv_pkg iv_request = is_req-transport
                      CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
    IF lv_ok = abap_false.
      rs_resp-status = 'error'.
    ENDIF.
  ENDMETHOD.


  METHOD bw_change.
    DATA: lr_d TYPE REF TO data, lr_c TYPE REF TO data, lr_a TYPE REF TO data, lr_n TYPE REF TO data,
          lr_ret TYPE REF TO data, lt_values TYPE ty_field_value_tt,
          lt_ptab TYPE abap_func_parmbind_tab,
          lt_etab TYPE abap_func_excpbind_tab,
          lv_fm TYPE string VALUE `BAPI_IOBJ_CHANGE`.
    FIELD-SYMBOLS: <det> TYPE any, <f> TYPE any, <ret> TYPE any.

    IF is_req-tlogo <> 'IOBJ'.
      rs_resp-status = 'error'.
      APPEND |Changing stopped: changing { is_req-tlogo } objects is not built yet; this version changes InfoObjects (IOBJ).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA lv_can TYPE abap_bool.
    writes_possible( EXPORTING iv_what = |Changing { is_req-tlogo } { is_req-name }| CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_can ).
    IF lv_can = abap_false.
      rs_resp-status = 'error'.
      RETURN.
    ENDIF.
    IF fm_exists( lv_fm ) = abap_false OR fm_exists( `BAPI_IOBJ_GETDETAIL` ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Changing stopped: this system has no { lv_fm } / BAPI_IOBJ_GETDETAIL. bw_capabilities shows what it has.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    " Start from the current definition: the modified version when there is one, else the active one.
    DATA lv_ok TYPE abap_bool.
    iobj_get( EXPORTING iv_name = is_req-name iv_objvers = `M`
              IMPORTING er_details = lr_d er_compounds = lr_c er_attrs = lr_a er_navattrs = lr_n
              CHANGING  ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
    IF lv_ok = abap_false.
      CLEAR rs_resp-messages.
      iobj_get( EXPORTING iv_name = is_req-name iv_objvers = `A`
                IMPORTING er_details = lr_d er_compounds = lr_c er_attrs = lr_a er_navattrs = lr_n
                CHANGING  ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
      IF lv_ok = abap_false.
        rs_resp-status = 'error'.
        APPEND |Changing stopped: there is no InfoObject { is_req-name }. Check the name with bw_list.| TO rs_resp-messages.
        RETURN.
      ENDIF.
    ENDIF.
    CLEAR rs_resp-messages.

    " Field changes on DETAILS; whole tables when given.
    ASSIGN lr_d->* TO <det>.
    IF is_req-values_json IS NOT INITIAL.
      /ui2/cl_json=>deserialize( EXPORTING json = is_req-values_json pretty_name = /ui2/cl_json=>pretty_mode-none
                                 CHANGING data = lt_values ).
    ENDIF.
    LOOP AT lt_values INTO DATA(ls_v).
      ASSIGN COMPONENT to_upper( ls_v-field ) OF STRUCTURE <det> TO <f>.
      IF sy-subrc <> 0.
        rs_resp-status = 'error'.
        APPEND |Changing stopped: { ls_v-field } is not a field of the InfoObject definition (BAPI6108; texts are TEXTSHORT and TEXTLONG). | &&
               |Nothing was changed.| TO rs_resp-messages.
        RETURN.
      ENDIF.
      <f> = ls_v-value.
    ENDLOOP.
    IF is_req-compounds_json  IS NOT INITIAL. fill_from_json( iv_json = is_req-compounds_json  ir_data = lr_c ). ENDIF.
    IF is_req-attributes_json IS NOT INITIAL. fill_from_json( iv_json = is_req-attributes_json ir_data = lr_a ). ENDIF.
    IF is_req-navattr_json    IS NOT INITIAL. fill_from_json( iv_json = is_req-navattr_json    ir_data = lr_n ). ENDIF.

    DATA(lv_pkg) = package_of( iv_tlogo = `IOBJ` iv_name = is_req-name ).
    DATA(lv_local) = xsdbool( lv_pkg IS INITIAL OR lv_pkg(1) = '$' ).
    IF lv_local = abap_false AND is_req-transport IS INITIAL AND is_req-commit = abap_true.
      rs_resp-status = 'error'.
      APPEND |Changing stopped: { is_req-name } is in package { lv_pkg }, which records changes, and no transport request was given. | &&
             |Name a Workbench request.| TO rs_resp-messages.
      RETURN.
    ENDIF.

    IF is_req-commit <> abap_true.
      rs_resp-status  = 'ok'.
      rs_resp-dry_run = abap_true.
      APPEND |DRY RUN — InfoObject { is_req-name } would be changed ({ lines( lt_values ) } field(s))| &&
             COND string( WHEN is_req-activate = abap_true THEN ` and activated` ELSE `` ) &&
             COND string( WHEN lv_local = abap_true THEN `; local, not recorded.`
                          WHEN is_req-transport IS INITIAL THEN |; package { lv_pkg } records changes, so a Workbench request is needed to commit.|
                          ELSE |; recorded on { is_req-transport }.| ) TO rs_resp-messages.
      rs_resp-data_json = |\{"DETAILS":{ to_json( lr_d ) }\}|.
      RETURN.
    ENDIF.

    lr_ret = create_by_name( VALUE #( ( `BAPIRET2` ) ) ).
    DATA lv_name30 TYPE c LENGTH 30.
    lv_name30 = is_req-name.
    INSERT VALUE #( name = 'INFOOBJECT' kind = abap_func_exporting value = REF #( lv_name30 ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'DETAILS'    kind = abap_func_exporting value = lr_d ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'RETURN'     kind = abap_func_importing value = lr_ret ) INTO TABLE lt_ptab.
    IF lr_c IS BOUND. INSERT VALUE #( name = 'COMPOUNDS'            kind = abap_func_tables value = lr_c ) INTO TABLE lt_ptab. ENDIF.
    IF lr_a IS BOUND. INSERT VALUE #( name = 'ATTRIBUTES'           kind = abap_func_tables value = lr_a ) INTO TABLE lt_ptab. ENDIF.
    IF lr_n IS BOUND. INSERT VALUE #( name = 'NAVIGATIONATTRIBUTES' kind = abap_func_tables value = lr_n ) INTO TABLE lt_ptab. ENDIF.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_etab.
    CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.

    ASSIGN lr_ret->* TO <ret>.
    DATA lr_one TYPE REF TO data.
    lr_one = create_by_name( it_names = VALUE #( ( `BAPIRET2` ) ) iv_table = abap_true ).
    FIELD-SYMBOLS <one> TYPE STANDARD TABLE.
    ASSIGN lr_one->* TO <one>.
    INSERT <ret> INTO TABLE <one>.
    DATA lv_e1 TYPE abap_bool.
    take_bapiret( EXPORTING it_ret = <one> CHANGING ct_messages = rs_resp-messages RECEIVING rv_err = lv_e1 ).
    IF lv_e1 = abap_true.
      ROLLBACK WORK.
      rs_resp-status = 'error'.
      APPEND |InfoObject { is_req-name } was not changed.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    APPEND |InfoObject { is_req-name } changed (modified version).| TO rs_resp-messages.
    rs_resp-status = 'ok'.
    IF is_req-activate = abap_true.
      iobj_activate( EXPORTING iv_name = is_req-name CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
      IF lv_ok = abap_false.
        rs_resp-status = 'error'.
      ENDIF.
    ENDIF.
    IF lv_local = abap_false.
      record_transport( EXPORTING iv_tlogo = `IOBJ` iv_name = is_req-name iv_package = lv_pkg iv_request = is_req-transport
                        CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
      IF lv_ok = abap_false.
        rs_resp-status = 'error'.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD bw_activate.
    IF is_req-tlogo <> 'IOBJ'.
      rs_resp-status = 'error'.
      APPEND |Activating stopped: activating { is_req-tlogo } objects is not built yet; this version activates InfoObjects (IOBJ).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA lv_can TYPE abap_bool.
    writes_possible( EXPORTING iv_what = |Activating { is_req-tlogo } { is_req-name }| CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_can ).
    IF lv_can = abap_false.
      rs_resp-status = 'error'.
      RETURN.
    ENDIF.
    DATA(lv_pkg) = package_of( iv_tlogo = `IOBJ` iv_name = is_req-name ).
    DATA(lv_local) = xsdbool( lv_pkg IS INITIAL OR lv_pkg(1) = '$' ).
    IF lv_local = abap_false AND is_req-transport IS INITIAL AND is_req-commit = abap_true.
      rs_resp-status = 'error'.
      APPEND |Activating stopped: { is_req-name } is in package { lv_pkg }, which records changes, and no transport request was given.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF is_req-commit <> abap_true.
      rs_resp-status  = 'ok'.
      rs_resp-dry_run = abap_true.
      APPEND |DRY RUN — InfoObject { is_req-name } would be activated| &&
             COND string( WHEN lv_local = abap_true THEN `.`
                          WHEN is_req-transport IS INITIAL THEN |; package { lv_pkg } records changes, so a Workbench request is needed to commit.|
                          ELSE | and recorded on { is_req-transport }.| ) TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA lv_ok TYPE abap_bool.
    iobj_activate( EXPORTING iv_name = is_req-name CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
    rs_resp-status = COND #( WHEN lv_ok = abap_true THEN 'ok' ELSE 'error' ).
    IF lv_ok = abap_true AND lv_local = abap_false.
      record_transport( EXPORTING iv_tlogo = `IOBJ` iv_name = is_req-name iv_package = lv_pkg iv_request = is_req-transport
                        CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_ok ).
      IF lv_ok = abap_false.
        rs_resp-status = 'error'.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD bw_delete.
    DATA: lr_names TYPE REF TO data,
          lr_msg   TYPE REF TO data,
          lv_subrc TYPE sy-subrc,
          lt_ptab  TYPE abap_func_parmbind_tab,
          lt_etab  TYPE abap_func_excpbind_tab,
          lv_fm    TYPE string VALUE `RSDG_IOBJ_MULTI_DELETE`,
          lv_flag_x TYPE c LENGTH 1 VALUE 'X',
          lv_flag_  TYPE c LENGTH 1 VALUE ' '.
    FIELD-SYMBOLS: <names> TYPE STANDARD TABLE, <msg> TYPE ANY TABLE.

    IF is_req-tlogo <> 'IOBJ'.
      rs_resp-status = 'error'.
      APPEND |Deleting stopped: deleting { is_req-tlogo } objects is not built yet; this version deletes InfoObjects (IOBJ).| TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA lv_can TYPE abap_bool.
    writes_possible( EXPORTING iv_what = |Deleting { is_req-tlogo } { is_req-name }| CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_can ).
    IF lv_can = abap_false.
      rs_resp-status = 'error'.
      RETURN.
    ENDIF.
    IF fm_exists( lv_fm ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Deleting stopped: this system has no { lv_fm }, which BW uses to delete InfoObjects.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA(ls_t) = tlogo_info( `IOBJ` ).
    DATA(lv_w) = |{ ls_t-fieldnm } = '{ esc( is_req-name ) }'|.
    DATA lv_found TYPE string.
    SELECT SINGLE (ls_t-fieldnm) FROM (ls_t-tlogotab) WHERE (lv_w) INTO @lv_found.
    IF sy-subrc <> 0.
      rs_resp-status = 'error'.
      APPEND |Deleting stopped: there is no InfoObject { is_req-name }.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    " A transported object's deletion travels with the request: BW's export finds no active version and
    " ships the deletion, so the object goes on the request before it is deleted (as RSD1 does).
    DATA(lv_pkg) = package_of( iv_tlogo = `IOBJ` iv_name = is_req-name ).
    DATA(lv_local) = xsdbool( lv_pkg IS INITIAL OR lv_pkg(1) = '$' ).
    IF lv_local = abap_false AND is_req-transport IS INITIAL AND is_req-commit = abap_true.
      rs_resp-status = 'error'.
      APPEND |Deleting stopped: { is_req-name } is in package { lv_pkg }, which records changes, and no transport request was given. | &&
             |The deletion has to be recorded so that it reaches the other systems; name a Workbench request.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    " Who still uses it (BW refuses then too; the list is shown either way).
    DATA lv_users TYPE i.
    IF table_exists( `RSOOBJXREF` ) = abap_true.
      DATA(lv_xw) = |TLOGO_DEP = 'IOBJ' AND OBJNM_DEP = '{ esc( is_req-name ) }' AND OBJVERS = 'A'|.
      SELECT COUNT(*) FROM ('RSOOBJXREF') WHERE (lv_xw) INTO @lv_users.
    ENDIF.
    IF is_req-commit <> abap_true.
      rs_resp-status  = 'ok'.
      rs_resp-dry_run = abap_true.
      APPEND |DRY RUN — InfoObject { is_req-name } (package { COND string( WHEN lv_pkg IS INITIAL THEN `none` ELSE lv_pkg ) }) | &&
             |would be deleted; { lv_users } where-used entr{ COND string( WHEN lv_users = 1 THEN `y` ELSE `ies` ) } point to it| &&
             COND string( WHEN lv_users > 0 THEN ` (BW refuses while it is used; bw_where_used lists them).` ELSE `.` ) TO rs_resp-messages.
      APPEND COND string( WHEN lv_local = abap_true THEN `Local package: the deletion is not recorded.`
                          WHEN is_req-transport IS INITIAL THEN |Package { lv_pkg } records changes: committing needs a Workbench request, which carries the deletion.|
                          ELSE |The deletion is recorded on { is_req-transport }.| ) TO rs_resp-messages.
      RETURN.
    ENDIF.
    IF lv_local = abap_false.
      DATA lv_rec TYPE abap_bool.
      record_transport( EXPORTING iv_tlogo = `IOBJ` iv_name = is_req-name iv_package = lv_pkg iv_request = is_req-transport
                        CHANGING ct_messages = rs_resp-messages RECEIVING rv_ok = lv_rec ).
      IF lv_rec = abap_false.
        rs_resp-status = 'error'.
        APPEND |Deleting stopped: { is_req-name } could not be recorded on { is_req-transport }, so nothing was deleted.| TO rs_resp-messages.
        RETURN.
      ENDIF.
    ENDIF.

    lr_names = create_by_name( it_names = VALUE #( ( `RSD_T_C30` ) ) ).
    lr_msg   = create_by_name( it_names = VALUE #( ( `RS_T_MSG` ) ( `\TYPE-POOL=RS\TYPE=RS_T_MSG` ) ) ).
    IF lr_names IS NOT BOUND OR lr_msg IS NOT BOUND.
      rs_resp-status = 'error'.
      APPEND |Deleting stopped: the types RSD_T_C30 / RS_T_MSG that { lv_fm } needs are not on this system.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    ASSIGN lr_names->* TO <names>.
    APPEND INITIAL LINE TO <names> ASSIGNING FIELD-SYMBOL(<n>).
    <n> = is_req-name.
    INSERT VALUE #( name = 'I_T_IOBJNM'        kind = abap_func_exporting value = lr_names ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'I_WRITE_PROTOCOL'  kind = abap_func_exporting value = REF #( lv_flag_ ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'I_CHECK_DEPENDENT' kind = abap_func_exporting value = REF #( lv_flag_x ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'I_MANUAL'          kind = abap_func_exporting value = REF #( lv_flag_x ) ) INTO TABLE lt_ptab.   " a user's deletion, not an import's
    INSERT VALUE #( name = 'I_WITH_AUTHORITY'  kind = abap_func_exporting value = REF #( lv_flag_x ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'E_T_MSG'           kind = abap_func_importing value = lr_msg ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'E_SUBRC'           kind = abap_func_importing value = REF #( lv_subrc ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_etab.
    CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.
    ASSIGN lr_msg->* TO <msg>.
    DATA lv_err TYPE abap_bool.
    take_rsmsg( EXPORTING it_msg = <msg> CHANGING ct_messages = rs_resp-messages RECEIVING rv_err = lv_err ).

    SELECT SINGLE (ls_t-fieldnm) FROM (ls_t-tlogotab) WHERE (lv_w) INTO @lv_found.
    IF sy-subrc = 0.
      rs_resp-status = 'error'.
      APPEND |InfoObject { is_req-name } was not deleted{ COND string( WHEN lv_subrc = 4 THEN ` (cancelled)` ELSE `` ) }| &&
             COND string( WHEN lv_users > 0 THEN |: { lv_users } object(s) still use it (bw_where_used lists them).| ELSE `.` ) TO rs_resp-messages.
      IF lv_local = abap_false.
        APPEND |It stays on { is_req-transport }, where it now carries the unchanged object.| TO rs_resp-messages.
      ENDIF.
      RETURN.
    ENDIF.
    rs_resp-status = 'ok'.
    APPEND |InfoObject { is_req-name } deleted.| TO rs_resp-messages.
  ENDMETHOD.


  METHOD bw_client.
    DATA: lv_fm     TYPE string VALUE `RS_MANDT_UNIQUE_GET`,
          lv_mandt  TYPE sy-mandt.
    IF fm_exists( lv_fm ) = abap_false.
      RETURN.
    ENDIF.
    CALL FUNCTION lv_fm
      IMPORTING  e_unique_mandt = lv_mandt
      EXCEPTIONS OTHERS         = 1.
    IF sy-subrc = 0.
      rv_client = lv_mandt.
    ENDIF.
  ENDMETHOD.


  METHOD writes_possible.
    DATA(lv_client) = bw_client( ).
    IF lv_client IS INITIAL.
      APPEND |{ iv_what } stopped: BW is not set up on this system (no BW client: RS_MANDT_UNIQUE_GET finds none), | &&
             |so BW's own APIs cannot create or change objects here. Run BW's initial setup in the client BW should use | &&
             |(on S/4HANA the task list SAP_BW_SETUP_INITIAL_S4HANA), then retry.| TO ct_messages.
      RETURN.
    ENDIF.
    IF lv_client <> sy-mandt.
      APPEND |{ iv_what } stopped: BW runs in client { lv_client }, and this connection is logged on to client { sy-mandt }. | &&
             |Use a connection to client { lv_client }.| TO ct_messages.
      RETURN.
    ENDIF.
    rv_ok = abap_true.
  ENDMETHOD.


  METHOD iobj_get.
    DATA: lr_ret  TYPE REF TO data,
          lt_ptab TYPE abap_func_parmbind_tab,
          lt_etab TYPE abap_func_excpbind_tab,
          lv_fm   TYPE string VALUE `BAPI_IOBJ_GETDETAIL`,
          lv_vers TYPE c LENGTH 1,
          lv_name TYPE c LENGTH 30.
    FIELD-SYMBOLS: <ret> TYPE any.
    IF fm_exists( lv_fm ) = abap_false.
      RETURN.
    ENDIF.
    er_details   = create_by_name( VALUE #( ( `BAPI6108` ) ) ).
    er_compounds = create_by_name( it_names = VALUE #( ( `BAPI6108CM` ) ) iv_table = abap_true ).
    er_attrs     = create_by_name( it_names = VALUE #( ( `BAPI6108AT` ) ) iv_table = abap_true ).
    er_navattrs  = create_by_name( it_names = VALUE #( ( `BAPI6108AN` ) ) iv_table = abap_true ).
    lr_ret       = create_by_name( VALUE #( ( `BAPIRET2` ) ) ).
    IF er_details IS NOT BOUND OR lr_ret IS NOT BOUND.
      RETURN.
    ENDIF.
    lv_vers = iv_objvers.
    lv_name = iv_name.
    INSERT VALUE #( name = 'VERSION'    kind = abap_func_exporting value = REF #( lv_vers ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'INFOOBJECT' kind = abap_func_exporting value = REF #( lv_name ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'DETAILS'    kind = abap_func_importing value = er_details ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'RETURN'     kind = abap_func_importing value = lr_ret ) INTO TABLE lt_ptab.
    IF er_compounds IS BOUND. INSERT VALUE #( name = 'COMPOUNDS'            kind = abap_func_tables value = er_compounds ) INTO TABLE lt_ptab. ENDIF.
    IF er_attrs     IS BOUND. INSERT VALUE #( name = 'ATTRIBUTES'           kind = abap_func_tables value = er_attrs ) INTO TABLE lt_ptab. ENDIF.
    IF er_navattrs  IS BOUND. INSERT VALUE #( name = 'NAVIGATIONATTRIBUTES' kind = abap_func_tables value = er_navattrs ) INTO TABLE lt_ptab. ENDIF.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_etab.
    CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.
    ASSIGN lr_ret->* TO <ret>.
    DATA lr_one TYPE REF TO data.
    lr_one = create_by_name( it_names = VALUE #( ( `BAPIRET2` ) ) iv_table = abap_true ).
    FIELD-SYMBOLS <one> TYPE STANDARD TABLE.
    ASSIGN lr_one->* TO <one>.
    INSERT <ret> INTO TABLE <one>.
    DATA lv_err TYPE abap_bool.
    take_bapiret( EXPORTING it_ret = <one> CHANGING ct_messages = ct_messages RECEIVING rv_err = lv_err ).
    rv_ok = xsdbool( lv_err = abap_false ).
  ENDMETHOD.


  METHOD iobj_activate.
    DATA: lr_io   TYPE REF TO data,
          lr_err  TYPE REF TO data,
          lr_rett TYPE REF TO data,
          lt_ptab TYPE abap_func_parmbind_tab,
          lt_etab TYPE abap_func_excpbind_tab,
          lv_fm   TYPE string VALUE `BAPI_IOBJ_ACTIVATE_MULTIPLE`.
    FIELD-SYMBOLS: <io> TYPE STANDARD TABLE, <err> TYPE STANDARD TABLE, <rett> TYPE ANY TABLE, <f> TYPE any.
    IF fm_exists( lv_fm ) = abap_false.
      APPEND |Activating stopped: this system has no { lv_fm }.| TO ct_messages.
      RETURN.
    ENDIF.
    lr_io   = create_by_name( it_names = VALUE #( ( `BAPI6108IO` ) ) iv_table = abap_true ).
    lr_err  = create_by_name( it_names = VALUE #( ( `BAPI6108IO` ) ) iv_table = abap_true ).
    lr_rett = create_by_name( it_names = VALUE #( ( `BAPIRET2` ) ) iv_table = abap_true ).
    ASSIGN lr_io->* TO <io>.
    APPEND INITIAL LINE TO <io> ASSIGNING FIELD-SYMBOL(<line>).
    ASSIGN COMPONENT 'INFOOBJECT' OF STRUCTURE <line> TO <f>.
    IF sy-subrc = 0.
      <f> = iv_name.
    ELSE.
      <line> = iv_name.
    ENDIF.
    INSERT VALUE #( name = 'INFOOBJECTS'       kind = abap_func_tables value = lr_io ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'RETURN'            kind = abap_func_tables value = lr_rett ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'INFOOBJECTS_ERROR' kind = abap_func_tables value = lr_err ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_etab.
    CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.
    ASSIGN lr_rett->* TO <rett>.
    ASSIGN lr_err->* TO <err>.
    DATA lv_err TYPE abap_bool.
    take_bapiret( EXPORTING it_ret = <rett> CHANGING ct_messages = ct_messages RECEIVING rv_err = lv_err ).
    IF lv_err = abap_true OR <err> IS NOT INITIAL.
      ROLLBACK WORK.
      APPEND |InfoObject { iv_name } was not activated.| TO ct_messages.
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    APPEND |InfoObject { iv_name } activated.| TO ct_messages.
    rv_ok = abap_true.
  ENDMETHOD.


  METHOD record_transport.
    DATA: lr_t     TYPE REF TO data,
          lr_msg   TYPE REF TO data,
          lv_subrc TYPE sy-subrc,
          lv_req   TYPE c LENGTH 20,
          lv_out   TYPE c LENGTH 20,
          lt_ptab  TYPE abap_func_parmbind_tab,
          lt_etab  TYPE abap_func_excpbind_tab,
          lv_fm    TYPE string VALUE `RS_TR_WRITE_OBJECTS_TO_REQUEST`.
    FIELD-SYMBOLS: <t> TYPE STANDARD TABLE, <f> TYPE any, <msg> TYPE ANY TABLE.

    IF iv_package IS INITIAL OR iv_package(1) = '$'.
      APPEND |Not recorded: package { COND string( WHEN iv_package IS INITIAL THEN `none` ELSE iv_package ) } is local.| TO ct_messages.
      rv_ok = abap_true.
      RETURN.
    ENDIF.
    IF fm_exists( lv_fm ) = abap_false.
      APPEND |Recording stopped: this system has no { lv_fm }, so { iv_tlogo } { iv_name } was not recorded on { iv_request }. | &&
             |Record it in the BW transport connection (RSOR).| TO ct_messages.
      RETURN.
    ENDIF.
    lr_t   = create_by_name( VALUE #( ( `RS_T_TR_OBJECT` ) ( `\TYPE-POOL=RS\TYPE=RS_T_TR_OBJECT` ) ) ).
    lr_msg = create_by_name( VALUE #( ( `RS_T_MSG` ) ( `\TYPE-POOL=RS\TYPE=RS_T_MSG` ) ) ).
    IF lr_t IS NOT BOUND OR lr_msg IS NOT BOUND.
      APPEND |Recording stopped: the types RS_T_TR_OBJECT / RS_T_MSG are not on this system; { iv_tlogo } { iv_name } was not recorded.|
        TO ct_messages.
      RETURN.
    ENDIF.
    ASSIGN lr_t->* TO <t>.
    APPEND INITIAL LINE TO <t> ASSIGNING FIELD-SYMBOL(<row>).
    LOOP AT VALUE ty_field_value_tt( ( field = `PGMID` value = `R3TR` ) ( field = `OBJECT` value = iv_tlogo )
                                     ( field = `OBJ_NAME` value = iv_name ) ( field = `DEVCLASS` value = iv_package )
                                     ( field = `MASTERLANG` value = CONV string( sy-langu ) ) ) INTO DATA(ls_fv).
      ASSIGN COMPONENT ls_fv-field OF STRUCTURE <row> TO <f>.
      IF sy-subrc = 0.
        <f> = ls_fv-value.
      ENDIF.
    ENDLOOP.
    lv_req = to_upper( iv_request ).
    INSERT VALUE #( name = 'I_T_TR_OBJECT' kind = abap_func_exporting value = lr_t ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'I_REQUEST'     kind = abap_func_exporting value = REF #( lv_req ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'E_T_MSG'       kind = abap_func_importing value = lr_msg ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'E_SUBRC'       kind = abap_func_importing value = REF #( lv_subrc ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'E_REQUEST'     kind = abap_func_importing value = REF #( lv_out ) ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_etab.
    CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.
    ASSIGN lr_msg->* TO <msg>.
    DATA lv_err TYPE abap_bool.
    take_rsmsg( EXPORTING it_msg = <msg> CHANGING ct_messages = ct_messages RECEIVING rv_err = lv_err ).
    IF lv_subrc <> 0 OR sy-subrc <> 0 OR lv_err = abap_true.
      APPEND |{ iv_tlogo } { iv_name } was not recorded on { iv_request } (return code { lv_subrc }). Record it in RSOR.| TO ct_messages.
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    APPEND |{ iv_tlogo } { iv_name } recorded on { COND string( WHEN lv_out IS NOT INITIAL THEN CONV string( lv_out ) ELSE iv_request ) } | &&
           |(package { iv_package }).| TO ct_messages.
    rv_ok = abap_true.
  ENDMETHOD.


  METHOD package_of.
    DATA: lv_obj  TYPE c LENGTH 4,
          lv_name TYPE c LENGTH 40.
    lv_obj  = iv_tlogo.
    lv_name = iv_name.
    SELECT SINGLE devclass FROM tadir WHERE pgmid = 'R3TR' AND object = @lv_obj AND obj_name = @lv_name INTO @rv_devclass.
  ENDMETHOD.


  METHOD take_bapiret.
    FIELD-SYMBOLS: <l> TYPE any, <type> TYPE any, <msg> TYPE any.
    LOOP AT it_ret ASSIGNING <l>.
      ASSIGN COMPONENT 'TYPE'    OF STRUCTURE <l> TO <type>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT 'MESSAGE' OF STRUCTURE <l> TO <msg>.
      CHECK sy-subrc = 0.
      IF <type> IS INITIAL AND <msg> IS INITIAL.
        CONTINUE.
      ENDIF.
      APPEND |{ <type> }: { <msg> }| TO ct_messages.
      IF <type> = 'E' OR <type> = 'A' OR <type> = 'X'.
        rv_err = abap_true.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD take_rsmsg.
    DATA lv_text TYPE string.
    FIELD-SYMBOLS: <l> TYPE any, <ty> TYPE any, <id> TYPE any, <no> TYPE any,
                   <v1> TYPE any, <v2> TYPE any, <v3> TYPE any, <v4> TYPE any.
    LOOP AT it_msg ASSIGNING <l>.
      ASSIGN COMPONENT 'MSGTY' OF STRUCTURE <l> TO <ty>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT 'MSGID' OF STRUCTURE <l> TO <id>.
      ASSIGN COMPONENT 'MSGNO' OF STRUCTURE <l> TO <no>.
      ASSIGN COMPONENT 'MSGV1' OF STRUCTURE <l> TO <v1>.
      ASSIGN COMPONENT 'MSGV2' OF STRUCTURE <l> TO <v2>.
      ASSIGN COMPONENT 'MSGV3' OF STRUCTURE <l> TO <v3>.
      ASSIGN COMPONENT 'MSGV4' OF STRUCTURE <l> TO <v4>.
      IF <id> IS ASSIGNED AND <no> IS ASSIGNED AND <v4> IS ASSIGNED.
        MESSAGE ID <id> TYPE 'S' NUMBER <no> WITH <v1> <v2> <v3> <v4> INTO lv_text.
      ENDIF.
      APPEND |{ <ty> }: { lv_text }| TO ct_messages.
      IF <ty> = 'E' OR <ty> = 'A' OR <ty> = 'X'.
        rv_err = abap_true.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD create_by_name.
    LOOP AT it_names INTO DATA(lv_name).
      TRY.
          IF iv_table = abap_true.
            CREATE DATA rr_data TYPE STANDARD TABLE OF (lv_name).
          ELSE.
            CREATE DATA rr_data TYPE (lv_name).
          ENDIF.
          RETURN.
        CATCH cx_sy_create_data_error.
          CLEAR rr_data.
      ENDTRY.
    ENDLOOP.
  ENDMETHOD.


  METHOD fill_from_json.
    FIELD-SYMBOLS <d> TYPE any.
    IF iv_json IS INITIAL OR ir_data IS NOT BOUND.
      RETURN.
    ENDIF.
    ASSIGN ir_data->* TO <d>.
    /ui2/cl_json=>deserialize( EXPORTING json = iv_json pretty_name = /ui2/cl_json=>pretty_mode-none
                               CHANGING data = <d> ).
  ENDMETHOD.


  METHOD to_json.
    FIELD-SYMBOLS <d> TYPE any.
    IF ir_data IS NOT BOUND.
      rv_json = `null`.
      RETURN.
    ENDIF.
    ASSIGN ir_data->* TO <d>.
    /ui2/cl_json=>serialize( EXPORTING data = <d> pretty_name = /ui2/cl_json=>pretty_mode-none RECEIVING r_json = rv_json ).
    IF rv_json IS INITIAL.
      rv_json = `null`.
    ENDIF.
  ENDMETHOD.


  METHOD fm_exists.
    DATA lv_fm TYPE c LENGTH 30.
    lv_fm = iv_fm.
    SELECT SINGLE @abap_true FROM tfdir WHERE funcname = @lv_fm INTO @rv_ok.
  ENDMETHOD.


  METHOD class_exists.
    DATA lv_cls TYPE c LENGTH 30.
    lv_cls = iv_class.
    SELECT SINGLE @abap_true FROM seoclass WHERE clsname = @lv_cls INTO @rv_ok.
  ENDMETHOD.


  METHOD table_exists.
    DATA lv_tab TYPE c LENGTH 30.
    lv_tab = iv_table.
    SELECT SINGLE @abap_true FROM dd02l WHERE tabname = @lv_tab AND as4local = 'A' INTO @rv_ok.
  ENDMETHOD.


  METHOD field_exists.
    DATA: lv_tab TYPE c LENGTH 30,
          lv_fld TYPE c LENGTH 30.
    lv_tab = iv_table.
    lv_fld = iv_field.
    SELECT SINGLE @abap_true FROM dd03l WHERE tabname = @lv_tab AND fieldname = @lv_fld AND as4local = 'A' INTO @rv_ok.
  ENDMETHOD.


  METHOD is_valid_name.
    DATA(lv) = to_upper( iv_name ).
    IF lv IS INITIAL OR strlen( lv ) > 40.
      RETURN.
    ENDIF.
    FIND FIRST OCCURRENCE OF REGEX '[^A-Z0-9_/]' IN lv.
    rv_ok = xsdbool( sy-subrc <> 0 ).
  ENDMETHOD.


  METHOD esc.
    rv_val = iv_val.
    REPLACE ALL OCCURRENCES OF '''' IN rv_val WITH ''''''.
  ENDMETHOD.


  METHOD may_display.
    DATA: lv_group TYPE c LENGTH 4,
          lv_tab   TYPE c LENGTH 30.
    lv_tab = to_upper( iv_table ).
    SELECT SINGLE cclass FROM tddat WHERE tabname = @lv_tab INTO @lv_group.
    IF lv_group IS INITIAL.
      lv_group = '&NC&'.
    ENDIF.
    AUTHORITY-CHECK OBJECT 'S_TABU_DIS' ID 'DICBERCLS' FIELD lv_group ID 'ACTVT' FIELD '03'.
    IF sy-subrc = 0.
      rv_ok = abap_true.
      RETURN.
    ENDIF.
    AUTHORITY-CHECK OBJECT 'S_TABU_NAM' ID 'ACTVT' FIELD '03' ID 'TABLE' FIELD lv_tab.
    rv_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.

ENDCLASS.
