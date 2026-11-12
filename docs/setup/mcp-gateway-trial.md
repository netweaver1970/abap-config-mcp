# Testing the engine behind SAP's MCP Gateway, from a system that isn't on the internet

This guide sets up a test of phase 4 of [spec 001](../specs/001-two-constellations.md): an AI
client calls the customizing engine through SAP's MCP Gateway in Integration Suite, and the call
reaches an SAP system that is not reachable from the internet. It answers one question: does the
call arrive in SAP as the person who made it?

The engine's ping makes that visible. It replies with a line like
`MCP Customizing Engine alive on A4H client 250, running as user GEERT`.

```
AI client  ──OAuth──▶  MCP Gateway (BTP trial)  ──▶  Cloud Connector (your machine)  ──▶  SAP system
                                                        outbound tunnel only
```

Part 1 proves the path with a basic-auth user. Part 2 switches to principal propagation, where
your own identity becomes your SAP user. Plan half a day for part 1 and most of a day for part 2.

## Before you start

- An SAP system your machine can reach, with the engine at version 0.9.36 or later and its ICF
  node `/sap/bc/zmcp_cust` active. `customizing_engine_ping` in direct mode shows both.
- Your own SAP user on it, and for part 2 an administrator who can use STRUST, the profile
  parameters and CERTRULE (on a sandbox, that's usually you).
- Java 17 or 21 (SapMachine works) for the Cloud Connector.

Things that change from release to release, so check them on the way rather than trusting this
guide: which BTP trial regions offer Integration Suite, where the MCP server capability sits in
Integration Suite, whether the trial includes the Integration Cell runtime the gateway needs, and
whether the portable Cloud Connector exists for your processor (on Apple Silicon, a small Linux
VM is the fallback).

## Part 1: the path, with a basic-auth user

### 1. BTP trial and Integration Suite

1. Create a trial account at <https://account.hanatrial.ondemand.com>, in a region that offers
   Integration Suite.
2. In the subaccount, subscribe to Integration Suite (trial plan) and assign yourself the
   provisioning role collection it asks for.
3. Open Integration Suite and add the capability that offers MCP servers (SAP's help:
   [Model Context Protocol](https://help.sap.com/docs/integration-suite/isuite-integrations-and-apis/model-context-protocol-mcp)).
   Note the subaccount ID and region; the Cloud Connector needs them.

### 2. Cloud Connector on your machine

1. Download the portable Cloud Connector from <https://tools.hana.ondemand.com/#cloud> and start
   it (`go.sh`). The admin page is <https://localhost:8443>; change the initial password.
2. Connect it to your subaccount (region, subaccount ID, your BTP user). Give it a location ID,
   for example `mac`.
3. Add a system mapping, cloud to on-premise:
   - back-end type ABAP System, protocol HTTP, internal host and port of your SAP system;
   - a virtual host and port, for example `s4-engine:8088`; this is the only name BTP sees;
   - principal type None for now.
4. Add one resource to that mapping: URL path `/sap/bc/zmcp_cust`, path and all sub-paths.
   Nothing else on the SAP system is exposed.

### 3. Destination

In the BTP subaccount, Connectivity, Destinations, create:

| Field | Value |
| --- | --- |
| Name | `S4_ENGINE` |
| Type | HTTP |
| URL | `http://s4-engine:8088/sap/bc/zmcp_cust` (the virtual host) |
| Proxy type | OnPremise |
| Location ID | `mac` |
| Authentication | BasicAuthentication, your own SAP user and password |
| Additional property | `sap-client` = your client |

The connectivity check should report the Cloud Connector as reachable.

### 4. The MCP server in Integration Suite

1. Create an MCP server from an HTTP endpoint, with destination `S4_ENGINE`
   ([SAP's help](https://help.sap.com/docs/integration-suite/isuite-integrations-and-apis/create-mcp-server-from-http-endpoint)).
2. Upload [engine-ping.openapi.yaml](engine-ping.openapi.yaml). It describes one operation, so
   the gateway offers one tool, `engine_ping`.
3. Deploy it and note the MCP endpoint URL.

### 5. Connect an AI client and call it

1. Subscribe to the MCP server in the developer hub to get OAuth credentials
   ([consuming MCP servers](https://help.sap.com/docs/integration-suite/isuite-integrations-and-apis/consuming-mcp-servers)).
2. Add it to your AI client as a remote MCP server with that endpoint and OAuth. For Claude, SAP
   documents the redirect URI `https://claude.ai/api/mcp/auth_callback`.
3. Ask the client to run `engine_ping`.

Expected: `… running as user <the user in the destination>`. That proves the tunnel and the
gateway, but not yet the person: every caller still arrives as that one user.

## Part 2: your own user, through principal propagation

The Cloud Connector turns the caller's identity into a short-lived X.509 certificate, and the
SAP system maps that certificate to an SAP user. This needs HTTPS on the SAP side.

1. **Cloud Connector certificates.** Under Configuration, On Premise, set a system certificate
   and a CA certificate for principal propagation (the Cloud Connector can create self-signed ones
   for a test). Under the principal propagation settings, set the subject pattern, for example
   `CN=${name}`.
2. **SAP trusts the Cloud Connector.** In STRUST, import the Cloud Connector's CA certificate
   into the SSL server PSE. Set `icm/HTTPS/verify_client = 1`, and tell the ICM to trust the
   Cloud Connector's system certificate as a reverse proxy:
   `icm/trusted_reverse_proxy_0 = SUBJECT="<system certificate subject>", ISSUER="<its issuer>"`
   (on older releases, `icm/HTTPS/trust_client_with_subject` and
   `icm/HTTPS/trust_client_with_issuer`). Restart the ICM.
3. **Certificate to user.** In CERTRULE, map the subject `CN=<your BTP user name>` to your SAP
   user.
4. **Mapping and destination.** Change the Cloud Connector system mapping to HTTPS with principal
   type X.509 Certificate, and the destination's authentication to PrincipalPropagation (no user
   or password).
5. Call `engine_ping` again.

Expected: `… running as user <your SAP user>`, mapped from your own identity, with no password
anywhere in the chain. If it still shows a technical user, or the call fails with 401, the
propagation isn't arriving; SAP's own roadmap from July 2026 still listed end-to-end propagation
for the gateway as coming, so a failure here is a real finding, not necessarily a mistake.

## What this test doesn't cover

- The engine's other actions. In phase 4 the engine gets one path per action, so the gateway can
  offer each as a tool; this test only uses the ping.
- Payload size and timeout limits of the gateway, and how MCP calls are metered.
- Whether SAP sees a customer-namespace customizing writer behind its gateway as within FAQ
  questions 23, 27 and 35.

## Cleaning up

Disconnect the Cloud Connector from the subaccount, or stop it. The trial expires on its own. In
SAP, remove the CERTRULE mapping and the CA certificate from STRUST if you won't keep the set-up.
