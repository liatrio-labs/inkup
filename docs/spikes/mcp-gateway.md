# Spike: what a self-hosted MCP gateway needs from an upstream

Date: 2026-10-20. No gateway container was started. Nothing below is marked observed.

The question is what an upstream MCP server such as the InkUp Host must offer so a self-hosted MCP gateway such as
Obot can sit in front of an AI client. The Host already serves Streamable HTTP at `/mcp`. Off loopback it expects
`Authorization: Bearer` with an agent token (ADR 0006). `watch_items` may block for up to 600 seconds.
`get_screenshot` returns MCP image content. This page does not choose a gateway. Any gateway that speaks Streamable
HTTP and forwards a header is enough.

## How a claim is labeled

- **documented**: the current public user docs say it. The live site identifies itself as Obot docs v0.27.0. Pages
  were fetched on 2026-10-20 and each returned HTTP 200.
- **source**: public code at a pinned commit, or a unit test in that tree. It was read, not executed here.
- **unknown**: the docs and the code that was read do not say, or a cited URL could not be fetched.

Obot source is `obot-platform/obot` commit `a6070110d55b67681945f1a34d3f6376f297b0cd` (2026-10-20, the v0.27 docs
release). The composite runtime that commit depends on is `github.com/obot-platform/mmmcp`
`v0.2.1-0.20261019204352-e619b4f7dc01`. Older versioned docs (v0.24 and v0.26) are cited only where the current
pages no longer say the same thing. Full URLs are in [Sources](#sources).

## Results

| Topic | Result | Label |
| --- | --- | --- |
| Transport the gateway accepts for a remote server | HTTP Streaming, which the same docs treat as Streamable HTTP. A legacy SSE-only endpoint is not enough for a vMCP. stdio is only for a server the gateway runs itself | documented |
| Transport clients get | Streamable HTTP at `https://<gateway>/mcp-connect/<vmcp-id>` | documented |
| Static upstream header, including a secret-backed one | An admin sets headers on the remote entry. `Authorization` is the documented example. A Kubernetes Secret can supply the value. The value is sent as written, so an agent token has to be `Bearer <token>` | documented |
| Per-user upstream header | Provided at connection, or `multiUserConfig.userDefinedHeaders` on a legacy multi-user entry. One shared token or one token per user both fit | documented |
| MCP OAuth to the upstream | Spec-conformant remote OAuth works, including a pre-registered client id and secret. The client receives a gateway token. Upstream credentials stay on the gateway. That flow does not carry an already-issued InkUp agent token | documented |
| End-user identity on the upstream | Not described for a remote upstream. The gateway source that was read does not set a user header. A separate proxy project is sometimes cited for identity headers; its repository returned HTTP 404, so that behavior is unverified | unknown |
| `clientInfo.name` the upstream sees | Not in the user docs. With forwarding on, the composite's unit test shows the connecting client's name and version. If that identity is missing, the configured fallback is `Obot MCP Gateway` | source |
| Private, loopback, and link-local upstreams | Refused by default. An admin can turn each check off. The gateway docs also describe an MCP tunnel. A tunnel on the Host's machine that dials 127.0.0.1 is a local peer and needs no token | documented; local peer is source |
| Tool-call timeout (`watch_items`, up to 600 s) | No user-doc deadline for a tool call. The proxy's HTTP client timeout is unset, and the composite treats a non-positive server timeout as no deadline. Whether an ingress cuts the call is unknown | source; ingress unknown |
| Response size (`get_screenshot`) | No user-doc cap. A 10 MiB hook body limit can apply to a message the hook reader buffers, including a non-streaming response when hooks run. It is not a general request cap. A database limit was not found | source; storage unknown |
| Audit of requests and responses | The gateway records MCP requests and responses, including full payloads for the Auditor role. A screenshot or a transcript excerpt in a tool result is stored. Application-level encryption is off by default. Retention defaults to 90 days | documented |

## Transport

Clients connect to a virtual MCP (vMCP), one URL for the tools an admin selected. The connect guide says the endpoint
uses Streamable HTTP, in the form `https://<gateway>/mcp-connect/<vmcp-id>`. Copy the URL from the gateway rather than
building it. API-key clients use that same HTTP endpoint with their own `Authorization` header; that header
authenticates the client to the gateway, not the gateway to the upstream.

A remote catalog entry is for a server that already runs somewhere else. The current page says servers that are HTTP
Streaming compatible should be configured this way, and that the gateway proxies the connection rather than deploying
or sandboxing that service.

Hosted containerized servers, which the gateway runs itself, must expose Streamable HTTP. The hosting guide says
legacy HTTP+SSE (separate SSE and POST endpoints) is deprecated, and that a legacy SSE-only endpoint is not sufficient
for a vMCP. Streamable HTTP can still use SSE to stream a response. Hosted `npx` and `uvx` servers run via stdio; the
client still connects to the vMCP over Streamable HTTP. v0.26 docs said those stdio servers use a transport adapter
inside their workload. The current hosting page does not repeat "transport adapter". It still says they run via
stdio. v0.26 also said every server is exposed as `streamable-http` whatever its runtime. That sentence is not on the
current overview page. The current connect guide still says the client endpoint uses Streamable HTTP.

The Host already serves Streamable HTTP at `/mcp` (`host/crates/server/src/mcp.rs`). No new MCP transport is required.
A remote entry is the match. Packaging the Host as a container the gateway runs is not required.

Tool search on a vMCP is off by default, so clients list and call the upstream tools directly. If an admin turns it
on, clients see `search_tools` and `call_tool` instead, and `watch_items` and `get_screenshot` are reachable only
through that search-then-call workflow.

## Auth to the upstream

The docs describe configured headers and MCP OAuth. Only a configured header can carry an InkUp agent token.

A remote entry takes custom HTTP headers. The Git catalog schema uses `remoteConfig.fixedURL` (or `hostname`) and
`remoteConfig.headers`, with `key: Authorization` and `sensitive: true`, and an optional Kubernetes `secretBinding`.
The public catalog rules say credentials must not be interpolated into `fixedURL` or a URL template. On a vMCP, each
remaining field is Preconfigured (one value for every connection), Provided at connection (each user supplies their
own), or Ignore. User-provided headers stay isolated per connection and do not need a separate deployment. A legacy
multi-user catalog entry can declare `multiUserConfig.userDefinedHeaders` for the same split. Secret bindings exist
only on the Kubernetes backend, and a remote runtime binds the secret to an outbound header rather than to an
environment variable.

The gateway sends that header value as written. ADR 0006 says a remote peer must send `Authorization: Bearer` and a
known agent token. The configured value therefore has to be `Bearer <token>`, scheme included, whether an admin
preconfigures it or a user types it at connection. One shared token and one token per user both fit. A shared token
makes every person the same agent to the Host.

The caller's gateway credential is not that token. **source**: the proxy deletes `Authorization`, `Cookie`,
`Proxy-Authorization`, and `X-API-Key` on the way out, then adds the headers configured for the upstream. A static
header replaces a passthrough header of the same name. The composite config for a vMCP does not attach the frontend
`Authorization` header to component connections. The comment on that config says a pooled session would otherwise
replay a header after the request that opened it had expired. Those component URLs are the gateway's own local
connect URLs; the second hop applies the remote entry's headers. User docs do not describe the passthrough list, and
this spike did not find an admin control for it in the v0.27 task pages. That control is **unknown**. It is not a way
to pass an InkUp token.

MCP OAuth is the other documented path. Remote servers that conform to the MCP authentication schema work out of the
box. Static OAuth lets an admin register one client id and secret; each user still signs in. Clients receive gateway
tokens, and upstream credentials stay with the gateway. An InkUp agent token is a static bearer secret (ADR 0006),
not an access token from an authorization server the Host implements, so this flow does not accept that secret as the
upstream credential. v0.24 docs described RFC 8693 token exchange in an older shim, including forwarding the original
bearer unchanged. Those sentences are not on the current architecture page, and the current proxy deletes the inbound
`Authorization` header. Do not rely on the v0.24 description.

## Identity

**unknown** in the user docs, for a remote upstream.

The gateway identifies the Obot user for its own access checks and audit records. The architecture page says clients
receive Obot tokens and that upstream OAuth credentials remain with Obot. It does not say the end user's id, email,
or name is forwarded to a remote MCP server, and it does not describe an assertion the upstream could verify.

**source**: a search of `obot-platform/obot` at the pinned commit found no `X-Forwarded-User`. The proxy sets
`X-Forwarded-Host` and `X-Forwarded-Proto`, and drops them when the inbound host is loopback. Those are not a user
identity.

A separate project, `obot-platform/mcp-oauth-proxy`, is sometimes described as injecting user headers onto the
upstream request. On 2026-10-20, `https://github.com/obot-platform/mcp-oauth-proxy` returned HTTP 404 to an anonymous
request, so that description is **unverified**. It is also a different program from the gateway. An upstream should
not trust an unsigned identity header. The check the Host already has is the agent token.

If each user has their own agent token in a Provided-at-connection header, the Host can tell those tokens apart. A
single preconfigured token cannot. The user recorded in the gateway's audit log is not that token.

## `clientInfo.name`

**source**. Not in the user docs, and not observed on a running gateway.

`start_item` records the agent's name from `clientInfo.name` on MCP `initialize` (ADR 0021). The composite is built
with client-identity forwarding on, and with a fallback name of `Obot MCP Gateway` when the frontend identity is
missing. The HTTP component client uses the forwarded identity when the request context has one.
`TestCompositeUpstreamClientIdentity` connects two clients, named `first-client` and `second-client`, and fails if
the upstream tool does not observe that same name and version.

A Resolution on an MCP connection should therefore be named after the AI client, whatever that client sends, not
after the Obot user. A gateway-initiated connection with no frontend identity uses `Obot MCP Gateway`. Reuse of one
MCP connection across two clients of one Obot user was not checked beyond that unit test, which uses a fresh
composite for each connection.

## Network reach

**documented.** By default the gateway refuses an upstream on localhost, a private IP, or a link-local address. The
switches, each defaulting to disallow, are `OBOT_SERVER_DISALLOW_LOCALHOST_MCP`,
`OBOT_SERVER_DISALLOW_PRIVATE_IPMCP`, and `OBOT_SERVER_DISALLOW_LINK_LOCAL_MCP`. The configuration reference says to
set one to `false` only when the gateway runtime is supposed to reach that class of address. The remote-server page
says not to turn the checks off globally just to reach an arbitrary endpoint. **source**: the proxy client applies
the same three blocks.

The gateway docs also describe an MCP tunnel for an upstream the gateway cannot route to. An `obot tunnel` process
on a machine that can see the server opens an outbound WebSocket to the gateway and forwards HTTP and streaming
responses to an allow-listed URL. It is not a general TCP tunnel. For a tunneled target the localhost, private, and
link-local checks do not apply, because the tunnel machine dials the server. The catalog URL has to be an exact URL
or hostname. A URL template cannot be combined with a tunnel. The tunnel's allowed-URL list is the boundary. The
security notes say forwarded MCP headers may contain credentials, and that the CLI should run only on a trusted
machine because it makes the final request to the destination. That machine handles the upstream
`Authorization: Bearer` value, so it has to be trusted with the agent token. The CLI log does not record header
values. That is what the gateway documents. It is not a recommendation to run the tunnel beside the Host.

**source**, `host/crates/server/src/guard.rs`. A peer is local when its address is loopback. `peer` sets `remote`
only when `every_peer_is_remote` is set or the address is not loopback (`guard.rs:86`). `every_peer_is_remote` is a
test-only field on `Config` (`host/crates/server/src/lib.rs`: "Treat every peer, loopback too, as another machine.
Tests only"). It is not a user-facing flag. The default is false, and the CLI does not set it. A tunnel or a gateway
on the Host's machine that connects to 127.0.0.1 is that loopback peer. `/mcp`, `/api/*` and `/blobs/*` then need no
token. The control API (`/api/host` and below) is refused when the peer is remote or the request has an `Origin`
header (`guard.rs:50`), so a loopback request with no `Origin` is accepted. A same-machine tunnel exposes that
unauthenticated local surface, including the control API. What to do about it belongs to ADR 0030 (#111). This page
does not propose a fix, and it does not suggest placing a tunnel next to the Host to make the peer remote.

A caller on another machine, whose address is not loopback, is a remote peer. Then `/mcp`, `/api/*` and `/blobs/*`
need `Authorization: Bearer` (ADR 0006). The `Host` header still has to be one of the names that ADR allows.

## Limits

**Tool calls.** User docs do not state a request timeout or an idle timeout for an MCP tool call. **source**: the
OAuth helper client uses 30 seconds, and its comment limits that client to metadata, registration, and token
calls, not to tool calls. The proxy calls its upstream HTTP client with no timeout, which means no deadline. The
composite config does not set a per-server timeout, and the composite leaves the context alone when that timeout is
missing or zero.

A code search of `obot-platform/obot` for `WriteTimeout` and `ReadHeaderTimeout` returned no matches. That is not
proof that no server deadline exists. Whether the process, or a reverse proxy in front of it, cuts a long response
is **unknown**. The tunnel guide tells operators to check idle timeouts on the tunnel WebSocket. It does not state
an MCP tool-call limit.

`watch_items` waits up to 600 seconds (`MAX_WATCH_SECONDS` in `host/crates/server/src/mcp.rs`). Nothing in the
gateway docs promises that a 600 second tool call completes. The source that was read adds no deadline of its own.
Survival of that call was not observed.

**Response size.** User docs do not state a cap on MCP response bodies or on image content. `get_screenshot` returns
one base64 image block. **source**: `maxMCPProxyHookBodySize` in `proxy_hooks.go` is `10 << 20` (10 MiB), at line 23.
`readMCPHookBody` rejects a buffered message over that size with "MCP message exceeds N byte hook limit". It is a
hook body limit, not a general request limit. The audit reader uses the same constant when it buffers a request.
When hooks are enabled, `filterResponse` reads a non-streaming response through `readMCPHookBody`, so the same limit
can apply to a response. An SSE response is not passed through that whole-body read. When hooks are disabled,
`filterResponse` returns without reading the body, and the audit wrapper copies the response with no size check.
Whether the database rejects a large audit row was not determined, so a practical cap beyond the hook path is
**unknown**. A `get_screenshot` request is small. A large image in the response hits the hook limit only when that
response is read through it.

## Audit

**documented.** Audit logs capture the MCP requests and responses that flow through the gateway: the operation, the
user, the time, and the server. The detailed view includes the full payloads and headers for the Auditor role. Admin
and Owner see metadata only. Retention defaults to 90 days (`OBOT_SERVER_MCPAUDIT_LOG_RETENTION_DAYS`).
Application-level encryption is disabled by default. When an admin turns an encryption provider on, it covers
selected fields, including sensitive audit payloads, and it does not encrypt entire records.

A `get_screenshot` result is image content in the response payload, so the image lands in that store, readable by an
Auditor, and unencrypted unless an admin configures encryption. Transcript excerpts inside `read_items` or
`watch_items` results land there the same way. The Host cannot keep a tool result out of the gateway's audit log
once the call goes through the gateway.

**source**: `sanitizedMCPHeaders` in `proxy_audit.go` writes `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`,
`X-Auth-Token`, and `Proxy-Authorization` as `[REDACTED]`. Other headers are copied. Request and response bodies are
not passed through that function, so the payloads stay in the log after those credential headers are blanked. The
agent token in `Authorization` is not in the stored headers. A screenshot in the tool result still is.

## What was not run

The optional local check, the public gateway image against `inkup serve` on loopback, was not run. `clientInfo.name`,
a 600 second `watch_items`, and the image-size behavior are therefore not observed. The gateway refuses a loopback
upstream unless `OBOT_SERVER_DISALLOW_LOCALHOST_MCP=false`, or a tunnel dials that URL. A tunnel on the Host's
machine is the local peer in [Network reach](#network-reach), not a remote one.

## Inputs to ADR 0030 (#111)

This page records what the gateway docs and the current Host do. It does not choose a deployment. ADR 0030 (#111)
is the decision. The facts that decision has to weigh:

- The Host already serves Streamable HTTP at `/mcp`. A remote catalog entry is that transport. The gateway docs use
  stdio, and a legacy SSE-only endpoint, for other shapes of server.
- When the peer is another machine, an agent token is a configured `Authorization` header whose value is
  `Bearer <token>`. Preconfigured is one shared token. Provided at connection is one token per user. A Kubernetes
  Secret can hold the value. The public catalog rules keep the token out of the URL. The client's gateway credential
  and MCP OAuth do not present an InkUp agent token. The Host does not implement MCP OAuth.
- The gateway docs do not give the upstream a signed end-user identity. Per-user agent tokens are the split the Host
  can already see. An unsigned user header is not that check.
- In the source that was read, `clientInfo.name` on an MCP connection is the AI client's name, and
  `Obot MCP Gateway` when the gateway has no frontend identity. ADR 0021 names a Resolution from that field. This
  was not captured on a running gateway.
- A same-machine tunnel or gateway that dials 127.0.0.1 is a local peer. It opens the unauthenticated local surface
  (`/mcp`, `/api/*`, `/blobs/*` with no token, and the control API when the request has no `Origin`). Running a
  tunnel beside the Host does not make that peer remote. The tunnel machine makes the final request, and forwarded
  headers may carry the agent token, so that machine has to be trusted with it.
- A peer that is not loopback is remote use, and it runs past limits ADR 0006 already sets:
  - Network mode is plaintext HTTP and WebSocket, with no TLS. Everything on the path can read it.
  - It is for a trusted LAN only.
  - The `Host` header allowlist is small. Loopback names on the Host's own port are served. In network mode,
    `serves_name` also admits the `.local` names this Host could hold (its base name, and `-2` through `-5`) and its
    own LAN IPv4 addresses. Any other name is refused (`guard.rs`, ADR 0006).
- The gateway code that was read sets no tool-call deadline, so a 600 second `watch_items` can still be cut by
  something in front of the gateway.
- A proxied `get_screenshot`, and transcript excerpts in `read_items` or `watch_items`, are stored in the gateway
  audit log. `Authorization` and the other credential headers `sanitizedMCPHeaders` lists are stored as
  `[REDACTED]`. The payloads are not.

## Sources

User docs, each HTTP 200 on 2026-10-20:

```text
https://docs.obot.ai/mcp-gateway/connect-clients/
https://docs.obot.ai/start-here/connect/
https://docs.obot.ai/mcp-gateway/register-remote/
https://docs.obot.ai/mcp-gateway/server-types/
https://docs.obot.ai/concepts/mcp-hosting/
https://docs.obot.ai/concepts/architecture/
https://docs.obot.ai/architecture/request-flows/
https://docs.obot.ai/configuration/mcp-server-gitops/
https://docs.obot.ai/configuration/mcp-server-oauth-configuration/
https://docs.obot.ai/configuration/server-configuration/
https://docs.obot.ai/functionality/mcp-servers/
https://docs.obot.ai/functionality/mcp-tunnels/
https://docs.obot.ai/security/audit-data/
https://docs.obot.ai/security/isolation/
https://github.com/obot-platform/mcp-catalog/blob/main/AGENTS.md
```

Pinned source. The `obot` links are commit `a6070110d55b67681945f1a34d3f6376f297b0cd`. The `mmmcp` links are commit
`e619b4f7dc01d6794af157ee62d4ed982a5f97e4`.

```text
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/api/handlers/mcpgateway/handler.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/api/handlers/mcpgateway/handler_test.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/api/handlers/mcpgateway/proxy_audit.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/api/handlers/mcpgateway/proxy_hooks.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/mcp/backend.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/mcp/http.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/pkg/mcp/client.go
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/docs/versioned_docs/version-v0.26.0/concepts/mcp-gateway.md
https://github.com/obot-platform/obot/blob/a6070110d55b67681945f1a34d3f6376f297b0cd/docs/versioned_docs/version-v0.24.0/concepts/architecture.md
https://github.com/obot-platform/mmmcp/blob/e619b4f7dc01d6794af157ee62d4ed982a5f97e4/options.go
https://github.com/obot-platform/mmmcp/blob/e619b4f7dc01d6794af157ee62d4ed982a5f97e4/component/http/client.go
```

Unverified, HTTP 404 to an anonymous request on 2026-10-20:

```text
https://github.com/obot-platform/mcp-oauth-proxy
```
