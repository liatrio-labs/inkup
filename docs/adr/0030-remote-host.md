---
status: accepted
date: 2026-10-20
supersedes: the loopback-only MCP trust in 0005
---

# A Remote Host is reached only at an https public URL, every peer needs a token, and a Client pairs by code

A reviewer can run the Host off their own machine and still hand Change Items to a coding agent in the cloud. Loopback
(ADR 0005) binds 127.0.0.1 and lets MCP in with no token, so a reverse proxy or a gateway on the same machine is let
in. Network mode (ADR 0006) is HTTP without TLS on a trusted LAN, found by a `.local` name. A cloud agent reaches
neither. InkUp's authors run no servers for it (PRODUCT.md): the user runs this Host. A self-hosted MCP gateway such
as Obot is how that agent reaches the Host's MCP. The rules below follow the findings of the #110 spike, recorded in
`docs/spikes/mcp-gateway.md` (#120). This ADR follows the findings of that spike. Where the spike says a claim is
unknown or unverified, this ADR does not rely on it.

**The term is Remote Host.** A Remote Host is a Host reached over HTTPS from other networks. It sits beside loopback
and Network mode, and those two keep the behaviour they have today. CONTEXT.md lists "Remote mode" and "server mode"
under Network mode's _Avoid_. #116 adds **Remote Host** to CONTEXT.md. The other name offered in
the epic, "Hosted mode", goes unused.

**One origin, Streamable HTTP, and the public URL is https.** MCP stays Streamable HTTP at `/mcp`
(`host/crates/server/src/mcp.rs`, `service`, rmcp). The Client WebSocket (`/ws`), `/blobs/*` and `/api/*` are served
on that same origin. Clients and agents are given only the configured public URL, and a Remote Host starts only
when that URL is `https://`. A self-hosted MCP gateway such as Obot exposes its clients over Streamable HTTP and takes a
remote upstream as Streamable HTTP, so the Host grows no second MCP transport.

**TLS ends at a reverse proxy or at the Host.** A reverse proxy is the usual end. The Host listens as HTTP on an
address the proxy can reach (loopback for a sidecar, or the container's own interface), and the proxy presents the
https URL. That listen address is not advertised. The Host can also terminate TLS itself, from a certificate and key
the user provides (#113). A Remote Host refuses to start when the public URL is `http://`. It does not treat
`X-Forwarded-Proto`, or any other forwarded header, as proof that TLS happened. The Pair link, the serve banner and
the address a Client stores all use the https public URL. Network mode stays unencrypted HTTP on a trusted LAN. The
TLS decided here is the TLS ADR 0006 deferred.

**Every peer is another machine, loopback included.** A reverse proxy, a gateway or a gateway's tunnel process on
the same machine connects from 127.0.0.1. Today `peer` in `host/crates/server/src/guard.rs` marks a loopback peer
local, so such a request reaches `/mcp`, `/api/*` and `/blobs/*` with no token check. The control API (`/api/host/*`)
refuses a local peer only when it sends an Origin header. A proxied request may send none, which leaves the control
token in `host.json` as that API's only check (ADR 0025). On a Remote Host every caller arrives that way, so this
ADR treats loopback as no boundary at all. A Remote Host sets `Config::every_peer_is_remote`, the switch that today
exists for tests. `/mcp`, `/api/*` and `/blobs/*` then need `Authorization: Bearer`, a paired Client's token or an
Agent token, from every address, 127.0.0.1 included. `/api/host/*` is refused to every peer. A request with no known
peer address still fails closed. `/ws` keeps its handshake: a hello without a token is answered
`pairing_code_required`, and a later hello carries the Client token.

**`/health` is reachable from the internet.** It stays open, with no token: a Client reads it before pairing, and
the container uses it as its health check (`host/crates/server/src/http.rs`, `health`). Anyone who can open the
public URL can read it. `inkup_protocol::health` (`host/crates/protocol/src/lib.rs`) adds `hub_name` when the config
has one. `hub_name()` in `host/crates/inkup/src/main.rs`, and the same function in
`apps/desktop/src-tauri/src/startup.rs`, builds `inkup on {host}` from the first label of the machine's hostname.
A Remote Host does not publish that name. It omits `hub_name`, or the operator sets one that is not the machine's
name. Loopback and Network mode keep `inkup on {machine}`.

**Forwarded headers are not credentials.** `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and the identity
headers `X-Forwarded-User`, `X-Forwarded-Email`, `X-Forwarded-Name` and `X-Forwarded-Access-Token` do not authenticate
a request and do not mark a peer local. The spike found no user identity forwarded to a remote upstream: the docs of
a self-hosted MCP gateway such as Obot don't describe one, and the gateway source it read sets no user header. A
separate proxy project is said to inject these identity headers, but its repository could not be fetched, so that
claim is unverified. Either way an unsigned header proves nothing. The Host ignores them for auth.

**The Host header admits the public host.** `host_allowed` keeps the loopback names, so a health check of
`127.0.0.1` still succeeds, and it also admits the public URL's host: that name alone, or that name with the public
URL's port. The process's bind port need not be in the header, because the proxy terminates TLS on 443 and dials the
Host on another port. rmcp's allowlist knows only loopback names, so a Remote Host turns it off the way `service`
already does when `network` is set (`disable_allowed_hosts`), and `guard.rs` remains the check. Any other host name
is refused. The Origin rule is unchanged: a web page Origin is refused, an extension origin is accepted, and a
missing Origin is accepted. The public site's Origin gains no exception.

**Agent tokens are the header the gateway sets.** An Agent token is made with `inkup token create --name <agent>`
(or the TUI's t key) and stored as SHA-256 (`agent_tokens`, `authenticate_agent` in
`host/crates/store/src/agents.rs`). The gateway sends it on the upstream as a configured `Authorization` header whose
value is `Bearer <token>`, scheme included, because the gateway sends the value as written. A self-hosted MCP
gateway such as Obot can set that header once for everyone (preconfigured, optionally from a secret) or once per
user, supplied when that user connects. One shared token and one token per user both satisfy the Host. Only per-user
tokens let the Host tell people apart. The caller's own credential for the gateway never reaches the Host: the
spike found the gateway drops the inbound `Authorization` header and adds the configured one. The token goes in a
header, never in the URL.

**Gateway identity and OAuth wait (#118).** Trusting an identity the gateway asserts, and speaking the MCP
authorization spec (the Host as an OAuth 2.1 resource server), are both deferred. The gateway can already sign its
users in and store upstream credentials for a remote server that speaks that spec, but that flow does not carry an
Agent token, which is a static secret and not an access token from an authorization server. Token exchange appears
only in older (v0.24) gateway docs, so this ADR does not rely on it. The Host has no accounts and no sign-in
(PRODUCT.md). Identity headers are not a documented property of a remote upstream, so they do not stand in for a
token. An Agent token already fits the headers the gateway documents.

**A Resolution names the Agent token.** `start_item` and `resolve_item` store `Resolution.agent` from
`clientInfo.name` (`agent_name` in `mcp.rs`), the name an MCP client reports about itself in `initialize`. Any caller
can send any string there. Through a gateway the spike found, from the gateway's source and unit test rather than
a live run, that on an MCP connection the upstream sees the AI client's own name and version, and `Obot MCP Gateway`
only when the gateway has no identity for the client. The string is usually informative, and it is self-reported. On a
Remote Host the Resolution is named for the Agent token that authenticated the request (`AgentToken.name`, set when
the Host's user made the token, checked on every request). `clientInfo.name` is stored beside it as the client's
description of itself. The card shows the token's name. With one shared token every Resolution shows the same name;
per-user tokens tell people apart. This settles the naming point open in #117. Loopback and Network mode keep ADR
0021, where `clientInfo.name` stays the agent's name.

**A Remote Host pairs only with a code the operator issued.** The maintainer chose this. A hello on the public URL
that carries no token and no code gets no code back: it does not call `PairingCodes::issue`. The operator runs
`inkup pairing` (#113) inside the container, or wherever the data dir is, and that command mints the one-time code,
prints it there, and sets its expiry and its own small guess budget. A hello with no Client token is
answered `pairing_denied`: the message says the code comes from the operator running `inkup pairing`. A dedicated
error code waits for #115, so this does not raise the protocol version (ADR 0007). The Client sends
`hello{pairing_code}`. The Pair link carries the public URL,
`inkup://pair?url=<https public URL>&code=<code>`. `--auto-approve-pairing` is
refused on a Remote Host, as it is with `--network` (`host/crates/inkup/src/main.rs`). Combined with the hidden test
flag `--print-pairing-codes` the process still starts, and even then a Client pairs only by a code the operator
issued. The extension offers a place to type that code before the Host asks for one (#115).

There is no pairing code obtainable or guessable from the public URL, so the per-IP flow is not reachable on a
Remote Host. `PairingCodes::issue` in `host/crates/server/src/pairing.rs` keys a waiting code by the peer's IP, and
a new hello from that address drops the code and resets its wrong-guess count. `issue_code` in
`host/crates/server/src/ws.rs` passes the peer's address. Behind a reverse proxy every caller shares that address,
so a hello from the public URL would let anyone wipe the reviewer's code and spend about 500,000 guesses on average
across the 6-digit space, five at a time. A headless Host also has nobody at the TUI to refuse a code. Network mode
keeps that flow, because there each peer address is one machine (ADR 0006).

**Evidence stays on a volume the user owns.** The store is `inkup.db` and `blobs/<id>` in the data dir
(`host/crates/store/src/lib.rs`). In the container that directory is a volume the user owns. `get_screenshot`
returns MCP image content and refuses a blob whose mime is not `image/`, so audio and video never travel over MCP.
The Client uploads them to `/blobs/*` with its token, over HTTPS. A gateway may keep MCP requests and responses in
its audit log. A self-hosted MCP gateway such as Obot does, with application-level encryption off by default. The
log blanks the `Authorization` header that carried the token, and still stores the response body, so a screenshot
from `get_screenshot` and the words on a Signal are kept. #116 says so in PRIVACY.md. The Host leaves
`get_screenshot` as it is.

**A proxy may stop a body the Host would still store.** `MAX_BLOB_BYTES` in `host/crates/server/src/http.rs` is
4 GiB. A reverse proxy often refuses a smaller body, and the audio or video upload then fails in front of the Host.
The operator raises the proxy's limit. The gateway's user docs state no cap on an image response. When hooks run,
the gateway can refuse a non-streaming response over 10 MiB (`maxMCPProxyHookBodySize`). That hook reads the
response as well as the request. An SSE response is not passed through that whole-body read, and with hooks off
the limit does not apply. The Host does not shrink screenshots to fit that hook. Whether the audit store rejects
a large row is unknown. `watch_items` waits up to 600 seconds (`MAX_WATCH_SECONDS` in
`mcp.rs`; the default is 120). The gateway source the spike read sets no tool-call deadline, but whether an ingress
or proxy in front cuts the call is
unknown, and a 600-second call was not observed. Every hop on the path to `/mcp` needs an idle timeout of at least
600 seconds, or a long watch ends as a transport error.

**One image, built from `host/`, with no self-update inside it.** #114 builds one container image from `host/`. It
runs `inkup serve` as a Remote Host, as a user other than root, with the data dir on a volume and `/health` as the
health check. ADR 0025's lock (`inkup_store::instance::HostLock` on `host.lock`) still means one Host per data dir,
in the container as anywhere else. ADR 0027's self-update does not run in the container. Replacing the image is how
it updates. Publishing the image from the release workflow is #119, and it waits. Until then the image is built
from source.

**These stay on the reviewer's machine.** A Remote Host closes `/api/host/*` to every peer, loopback included, so a
request forwarded by a proxy on 127.0.0.1, with or without an Origin header, never reaches the control API.
Loopback and Network mode keep the control API as ADR 0025 describes it. `inkup token` opens the store on the data
dir; it does not call `/api/host/*`. The TUI and the desktop app remain local front ends.
A Remote Host serves neither of them. mDNS, `.local` names and Find hubs stay Network mode (ADR 0006). A Remote Host
leaves mDNS off and leaves `--network` off. Model keys and Process stay in the browser (ADR 0016). Transcription
keys stay in the browser (`extensions/web/src/adapters/transcription/`, ADR 0014). The Host calls no model and
transcribes nothing.

**The extension keeps the port the URL had.** `normalizeAddress` (`extensions/web/src/adapters/host/discovery.ts`)
adds port 47823 when the typed URL has none, so an `https://` URL on the scheme's default port is stored with
`:47823` and the Client misses the Host. #115 keeps a port that was typed, including the scheme default, and leaves
an omitted port omitted. A paired Remote Host is labelled encrypted. `inkup mcp install` already accepts
`--remote https://…` (`host/crates/inkup/src/mcp_install.rs`).

## Considered options

- Network mode plus a VPN only. The Host stays on a private address and speaks unencrypted HTTP. A cloud agent joins
  that VPN only when someone arranges it. A self-hosted MCP gateway such as Obot refuses a loopback, private or
  link-local upstream unless an admin sets `OBOT_SERVER_DISALLOW_PRIVATE_IPMCP=false` (and the localhost and
  link-local equivalents). The https public URL is the address that needs none of that.
- Host-native TLS only. Every Remote Host would carry its own certificate, including one that already ends TLS at a
  proxy. The proxy is the path operators already have; the Host's own certificate is the other one (#113).
- A tunnel from the gateway instead of exposing the Host. The gateway documents a tunnel process inside the network
  that opens an outbound connection and forwards to an allow-listed URL, which satisfies the gateway's private-address
  check. The browser Client still needs an https URL to pair, and the tunnel is the gateway's feature, not a second
  transport on the Host. An operator may put a tunnel in front. The Host's contract remains the public https URL.
- Trusting gateway identity headers. No forwarded identity is documented for a remote upstream, the claim that a
  separate proxy injects such headers is unverified, and any peer can send them itself. A later proof would be a
  secret the Host holds. That decision is #118.
- Naming a Resolution by `clientInfo.name` alone, as ADR 0021 does. Through a gateway it is usually the AI client's
  own name, but it is self-reported. The Agent token's name is the one the Host authenticated.
- OAuth on the Host now. The MCP authorization spec would make the Host a resource server and give it accounts, which
  the product does not have. The gateway already carries an Agent token as a Bearer header. OAuth waits in #118.
- A pairing budget that a new hello does not reset (a Host-wide or per-code guess limit, a lockout, and the 2-minute
  expiry). Callers on the public URL would still be able to ask for a code. Behind a proxy they share one peer
  address, so that surface stays guessable, and a headless Host has nobody watching to refuse a code. The maintainer
  rejected it. Codes come only from `inkup pairing`.

## Consequences

- #112 runs the Host as a Remote Host. `guard.rs` sets `every_peer_is_remote` and `host_allowed` admits the public
  host. `mcp.rs` `service` calls `disable_allowed_hosts`. `/mcp`, `/api/*` and `/blobs/*` require a Client or Agent
  token from every peer, 127.0.0.1 included. `/api/host/*` is closed. `/health` stays open. `/ws` keeps its
  handshake. `--auto-approve-pairing` is refused. A hello on the public URL does not issue a pairing code. On a
  Remote Host, `Resolution.agent` is the Agent token's name and
  `clientInfo.name` is stored beside it (`mcp.rs` `agent_name`, `Resolution` in `host/crates/store/src/items.rs`).
  Loopback and Network mode stay as they are.
- #113 serves HTTPS from a certificate and key the user provides, and adds `inkup pairing`, the only way a Remote
  Host issues a pairing code.
- #114 is the container image: built from `host/`, running `inkup serve` as a Remote Host, non-root, the data dir on a
  volume, `/health` as the check, `host.lock` unchanged, and no self-update.
- #115 pairs the extension at an `https://` URL. `normalizeAddress` stops writing port 47823 onto a URL that omitted
  a port. The paired Host is labelled encrypted. The extension takes a code the operator issued, before the Host
  asks for one.
- #112 also stops a Remote Host publishing the machine name in `/health`: `hub_name` is omitted, or the operator
  sets one that is not the hostname.
- #116 adds the term Remote Host to CONTEXT.md, and updates PRODUCT.md, PRIVACY.md (a gateway audit log keeps
  screenshots and Signal text even though it blanks the token header), the README, the PRD's non-goals and a manual
  check. The authors still run no servers. The user runs this Host.
- #118, deferred: an identity the gateway asserts, or the Host as an OAuth 2.1 resource server.
- #119, deferred: publish the image from the release workflow.
- ADR 0005's status is `accepted; superseded in part by 0006 and 0030` (the part: MCP on loopback
  with no token, once the Host is a Remote Host), and the index row matches. ADR 0005, ADR 0006 and ADR 0021
  keep their decision text. Each carries a History line recording this acceptance.

## History

- 2026-10-20: proposed, from the findings of the #110 spike (#120). Acceptance belongs to the maintainer. While the
  status stays `proposed`, loopback and Network mode remain the rules in ADR 0005 and ADR 0006.
- 2026-10-20: the maintainer chose operator-issued pairing codes. On a Remote Host, `inkup pairing` is the only way a
  code is issued. A hello on the public URL issues none, so the per-IP reset in `pairing.rs` is not reachable there.
- 2026-10-20: accepted by the maintainer. ADR 0005's status is `accepted; superseded in part by 0006 and 0030`
  (the part: MCP on loopback with no token, once the Host is a Remote Host), and the index row matches.
- 2026-10-20: a tokenless hello on a Remote Host is refused with `pairing_denied`. A dedicated code is deferred to
  #115 to avoid an ADR 0007 protocol bump.

## Sources

- #110, and its findings page `docs/spikes/mcp-gateway.md` (#120). This ADR uses that page's
  labels (documented, source, unknown, unverified): <https://github.com/liatrio-labs/inkup/issues/110>,
  <https://github.com/liatrio-labs/inkup/pull/120>
- #111, this decision: <https://github.com/liatrio-labs/inkup/issues/111>
- #117, the epic, including the open naming point: <https://github.com/liatrio-labs/inkup/issues/117>
- What a self-hosted MCP gateway such as Obot documents for a remote upstream (transports, headers, private addresses,
  tunnels, audit): <https://docs.obot.ai/concepts/mcp-gateway/>,
  <https://docs.obot.ai/functionality/mcp-servers/>,
  <https://docs.obot.ai/functionality/virtual-mcps/>,
  <https://docs.obot.ai/configuration/mcp-server-gitops/>,
  <https://docs.obot.ai/functionality/mcp-tunnels/>,
  <https://docs.obot.ai/concepts/architecture/>
- Identity headers: the claim that a separate proxy project injects them is unverified, because its repository
  could not be fetched. The gateway docs linked above do not describe them for a remote upstream
  (`docs/spikes/mcp-gateway.md`, Identity).
- MCP authorization (OAuth 2.1 resource server), deferred here:
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- The pairing code store and how a hello issues a code: `host/crates/server/src/pairing.rs` (`PairingCodes::issue`,
  `redeem`) and `host/crates/server/src/ws.rs` (`issue_code`).
- ADR 0005, ADR 0006, ADR 0014, ADR 0016, ADR 0021, ADR 0025 and ADR 0027.
