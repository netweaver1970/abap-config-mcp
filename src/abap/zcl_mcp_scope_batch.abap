CLASS zcl_mcp_scope_batch DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  "! Optional part of the MCP customizing engine, for SAP_BASIS 7.50 and later.
  "! The engine's retest_scope counts rows of up to thousands of tables; one SQL
  "! statement per table spends most of its time preparing statements. This class
  "! counts eight tables in one statement, a UNION ALL of eight dynamic branches,
  "! which ABAP SQL supports from 7.50. The engine calls it dynamically and counts
  "! one table at a time when it is not installed, so the engine itself keeps the
  "! release floor it had (7.40). COUNTS ONLY: each branch is
  "! "<n> AS B, <field> AS K, COUNT(*) AS N" over one table, grouped by the field.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_branch,
             f TYPE string,   " select list
             t TYPE string,   " table
             w TYPE string,   " where condition
             g TYPE string,   " group by
           END OF ty_branch,
           ty_branch_tt TYPE STANDARD TABLE OF ty_branch WITH DEFAULT KEY,
           BEGIN OF ty_count,
             b TYPE i,        " branch number 1..8
             k TYPE string,   " key value
             n TYPE i,        " rows
           END OF ty_count,
           ty_count_tt TYPE STANDARD TABLE OF ty_count WITH DEFAULT KEY.

    "! Exactly eight branches; anything else returns no counts and raises nothing.
    CLASS-METHODS count8
      IMPORTING it_branches TYPE ty_branch_tt
      EXPORTING et_counts   TYPE ty_count_tt
      RAISING   cx_sy_open_sql_db
                cx_sy_dynamic_osql_error.
ENDCLASS.



CLASS zcl_mcp_scope_batch IMPLEMENTATION.

  METHOD count8.
    DATA: b1 TYPE ty_branch, b2 TYPE ty_branch, b3 TYPE ty_branch, b4 TYPE ty_branch,
          b5 TYPE ty_branch, b6 TYPE ty_branch, b7 TYPE ty_branch, b8 TYPE ty_branch.
    CLEAR et_counts.
    IF lines( it_branches ) <> 8.
      RETURN.
    ENDIF.
    b1 = it_branches[ 1 ]. b2 = it_branches[ 2 ]. b3 = it_branches[ 3 ]. b4 = it_branches[ 4 ].
    b5 = it_branches[ 5 ]. b6 = it_branches[ 6 ]. b7 = it_branches[ 7 ]. b8 = it_branches[ 8 ].
    SELECT (b1-f) FROM (b1-t) WHERE (b1-w) GROUP BY (b1-g)
      UNION ALL SELECT (b2-f) FROM (b2-t) WHERE (b2-w) GROUP BY (b2-g)
      UNION ALL SELECT (b3-f) FROM (b3-t) WHERE (b3-w) GROUP BY (b3-g)
      UNION ALL SELECT (b4-f) FROM (b4-t) WHERE (b4-w) GROUP BY (b4-g)
      UNION ALL SELECT (b5-f) FROM (b5-t) WHERE (b5-w) GROUP BY (b5-g)
      UNION ALL SELECT (b6-f) FROM (b6-t) WHERE (b6-w) GROUP BY (b6-g)
      UNION ALL SELECT (b7-f) FROM (b7-t) WHERE (b7-w) GROUP BY (b7-g)
      UNION ALL SELECT (b8-f) FROM (b8-t) WHERE (b8-w) GROUP BY (b8-g)
      INTO CORRESPONDING FIELDS OF TABLE @et_counts.
  ENDMETHOD.

ENDCLASS.
