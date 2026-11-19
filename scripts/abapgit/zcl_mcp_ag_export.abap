CLASS zcl_mcp_ag_export DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PRIVATE SECTION.
    CONSTANTS c_ag TYPE string VALUE '\PROGRAM={{ABAPGIT_PROGRAM}}'.
    CONSTANTS c_package TYPE devclass VALUE '{{PACKAGE}}'.
ENDCLASS.

CLASS zcl_mcp_ag_export IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    " Exports a package with abapGit's own serializer (as "Export package as zip"), printed as base64,
    " so scripts/abapgit-install.ts --verify can compare it with the repository. Deleted after the run.
    DATA: lr_repo TYPE REF TO data,
          lr_dot  TYPE REF TO data,
          lv_x    TYPE xstring,
          lv_b64  TYPE string,
          lv_n    TYPE string.
    FIELD-SYMBOLS: <repo> TYPE any, <local> TYPE any, <dot> TYPE any, <f> TYPE any.
    TRY.
        lv_n = c_ag && '\INTERFACE=ZIF_ABAPGIT_PERSISTENCE\TYPE=TY_REPO'.
        CREATE DATA lr_repo TYPE (lv_n).
        ASSIGN lr_repo->* TO <repo>.
        ASSIGN COMPONENT 'LOCAL_SETTINGS' OF STRUCTURE <repo> TO <local>.
        lv_n = c_ag && '\CLASS=ZCL_ABAPGIT_DOT_ABAPGIT'.
        CREATE DATA lr_dot TYPE REF TO (lv_n).
        ASSIGN lr_dot->* TO <dot>.
        CALL METHOD (lv_n)=>build_default RECEIVING ro_dot_abapgit = <dot>.
        DATA lo_dot TYPE REF TO object.
        lo_dot = <dot>.
        DATA lv_logic TYPE string VALUE `PREFIX`.
        CALL METHOD lo_dot->('SET_FOLDER_LOGIC') EXPORTING iv_logic = lv_logic.
        lv_n = c_ag && '\CLASS=ZCL_ABAPGIT_ZIP'.
        CALL METHOD (lv_n)=>export
          EXPORTING is_local_settings = <local> iv_package = c_package io_dot_abapgit = <dot> iv_show_log = abap_false
          RECEIVING rv_xstr = lv_x.
        CALL FUNCTION 'SCMS_BASE64_ENCODE_STR' EXPORTING input = lv_x IMPORTING output = lv_b64.
        out->write( |B64BEGIN{ lv_b64 }B64END| ).
      CATCH cx_root INTO DATA(lx).
        out->write( |ERROR { cl_abap_classdescr=>get_class_name( lx ) }: { lx->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.
ENDCLASS.
