---
status: accepted
date: 2026-09-23
supersedes: the loopback-only parts of 0005
---

# Network mode: an opt-in Host on the LAN, found by a `.local` name, paired by code, tokens off loopback

A reviewer wants to record on one machine (a laptop, a test device) and have the Sessions land in a Host running on
another (the machine where their agents work), and future thick Clients will want the same. ADR 0005 kept every other
machine out by binding 127.0.0.1. Network mode lets them in, as an option, and keeps loopback as it was.

**Opt-in, loopback by default.** `inkup serve --network`, or the TUI's N key, which writes `network = true` to
`config.toml` in the data dir and restarts the server, binds `0.0.0.0:47823`. Otherwise the Host binds 127.0.0.1 as
before. Network mode is HTTP and WebSocket without TLS, so everything a Client sends crosses the LAN in the clear. The
TUI header and the `serve` banner say so on every run: "Network mode: unencrypted on this LAN — trusted networks only".
TLS comes later. It needs a certificate that browsers trust for a `.local` name, and that is a separate decision.

**Found by a `.local` name.** Extensions cannot browse mDNS, but the browser resolves `.local` names through the OS. The
Host claims the host name `inkup.local` on mDNS (`mdns-sd`). If another machine holds it, the Host takes
`inkup-2.local`, and so on up to `-5`; the name it holds shows in the TUI header. A Client probes
`http://inkup{,-2,…,-5}.local:47823/health` and any addresses it saved. `/health` now carries `hub_name`
(`inkup on studio-mac`) so it can list what it found. For native and future thick Clients the Host also advertises the
DNS-SD service `_inkup._tcp` with TXT `id` (the hub id from `config.toml`), `name`, `version` and `protocol_version`.
The server and mDNS are IPv4 only. When multicast is unavailable the Host still runs, and a Client is given its address
or a pair link.

**Host header.** The DNS-rebinding check stays. It also admits the `.local` names the Host could hold (base, `-2`…`-5`)
and the machine's LAN IPv4 addresses, always on its own port. rmcp's own Host allowlist, which knows only loopback
names, is switched off in network mode because `guard.rs` does the check.

**Tokens off loopback only.** The server knows the peer address of each request. From another machine, `/mcp`, `/api/*`
and `/blobs/*` need `Authorization: Bearer`, either a paired Client's token or an agent token; `/health` stays open and
`/ws` has its own handshake. From this machine nothing changes, and MCP still needs no token. An agent token is made
with `inkup token create --name <agent>` or the TUI's t key. It is shown once, stored as SHA-256 (store migration 4,
`agent_tokens`) and revoked in the TUI's Tokens view (r) or with `inkup token revoke`.
`inkup mcp install --remote http://inkup.local:47823 --token <token>` writes the URL and the header into the agent's
config: `headers` for Claude Code and Cursor, `http_headers` for Codex.

**Pairing from another machine is by code.** A y/n prompt is not enough there. The request carries a name the Client
chose, and anyone on the LAN can send one, so a quick "y" to "Chrome extension wants to connect" could let a stranger
in. Instead, a hello without a token from another machine is answered `error{pairing_code_required}`. The Host shows the
device name, its IP, a 6-digit code, and a terminal QR code of `inkup://pair?url=http://inkup.local:47823&code=<code>`.
The Client asks its user for the code (typed, scanned, or pasted as the link) and connects again with
`hello{pairing_code}`, which gets `paired` then `welcome`. A code lasts 2 minutes. Every wrong code counts against every
waiting code, and the fifth refuses it (`pairing_denied`), so guessing across several requests gains nothing. At most 4
codes wait at once, so hellos from the LAN cannot flood the TUI. The user can refuse a code early (n or Esc). Pairing
from this machine is unchanged (y/n).

**`--auto-approve-pairing` stays loopback-only.** With `--network` it is refused, unless the hidden test flag
`--print-pairing-codes` is also given. That flag prints each code as a `pairing code: <code>` stdout line for e2e
harnesses. Even then a Client on another machine pairs only with its code.

## Considered options

- Only a manual address: works without multicast, but each machine has to type an IP, and DHCP changes it. It is kept as
  a fallback next to the `.local` probe.
- Browsing DNS-SD from the extension: no extension API does it in Chrome, Firefox or Safari.
- TLS now, with a self-signed certificate: every browser would refuse it until the user trusted it by hand on each
  device. Deferred, with the warning in the meantime.
- Tokens for MCP on loopback too: see 0005. A local process can read the data dir, so a loopback token protects nothing.
  Off loopback a token is the only thing standing between the LAN and the Session data.
- Approving remote pairing with y/n: the name in the prompt is the Client's to choose, so it proves nothing about which
  device is asking.

## Consequences

- Everything on the LAN can reach `/health` and ask to pair, and all traffic is readable by anyone on the network path.
  Network mode is for trusted networks only, and the UI says so.
- The TUI restarts the server to switch modes. It closes open WebSockets (a cancellation token), and Clients reconnect
  on their own.
- Store migration 4 adds `agent_tokens`. Wire: `hello.pairing_code`, error codes `pairing_code_required` and
  `wrong_pairing_code`, and `/health.hub_name`. The Rust types are regenerated.
- CI cannot count on multicast. The mDNS browse test is skipped when `CI` is set. The peer-address rule is also tested
  with a switch that treats every peer as remote, and with a real bind reached through the machine's LAN address.

## Sources

- mDNS host names and conflict renaming: <https://www.rfc-editor.org/rfc/rfc6762#section-9>
- DNS-SD TXT records: <https://www.rfc-editor.org/rfc/rfc6763#section-6>
- `mdns-sd`: <https://docs.rs/mdns-sd>
- MCP Streamable HTTP authorization: <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
