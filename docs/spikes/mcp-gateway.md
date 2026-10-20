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
| Private, loopback, and link-local upstreams | Refused by default. An admin can turn each check off. The documented alternative is an MCP tunnel from inside the network | documented |
| Tool-call timeout (`watch_items`, up to 600 s) | No user-doc deadline for a tool call. The proxy's HTTP client timeout is unset, and the composite treats a non-positive server timeout as no deadline. Whether an ingress cuts the call is unknown | source; ingress unknown |
| Response size (`get_screenshot`) | No user-doc cap. The proxy rejects a request body over 10 MiB. The audit reader copies the response with no size check in the file that was read. A database limit was not found | source; storage unknown |
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

A Resolution on a user session should therefore be named after the AI client, whatever that client sends, not after
the Obot user. A gateway-initiated connection with no frontend identity uses `Obot MCP Gateway`. Session reuse across
two clients of one Obot user was not checked beyond that unit test, which uses a fresh composite for each connection.

## Network reach

**documented.** By default the gateway refuses an upstream on localhost, a private IP, or a link-local address. The
switches, each defaulting to disallow, are `OBOT_SERVER_DISALLOW_LOCALHOST_MCP`,
`OBOT_SERVER_DISALLOW_PRIVATE_IPMCP`, and `OBOT_SERVER_DISALLOW_LINK_LOCAL_MCP`. Set one to `false` only when the
gateway runtime is supposed to reach that class of address. The remote-server page says not to turn the checks off
globally just to reach an arbitrary endpoint. **source**: the proxy client applies the same three blocks.

The documented way to reach a server the gateway cannot route to is an MCP tunnel. An `obot tunnel` process on a
machine that can see the server opens an outbound WebSocket to the gateway and forwards HTTP and streaming responses
to an allow-listed URL. It is not a general TCP tunnel. For a tunneled target the localhost, private, and link-local
checks do not apply, because the tunnel machine dials the server. The catalog URL has to be an exact URL or hostname.
A URL template cannot be combined with a tunnel. The tunnel's allowed-URL list is the boundary.

A Host on loopback, or on a private address, is refused until an admin sets the matching flag or publishes it through
a tunnel. The Host's `every_peer_is_remote` flag does not change that. It only changes how the Host classifies
peers. A tunnel, or a gateway on another machine, is a remote peer, so the Host then requires an agent token
(ADR 0006). The URL's host must also be a name the Host accepts: a loopback name, or, in network mode, its `.local`
name or a LAN address.

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
one base64 image block. **source**: the proxy refuses a request body larger than 10 MiB (`10 << 20`) before it
forwards. A `get_screenshot` request is small. The audit wrapper copies the response body with no length check in
`proxy_audit.go`. Whether the database rejects a large audit row was not determined, so a practical cap is
**unknown**. A screenshot the Host returns is audited in full if that row is stored.

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

## What was not run

The optional local check, the public gateway image against `inkup serve` on loopback, was not run. `clientInfo.name`,
a 600 second `watch_items`, and the image-size behavior are therefore not observed. Reaching a loopback Host from
the gateway also requires `OBOT_SERVER_DISALLOW_LOCALHOST_MCP=false`, or a tunnel. The default refuses loopback.

## What this means for the Host

- Keep serving Streamable HTTP at `/mcp`. Do not add stdio, or a legacy SSE-only endpoint, for this gateway.
- Put the agent token in a gateway header named `Authorization` whose value is `Bearer <token>`. Preconfigured is
  one shared token. Provided at connection is one token per user. A Kubernetes Secret can hold the value. Do not put
  the token in the URL.
- Do not expect the client's gateway login, or MCP OAuth, to present an InkUp agent token. The Host does not
  implement MCP OAuth.
- Do not trust an unsigned user header. The agent token is the check. Per-user tokens are how the Host tells people
  apart.
- Expect `clientInfo.name` on a user session to be the AI client's name, and `Obot MCP Gateway` only when the
  gateway has no frontend identity. That name is what a Resolution shows. This is source, not a live capture.
- A Host on a private or loopback address is unreachable until an admin relaxes that check or runs a tunnel beside
  the Host. Off loopback the Host requires the token.
- Assume `watch_items` can still be cut by something in front of the gateway. The gateway code that was read sets
  no tool-call deadline.
- Assume `get_screenshot` bytes, and transcript excerpts, are stored in the gateway audit log.

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
