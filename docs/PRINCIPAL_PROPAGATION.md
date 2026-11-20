# The engine behind SAP's MCP Gateway, as the end user: manual set-up

This guide sets up the chain in which an AI agent calls the abap-config-mcp engine through
SAP's MCP Gateway (SAP Integration Suite) and SAP runs every call as the person who signed in to
the agent, not as a shared technical user:

```
AI agent ──OAuth──▶ MCP Gateway ──destination──▶ Cloud Connector ──mTLS──▶ ICM ──▶ ZCL_MCP_CUST_ENGINE
(user signs in)     (Integration    (PrincipalPropagation)  (short-lived X.509     (maps the      (runs as that
                     Suite)                                   for the user)          certificate    SAP user, with
                                                                                     to a user)     their authorizations)
```

Parts 3 to 5 (everything in the ABAP system) were tested end to end on a lab system (CAR,
SAP_BASIS 757) on 19 November 2026, with local stand-ins for the BTP parts (see part 7). The
BTP and Cloud Connector steps (parts 1 and 2) follow SAP's documented principal propagation
set-up and community walkthroughs; check the screens against SAP Help for your release, since
SAP's MCP Gateway is new and its principal propagation support was still rolling out in 2026.

What you need:

| | |
|---|---|
| SAP BTP subaccount | with SAP Integration Suite (an edition that includes the MCP Gateway) and the Connectivity service |
| Identity provider | SAP Cloud Identity Services (IAS), trusted by the subaccount; your users sign in there |
| SAP Cloud Connector | 2.x, installed in the network of the ABAP system, connected to the subaccount |
| ABAP system | SAP_BASIS 7.40 SP08 or later (7.50+ for every engine feature), HTTPS active in ICM |
| abapGit | standalone or developer version, to install the engine |
| Basis access | STRUST, RZ10/RZ11, SICF, SU01 / SM30, SMICM |

---

## Part 0: decide the user mapping

Cloud Connector issues a certificate whose subject comes from a pattern you set, for example
`CN=${login_name}, O=Example, C=BE` or `CN=${email}`. SAP must map that subject to an SAP user.
Pick one of two ways:

- **One entry per user** (table USREXTID, SM30 view `VUSREXTID`, type DN): simple, explicit, fine
  for a pilot. Each user's DN is entered once.
- **A rule** (transaction `CERTRULE`, with `login/certificate_mapping_rulebased = 1`): maps every
  certificate of the Cloud Connector CA by rule, e.g. the CN is the SAP user name. Use it for more
  than a handful of users.

With the pattern `CN=${login_name}` and IAS login names equal to SAP user names, a CERTRULE rule
"CN → user" needs no per-user maintenance.

---

## Part 1: BTP

1. **Trust**: in the subaccount, Security → Trust Configuration, establish trust to your IAS
   tenant. Keep the default identity provider entry too; community reports say principal
   propagation fails silently when only one entry is listed.
2. **Connectivity**: the subaccount needs the Connectivity service (it carries the
   `SAP-Connectivity-Authentication` header with the user's token to Cloud Connector).
3. **Destination** (Connectivity → Destinations), for example `ZMCP_ENGINE`:

   | Field | Value |
   |---|---|
   | Type | HTTP |
   | URL | `http://<virtual host>:<virtual port>/sap/bc/zmcp_cust` (the virtual host from part 2) |
   | Proxy Type | OnPremise |
   | Authentication | PrincipalPropagation |
   | Location ID | the Cloud Connector's location ID, if you set one |
   | Additional property `sap-client` | the ABAP client, e.g. `600` |

4. **MCP server in Integration Suite**: create an MCP server artifact with source type
   "HTTP endpoint with OpenAPI specification":
   - upload [`docs/gateway/zmcp_cust.openapi.json`](gateway/zmcp_cust.openapi.json) (24 operations,
     one tool each; the gateway takes at most 30 per MCP server), and for reading ABAP code a
     second MCP server artifact from [`docs/gateway/zmcp_abap.openapi.json`](gateway/zmcp_abap.openapi.json)
     (11 read-only operations) on the same destination,
   - point it at the destination `ZMCP_ENGINE`,
   - curate tool names and descriptions if you like, and leave out the write tools (`write`,
     `create`, `delete`, `org_copy`, `listing`, `transport_move`, `bw_create`, `bw_change`,
     `bw_activate`, `bw_delete`) if the agent should only read. Every write is a dry run unless the
     call sets `commit: true`, and SAP's authorizations of the user apply in any case.
5. **OAuth for the agent**: the MCP client (Claude, Copilot Studio, Joule, …) signs the user in
   through IAS; register the client as the MCP server's documentation describes. The token must
   reach the gateway as the user's token, not a client-credentials token, or there is no user to
   propagate.

## Part 2: Cloud Connector

1. **Connect** the Cloud Connector to the subaccount (Define Subaccount).
2. **System certificate** (Configuration → On Premise → System Certificate): the certificate
   Cloud Connector presents to ICM. Use one from your PKI, or let Cloud Connector create one.
   Note its subject and its issuer: they go into `icm/trusted_reverse_proxy_0` in part 3.
3. **CA certificate for principal propagation** (Configuration → On Premise → CA Certificate):
   the CA that signs the short-lived user certificates. Export it (its public certificate): it
   goes into STRUST in part 3.
4. **Principal propagation** (Configuration → On Premise → Principal Propagation): set the
   subject pattern, e.g. `CN=${login_name}, O=Example, C=BE`, and the validity of the issued
   certificates (short, e.g. 10 minutes). **The clocks of the Cloud Connector host and the ABAP
   system must agree** (NTP on both): a short-lived certificate is refused as "certificate expired"
   as soon as the back end's clock is ahead by more than its validity. On the lab system S4, whose
   clock ran about two hours ahead, every propagated logon failed that way until NTP (chronyd) was
   enabled on the host. Then Cloud To On-Premise → Principal Propagation →
   **Synchronize**, so Cloud Connector trusts the subaccount's IAS tokens.
5. **System mapping** (Cloud To On-Premise → Access Control → Add): back-end type ABAP System,
   protocol **HTTPS**, internal host and port of ICM's HTTPS service (e.g. `sapcar:44301`),
   virtual host and port (used in the destination URL), **principal type X.509 Certificate
   (general usage)**, system certificate for logon as configured. Add the resource
   `/sap/bc/zmcp_cust` with "Path and all sub-paths".

## Part 3: the ABAP system's trust (STRUST, ICM)

> **Before you touch STRUST, check where the SSL server PSE lives.** STRUST keeps PSEs in the
> database and writes them to `$(DIR_INSTANCE)/sec`. If the SSL server PSE was put in place at OS
> level (for example a Let's Encrypt certificate imported with `sapgenpse`) it may exist only as a
> file: table `SSF_PSE_H` has no row for `SAPSSLS.pse`. Then any database sync (opening it in
> STRUST and saving, or `SSFPSE_UPDATED`, which `CL_ABAP_PSE` calls) **deletes the file** as
> "removed from the database", and ICM loses its server certificate at the next reload. In that
> case either first store the PSE in the database the supported way (STRUST, PSE → Import, then
> save, so the database holds it), or change only the file with `sapgenpse` at OS level:
> `sapgenpse maintain_pk -a cc_ca.crt -p SAPSSLS.pse`, then reload in SMICM.

1. **Trust the Cloud Connector CA** (and the issuer of its system certificate, if different):
   STRUST → SSL server Standard → Import certificate → Add to Certificate List → Save. If you run
   several SSL server identities (SNI), add it to each that serves the HTTPS port.
2. **Reload ICM's PSEs**: SMICM → Administration → ICM → Exit Soft (or Goto → Reload SSL
   certificates / PSEs, depending on release). Check from outside that ICM now offers the CA:
   `openssl s_client -connect <host>:<https port>` lists it under "Acceptable client certificate
   CA names".
3. **Accept client certificates**: `icm/HTTPS/verify_client = 1` (the default: request, do not
   require). `2` would require a certificate on every HTTPS connection.
4. **Trust Cloud Connector as reverse proxy**: in the instance profile (RZ10), so it survives a
   restart, and for an immediate effect in the running ICM (SMICM → Goto → Parameters → Display →
   Change Value, or function module `ICM_SET_VECTOR_PARM` for vector `icm/trusted_reverse_proxy`;
   RZ11 refuses it as "Parameter not found" until it exists in a profile):

   ```
   icm/trusted_reverse_proxy_0 = SUBJECT="CN=<cc system cert CN>, O=<…>, C=<…>", ISSUER="CN=<its issuer CN>, O=<…>, C=<…>"
   ```

   Write both DNs as SAP shows them in STRUST (most specific first, comma and space). Without
   this parameter ICM ignores the `SSL_CLIENT_CERT` header that carries the user's certificate:
   SAP then sees only the Cloud Connector's own certificate, which maps to no user, and answers
   401 (verified). This is what stops anyone else from forging the header.
   (Older releases use `icm/HTTPS/trust_client_with_issuer` and `icm/HTTPS/trust_client_with_subject`,
   which cannot be changed dynamically.)

   > **Bind the user mapping to the Cloud Connector CA.** For a trusted reverse proxy, ICM does not
   > check who issued the certificate it forwards: on the lab system a certificate for `CN=BASIS`
   > signed by an unrelated CA, forwarded by the trusted proxy, logged on as BASIS while the mapping
   > was by DN only. So whoever holds the Cloud Connector's system certificate can name any user,
   > unless SAP only accepts certificates of the Cloud Connector CA: give every `VUSREXTID` entry the
   > issuer (part 4), or use CERTRULE, whose rules are per issuer. With the issuer in the mapping the
   > same forged certificate got 401. Protect the system certificate's private key in any case.

## Part 4: the ABAP system's users

**Per-user mapping (VUSREXTID)**: SM30 → `VUSREXTID` → External ID type **DN** → New entries:

| External ID | Issuer | User | Activated |
|---|---|---|---|
| `CN=JDOE, O=Example, C=BE` | `CN=<Cloud Connector CA>, O=Example, C=BE` | JDOE | ✓ |

Fill the issuer: see the note in part 3, step 4.

The DN must be written **with a space after each comma**, most specific part first, as SAP renders
it: `CN=BASIS, O=MCP Simulation, C=BE` mapped on the lab system, while `CN=BASIS,O=MCP Simulation,C=BE`
(how some tools print the same DN) did not, and the logon failed with 401. The issuer is written the same
way. Programmatically the same is function module `SUSR_USER_EXTID_SET` (type `DN`, operation `I`,
fields EXTID and ISSUER); `SUSR_USER_EXTID_DEL` removes a user's entries.

**Rule-based mapping (CERTRULE)**: set `login/certificate_mapping_rulebased = 1` (RZ11, dynamic;
RZ10 to keep it), then CERTRULE → upload a sample certificate from Cloud Connector → add a rule,
for example "Certificate attribute CN → Login as", and save. Check it in CERTRULE with the sample
certificate ("Status" shows the user it maps to). When rule-based mapping is on, `VUSREXTID`
entries are no longer used.

**Authorizations**: the propagated user needs, besides S_ICF if your SICF node checks it:

- display of the customizing tables it reads (`S_TABU_DIS` / `S_TABU_NAM`),
- `S_TRANSPRT` display for the transport tools, and for writes the change authorizations of the
  tables and `S_TRANSPRT` / `S_CTS_ADMI` for recording,
- for BW: the BW authorizations of the objects (`S_RS_IOBJ`, `S_RS_ADSO`, …) and `S_RS_ADMWB`.

This is the point of propagation: an agent acting for a user can do exactly what that user can.

## Part 5: the engine

1. **Install it with abapGit** into a package of its own (see the README, "Installing the engine
   with abapGit"): New Offline (or New Online with this repository) → Import zip
   `release/abap-config-mcp-engine-<version>.zip` → Pull. It brings the classes, the write report
   and the SICF nodes `/sap/bc/zmcp_cust` and `/sap/bc/zmcp_diag`.
2. **Check that it compiled**: abapGit activates what it can and does not stop on a syntax error.
   Open `ZCL_MCP_CUST_ENGINE` in SE24 / ADT and run a syntax check, or call the engine (step 4).
3. **SICF** (`/sap/bc/zmcp_cust`): active; Logon Data → Procedure "Standard" (it includes SSL
   client certificates), no service user. Leave "Required with" logon data empty, so the caller's
   own logon counts.
4. **Verify the identity** with the `whoami` action (read-only, reads nothing from the database):

   ```
   POST https://<host>:<https port>/sap/bc/zmcp_cust/whoami?sap-client=<client>
   {}
   ```

   With basic authentication it answers `BASIS on CAR/600, logged on by basic authentication,
   over TLS`; through the chain it must say `<the user> on <SID>/<client>, logged on by X.509 client
   certificate, over TLS`. Every action has its own path (`/sap/bc/zmcp_cust/<action>`), which is
   what the OpenAPI description uses.

## Part 6: checks end to end

| Check | Expected |
|---|---|
| Agent calls the `whoami` tool | the user who signed in to the agent, "logged on by X.509 client certificate" |
| A read tool (`bw_capabilities`, `ddic_describe`, `read`) | data, within the user's authorizations |
| A write tool without `commit` | "DRY RUN — nothing written" |
| User without a mapping | HTTP 401 from SAP |
| No sign-in, forged or expired token | the gateway refuses; SAP sees no request |
| Certificate from a CA SAP does not trust | TLS handshake refused |
| `SSL_CLIENT_CERT` header from a host not in `icm/trusted_reverse_proxy_<n>` | header ignored, 401 |
| Trusted proxy forwards a certificate of another CA for a mapped DN | 401, only if the mapping names the issuer |
| SM20 (Security Audit Log), if active | logons of the propagated users by certificate |

## Part 7: rehearsing it without BTP (what was tested)

`src/gateway/simulator.ts` stands in for the BTP side: an identity provider issuing RS256 tokens,
the gateway (an MCP server whose tools are the OpenAPI operations, refusing calls without a valid
token), and Cloud Connector (checks the token, issues a short-lived certificate from the subject
pattern, calls SAP either with that certificate or with its system certificate and the
`SSL_CLIENT_CERT` header). Scripts:

```bash
# test PKI: CA, Cloud Connector system certificate, a rogue CA for negative tests (openssl)
# SAP side on a lab system: status | apply | revert (trust in the PSE file with a backup, DN mapping)
ABAP_MCP_CONFIG=<cfg> node --require ts-node/register scripts/propagation/pp-setup.ts --connection CAR --user BASIS --pki <dir> --mode apply
# trusted reverse proxy in the running ICM (header mode): show | set | clear
ABAP_MCP_CONFIG=<cfg> node --require ts-node/register scripts/propagation/pp-profile.ts --connection CAR --pki <dir> --mode set
# the chain end to end, direct (user certificate) or header (Cloud Connector's way)
node --require ts-node/register scripts/propagation/e2e.ts --pki <dir> --sap https://<host>:<port> --client 600 --user BASIS --mode direct
# back to the original state
ABAP_MCP_CONFIG=<cfg> node --require ts-node/register scripts/propagation/pp-setup.ts --connection CAR --user BASIS --pki <dir> --mode revert
```

Result on CAR (BASIS) and S4 (GEERT; after S4's clock fix without `--skew-minutes`), 8 of 8 in both modes each: the user signed in at the identity provider reached SAP as
that user, logged on by X.509 client certificate over TLS; a read and a dry-run write worked
through the gateway's tools (the write: a customizing copy of units of measure, KG to ZZ9, without
commit); missing, forged and expired tokens were refused by the gateway; a
user without a mapping got 401 from SAP; a certificate from an untrusted CA was refused (direct
mode: in the TLS handshake; header mode: 401, once the mapping named the issuer, see part 3).
Header mode is what Cloud Connector does: the simulator connects with its system certificate and
forwards the user's certificate in `SSL_CLIENT_CERT`; ICM trusted it through
`icm/trusted_reverse_proxy_0`, set in the running ICM only (`scripts/propagation/pp-profile.ts`,
`ICM_SET_VECTOR_PARM`) and cleared afterwards. Without that entry SAP ignored the header (401).
The lab system was put back to its original state after each run: PSE file restored byte for
byte from the backup, mappings removed, trusted-proxy entry cleared.

### The permanent test set-up on CAR and S4 (since 19 November 2026)

CAR (client 600, user BASIS) and S4 (A4H client 250, user GEERT; redone from this guide) keep the
rehearsal chain in place, so the simulator works any time. On CAR:

| What | Where | Undo |
|---|---|---|
| "MCP Test CA" trusted for client certificates | SSL server PSE file `/usr/sap/CAR/D01/sec/SAPSSLS.pse`; original bytes in `SAPSSLS.pse.mcp-pp-backup` next to it | `pp-setup.ts --mode revert` restores the file from the backup |
| `CN=BASIS, O=MCP Simulation, C=BE`, issuer "MCP Test CA" → BASIS | VUSREXTID (type DN) | `pp-setup.ts --mode revert` |
| Cloud Connector simulator as trusted reverse proxy | instance profile `/usr/sap/CAR/SYS/profile/CAR_D01_sapcar` (2 lines appended, backup `CAR_D01_sapcar.mcp-pp-backup`) and the running ICM | `pp-profile.ts --mode removefile` |
| Test keys (CA, Cloud Connector, rogue CA; valid until November 2028) | `~/.abap-config-mcp/pp-test-pki` on the Mac, owner-only | delete the folder after the undo steps |

On S4 the same three changes, with its own paths and user:

| What | Where | Undo |
|---|---|---|
| "MCP Test CA" trusted | `/usr/sap/A4H/D88/sec/SAPSSLS.pse`, backup `SAPSSLS.pse.mcp-pp-backup` | `pp-setup.ts --connection S4 --user GEERT --mode revert` |
| `CN=GEERT, O=MCP Simulation, C=BE`, issuer "MCP Test CA" → GEERT | VUSREXTID (type DN) | same |
| Cloud Connector simulator as trusted reverse proxy | `/usr/sap/A4H/SYS/profile/A4H_D88_s4hana2025` (backup `.mcp-pp-backup`) and the running ICM | `pp-profile.ts --connection S4 --mode removefile` |

S4's clock ran about two hours ahead until 2026-11-20, when chronyd was enabled on the host; since then
its test runs pass without `--skew-minutes`. Stepping a host's clock back has side effects: restart
`sapstartsrv` (sapcontrol `RestartService` per instance) and `saphostexec -restart`, and on a host
reached over ZeroTier restart `zerotier-one`, whose peer timestamps otherwise lie in the future and
leave the host unreachable. Its RZ10 copy
(`A4H_D88_S4HANA2025`, newest version 5) is behind the file as well: one `icm/server_port` line
against three in the file; the RZ10 note below applies to S4 too.

Whoever holds `ca.key` or `cc.key` from that folder can log on to CAR as BASIS without a password:
keep it private, and remove the set-up when the rehearsal is no longer needed:

```bash
ABAP_MCP_CONFIG=<cfg> node --require ts-node/register scripts/propagation/pp-profile.ts --connection CAR --pki ~/.abap-config-mcp/pp-test-pki --mode removefile
ABAP_MCP_CONFIG=<cfg> node --require ts-node/register scripts/propagation/pp-setup.ts --connection CAR --user BASIS --pki ~/.abap-config-mcp/pp-test-pki --mode revert
```

What can undo it without anyone running those:

- **A Let's Encrypt renewal** that rewrites `SAPSSLS.pse` (the current certificate runs until
  12 February 2027) drops the test CA: run `pp-setup.ts --mode apply --no-proxy` again afterwards.
  The backup it keeps is then out of date; delete `SAPSSLS.pse.mcp-pp-backup` first so a new one
  is taken.
- **RZ10**: its database copy of the instance profile (`CAR_D01_SAPCAR`, version 2) is already
  behind the file (it has `icm/server_port_0` only, not the HTTPS port). Activating that copy would
  overwrite the file and drop both the HTTPS port and the trusted proxy. Import the file into RZ10
  (Utilities → Import profiles of active servers) before maintaining the profile there.

## Troubleshooting

| Symptom | Cause found |
|---|---|
| 401 "Anmeldung fehlgeschlagen" / "Logon failed" with a valid certificate | DN in VUSREXTID without the space after each comma; or no mapping; or CERTRULE on (then VUSREXTID is ignored) |
| TLS handshake fails, curl exit 35 | client certificate's CA not in the SSL server PSE; or (client side) the host name is not the one in SAP's server certificate |
| 401 through Cloud Connector, direct mTLS works | `icm/trusted_reverse_proxy_0` missing or its SUBJECT/ISSUER do not match the system certificate exactly |
| RZ11: "Parameter not found" for `icm/trusted_reverse_proxy_0` | it is not in any profile yet: add it in RZ10, or change it in the running ICM (SMICM) |
| Certificates of any CA log on behind Cloud Connector | the mapping is by DN only; add the issuer (part 4) or use CERTRULE |
| ICM trace: "PSE does not exist" after a STRUST action | file-only SSL server PSE wiped by a database sync (part 3, note) |
| "certificate expired" (TLS alert 45) for a certificate issued seconds ago | the ABAP system's clock is ahead of Cloud Connector's (S4: two hours); sync both with NTP |
| Engine answers 500 "Syntax error in program ZCL_MCP_CUST_ENGINE" | abapGit pulled a version that does not compile on this release; check the syntax and pull a fixed one |
| The agent's calls all run as one technical user | the destination is not PrincipalPropagation, or the agent sends a client-credentials token |
