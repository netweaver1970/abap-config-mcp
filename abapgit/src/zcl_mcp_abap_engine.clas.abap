CLASS zcl_mcp_abap_engine DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  " Read-only ABAP part of the MCP engine. Reached through ZCL_MCP_CUST_ENGINE, which
  " hands every abap_* operation to HANDLE, so governed mode (no ADT calls) can still
  " search, read and cross-reference ABAP code as the signed-in user.
  "
  " Nothing here writes: it reads the repository (TADIR, READ REPORT, the cross-reference
  " tables, VRSD, DWINACTIV, the text pools, SNAP) and runs SYNTAX-CHECK, which saves
  " nothing. Every object is checked against S_DEVELOP display (ACTVT 03) for its type,
  " name and package before anything about it is returned.
  PUBLIC SECTION.
    CLASS-METHODS handle
      IMPORTING iv_json        TYPE string
                iv_version     TYPE string
      RETURNING VALUE(rv_json) TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_req,
             operation   TYPE string,
             object_type TYPE string,    " PROG, INCL, CLAS, INTF, FUGR, FUNC, TABL, VIEW, DTEL, DOMA, TTYP, TRAN, DEVC
             name        TYPE string,
             include     TYPE string,    " source: main | definitions | implementations | macros | testclasses
             pattern     TYPE string,    " search / tables: * as wildcard
             keyword     TYPE string,    " tables: words of the description
             package     TYPE string,
             subpackages TYPE abap_bool,
             max_rows    TYPE i,
             language    TYPE string,
             source      TYPE string,    " syntax: the program source to check instead of the stored one
             all_users   TYPE abap_bool, " dumps / inactive: not only the caller's own
             days        TYPE i,         " dumps: how many days back (default 7)
           END OF ty_req.

    TYPES: BEGIN OF ty_resp,
             status    TYPE string,
             operation TYPE string,
             version   TYPE string,
             messages  TYPE stringtab,
             data_json TYPE string,
           END OF ty_resp.

    TYPES: BEGIN OF ty_obj,
             type        TYPE string,
             name        TYPE string,
             package     TYPE string,
             author      TYPE string,
             description TYPE string,
           END OF ty_obj,
           ty_obj_tt TYPE STANDARD TABLE OF ty_obj WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_use,
             include   TYPE string,
             main_type TYPE string,
             main_name TYPE string,
             method    TYPE string,
             kind      TYPE string,
           END OF ty_use,
           ty_use_tt TYPE STANDARD TABLE OF ty_use WITH DEFAULT KEY.

    CONSTANTS: c_default_rows TYPE i VALUE 200,
               c_max_rows     TYPE i VALUE 2000.

    CLASS-METHODS abap_search      IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_info        IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_source      IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_where_used  IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_versions    IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_package     IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_text_elements IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_inactive    IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_tables      IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_syntax      IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.
    CLASS-METHODS abap_dumps       IMPORTING is_req TYPE ty_req RETURNING VALUE(rs_resp) TYPE ty_resp.

    "! S_DEVELOP display for one object.
    CLASS-METHODS may_display
      IMPORTING iv_type      TYPE string
                iv_name      TYPE string
                iv_package   TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    "! TADIR type, name and package of an object; FUNC and INCL resolve to their TADIR owner.
    CLASS-METHODS locate
      IMPORTING iv_type    TYPE string
                iv_name    TYPE string
      EXPORTING ev_package TYPE string
                ev_author  TYPE string
                ev_found   TYPE abap_bool
                ev_owner_type TYPE string
                ev_owner_name TYPE string.
    "! Checks existence and authorization; on failure fills rs_resp and returns false.
    CLASS-METHODS admit
      IMPORTING iv_type      TYPE string
                iv_name      TYPE string
      CHANGING  cs_resp      TYPE ty_resp
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS describe
      IMPORTING iv_type        TYPE string
                iv_name        TYPE string
                iv_langu       TYPE sy-langu
      RETURNING VALUE(rv_text) TYPE string.
    "! The main program of a function group, keeping a namespace: /NS/NAME → /NS/SAPLNAME.
    CLASS-METHODS fugr_main
      IMPORTING iv_fugr        TYPE string
      RETURNING VALUE(rv_prog) TYPE string.
    "! Source lines of one object and part (see ty_req-include).
    CLASS-METHODS source_lines
      IMPORTING iv_type     TYPE string
                iv_name     TYPE string
                iv_part     TYPE string
      EXPORTING et_lines    TYPE stringtab
                ev_program  TYPE string
                ev_error    TYPE string.
    "! The program SYNTAX-CHECK runs on for an object (class pool, SAPL…, an include's master).
    CLASS-METHODS main_program
      IMPORTING iv_type        TYPE string
                iv_name        TYPE string
      RETURNING VALUE(rv_prog) TYPE string.
    "! Which object an include belongs to (class + method, function group, program).
    CLASS-METHODS owner_of_include
      IMPORTING iv_include TYPE string
      RETURNING VALUE(rs_use) TYPE ty_use.
    CLASS-METHODS valid_name
      IMPORTING iv_name      TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS like_pattern
      IMPORTING iv_pattern     TYPE string
      RETURNING VALUE(rv_like) TYPE string.
    CLASS-METHODS rows
      IMPORTING iv_rows        TYPE i
      RETURNING VALUE(rv_rows) TYPE i.
    CLASS-METHODS langu
      IMPORTING iv_language     TYPE string
      RETURNING VALUE(rv_langu) TYPE sy-langu.
    CLASS-METHODS fm_exists
      IMPORTING iv_fm        TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    CLASS-METHODS to_json
      IMPORTING ia_data        TYPE any
      RETURNING VALUE(rv_json) TYPE string.
ENDCLASS.



CLASS zcl_mcp_abap_engine IMPLEMENTATION.

  METHOD handle.
    DATA: ls_req  TYPE ty_req,
          ls_resp TYPE ty_resp.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_json pretty_name = /ui2/cl_json=>pretty_mode-none
                                   CHANGING data = ls_req ).
        ls_req-object_type = to_upper( condense( ls_req-object_type ) ).
        ls_req-name        = to_upper( condense( ls_req-name ) ).
        ls_req-package     = to_upper( condense( ls_req-package ) ).
        ls_req-include     = to_lower( condense( ls_req-include ) ).
        ls_resp-status = 'ok'.
        CASE to_lower( ls_req-operation ).
          WHEN 'abap_search'.        ls_resp = abap_search( ls_req ).
          WHEN 'abap_info'.          ls_resp = abap_info( ls_req ).
          WHEN 'abap_source'.        ls_resp = abap_source( ls_req ).
          WHEN 'abap_where_used'.    ls_resp = abap_where_used( ls_req ).
          WHEN 'abap_versions'.      ls_resp = abap_versions( ls_req ).
          WHEN 'abap_package'.       ls_resp = abap_package( ls_req ).
          WHEN 'abap_text_elements'. ls_resp = abap_text_elements( ls_req ).
          WHEN 'abap_inactive'.      ls_resp = abap_inactive( ls_req ).
          WHEN 'abap_tables'.        ls_resp = abap_tables( ls_req ).
          WHEN 'abap_syntax'.        ls_resp = abap_syntax( ls_req ).
          WHEN 'abap_dumps'.         ls_resp = abap_dumps( ls_req ).
          WHEN OTHERS.
            ls_resp-status = 'error'.
            APPEND |Unknown operation: '{ ls_req-operation }'| TO ls_resp-messages.
        ENDCASE.
      CATCH cx_root INTO DATA(lx).
        ls_resp-status = 'error'.
        APPEND |{ ls_req-operation } stopped: { lx->get_text( ) }| TO ls_resp-messages.
    ENDTRY.
    IF ls_resp-status IS INITIAL.
      ls_resp-status = 'ok'.
    ENDIF.
    ls_resp-operation = ls_req-operation.
    ls_resp-version   = iv_version.
    /ui2/cl_json=>serialize( EXPORTING data = ls_resp pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rv_json ).
  ENDMETHOD.


  METHOD abap_search.
    TYPES: BEGIN OF ty_tadir,
             object   TYPE tadir-object,
             obj_name TYPE tadir-obj_name,
             devclass TYPE tadir-devclass,
             author   TYPE tadir-author,
           END OF ty_tadir.
    DATA: lt_tadir TYPE STANDARD TABLE OF ty_tadir WITH DEFAULT KEY,
          lt_out   TYPE ty_obj_tt,
          lv_type  TYPE tadir-object.

    rs_resp-status = 'ok'.
    DATA(lv_like) = like_pattern( is_req-pattern ).
    IF lv_like IS INITIAL.
      rs_resp-status = 'error'.
      APPEND `Give a name or pattern (letters, digits, _ / $ and * as the wildcard).` TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA(lv_max) = rows( is_req-max_rows ).
    DATA(lv_fetch) = lv_max * 3.
    lv_type = is_req-object_type.
    IF lv_type IS INITIAL.
      SELECT object, obj_name, devclass, author FROM tadir
        WHERE pgmid = 'R3TR' AND obj_name LIKE @lv_like AND delflag = @space
        ORDER BY obj_name, object
        INTO TABLE @lt_tadir UP TO @lv_fetch ROWS.
    ELSE.
      SELECT object, obj_name, devclass, author FROM tadir
        WHERE pgmid = 'R3TR' AND object = @lv_type AND obj_name LIKE @lv_like AND delflag = @space
        ORDER BY obj_name
        INTO TABLE @lt_tadir UP TO @lv_fetch ROWS.
    ENDIF.

    DATA(lv_hidden) = 0.
    DATA(lv_langu) = langu( is_req-language ).
    LOOP AT lt_tadir INTO DATA(ls_t).
      IF lines( lt_out ) >= lv_max.
        EXIT.
      ENDIF.
      IF may_display( iv_type = CONV #( ls_t-object ) iv_name = CONV #( ls_t-obj_name ) iv_package = CONV #( ls_t-devclass ) ) = abap_false.
        lv_hidden = lv_hidden + 1.
        CONTINUE.
      ENDIF.
      APPEND VALUE #( type = ls_t-object name = ls_t-obj_name package = ls_t-devclass author = ls_t-author
                      description = describe( iv_type = CONV #( ls_t-object ) iv_name = CONV #( ls_t-obj_name ) iv_langu = lv_langu ) )
        TO lt_out.
    ENDLOOP.
    IF lv_hidden > 0.
      APPEND |{ lv_hidden } object(s) left out: no S_DEVELOP display authorization.| TO rs_resp-messages.
    ENDIF.
    IF lines( lt_tadir ) >= lv_fetch.
      APPEND |Stopped at { lv_max } hit(s): there may be more; narrow the pattern.| TO rs_resp-messages.
    ENDIF.
    rs_resp-data_json = to_json( lt_out ).
  ENDMETHOD.


  METHOD abap_info.
    TYPES: BEGIN OF ty_info,
             type        TYPE string,
             name        TYPE string,
             package     TYPE string,
             author      TYPE string,
             created_on  TYPE string,
             changed_by  TYPE string,
             changed_on  TYPE string,
             language    TYPE string,
             description TYPE string,
             subtype     TYPE string,
             owner_type  TYPE string,
             owner_name  TYPE string,
             inactive    TYPE abap_bool,
             parts       TYPE stringtab,
           END OF ty_info.
    DATA: ls_info TYPE ty_info,
          lv_pkg  TYPE string,
          lv_auth TYPE string,
          lv_found TYPE abap_bool.

    rs_resp-status = 'ok'.
    IF admit( EXPORTING iv_type = is_req-object_type iv_name = is_req-name CHANGING cs_resp = rs_resp ) = abap_false.
      RETURN.
    ENDIF.
    locate( EXPORTING iv_type = is_req-object_type iv_name = is_req-name
            IMPORTING ev_package = lv_pkg ev_author = lv_auth ev_found = lv_found
                      ev_owner_type = ls_info-owner_type ev_owner_name = ls_info-owner_name ).
    ls_info-type    = is_req-object_type.
    ls_info-name    = is_req-name.
    ls_info-package = lv_pkg.
    ls_info-author  = lv_auth.
    ls_info-description = describe( iv_type = is_req-object_type iv_name = is_req-name iv_langu = langu( is_req-language ) ).
    IF ls_info-owner_type = is_req-object_type AND ls_info-owner_name = is_req-name.
      CLEAR: ls_info-owner_type, ls_info-owner_name.
    ENDIF.

    DATA lv_obj_name TYPE dwinactiv-obj_name.
    lv_obj_name = is_req-name.
    SELECT SINGLE @abap_true FROM dwinactiv WHERE obj_name = @lv_obj_name INTO @ls_info-inactive.

    CASE is_req-object_type.
      WHEN 'PROG' OR 'INCL'.
        DATA lv_prog TYPE trdir-name.
        lv_prog = is_req-name.
        SELECT SINGLE subc, cnam, cdat, unam, udat, rload FROM trdir WHERE name = @lv_prog
          INTO @DATA(ls_dir).
        IF sy-subrc = 0.
          ls_info-subtype    = SWITCH #( ls_dir-subc WHEN '1' THEN `executable program` WHEN 'I' THEN `include`
                                                     WHEN 'M' THEN `module pool` WHEN 'S' THEN `subroutine pool`
                                                     WHEN 'F' THEN `function group` WHEN 'K' THEN `class pool`
                                                     WHEN 'J' THEN `interface pool` ELSE |type { ls_dir-subc }| ).
          ls_info-author     = ls_dir-cnam.
          ls_info-created_on = ls_dir-cdat.
          ls_info-changed_by = ls_dir-unam.
          ls_info-changed_on = ls_dir-udat.
          ls_info-language   = ls_dir-rload.
        ENDIF.
      WHEN 'CLAS' OR 'INTF'.
        DATA lv_cls TYPE seoclsname.
        lv_cls = is_req-name.
        SELECT SINGLE author, createdon, changedby, changedon FROM seoclassdf
          WHERE clsname = @lv_cls AND version = '1' INTO @DATA(ls_cdf).
        IF sy-subrc = 0.
          ls_info-author     = ls_cdf-author.
          ls_info-created_on = ls_cdf-createdon.
          ls_info-changed_by = ls_cdf-changedby.
          ls_info-changed_on = ls_cdf-changedon.
        ENDIF.
        " methods, with the include each lives in
        DATA lt_meth TYPE seop_methods_w_include.
        CALL METHOD cl_oo_classname_service=>get_all_method_includes
          EXPORTING  clsname = lv_cls
          RECEIVING  result  = lt_meth
          EXCEPTIONS OTHERS  = 1.
        IF sy-subrc = 0.
          LOOP AT lt_meth INTO DATA(ls_m).
            APPEND |method { ls_m-cpdkey-cpdname } ({ ls_m-incname })| TO ls_info-parts.
          ENDLOOP.
        ENDIF.
      WHEN 'FUGR'.
        DATA lv_area TYPE enlfdir-area.
        lv_area = is_req-name.
        SELECT funcname FROM enlfdir WHERE area = @lv_area ORDER BY funcname INTO TABLE @DATA(lt_fm).
        LOOP AT lt_fm INTO DATA(ls_fm).
          APPEND |function module { ls_fm-funcname }| TO ls_info-parts.
        ENDLOOP.
        ls_info-subtype = |main program { fugr_main( is_req-name ) }|.
      WHEN 'FUNC'.
        DATA lv_func TYPE tfdir-funcname.
        lv_func = is_req-name.
        SELECT SINGLE pname, include, fmode FROM tfdir WHERE funcname = @lv_func INTO @DATA(ls_tf).
        IF sy-subrc = 0.
          ls_info-subtype = COND #( WHEN ls_tf-fmode = 'R' THEN `remote-enabled function module` ELSE `function module` ).
          APPEND |main program { ls_tf-pname }, include number { ls_tf-include }| TO ls_info-parts.
        ENDIF.
      WHEN OTHERS.
    ENDCASE.
    rs_resp-data_json = to_json( ls_info ).
  ENDMETHOD.


  METHOD abap_source.
    TYPES: BEGIN OF ty_src,
             type    TYPE string,
             name    TYPE string,
             part    TYPE string,
             program TYPE string,
             lines   TYPE stringtab,
           END OF ty_src.
    DATA: ls_src  TYPE ty_src,
          lv_err  TYPE string.
    rs_resp-status = 'ok'.
    IF admit( EXPORTING iv_type = is_req-object_type iv_name = is_req-name CHANGING cs_resp = rs_resp ) = abap_false.
      RETURN.
    ENDIF.
    ls_src-type = is_req-object_type.
    ls_src-name = is_req-name.
    ls_src-part = COND #( WHEN is_req-include IS INITIAL THEN `main` ELSE is_req-include ).
    source_lines( EXPORTING iv_type = is_req-object_type iv_name = is_req-name iv_part = ls_src-part
                  IMPORTING et_lines = ls_src-lines ev_program = ls_src-program ev_error = lv_err ).
    IF lv_err IS NOT INITIAL.
      rs_resp-status = 'error'.
      APPEND lv_err TO rs_resp-messages.
      RETURN.
    ENDIF.
    rs_resp-data_json = to_json( ls_src ).
  ENDMETHOD.


  METHOD abap_where_used.
    DATA: lt_inc  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lt_use  TYPE ty_use_tt,
          lv_name TYPE string,
          lv_kind TYPE string.
    rs_resp-status = 'ok'.
    IF admit( EXPORTING iv_type = is_req-object_type iv_name = is_req-name CHANGING cs_resp = rs_resp ) = abap_false.
      RETURN.
    ENDIF.
    DATA(lv_max) = rows( is_req-max_rows ).
    lv_name = is_req-name.

    CASE is_req-object_type.
      WHEN 'FUNC'.
        lv_kind = `CALL FUNCTION`.
        SELECT DISTINCT include FROM cross WHERE type = 'F' AND name = @lv_name
          INTO TABLE @lt_inc UP TO @lv_max ROWS.
      WHEN 'PROG'.
        lv_kind = `SUBMIT / INCLUDE`.
        SELECT DISTINCT include FROM cross WHERE type = 'R' AND name = @lv_name
          INTO TABLE @lt_inc UP TO @lv_max ROWS.
        SELECT DISTINCT include FROM wbcrossi WHERE name = @lv_name
          APPENDING TABLE @lt_inc UP TO @lv_max ROWS.
      WHEN 'INCL'.
        lv_kind = `INCLUDE`.
        SELECT DISTINCT include FROM wbcrossi WHERE name = @lv_name
          INTO TABLE @lt_inc UP TO @lv_max ROWS.
      WHEN 'TRAN'.
        lv_kind = `CALL TRANSACTION`.
        SELECT DISTINCT include FROM cross WHERE type = 'T' AND name = @lv_name
          INTO TABLE @lt_inc UP TO @lv_max ROWS.
      WHEN 'MSAG'.
        lv_kind = `MESSAGE`.
        DATA(lv_msg_like) = |{ lv_name }%|.
        SELECT DISTINCT include FROM cross WHERE type = 'N' AND name LIKE @lv_msg_like
          INTO TABLE @lt_inc UP TO @lv_max ROWS.
      WHEN OTHERS.
        " classes, interfaces, tables, views, data elements, table types, structures: the type index
        lv_kind = `type reference`.
        SELECT DISTINCT include FROM wbcrossgt WHERE otype = 'TY' AND name = @lv_name
          INTO TABLE @lt_inc UP TO @lv_max ROWS.
    ENDCASE.
    SORT lt_inc.
    DELETE ADJACENT DUPLICATES FROM lt_inc.

    DATA(lv_hidden) = 0.
    LOOP AT lt_inc INTO DATA(lv_inc).
      DATA(ls_use) = owner_of_include( lv_inc ).
      ls_use-kind = lv_kind.
      " the object's own includes are not a usage
      IF ls_use-main_name = is_req-name AND ( ls_use-main_type = is_req-object_type OR is_req-object_type = 'INCL' ).
        CONTINUE.
      ENDIF.
      DATA lv_pkg TYPE string.
      DATA lv_found TYPE abap_bool.
      CLEAR lv_pkg.
      locate( EXPORTING iv_type = ls_use-main_type iv_name = ls_use-main_name IMPORTING ev_package = lv_pkg ev_found = lv_found ).
      IF may_display( iv_type = ls_use-main_type iv_name = ls_use-main_name iv_package = lv_pkg ) = abap_false.
        lv_hidden = lv_hidden + 1.
        CONTINUE.
      ENDIF.
      APPEND ls_use TO lt_use.
    ENDLOOP.
    IF lv_hidden > 0.
      APPEND |{ lv_hidden } usage(s) left out: no S_DEVELOP display authorization for the using object.| TO rs_resp-messages.
    ENDIF.
    IF lines( lt_inc ) >= lv_max.
      APPEND |Stopped at { lv_max } using include(s): there may be more.| TO rs_resp-messages.
    ENDIF.
    APPEND `From the cross-reference index (WBCROSSGT, CROSS, WBCROSSI); objects not indexed yet do not appear.` TO rs_resp-messages.
    rs_resp-data_json = to_json( lt_use ).
  ENDMETHOD.


  METHOD abap_versions.
    TYPES: BEGIN OF ty_ver,
             objtype   TYPE string,
             objname   TYPE string,
             versno    TYPE string,
             date      TYPE string,
             time      TYPE string,
             author    TYPE string,
             transport TYPE string,
           END OF ty_ver.
    DATA: lt_ver   TYPE STANDARD TABLE OF ty_ver WITH DEFAULT KEY,
          lt_types TYPE RANGE OF vrsd-objtype,
          lv_name  TYPE vrsd-objname,
          lv_like  TYPE vrsd-objname.
    rs_resp-status = 'ok'.
    IF admit( EXPORTING iv_type = is_req-object_type iv_name = is_req-name CHANGING cs_resp = rs_resp ) = abap_false.
      RETURN.
    ENDIF.
    DATA(lt_names) = VALUE stringtab( ( `REPS` ) ).
    CASE is_req-object_type.
      WHEN 'PROG' OR 'INCL'. lt_names = VALUE #( ( `REPS` ) ( `REPT` ) ).
      WHEN 'CLAS'.           lt_names = VALUE #( ( `CLSD` ) ( `CPUB` ) ( `CPRO` ) ( `CPRI` ) ( `METH` ) ( `CINC` ) ).
      WHEN 'INTF'.           lt_names = VALUE #( ( `INTF` ) ).
      WHEN 'FUNC'.           lt_names = VALUE #( ( `FUNC` ) ).
      WHEN 'TABL'.           lt_names = VALUE #( ( `TABD` ) ( `TABT` ) ).
      WHEN 'VIEW'.           lt_names = VALUE #( ( `VIED` ) ( `VIET` ) ).
      WHEN 'DTEL'.           lt_names = VALUE #( ( `DTED` ) ).
      WHEN 'DOMA'.           lt_names = VALUE #( ( `DOMD` ) ).
      WHEN OTHERS.           lt_names = VALUE #( ( CONV string( is_req-object_type ) ) ).
    ENDCASE.
    lt_types = VALUE #( FOR t IN lt_names ( sign = 'I' option = 'EQ' low = t ) ).
    lv_name = is_req-name.
    lv_like = |{ is_req-name }%|.
    IF is_req-object_type = 'CLAS'.
      " methods are stored as class name padded to 30 plus method name
      SELECT objtype, objname, versno, datum, zeit, author, korrnum FROM vrsd
        WHERE objtype IN @lt_types AND ( objname = @lv_name OR objname LIKE @lv_like )
        INTO TABLE @DATA(lt_raw) UP TO 500 ROWS.
    ELSE.
      SELECT objtype, objname, versno, datum, zeit, author, korrnum FROM vrsd
        WHERE objtype IN @lt_types AND objname = @lv_name
        INTO TABLE @lt_raw UP TO 500 ROWS.
    ENDIF.
    LOOP AT lt_raw INTO DATA(ls_r).
      APPEND VALUE #( objtype = ls_r-objtype objname = condense( ls_r-objname ) versno = ls_r-versno
                      date = ls_r-datum time = ls_r-zeit author = ls_r-author transport = ls_r-korrnum ) TO lt_ver.
    ENDLOOP.
    SORT lt_ver BY date DESCENDING time DESCENDING objname.
    " the active version, from the program directory or the class header, when VRSD has no entry for it
    IF NOT line_exists( lt_ver[ versno = `00000` ] ).
      DATA ls_act TYPE ty_ver.
      ls_act-versno = `active`.
      ls_act-objname = is_req-name.
      CASE is_req-object_type.
        WHEN 'PROG' OR 'INCL' OR 'FUNC'.
          DATA lv_prog TYPE trdir-name.
          lv_prog = is_req-name.
          IF is_req-object_type = 'FUNC'.
            DATA lt_dummy TYPE stringtab.
            DATA lv_srcprog TYPE string.
            DATA lv_err TYPE string.
            source_lines( EXPORTING iv_type = 'FUNC' iv_name = is_req-name iv_part = `main`
                          IMPORTING et_lines = lt_dummy ev_program = lv_srcprog ev_error = lv_err ).
            lv_prog = lv_srcprog.
          ENDIF.
          SELECT SINGLE unam, udat, cnam, cdat FROM trdir WHERE name = @lv_prog INTO @DATA(ls_dir).
          IF sy-subrc = 0.
            ls_act-objtype = `REPS`.
            ls_act-author  = COND #( WHEN ls_dir-unam IS NOT INITIAL THEN ls_dir-unam ELSE ls_dir-cnam ).
            ls_act-date    = COND #( WHEN ls_dir-udat IS NOT INITIAL THEN ls_dir-udat ELSE ls_dir-cdat ).
          ENDIF.
        WHEN 'CLAS' OR 'INTF'.
          DATA lv_cls TYPE seoclsname.
          lv_cls = is_req-name.
          SELECT SINGLE author, createdon, changedby, changedon FROM seoclassdf
            WHERE clsname = @lv_cls AND version = '1' INTO @DATA(ls_cdf).
          IF sy-subrc = 0.
            ls_act-objtype = `CLSD`.
            ls_act-author  = COND #( WHEN ls_cdf-changedby IS NOT INITIAL THEN ls_cdf-changedby ELSE ls_cdf-author ).
            ls_act-date    = COND #( WHEN ls_cdf-changedon IS NOT INITIAL THEN ls_cdf-changedon ELSE ls_cdf-createdon ).
          ENDIF.
      ENDCASE.
      IF ls_act-objtype IS NOT INITIAL.
        INSERT ls_act INTO lt_ver INDEX 1.
      ENDIF.
    ENDIF.
    APPEND `Version 00000 (or 'active') is the version that is active now; the others are stored versions (VRSD).` TO rs_resp-messages.
    rs_resp-data_json = to_json( lt_ver ).
  ENDMETHOD.


  METHOD abap_package.
    TYPES: BEGIN OF ty_pkg,
             package     TYPE string,
             description TYPE string,
             parent      TYPE string,
             objects     TYPE ty_obj_tt,
             more        TYPE i,
           END OF ty_pkg,
           ty_pkg_tt TYPE STANDARD TABLE OF ty_pkg WITH DEFAULT KEY.
    DATA: lt_pkgs  TYPE ty_pkg_tt,
          lt_names TYPE STANDARD TABLE OF devclass WITH DEFAULT KEY,
          lv_pkg   TYPE devclass.

    rs_resp-status = 'ok'.
    IF valid_name( is_req-package ) = abap_false.
      rs_resp-status = 'error'.
      APPEND |Invalid package name: '{ is_req-package }'.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    lv_pkg = is_req-package.
    SELECT SINGLE parentcl FROM tdevc WHERE devclass = @lv_pkg INTO @DATA(lv_parent).
    IF sy-subrc <> 0 AND lv_pkg <> '$TMP'.
      rs_resp-status = 'error'.
      APPEND |Package { lv_pkg } does not exist.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    APPEND lv_pkg TO lt_names.
    IF is_req-subpackages = abap_true.
      SELECT devclass FROM tdevc WHERE parentcl = @lv_pkg ORDER BY devclass
        APPENDING TABLE @lt_names UP TO 25 ROWS.
    ENDIF.
    DATA(lv_max) = rows( is_req-max_rows ).
    DATA(lv_langu) = langu( is_req-language ).
    DATA(lv_hidden) = 0.
    LOOP AT lt_names INTO DATA(lv_name).
      DATA(ls_pkg) = VALUE ty_pkg( package = lv_name ).
      SELECT SINGLE ctext FROM tdevct WHERE devclass = @lv_name AND spras = @lv_langu INTO @ls_pkg-description.
      SELECT SINGLE parentcl FROM tdevc WHERE devclass = @lv_name INTO @ls_pkg-parent.
      SELECT object, obj_name, author FROM tadir
        WHERE pgmid = 'R3TR' AND devclass = @lv_name AND delflag = @space
        ORDER BY object, obj_name INTO TABLE @DATA(lt_t).
      LOOP AT lt_t INTO DATA(ls_t).
        IF lines( ls_pkg-objects ) >= lv_max.
          ls_pkg-more = ls_pkg-more + 1.
          CONTINUE.
        ENDIF.
        IF may_display( iv_type = CONV #( ls_t-object ) iv_name = CONV #( ls_t-obj_name ) iv_package = CONV #( lv_name ) ) = abap_false.
          lv_hidden = lv_hidden + 1.
          CONTINUE.
        ENDIF.
        APPEND VALUE #( type = ls_t-object name = ls_t-obj_name package = lv_name author = ls_t-author
                        description = describe( iv_type = CONV #( ls_t-object ) iv_name = CONV #( ls_t-obj_name ) iv_langu = lv_langu ) )
          TO ls_pkg-objects.
      ENDLOOP.
      APPEND ls_pkg TO lt_pkgs.
    ENDLOOP.
    IF lv_hidden > 0.
      APPEND |{ lv_hidden } object(s) left out: no S_DEVELOP display authorization.| TO rs_resp-messages.
    ENDIF.
    rs_resp-data_json = to_json( lt_pkgs ).
  ENDMETHOD.


  METHOD abap_text_elements.
    TYPES: BEGIN OF ty_text,
             id     TYPE string,
             key    TYPE string,
             entry  TYPE string,
             length TYPE i,
           END OF ty_text.
    DATA: lt_pool TYPE STANDARD TABLE OF textpool WITH DEFAULT KEY,
          lt_out  TYPE STANDARD TABLE OF ty_text WITH DEFAULT KEY,
          lv_prog TYPE progname.
    rs_resp-status = 'ok'.
    IF admit( EXPORTING iv_type = is_req-object_type iv_name = is_req-name CHANGING cs_resp = rs_resp ) = abap_false.
      RETURN.
    ENDIF.
    lv_prog = main_program( iv_type = is_req-object_type iv_name = is_req-name ).
    IF lv_prog IS INITIAL.
      rs_resp-status = 'error'.
      APPEND |Text elements belong to programs, function groups and classes, not to type { is_req-object_type }.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    DATA(lv_langu) = langu( is_req-language ).
    READ TEXTPOOL lv_prog INTO lt_pool LANGUAGE lv_langu.
    LOOP AT lt_pool INTO DATA(ls_p).
      APPEND VALUE #( id = ls_p-id key = ls_p-key entry = ls_p-entry length = ls_p-length ) TO lt_out.
    ENDLOOP.
    APPEND |Text pool of { lv_prog }, language { lv_langu }.| TO rs_resp-messages.
    rs_resp-data_json = to_json( lt_out ).
  ENDMETHOD.


  METHOD abap_inactive.
    TYPES: BEGIN OF ty_inact,
             user    TYPE string,
             type    TYPE string,
             name    TYPE string,
             deleted TYPE abap_bool,
           END OF ty_inact.
    DATA lt_out TYPE STANDARD TABLE OF ty_inact WITH DEFAULT KEY.
    rs_resp-status = 'ok'.
    IF is_req-all_users = abap_true.
      SELECT uname, object, obj_name, delet_flag FROM dwinactiv ORDER BY uname, object, obj_name
        INTO TABLE @DATA(lt_raw) UP TO 1000 ROWS.
    ELSE.
      SELECT uname, object, obj_name, delet_flag FROM dwinactiv WHERE uname = @sy-uname ORDER BY object, obj_name
        INTO TABLE @lt_raw UP TO 1000 ROWS.
    ENDIF.
    LOOP AT lt_raw INTO DATA(ls_r).
      APPEND VALUE #( user = ls_r-uname type = ls_r-object name = ls_r-obj_name deleted = xsdbool( ls_r-delet_flag = 'X' ) ) TO lt_out.
    ENDLOOP.
    rs_resp-data_json = to_json( lt_out ).
  ENDMETHOD.


  METHOD abap_tables.
    TYPES: BEGIN OF ty_tab,
             name        TYPE string,
             kind        TYPE string,
             package     TYPE string,
             description TYPE string,
           END OF ty_tab.
    DATA: lt_out   TYPE STANDARD TABLE OF ty_tab WITH DEFAULT KEY,
          lt_names TYPE STANDARD TABLE OF tabname WITH DEFAULT KEY,
          lt_like  TYPE RANGE OF dd02t-ddtext.
    rs_resp-status = 'ok'.
    DATA(lv_max) = rows( is_req-max_rows ).
    DATA(lv_langu) = langu( is_req-language ).
    DATA(lv_pat) = like_pattern( is_req-pattern ).
    IF lv_pat IS NOT INITIAL.
      SELECT tabname FROM dd02l
        WHERE tabname LIKE @lv_pat AND as4local = 'A'
          AND tabclass IN ('TRANSP','VIEW','CLUSTER','POOL')
        ORDER BY tabname INTO TABLE @lt_names UP TO @lv_max ROWS.
    ENDIF.
    DATA(lv_kw) = condense( is_req-keyword ).
    IF lv_kw IS NOT INITIAL.
      " DD02T keeps the text as typed: try it as given, upper, lower and capitalised
      DATA(lv_low) = to_lower( lv_kw ).
      DATA(lv_cap) = to_upper( substring( val = lv_low len = 1 ) ) && substring( val = lv_low off = 1 ).
      lt_like = VALUE #( sign = 'I' option = 'CP'
                         ( low = |*{ lv_kw }*| ) ( low = |*{ to_upper( lv_kw ) }*| )
                         ( low = |*{ lv_low }*| ) ( low = |*{ lv_cap }*| ) ).
      SELECT t~tabname FROM dd02t AS t INNER JOIN dd02l AS l ON l~tabname = t~tabname AND l~as4local = t~as4local
        WHERE t~ddlanguage = @lv_langu AND t~as4local = 'A' AND t~ddtext IN @lt_like
          AND l~tabclass IN ('TRANSP','VIEW','CLUSTER','POOL')
        ORDER BY t~tabname APPENDING TABLE @lt_names UP TO @lv_max ROWS.
    ENDIF.
    IF lv_pat IS INITIAL AND lv_kw IS INITIAL.
      rs_resp-status = 'error'.
      APPEND `Give a name pattern or a keyword from the description.` TO rs_resp-messages.
      RETURN.
    ENDIF.
    SORT lt_names.
    DELETE ADJACENT DUPLICATES FROM lt_names.
    LOOP AT lt_names INTO DATA(lv_name).
      IF lines( lt_out ) >= lv_max.
        EXIT.
      ENDIF.
      SELECT SINGLE tabclass FROM dd02l WHERE tabname = @lv_name AND as4local = 'A' INTO @DATA(lv_class).
      DATA(lv_type) = COND string( WHEN lv_class = 'VIEW' THEN `VIEW` ELSE `TABL` ).
      SELECT SINGLE devclass FROM tadir WHERE pgmid = 'R3TR' AND object = @lv_type AND obj_name = @lv_name INTO @DATA(lv_pkg).
      APPEND VALUE #( name = lv_name kind = lv_class package = lv_pkg
                      description = describe( iv_type = lv_type iv_name = CONV #( lv_name ) iv_langu = lv_langu ) ) TO lt_out.
    ENDLOOP.
    rs_resp-data_json = to_json( lt_out ).
  ENDMETHOD.


  METHOD abap_syntax.
    TYPES: BEGIN OF ty_syn,
             program TYPE string,
             checked TYPE string,
             ok      TYPE abap_bool,
             message TYPE string,
             include TYPE string,
             line    TYPE i,
             word    TYPE string,
           END OF ty_syn.
    DATA: ls_syn  TYPE ty_syn,
          lt_src  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_prog TYPE progname,
          lv_msg  TYPE string,
          lv_line TYPE i,
          lv_word TYPE string,
          lv_inc  TYPE progname,
          lv_off  TYPE i,
          lv_mid  TYPE trmsg_key.
    rs_resp-status = 'ok'.
    IF admit( EXPORTING iv_type = is_req-object_type iv_name = is_req-name CHANGING cs_resp = rs_resp ) = abap_false.
      RETURN.
    ENDIF.
    lv_prog = main_program( iv_type = is_req-object_type iv_name = is_req-name ).
    IF lv_prog IS INITIAL.
      rs_resp-status = 'error'.
      APPEND |No program to check for { is_req-object_type } { is_req-name }.| TO rs_resp-messages.
      RETURN.
    ENDIF.
    ls_syn-program = lv_prog.
    IF is_req-source IS NOT INITIAL AND is_req-object_type = 'PROG' AND lv_prog = is_req-name.
      SPLIT is_req-source AT cl_abap_char_utilities=>newline INTO TABLE lt_src.
      LOOP AT lt_src ASSIGNING FIELD-SYMBOL(<l>).
        <l> = replace( val = <l> sub = cl_abap_char_utilities=>cr_lf(1) with = `` occ = 0 ).
      ENDLOOP.
      ls_syn-checked = `the source you supplied`.
    ELSE.
      IF is_req-source IS NOT INITIAL.
        APPEND |A supplied source is checked for executable programs only; checked the stored version of { lv_prog } instead.| TO rs_resp-messages.
      ENDIF.
      READ REPORT lv_prog INTO lt_src.
      IF sy-subrc <> 0.
        rs_resp-status = 'error'.
        APPEND |Program { lv_prog } has no active source.| TO rs_resp-messages.
        RETURN.
      ENDIF.
      ls_syn-checked = `the stored (active) version`.
    ENDIF.
    SYNTAX-CHECK FOR lt_src MESSAGE lv_msg LINE lv_line WORD lv_word PROGRAM lv_prog
      INCLUDE lv_inc OFFSET lv_off MESSAGE-ID lv_mid.
    ls_syn-ok      = xsdbool( sy-subrc = 0 ).
    ls_syn-message = lv_msg.
    ls_syn-include = lv_inc.
    ls_syn-line    = lv_line.
    ls_syn-word    = lv_word.
    IF ls_syn-ok = abap_false.
      APPEND `SYNTAX-CHECK reports the first error only.` TO rs_resp-messages.
    ENDIF.
    rs_resp-data_json = to_json( ls_syn ).
  ENDMETHOD.


  METHOD abap_dumps.
    TYPES: BEGIN OF ty_dump,
             date    TYPE string,
             time    TYPE string,
             user    TYPE string,
             client  TYPE string,
             host    TYPE string,
             error   TYPE string,
             program TYPE string,
             include TYPE string,
             line    TYPE string,
           END OF ty_dump.
    DATA: lt_out  TYPE STANDARD TABLE OF ty_dump WITH DEFAULT KEY,
          lv_from TYPE d.
    rs_resp-status = 'ok'.
    DATA(lv_days) = COND i( WHEN is_req-days > 0 AND is_req-days <= 90 THEN is_req-days ELSE 7 ).
    lv_from = sy-datum - lv_days.
    DATA(lv_max) = COND i( WHEN is_req-max_rows > 0 AND is_req-max_rows <= 500 THEN is_req-max_rows ELSE 100 ).
    DATA(lv_all) = is_req-all_users.
    IF lv_all = abap_true.
      " other users' dumps: the same as displaying them in the debugger
      AUTHORITY-CHECK OBJECT 'S_DEVELOP'
        ID 'DEVCLASS' DUMMY ID 'OBJTYPE' FIELD 'DEBUG' ID 'OBJNAME' DUMMY ID 'P_GROUP' DUMMY ID 'ACTVT' FIELD '03'.
      IF sy-subrc <> 0.
        lv_all = abap_false.
        APPEND `Only your own dumps: other users' dumps need S_DEVELOP display for object type DEBUG.` TO rs_resp-messages.
      ENDIF.
    ENDIF.
    IF lv_all = abap_true.
      SELECT datum, uzeit, uname, mandt, ahost, flist FROM snap
        WHERE seqno = '000' AND datum >= @lv_from
        ORDER BY datum DESCENDING, uzeit DESCENDING INTO TABLE @DATA(lt_snap) UP TO @lv_max ROWS.
    ELSE.
      SELECT datum, uzeit, uname, mandt, ahost, flist FROM snap
        WHERE seqno = '000' AND datum >= @lv_from AND uname = @sy-uname
        ORDER BY datum DESCENDING, uzeit DESCENDING INTO TABLE @lt_snap UP TO @lv_max ROWS.
    ENDIF.
    LOOP AT lt_snap INTO DATA(ls_s).
      DATA(ls_d) = VALUE ty_dump( date = ls_s-datum time = ls_s-uzeit user = ls_s-uname client = ls_s-mandt host = ls_s-ahost ).
      " FLIST: a run of <2-char id><3-digit length><value>; FC error id, AP program, AI include, AL line
      DATA(lv_f) = CONV string( ls_s-flist ).
      DATA(lv_pos) = 0.
      WHILE lv_pos + 5 <= strlen( lv_f ).
        DATA(lv_id) = substring( val = lv_f off = lv_pos len = 2 ).
        DATA(lv_lt) = substring( val = lv_f off = lv_pos + 2 len = 3 ).
        IF lv_lt CN '0123456789'.
          EXIT.
        ENDIF.
        DATA(lv_len) = CONV i( lv_lt ).
        IF lv_pos + 5 + lv_len > strlen( lv_f ).
          EXIT.
        ENDIF.
        DATA(lv_val) = condense( substring( val = lv_f off = lv_pos + 5 len = lv_len ) ).
        CASE lv_id.
          WHEN 'FC'. ls_d-error   = lv_val.
          WHEN 'AP'. ls_d-program = lv_val.
          WHEN 'AI'. ls_d-include = lv_val.
          WHEN 'AL'. ls_d-line    = shift_left( val = lv_val sub = `0` ).
        ENDCASE.
        lv_pos = lv_pos + 5 + lv_len.
      ENDWHILE.
      APPEND ls_d TO lt_out.
    ENDLOOP.
    APPEND |Dumps since { lv_from DATE = ISO }{ COND #( WHEN lv_all = abap_true THEN `, all users` ELSE |, user { sy-uname }| ) } (SNAP, as in ST22).| TO rs_resp-messages.
    rs_resp-data_json = to_json( lt_out ).
  ENDMETHOD.


  METHOD may_display.
    DATA: lv_type TYPE trobjtype,
          lv_name TYPE sobj_name,
          lv_pkg  TYPE devclass.
    lv_type = iv_type.
    lv_name = iv_name.
    lv_pkg  = iv_package.
    AUTHORITY-CHECK OBJECT 'S_DEVELOP'
      ID 'DEVCLASS' FIELD lv_pkg
      ID 'OBJTYPE'  FIELD lv_type
      ID 'OBJNAME'  FIELD lv_name
      ID 'P_GROUP'  DUMMY
      ID 'ACTVT'    FIELD '03'.
    rv_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.


  METHOD locate.
    DATA: lv_type TYPE tadir-object,
          lv_name TYPE tadir-obj_name.
    CLEAR: ev_package, ev_author, ev_found.
    ev_owner_type = iv_type.
    ev_owner_name = iv_name.
    CASE iv_type.
      WHEN 'FUNC'.
        DATA lv_func TYPE enlfdir-funcname.
        lv_func = iv_name.
        SELECT SINGLE area FROM enlfdir WHERE funcname = @lv_func INTO @DATA(lv_area).
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.
        ev_owner_type = `FUGR`.
        ev_owner_name = lv_area.
      WHEN 'INCL'.
        ev_owner_type = `PROG`.
        " a class or function group include belongs to its class or group
        DATA(ls_own) = owner_of_include( iv_name ).
        IF ls_own-main_type IS NOT INITIAL AND ls_own-main_type <> `PROG`.
          ev_owner_type = ls_own-main_type.
          ev_owner_name = ls_own-main_name.
        ENDIF.
    ENDCASE.
    lv_type = ev_owner_type.
    lv_name = ev_owner_name.
    SELECT SINGLE devclass, author FROM tadir
      WHERE pgmid = 'R3TR' AND object = @lv_type AND obj_name = @lv_name
      INTO (@ev_package, @ev_author).
    ev_found = xsdbool( sy-subrc = 0 ).
    IF ev_found = abap_false AND iv_type = 'INCL'.
      " an include without a TADIR entry of its own (generated, or part of a pool): it exists if it has source
      DATA lv_prog TYPE trdir-name.
      lv_prog = iv_name.
      SELECT SINGLE @abap_true FROM trdir WHERE name = @lv_prog INTO @ev_found.
    ENDIF.
  ENDMETHOD.


  METHOD admit.
    DATA: lv_pkg   TYPE string,
          lv_found TYPE abap_bool,
          lv_otype TYPE string,
          lv_oname TYPE string.
    rv_ok = abap_false.
    IF iv_type IS INITIAL OR valid_name( iv_name ) = abap_false OR iv_name CA '*%'.
      cs_resp-status = 'error'.
      APPEND |Give an object type and an exact name (got '{ iv_type }' '{ iv_name }').| TO cs_resp-messages.
      RETURN.
    ENDIF.
    locate( EXPORTING iv_type = iv_type iv_name = iv_name
            IMPORTING ev_package = lv_pkg ev_found = lv_found ev_owner_type = lv_otype ev_owner_name = lv_oname ).
    IF lv_found = abap_false.
      cs_resp-status = 'error'.
      APPEND |{ iv_type } { iv_name } does not exist on this system.| TO cs_resp-messages.
      RETURN.
    ENDIF.
    IF may_display( iv_type = lv_otype iv_name = lv_oname iv_package = lv_pkg ) = abap_false.
      cs_resp-status = 'error'.
      APPEND |No authorization to display { lv_otype } { lv_oname } (S_DEVELOP, activity 03, package { lv_pkg }).| TO cs_resp-messages.
      RETURN.
    ENDIF.
    rv_ok = abap_true.
  ENDMETHOD.


  METHOD describe.
    CLEAR rv_text.
    CASE iv_type.
      WHEN 'PROG' OR 'INCL'.
        SELECT SINGLE text FROM trdirt WHERE name = @iv_name AND sprsl = @iv_langu INTO @rv_text.
      WHEN 'CLAS' OR 'INTF'.
        SELECT SINGLE descript FROM seoclasstx WHERE clsname = @iv_name AND langu = @iv_langu INTO @rv_text.
      WHEN 'FUGR'.
        SELECT SINGLE areat FROM tlibt WHERE area = @iv_name AND spras = @iv_langu INTO @rv_text.
      WHEN 'FUNC'.
        SELECT SINGLE stext FROM tftit WHERE funcname = @iv_name AND spras = @iv_langu INTO @rv_text.
      WHEN 'TABL' OR 'VIEW'.
        SELECT SINGLE ddtext FROM dd02t WHERE tabname = @iv_name AND ddlanguage = @iv_langu AND as4local = 'A' INTO @rv_text.
      WHEN 'DTEL'.
        SELECT SINGLE ddtext FROM dd04t WHERE rollname = @iv_name AND ddlanguage = @iv_langu AND as4local = 'A' INTO @rv_text.
      WHEN 'DOMA'.
        SELECT SINGLE ddtext FROM dd01t WHERE domname = @iv_name AND ddlanguage = @iv_langu AND as4local = 'A' INTO @rv_text.
      WHEN 'TTYP'.
        SELECT SINGLE ddtext FROM dd40t WHERE typename = @iv_name AND ddlanguage = @iv_langu AND as4local = 'A' INTO @rv_text.
      WHEN 'TRAN'.
        SELECT SINGLE ttext FROM tstct WHERE tcode = @iv_name AND sprsl = @iv_langu INTO @rv_text.
      WHEN 'DEVC'.
        SELECT SINGLE ctext FROM tdevct WHERE devclass = @iv_name AND spras = @iv_langu INTO @rv_text.
      WHEN 'MSAG'.
        SELECT SINGLE stext FROM t100t WHERE arbgb = @iv_name AND sprsl = @iv_langu INTO @rv_text.
    ENDCASE.
  ENDMETHOD.


  METHOD fugr_main.
    IF iv_fugr IS INITIAL.
      RETURN.
    ENDIF.
    IF iv_fugr(1) = '/'.
      DATA(lv_end) = find( val = iv_fugr sub = `/` off = 1 ).
      IF lv_end > 0.
        rv_prog = |{ substring( val = iv_fugr len = lv_end + 1 ) }SAPL{ substring( val = iv_fugr off = lv_end + 1 ) }|.
        RETURN.
      ENDIF.
    ENDIF.
    rv_prog = |SAPL{ iv_fugr }|.
  ENDMETHOD.


  METHOD source_lines.
    DATA: lt_src  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_prog TYPE progname,
          lv_cls  TYPE seoclsname.
    CLEAR: et_lines, ev_program, ev_error.
    CASE iv_type.
      WHEN 'PROG' OR 'INCL'.
        lv_prog = iv_name.
      WHEN 'FUGR'.
        lv_prog = fugr_main( iv_name ).
      WHEN 'FUNC'.
        DATA lv_func TYPE tfdir-funcname.
        lv_func = iv_name.
        SELECT SINGLE pname, include FROM tfdir WHERE funcname = @lv_func INTO @DATA(ls_tf).
        IF sy-subrc <> 0.
          ev_error = |Function module { iv_name } does not exist.|.
          RETURN.
        ENDIF.
        " SAPL<group> → L<group>U<nn>, keeping a namespace
        DATA(lv_main) = CONV string( ls_tf-pname ).
        IF lv_main CS 'SAPL'.
          lv_prog = replace( val = lv_main sub = `SAPL` with = `L` ) && |U{ ls_tf-include }|.
        ENDIF.
      WHEN 'CLAS' OR 'INTF'.
        lv_cls = iv_name.
        CASE iv_part.
          WHEN `main` OR ``.
            TRY.
                DATA lt_full TYPE seop_source_string.
                DATA(lo_src) = cl_oo_factory=>create_instance( )->create_clif_source( clif_name = lv_cls ).
                lo_src->get_source( IMPORTING source = lt_full ).
                et_lines = lt_full.
                ev_program = cl_oo_classname_service=>get_classpool_name( lv_cls ).
                RETURN.
              CATCH cx_root.
                " older systems: the sections and method includes, as the class editor shows them
                IF iv_type = 'INTF'.
                  lv_prog = cl_oo_classname_service=>get_interfacepool_name( lv_cls ).
                  lv_prog = lv_prog(30) && 'IU'.
                ELSE.
                  DATA(lt_parts) = VALUE stringtab( ( CONV #( cl_oo_classname_service=>get_pubsec_name( lv_cls ) ) )
                                                    ( CONV #( cl_oo_classname_service=>get_prosec_name( lv_cls ) ) )
                                                    ( CONV #( cl_oo_classname_service=>get_prisec_name( lv_cls ) ) ) ).
                  LOOP AT lt_parts INTO DATA(lv_part).
                    lv_prog = lv_part.
                    READ REPORT lv_prog INTO lt_src.
                    APPEND LINES OF lt_src TO et_lines.
                  ENDLOOP.
                  APPEND `ENDCLASS.` TO et_lines.
                  APPEND `` TO et_lines.
                  APPEND |CLASS { to_lower( iv_name ) } IMPLEMENTATION.| TO et_lines.
                  DATA lt_mi TYPE seop_methods_w_include.
                  CALL METHOD cl_oo_classname_service=>get_all_method_includes
                    EXPORTING  clsname = lv_cls
                    RECEIVING  result  = lt_mi
                    EXCEPTIONS OTHERS  = 1.
                  LOOP AT lt_mi INTO DATA(ls_mi).
                    READ REPORT ls_mi-incname INTO lt_src.
                    APPEND LINES OF lt_src TO et_lines.
                    APPEND `` TO et_lines.
                  ENDLOOP.
                  APPEND `ENDCLASS.` TO et_lines.
                  ev_program = cl_oo_classname_service=>get_classpool_name( lv_cls ).
                  RETURN.
                ENDIF.
            ENDTRY.
          WHEN `definitions`.     lv_prog = cl_oo_classname_service=>get_ccdef_name( lv_cls ).
          WHEN `implementations`. lv_prog = cl_oo_classname_service=>get_ccimp_name( lv_cls ).
          WHEN `macros`.          lv_prog = cl_oo_classname_service=>get_ccmac_name( lv_cls ).
          WHEN `testclasses`.     lv_prog = cl_oo_classname_service=>get_ccau_name( lv_cls ).
          WHEN OTHERS.
            ev_error = |Unknown class part '{ iv_part }': use main, definitions, implementations, macros or testclasses.|.
            RETURN.
        ENDCASE.
      WHEN OTHERS.
        ev_error = |Type { iv_type } has no ABAP source here; use PROG, INCL, CLAS, INTF, FUGR or FUNC.|.
        RETURN.
    ENDCASE.
    IF lv_prog IS INITIAL.
      ev_error = |No source found for { iv_type } { iv_name }.|.
      RETURN.
    ENDIF.
    ev_program = lv_prog.
    READ REPORT lv_prog INTO lt_src.
    IF sy-subrc <> 0.
      ev_error = |{ lv_prog } has no active source{ COND #( WHEN iv_part <> `main` AND iv_part IS NOT INITIAL THEN ` (the class may not have this part)` ) }.|.
      RETURN.
    ENDIF.
    et_lines = lt_src.
  ENDMETHOD.


  METHOD main_program.
    DATA lv_cls TYPE seoclsname.
    CASE iv_type.
      WHEN 'PROG'.
        rv_prog = iv_name.
      WHEN 'INCL'.
        DATA lv_inc TYPE d010inc-include.
        lv_inc = iv_name.
        SELECT SINGLE master FROM d010inc WHERE include = @lv_inc INTO @rv_prog.
        IF sy-subrc <> 0.
          rv_prog = iv_name.
        ENDIF.
      WHEN 'CLAS'.
        lv_cls = iv_name.
        rv_prog = cl_oo_classname_service=>get_classpool_name( lv_cls ).
      WHEN 'INTF'.
        lv_cls = iv_name.
        rv_prog = cl_oo_classname_service=>get_interfacepool_name( lv_cls ).
      WHEN 'FUGR'.
        rv_prog = fugr_main( iv_name ).
      WHEN 'FUNC'.
        DATA lv_func TYPE tfdir-funcname.
        lv_func = iv_name.
        SELECT SINGLE pname FROM tfdir WHERE funcname = @lv_func INTO @rv_prog.
    ENDCASE.
  ENDMETHOD.


  METHOD owner_of_include.
    DATA: lv_prog TYPE progname,
          lv_fg   TYPE rs38l-area,
          lv_cls  TYPE seoclsname.
    rs_use-include   = iv_include.
    rs_use-main_type = `PROG`.
    rs_use-main_name = iv_include.
    lv_prog = iv_include.
    IF fm_exists( `RS_PROGNAME_SPLIT` ) = abap_true.
      CALL FUNCTION 'RS_PROGNAME_SPLIT'
        EXPORTING  progname_with_namespace = lv_prog
        IMPORTING  fugr_group = lv_fg class_name = lv_cls
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc = 0 AND lv_cls IS NOT INITIAL.
        rs_use-main_type = `CLAS`.
        rs_use-main_name = lv_cls.
        DATA ls_key TYPE seocpdkey.
        CALL METHOD cl_oo_classname_service=>get_method_by_include
          EXPORTING  incname = lv_prog
          RECEIVING  mtdkey  = ls_key
          EXCEPTIONS OTHERS  = 1.
        IF sy-subrc = 0.
          rs_use-method = ls_key-cpdname.
        ENDIF.
        SELECT SINGLE @abap_true FROM tadir WHERE pgmid = 'R3TR' AND object = 'INTF' AND obj_name = @lv_cls INTO @DATA(lv_intf).
        IF lv_intf = abap_true.
          rs_use-main_type = `INTF`.
        ENDIF.
      ELSEIF sy-subrc = 0 AND lv_fg IS NOT INITIAL.
        rs_use-main_type = `FUGR`.
        rs_use-main_name = lv_fg.
        " the function module, for a function module include L<group>U<nn>
        DATA(lv_len) = strlen( iv_include ).
        IF lv_len > 3 AND substring( val = iv_include off = lv_len - 3 len = 1 ) = 'U'.
          DATA lv_pname TYPE tfdir-pname.
          DATA lv_incno TYPE tfdir-include.
          lv_pname = fugr_main( CONV #( lv_fg ) ).
          lv_incno = substring( val = iv_include off = lv_len - 2 len = 2 ).
          SELECT SINGLE funcname FROM tfdir WHERE pname = @lv_pname AND include = @lv_incno INTO @DATA(lv_fm).
          IF sy-subrc = 0.
            rs_use-method = lv_fm.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD valid_name.
    rv_ok = xsdbool( iv_name IS NOT INITIAL AND strlen( iv_name ) <= 120
                     AND iv_name CO `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/$=*%<>-` ).
  ENDMETHOD.


  METHOD like_pattern.
    DATA(lv_p) = to_upper( condense( iv_pattern ) ).
    IF lv_p IS INITIAL OR valid_name( lv_p ) = abap_false.
      RETURN.
    ENDIF.
    rv_like = replace( val = lv_p sub = `*` with = `%` occ = 0 ).
  ENDMETHOD.


  METHOD rows.
    rv_rows = COND #( WHEN iv_rows <= 0 THEN c_default_rows
                      WHEN iv_rows > c_max_rows THEN c_max_rows
                      ELSE iv_rows ).
  ENDMETHOD.


  METHOD langu.
    rv_langu = sy-langu.
    IF strlen( iv_language ) = 1.
      rv_langu = to_upper( iv_language ).
    ELSEIF strlen( iv_language ) = 2.
      DATA lv_iso TYPE laiso.
      lv_iso = to_upper( iv_language ).
      SELECT SINGLE spras FROM t002 WHERE laiso = @lv_iso INTO @rv_langu.
      IF sy-subrc <> 0.
        rv_langu = sy-langu.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD fm_exists.
    DATA lv_fm TYPE c LENGTH 30.
    lv_fm = iv_fm.
    SELECT SINGLE @abap_true FROM tfdir WHERE funcname = @lv_fm INTO @rv_ok.
  ENDMETHOD.


  METHOD to_json.
    /ui2/cl_json=>serialize( EXPORTING data = ia_data pretty_name = /ui2/cl_json=>pretty_mode-none
                             RECEIVING r_json = rv_json ).
  ENDMETHOD.

ENDCLASS.
