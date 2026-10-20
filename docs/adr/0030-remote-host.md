---
status: proposed
date: 2026-10-20
supersedes: the loopback-only MCP trust in 0005
---

# A Remote Host is reached only at an https public URL, every peer needs a token, and a Client pairs by code

A reviewer can run the Host off their own machine and still hand Change Items to a coding agent in the cloud. Loopback
(ADR 0005) binds 127.0.0.1 and lets MCP in with no token, so a reverse proxy or a gateway on the same machine is let
in. Network mode (ADR 0006) is HTTP without TLS on a trusted LAN, found by a `.local` name. A cloud agent reaches
neither. InkUp's authors run no servers for it (PRODUCT.md): the user runs this Host. A self-hosted MCP gateway such
as Obot is how that agent reaches the Host's MCP. The rules below follow the public findings in #110. The page that
records them is `docs/spikes/mcp-gateway.md`, and this ADR merges after it.

**The term is Remote Host.** A Remote Host is a Host reached over HTTPS from other networks. It sits beside loopback
and Network mode, and those two keep the behaviour they have today. CONTEXT.md lists "Remote mode" and "server mode"
under Network mode's _Avoid_. #116 adds **Remote Host** to CONTEXT.md. The other name offered in
the epic, "Hosted mode", goes unused.

**One origin, Streamable HTTP, and the public URL is https.** MCP stays Streamable HTTP at `/mcp`
(`host/crates/server/src/mcp.rs`, `service`, rmcp). The Client WebSocket (`/ws`), `/blobs/*` and `/api/*` are served
on that same origin. Clients and agents are given only the configured public URL, and remote mode starts only when
that URL is `https://`. A self-hosted MCP gateway such as Obot exposes its clients over Streamable HTTP and takes a
remote upstream as Streamable HTTP, so the Host grows no second MCP transport.

**TLS ends at a reverse proxy or at the Host.** A reverse proxy is the usual end. The Host listens as HTTP on an
address the proxy can reach (loopback for a sidecar, or the container's own interface), and the proxy presents the
https URL. That listen address is not advertised. The Host can also terminate TLS itself, from a certificate and key
the user provides (#113). Remote mode refuses to start when the public URL is `http://`. It does not treat
`X-Forwarded-Proto`, or any other forwarded header, as proof that TLS happened. The Pair link, the serve banner and
the address a Client stores all use the https public URL. Network mode stays unencrypted HTTP on a trusted LAN. The
TLS decided here is the TLS ADR 0006 deferred.

**Every peer is another machine, loopback included.** A proxy or gateway on the same machine connects from 127.0.0.1,
which ADR 0005 counts as this machine. Remote mode sets `Config::every_peer_is_remote`
(`host/crates/server/src/guard.rs`, `peer`), the switch that today exists for tests. `/mcp`, `/api/*` and `/blobs/*`
then need `Authorization: Bearer`, a paired Client's token or an Agent token, from every address. A request with no
known peer address still fails closed. `/health` stays open and still says only the name, version, protocol version,
capabilities and hub name, including to anyone who can reach the public URL. `/ws` keeps its handshake: a hello
without a token is answered `pairing_code_required`, and a later hello carries the Client token.

**Forwarded headers are not credentials.** `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and the identity
headers `X-Forwarded-User`, `X-Forwarded-Email`, `X-Forwarded-Name` and `X-Forwarded-Access-Token` do not authenticate
a request and do not mark a peer local. #110 found those identity headers undocumented for a remote upstream of a
self-hosted MCP gateway such as Obot. A separate proxy project injects them. The Host ignores them for auth.

**The Host header admits the public host.** `host_allowed` keeps the loopback names, so a health check of
`127.0.0.1` still succeeds, and it also admits the public URL's host: that name alone, or that name with the public
URL's port. The process's bind port need not be in the header, because the proxy terminates TLS on 443 and dials the
Host on another port. rmcp's allowlist knows only loopback names, so remote mode turns it off the way `service`
already does when `network` is set (`disable_allowed_hosts`), and `guard.rs` remains the check. Any other host name
is refused. The Origin rule is unchanged: a web page Origin is refused, an extension origin is accepted, and a
missing Origin is accepted. The public site's Origin gains no exception.

**Agent tokens are the header the gateway sets.** An Agent token is made with `inkup token create --name <agent>`
(or the TUI's t key) and stored as SHA-256 (`agent_tokens`, `authenticate_agent` in
`host/crates/store/src/agents.rs`). The gateway sends it as `Authorization: Bearer` on the upstream. A self-hosted
MCP gateway such as Obot can set that header once for everyone (a static header, optionally from a secret) or once
per user, supplied when that user connects. One shared token and one token per user both satisfy the Host. The token
is set on the gateway's upstream entry. #110's user docs describe that header. They leave forwarding of the client's
own Authorization header undescribed for a remote upstream; where the gateway's code forwards headers, a static header
wins a clash.

**Gateway identity and OAuth wait (#118).** Trusting an identity the gateway asserts, and speaking the MCP
authorization spec (the Host as an OAuth 2.1 resource server), are both deferred. The gateway can already sign its
users in and store upstream credentials for a remote server that speaks that spec. Token exchange (RFC 8693) is
described for servers the gateway itself hosts. The Host has no accounts and no sign-in (PRODUCT.md). Identity
headers are not a documented property of a remote upstream, so they do not stand in for a token. An Agent token
already fits the headers the gateway documents.

**A Resolution names the Agent token.** `start_item` and `resolve_item` store `Resolution.agent` from
`clientInfo.name` (`agent_name` in `mcp.rs`). A gateway sits between the coding agent and the Host, so that string
may name the gateway's client rather than the agent. That is the open point in #117. #110 left the exact string
unknown; an observed value belongs in `docs/spikes/mcp-gateway.md`. The naming rule stands either way. On a Remote
Host the name on the Resolution is the Agent token's name (`AgentToken.name`). `clientInfo.name` is stored beside
it, and the card shows the token's name. Loopback and Network mode keep ADR 0021, where the MCP client is the agent
and the name stays `clientInfo.name`.

**Pairing against the public URL is by code.** The code rules are Network mode's (ADR 0006). A hello with no token
is `pairing_code_required`. The Client answers with `hello{pairing_code}`. The code lasts 2 minutes
(`pairing_code_ttl`, 120 seconds). The fifth wrong code refuses it (`MAX_WRONG_CODES` in
`host/crates/server/src/pairing.rs`). Each machine has one waiting code, the newest. The Pair link carries the
public URL, `inkup://pair?url=<https public URL>&code=<code>`. A headless Host has no y/n prompt. `prompt_pairing`
(`host/crates/tui/src/lib.rs`) already prints a remote request's code, its QR code and the link on stderr, including
when stdin is not a terminal, so the container log shows them. #113 adds `inkup pairing`, run inside the container,
to show the same code. `--auto-approve-pairing` is refused in remote mode, as it is with `--network`
(`host/crates/inkup/src/main.rs`). Combined with the hidden test flag `--print-pairing-codes` the process still
starts, and even then a Client pairs only by code.

**Evidence stays on a volume the user owns.** The store is `inkup.db` and `blobs/<id>` in the data dir
(`host/crates/store/src/lib.rs`). In the container that directory is a volume the user owns. `get_screenshot`
returns MCP image content and refuses a blob whose mime is not `image/`, so audio and video never travel over MCP.
The Client uploads them to `/blobs/*` with its token, over HTTPS. A gateway may keep MCP requests and responses in
its audit log. A self-hosted MCP gateway such as Obot does, with application-level encryption off by default, so a
screenshot and the words carried on a Signal can land in the gateway's store. #116 says so in PRIVACY.md. The Host
leaves `get_screenshot` as it is.

**A proxy may stop a body the Host would still store.** `MAX_BLOB_BYTES` in `host/crates/server/src/http.rs` is
4 GiB. A reverse proxy often refuses a smaller body, and the audio or video upload then fails in front of the Host.
The operator raises the proxy's limit. #110 left any cap on an image response unknown; the Host does not shrink
screenshots to fit a cap nobody has stated. `watch_items` waits up to 600 seconds (`MAX_WATCH_SECONDS` in `mcp.rs`;
the default is 120). The proxy and the gateway on the path to `/mcp` need an idle timeout of at least 600 seconds,
or a long watch ends as a transport error. #110 left that timeout unknown. `docs/spikes/mcp-gateway.md` is where an
observed value is written down.

**One image, built from `host/`, with no self-update inside it.** #114 builds one container image from `host/`. It
runs `inkup serve` in remote mode, as a user other than root, with the data dir on a volume and `/health` as the
health check. ADR 0025's lock (`inkup_store::instance::HostLock` on `host.lock`) still means one Host per data dir,
in the container as anywhere else. ADR 0027's self-update does not run in the container. Replacing the image is how
it updates. Publishing the image from the release workflow is #119, and it waits. Until then the image is built
from source.

**These stay on the reviewer's machine.** Remote mode closes `/api/host/*` to every peer, loopback included, so a
proxy on 127.0.0.1 cannot reach the control token in `host.json` (ADR 0025). Loopback and Network mode keep the
control API as ADR 0025 describes it. `inkup token` opens
the store on the data dir; it does not call `/api/host/*`. The TUI and the desktop app remain local front ends.
Remote mode serves neither of them. mDNS, `.local` names and Find hubs stay Network mode (ADR 0006). Remote mode
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
- Trusting gateway identity headers. They are undocumented for a remote upstream, the peer can send them itself, and
  a later proof would be a secret the Host holds. That decision is #118.
- OAuth on the Host now. The MCP authorization spec would make the Host a resource server and give it accounts, which
  the product does not have. The gateway already carries an Agent token as a Bearer header. OAuth waits in #118.

## Consequences

- #112 turns remote mode on in the Host. `guard.rs` sets `every_peer_is_remote` and `host_allowed` admits the public
  host. `mcp.rs` `service` calls `disable_allowed_hosts`. `/mcp`, `/api/*` and `/blobs/*` require a Client or Agent
  token from every peer. `/api/host/*` is closed. `/health` stays open. `/ws` keeps its handshake.
  `--auto-approve-pairing` is refused. On a Remote Host, `Resolution.agent` is the Agent token's name and
  `clientInfo.name` is stored beside it (`mcp.rs` `agent_name`, `Resolution` in `host/crates/store/src/items.rs`).
  Loopback and Network mode stay as they are.
- #113 serves HTTPS from a certificate and key the user provides, and adds `inkup pairing` so a headless Host can
  show the code `prompt_pairing` already prints to the log.
- #114 is the container image: built from `host/`, running `inkup serve` in remote mode, non-root, the data dir on a
  volume, `/health` as the check, `host.lock` unchanged, and no self-update.
- #115 pairs the extension at an `https://` URL. `normalizeAddress` stops writing port 47823 onto a URL that omitted
  a port. The paired Host is labelled encrypted.
- #116 adds the term Remote Host to CONTEXT.md, and updates PRODUCT.md, PRIVACY.md (a gateway audit log may keep
  screenshots and transcript excerpts), the README, the PRD's non-goals and a manual check. The authors still run no
  servers. The user runs this Host.
- #118, deferred: an identity the gateway asserts, or the Host as an OAuth 2.1 resource server.
- #119, deferred: publish the image from the release workflow.
- ADR 0005's status records the part remote mode supersedes: MCP on loopback with no token, once remote mode is on.
  ADR 0006 and ADR 0021 keep their text while this ADR is proposed. Their History lines point here.

## History

- 2026-10-20: proposed, from the public findings in #110. Acceptance belongs to the maintainer. While the status stays
  `proposed`, loopback and Network mode remain the rules in ADR 0005 and ADR 0006.

## Sources

- #110, and the findings page `docs/spikes/mcp-gateway.md` that this ADR merges after:
  <https://github.com/liatrio-labs/inkup/issues/110>
- #111, this decision: <https://github.com/liatrio-labs/inkup/issues/111>
- #117, the epic, including the open naming point: <https://github.com/liatrio-labs/inkup/issues/117>
- What a self-hosted MCP gateway such as Obot documents for a remote upstream (transports, headers, private addresses,
  tunnels, audit): <https://docs.obot.ai/concepts/mcp-gateway/>,
  <https://docs.obot.ai/functionality/mcp-servers/>,
  <https://docs.obot.ai/functionality/virtual-mcps/>,
  <https://docs.obot.ai/configuration/mcp-server-gitops/>,
  <https://docs.obot.ai/functionality/mcp-tunnels/>,
  <https://docs.obot.ai/concepts/architecture/>
- Identity headers are a finding in #110: a separate proxy injects them, and the gateway docs linked above
  do not describe them for a remote upstream.
- MCP authorization (OAuth 2.1 resource server), deferred here:
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- Token exchange, for servers the gateway hosts: <https://www.rfc-editor.org/rfc/rfc8693>
- ADR 0005, ADR 0006, ADR 0014, ADR 0016, ADR 0021, ADR 0025 and ADR 0027.
