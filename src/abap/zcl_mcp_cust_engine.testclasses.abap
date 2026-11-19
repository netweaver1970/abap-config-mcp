*"* ABAP Unit tests of ZCL_MCP_CUST_ENGINE (the class's test include).
*"* They cover the logic that does not depend on the system's data: the row cap,
*"* the delivery classes a read may cover, name checks and quoting, and how each
*"* governed action refuses bad input. Test tables are picked from the DDIC, never
*"* named, so the tests run on any ABAP system (ECC, S/4, BW, CRM, ...).
*"* RISK LEVEL HARMLESS: nothing is written.

CLASS ltc_engine DEFINITION DEFERRED.
CLASS zcl_mcp_cust_engine DEFINITION LOCAL FRIENDS ltc_engine.

CLASS ltc_engine DEFINITION FINAL FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.

  PRIVATE SECTION.
    DATA cut TYPE REF TO zcl_mcp_cust_engine.

    METHODS setup.
    METHODS assert_refused
      IMPORTING is_resp TYPE zcl_mcp_cust_engine=>ty_response
                iv_text TYPE string.
    METHODS first_message
      IMPORTING is_resp        TYPE zcl_mcp_cust_engine=>ty_response
      RETURNING VALUE(rv_text) TYPE string.

    METHODS row_cap FOR TESTING.
    METHODS customizing_classes FOR TESTING.
    METHODS valid_names FOR TESTING.
    METHODS quotes_escaped FOR TESTING.
    METHODS read_bad_name FOR TESTING.
    METHODS read_unknown_table FOR TESTING.
    METHODS read_application_data FOR TESTING.
    METHODS read_unknown_field FOR TESTING.
    METHODS describe_unknown FOR TESTING.
    METHODS describe_bad_name FOR TESTING.
    METHODS retest_scope_needs_keys FOR TESTING.
    METHODS transport_info_needs_object FOR TESTING.
    METHODS dependencies_needs_action FOR TESTING.
ENDCLASS.


CLASS ltc_engine IMPLEMENTATION.

  METHOD setup.
    cut = NEW #( ).
  ENDMETHOD.

  METHOD first_message.
    READ TABLE is_resp-messages INTO rv_text INDEX 1.
  ENDMETHOD.

  METHOD assert_refused.
    cl_abap_unit_assert=>assert_equals( act = is_resp-status exp = 'error' msg = |expected a refusal: { iv_text }| ).
    cl_abap_unit_assert=>assert_char_cp( act = first_message( is_resp ) exp = |*{ iv_text }*| ).
  ENDMETHOD.

  METHOD row_cap.
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_cust_engine=>clamp_rows( 0 )    exp = 200 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_cust_engine=>clamp_rows( -5 )   exp = 200 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_cust_engine=>clamp_rows( 50 )   exp = 50 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_cust_engine=>clamp_rows( 1000 ) exp = 1000 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_cust_engine=>clamp_rows( 5000 ) exp = 1000 ).
  ENDMETHOD.

  METHOD customizing_classes.
    cl_abap_unit_assert=>assert_true(  zcl_mcp_cust_engine=>is_customizing_class( 'C' ) ).
    cl_abap_unit_assert=>assert_true(  zcl_mcp_cust_engine=>is_customizing_class( 'G' ) ).
    cl_abap_unit_assert=>assert_true(  zcl_mcp_cust_engine=>is_customizing_class( 'E' ) ).
    cl_abap_unit_assert=>assert_false( zcl_mcp_cust_engine=>is_customizing_class( 'A' ) ).
    cl_abap_unit_assert=>assert_false( zcl_mcp_cust_engine=>is_customizing_class( 'S' ) ).
    cl_abap_unit_assert=>assert_false( zcl_mcp_cust_engine=>is_customizing_class( 'L' ) ).
    cl_abap_unit_assert=>assert_false( zcl_mcp_cust_engine=>is_customizing_class( ' ' ) ).
  ENDMETHOD.

  METHOD valid_names.
    cl_abap_unit_assert=>assert_true(  cut->is_valid_name( `T001W` ) ).
    cl_abap_unit_assert=>assert_true(  cut->is_valid_name( `/POSDW/V_TASK` ) ).
    cl_abap_unit_assert=>assert_false( cut->is_valid_name( `BAD NAME` ) ).
    cl_abap_unit_assert=>assert_false( cut->is_valid_name( `T001W'--` ) ).
    cl_abap_unit_assert=>assert_false( cut->is_valid_name( `` ) ).
    cl_abap_unit_assert=>assert_false( cut->is_valid_name( `ABCDEFGHIJKLMNOPQRSTUVWXYZ12345` ) ).   " 31 characters
  ENDMETHOD.

  METHOD quotes_escaped.
    cl_abap_unit_assert=>assert_equals( act = cut->esc_quote( `x' OR 1=1 --` ) exp = `x'' OR 1=1 --` ).
    cl_abap_unit_assert=>assert_equals( act = cut->esc_quote( `plain` )        exp = `plain` ).
  ENDMETHOD.

  METHOD read_bad_name.
    assert_refused( is_resp = cut->handle_read( VALUE #( table = `T001W; DROP` ) )
                    iv_text = `is not a valid DDIC name` ).
  ENDMETHOD.

  METHOD read_unknown_table.
    assert_refused( is_resp = cut->handle_read( VALUE #( table = `ZZ_MCP_NO_SUCH_TAB` ) )
                    iv_text = `there is no active table of that name` ).
  ENDMETHOD.

  METHOD read_application_data.
    " Any transparent table of delivery class A on this system.
    SELECT SINGLE tabname FROM dd02l
      WHERE contflag = 'A' AND tabclass = 'TRANSP' AND as4local = 'A'
      INTO @DATA(lv_tab).
    IF sy-subrc <> 0.
      RETURN.   " no application table at all: nothing to check here
    ENDIF.
    assert_refused( is_resp = cut->handle_read( VALUE #( table = lv_tab ) )
                    iv_text = `this read covers customizing only` ).
  ENDMETHOD.

  METHOD read_unknown_field.
    " A customizing table the test user may display, picked from the DDIC.
    SELECT tabname FROM dd02l
      WHERE contflag = 'C' AND tabclass = 'TRANSP' AND as4local = 'A'
      INTO TABLE @DATA(lt_tabs)
      UP TO 50 ROWS.
    LOOP AT lt_tabs INTO DATA(ls_tab).
      IF cut->may_display( CONV string( ls_tab-tabname ) ) = abap_true.
        assert_refused( is_resp = cut->handle_read( VALUE #( table = ls_tab-tabname key_field = `ZZ_NO_FIELD` source_key = `1` ) )
                        iv_text = `has no field ZZ_NO_FIELD` ).
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD describe_unknown.
    assert_refused( is_resp = cut->handle_ddic_describe( VALUE #( table = `ZZ_MCP_NO_SUCH_TAB` ) )
                    iv_text = `there is no active table or view of that name` ).
  ENDMETHOD.

  METHOD describe_bad_name.
    assert_refused( is_resp = cut->handle_ddic_describe( VALUE #( table = `A B` ) )
                    iv_text = `is not a valid DDIC name` ).
  ENDMETHOD.

  METHOD retest_scope_needs_keys.
    assert_refused( is_resp = cut->handle_retest_scope( VALUE #( org_unit = `WERKS` source_key = `1000` ) )
                    iv_text = `give the org-unit domain` ).
  ENDMETHOD.

  METHOD transport_info_needs_object.
    DATA(ls_resp) = cut->handle_transport_info( VALUE #( obj_type = `TOOLONG` obj_name = `X` ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_resp-status exp = 'error' ).
    " Without S_TRANSPRT display the authority check answers first; either way it stops.
    cl_abap_unit_assert=>assert_char_cp( act = first_message( ls_resp ) exp = `*stopped*` ).
  ENDMETHOD.

  METHOD dependencies_needs_action.
    DATA(ls_resp) = cut->handle_dependencies( VALUE #( action = `NOPE` ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_resp-status exp = 'error' ).
    cl_abap_unit_assert=>assert_char_cp( act = first_message( ls_resp ) exp = `*stopped*` ).
  ENDMETHOD.

ENDCLASS.
