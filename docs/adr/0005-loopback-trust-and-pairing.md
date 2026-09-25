---
status: accepted; superseded in part by 0006 (network mode: other machines, and tokens for MCP off loopback)
date: 2026-09-23
---

# The host trusts only loopback, checks the Host header, pairs Clients with tokens, and leaves MCP unauthenticated on loopback

The Host holds everything a reviewer recorded: screenshots of their pages, their voice, and their transcripts. The
obvious attackers are other machines on the network and web pages in the user's own browser. A local process running as
the same user can already read the data dir, so it is out of scope. The server binds `127.0.0.1:47823` only, which keeps
other machines out. Against web pages it refuses any request whose Host header is not `127.0.0.1`, `localhost` or
`[::1]` on its own port: a page that rebinds its domain to 127.0.0.1 still sends its own name. A browser WebSocket is
not bound by CORS, so `/ws` also refuses any Origin that belongs to a web page (`http(s)://` other than the Host
itself). Extension origins (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) and clients that send
no Origin are let through. A Client must pair before it can write. Its first `hello` names its kind and a display name.
Whichever process hosts asks: the TUI asks "Chrome extension "…" wants to connect [y/n]", headless `serve` asks on
the terminal, and the desktop app asks in its window (ADR 0025). A yes issues a
random 256-bit token, which the Client keeps in `storage.local` and sends in every later `hello` and as the
`Authorization: Bearer` token for `/blobs` and the read API. The Host stores only the token's SHA-256, and Forget
revokes it.

MCP at `/mcp` (H3) has no authentication. Agent tools (Claude Code, Cursor, Codex) connect with a static URL written by
`inkup mcp install`, and none of them can take part in a pairing prompt. The Host and Origin checks still apply, so only
local processes reach it, and those are out of scope as above.

## Considered options

- Tokens for MCP too: every agent config would carry a secret, and the tools store it in plain files next to the URL.
  That protects nothing against a local process that can read those files, and it breaks `mcp install` with no prompt.
- mTLS or a Unix socket: Unix sockets would stop other users on the same machine. But browser extensions can only speak
  HTTP and WebSocket, and Windows named pipes would be a separate path.
- Approving pairing without asking: a page that slipped past the Host and Origin checks would get a token silently.
  `--auto-approve-pairing` exists for tests only and logs a warning.

## Consequences

- `/health` needs no token and says only the name, version, protocol version and capabilities, so a Client can find the
  Host before pairing.
- A pairing request waits two minutes and then fails with `pairing_timeout`. A Client that closes while it waits cancels
  the request. Without a terminal, headless `serve` denies every request.
- The client name shown in the prompt comes from the Client, so control characters are stripped before it reaches the terminal.
- Other users on a shared machine can reach loopback. They can pair only if the user at the prompt approves, and they
  can read MCP. Revisit that before any multi-user deployment.

## History

- 2026-09-23: pairing was asked in the TUI or on `serve`'s terminal. 2026-09-25: whichever process hosts asks. The
  desktop app asks in its window, through the control API's pending list (`Server::ask_pairing_over_control`), and a
  window driving a CLI host leaves the asking to that host. The control API trusts the same boundary as this ADR:
  loopback, no web page Origin, and a token only the user can read (ADR 0025).

## Sources

- DNS rebinding: <https://en.wikipedia.org/wiki/DNS_rebinding>
- WebSockets and the same-origin policy: <https://www.rfc-editor.org/rfc/rfc6455#section-10.2>
- MCP Streamable HTTP security notes (validate Origin, bind localhost): <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning>
