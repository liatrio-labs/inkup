# Security Policy

InkUp is a browser extension and a local host program, not a hosted service. The extension records a reviewer's
voice, screenshots and drawings of the pages they review and keeps them in the browser's IndexedDB. The optional
`inkup` host keeps Sessions on the reviewer's own machine and serves them to their coding agents over MCP. There is
no server we operate and no data we hold. The security surface is what the extension and the host can be made to do
on a reviewer's machine, in the pages they visit, and on their local network.

## Reporting a vulnerability

Report privately through GitHub's security advisory form for this repository:

<https://github.com/liatrio-labs/inkup/security/advisories/new>

Private vulnerability reporting is enabled, and that form is the only supported channel. Do not open a public
issue, pull request or discussion for a suspected vulnerability: a public report discloses the problem to every
user before a fix exists.

### What to include

- The InkUp version (the extension's version in `chrome://extensions`, or `inkup --version`), the browser and the
  operating system.
- The component: the extension (content script and overlay, service worker, side panel, the page API
  `window.__inkup`), the host (HTTP and WebSocket server, pairing, agent tokens, MCP at `/mcp`, network mode), or
  a vendor adapter (Anthropic, Deepgram, ElevenLabs).
- A minimal reproduction: the smallest page, request sequence or configuration that triggers it.
- The impact you believe it has, for example a page reading recorded data, a site or LAN peer reaching the host
  without pairing, a token or API key disclosed, or a crafted input that executes code.

## What is in scope

- Web pages reaching data or controls they should not: the extension runs on all sites
  ([ADR 0003](docs/adr/0003-all-sites-host-permission.md)), so a page must not be able to read Sessions, keys or
  screenshots, or drive recording, beyond what the page API documents.
- The host's trust boundary: loopback trust, the Host and Origin checks against DNS rebinding, and Client pairing
  ([ADR 0005](docs/adr/0005-loopback-trust-and-pairing.md)); and in network mode, `.local` discovery, pairing by
  code and bearer tokens off loopback ([ADR 0006](docs/adr/0006-network-mode.md)).
- Disclosure of the API keys a reviewer enters in Settings (kept in `chrome.storage.local`) or of Client and agent
  tokens.
- Injection through recorded content: transcripts, Text Comments and element text become Change Items and agent
  prompts, so content that makes an agent act against the reviewer's intent is in scope.

## Known limits (not vulnerabilities)

- MCP on loopback is unauthenticated by design, so any process running as the same user can read it
  ([ADR 0005](docs/adr/0005-loopback-trust-and-pairing.md)). Other users on a shared machine can reach loopback too.
- Network mode is plain HTTP on the LAN. Tokens and recorded data are not encrypted in transit, so use it only on
  networks you trust.
- The paid transcription and Process features send audio or text to the vendor whose key you entered. The free
  tier sends nothing off the machine.

## Supported versions

Only the latest release, and `main`, receive security fixes.
