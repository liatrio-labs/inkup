# The contract between the extension and the host

Everything the two sides share, versioned, and nothing else ([ADR 0007](../docs/adr/0007-central-contract.md)).
Every file here is generated from the Zod schemas; do not edit by hand.

| Path | What | Version | Written by |
| --- | --- | --- | --- |
| `protocol.schema.json` | The WebSocket wire protocol | `PROTOCOL_VERSION` (`v`) | `pnpm schema` from `packages/protocol/src/index.ts` |
| `host-control.schema.json` | The control API: `host.json` and `/api/host/*` (local admin, the desktop app) | `CONTROL_API` (`control_api`) | `pnpm schema` from `packages/protocol/src/host-control.ts` |
| `session.schema.json` | The Session file format | `schema_version` | `pnpm schema` from `packages/core/src/session-document.ts` |
| `fixtures/` | The corpus both sides decode; `invalid/` both refuse; `host-control/` for the control API | | hand-written, and `pnpm -C packages/protocol fixtures:events` |

A change here runs both sides in CI, and `scripts/contract-compat.ts` fails it when it would break an older peer
without a version bump. Run it yourself against `main`:

```sh
pnpm schema && git diff --exit-code -- contract
node scripts/contract-compat.ts origin/main
```
