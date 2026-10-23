# SOAP RFC connections — read-only access to systems without ADT

Old NetWeaver releases have no ADT service (`/sap/bc/adt`): every ADT call there
answers 403 "Service cannot be reached". They do have SAP's SOAP RFC service,
`/sap/bc/soap/rfc`, which calls a remote-enabled function module over HTTP. A
connection marked `"protocol": "soap-rfc"` uses that service for a read-only
subset of the tools.

## Configuring a connection

In `connections.json`, add `"protocol": "soap-rfc"` to the system's entry. The
other fields mean what they mean for ADT connections:

```json
{
  "id": "OLDQ",
  "url": "http://<host>:<port>",
  "username": "<user>",
  "password": "…",
  "client": "200",
  "language": "EN",
  "protocol": "soap-rfc"
}
```

Leave `protocol` out (or set `"adt"`) for every ADT system; nothing changes for
them. The server reads `connections.json` at start, so restart it after the edit.

Before the first call, check that the service answers at all — without
credentials, so no failed logon is counted:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://<host>:<port>/sap/bc/soap/rfc?sap-client=<client>'
```

`401` means the service is active and wants a logon: good. `403` means it is not
active in SICF (Basis activates `/default_host/sap/bc/soap/rfc`); `404` means the
system has no such service.

## What works on a SOAP RFC connection

| Tool | How |
|---|---|
| `read_table_contents` | `RFC_READ_TABLE`, all readable fields, optional `whereClause` |
| `execute_data_query` | a single-table `SELECT <fields\|*> FROM <table> [WHERE …] [UP TO n ROWS]` mapped onto `RFC_READ_TABLE`; joins, `ORDER BY`, `GROUP BY`, aggregates, subqueries, `DISTINCT` and host variables are refused with the reason |
| `describe_database_table` | the field list `RFC_READ_TABLE` reports (`NO_DATA`), key fields from `DD03L` |
| `get_abap_object_lines`, `search_abap_object_lines`, `get_abap_batch_lines` | programs, includes, function modules, function groups, classes, interfaces — named by ADT URL as on ADT connections, or `PROG:`/`INCL:`/`FUNC:`/`FUGR:`/`CLAS:`/`INTF:` + name |
| `connected_systems` | marks the connection `[SOAP RFC …]` |
| `force_relogin` | answers that there is no session to renew |

Every other tool answers "not supported on this connection" without calling SAP.

## How it works

**Routing.** `tools/soapRfcRouting.ts` wraps every tool handler. At call time
the order is session scope → SOAP RFC routing → session recovery → the tool's
handler (`tools/index.ts`). A call whose connection — named, or the default — is
`soap-rfc` goes to the SOAP handler of that tool name or is refused, and never
reaches session recovery, so it never triggers an ADT reconnect. Any other call
reaches session recovery and the tool's own handler with its arguments untouched. As a second line, `ensureConnected` and
`newIsolatedClient` refuse to build an ADT client for a `soap-rfc` connection, and
the start-up warm-up skips one, so nothing ever tries an ADT logon there.

**Calls** (`soapRfc/client.ts`). Each FM call is one POST with Basic auth,
`sap-client` and `sap-language`, no cookies, `Connection: close`. Calls to one
connection run one at a time. The first **401** — or any answer that is not a
SOAP envelope, such as an HTML logon page from a form or SSO fallback — latches:
no further call goes to that connection until the server process restarts, so a
wrong password costs one failed logon per server process, not one per call. (The
HTTP server is one process; each stdio client starts its own.) A 403 is
explained as an inactive SICF service and does not latch, nor does a 5xx error
page (a proxy, ICM or dump page is not a logon answer). SOAP faults become
errors carrying SAP's exception name and text.

**Tables** (`soapRfc/readTable.ts`). `RFC_READ_TABLE` returns each row as one
512-character string (`DATA-WA`), cut by the offsets it reports; fields are
separated by `|`, so a row that lost blanks in transit is detected (the
delimiters are not at the offsets) and split on the delimiter instead. A first
call with `NO_DATA` gets the field list. If the selected fields fit one row, one
call reads them. If not, the fields are split into groups that each fit *with
the key fields* (from `DD03L`), read in turn with the same WHERE clause and row
count, and joined on the key. The reads have no sort order, so with a row limit
the parts can return different rows: only rows found in every part are returned,
and the answer says how many were left out. Without usable keys (views, an
unreadable `DD03L`) a wide read is refused — joining by row position could glue
different rows together — and the answer asks for fewer fields. Fields
`RFC_READ_TABLE` cannot read (strings, references) are left out with a note.
WHERE clauses go in as `OPTIONS` lines of at most 72 characters, cut at blanks
outside literals. Subqueries are refused in every WHERE clause:
`RFC_READ_TABLE` checks the authorization for its own table only.

**Sources** (`soapRfc/source.ts`). The first source read on a connection probes
which read FM to use, through `RFC_READ_TABLE` on `TFDIR` (exists, `FMODE = 'R'`)
and `FUPARAREF` (its parameters on this release): `RPY_PROGRAM_READ` with
`SOURCE_EXTENDED` (255-character lines) if available, else `RFC_READ_REPORT`
(on every release; 72-character lines), else `RPY_PROGRAM_READ`'s `SOURCE`. Only
parameters the FM has on that release are sent. A function module is read
through its include (`TFDIR` `PNAME`/`INCLUDE` → `L<group>U<nn>`); a class as its
class pool (`<class>====…CP`) with each of its includes, and `include methods.`,
expanded in place from the `TRDIR` list; an interface through its `IU` include.
When the reader returns 72-character lines and a line reaches 72, the answer
warns that lines may be cut.

## Read-only

The only function modules called are `RFC_READ_TABLE`, `RPY_PROGRAM_READ` and
`RFC_READ_REPORT`; none changes data. `execute_data_query` and
`read_table_contents` keep the DML/DDL block of the ADT path.

## Authorizations the user needs

`S_SERVICE`/`S_ICF` for the SOAP RFC service where it is restricted; `S_RFC` for
the function groups of the FMs above; `S_TABU_DIS` (or `S_TABU_NAM`) for each table
read — including `DD03L`, `TFDIR`, `FUPARAREF` and `TRDIR` for the key and source
lookups.

## Limits

- No sorting, joins or aggregates (`RFC_READ_TABLE` cannot); sort client-side.
- `RFC_READ_TABLE` reads only the logon client of client-dependent tables.
- Floating-point and some packed fields come back as `RFC_READ_TABLE` formats them.
- A WHERE literal longer than 71 characters cannot be passed.
- A row wider than 512 characters needs key fields to be read in parts (no views).
- Class sources are the pool with its includes inlined (marked `*" ---- include …`),
  not ADT's exact `source/main` layout.
