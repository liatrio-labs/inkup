---
status: accepted
date: 2026-09-24
supersedes: the contract location in 0004
---

# One versioned contract in `contract/`: CI runs both sides only when it changes, and blocks a break without a bump

The extension and the Host are about to ship on their own schedules: `extension-v*` tags through the stores, `host-v*`
tags through cargo-dist with self-update. An installed pair will often be out of step, an old extension against a new
Host or the other way round. What they agree on was spread out: the wire protocol's JSON Schema and its fixture corpus
lived in `packages/protocol`, and the Session file format the Host checks its readers against lived in `docs/schema`.
CI could not tell a change to the agreement from a change to one side, so it ran the Host matrix for any edit in
`packages/protocol`, and it had no check that a change kept an older peer working.

**Location.** `contract/` holds everything the two sides share, and nothing else:

- `protocol.schema.json`: the WebSocket wire protocol (ADR 0004), `PROTOCOL_VERSION` in its `v`.
- `session.schema.json`: the Session file format, `schema_version` in its `schema_version`.
- `fixtures/`: the corpus both sides decode (`<type>[.<case>].json` must parse, `invalid/` must be refused), with the
  generated `event.*.json` and `items.json`.

Zod stays the source of truth. `pnpm schema` and `pnpm -C packages/protocol fixtures:events` write into `contract/`,
and the Host reads only `contract/`: typify's `generated.rs`, the fixture tests, and `contract.rs`. The extension
side's drift check (`pnpm schema && git diff --exit-code -- contract`) is what makes the committed files a trustworthy
signal: a change in `packages/core` that moves the wire fails CI until `contract/` is regenerated in the same change.

**What counts as breaking.** Either side may meet an older or a newer peer, so a change is additive only when an old
reader of the new data and a new reader of the old data both still agree. `scripts/contract-compat.ts` compares each
schema with the pull request's base:

- Additive: a new optional property, a new definition, a new message type in a union of `$ref`s, and any change to
  annotations (`description`, `title`, `$comment`, `examples`, `$id`).
- Breaking: a removed or renamed property, definition or union member; a type change; optional to required or required
  to optional; a new required property; any enum change, new values included; any other validation keyword changed
  (`maxLength`, `pattern`, `minimum`, `format`, `additionalProperties`, ...), looser or tighter; a new branch in an inline
  union, such as a new Session event type.

New enum values are breaking because neither decoder tolerates them: Zod's `z.enum` and typify's serde enums both
refuse a value they do not know, and the extension drops a server message that fails to parse. Unknown properties are
tolerated (Zod strips them, the generated Rust types do not deny them), which is why a new optional property is safe.
A new message type is safe because the peer already handles one it does not know: the Host answers
`error{bad_message}` for that request and keeps the connection, and the extension logs and ignores it. A Client that
sends a new message must treat that refusal as "this Host cannot", and gate the feature on a `welcome` capability.

**Versioning rule.** A breaking change passes only when the same change bumps the schema's version:
`PROTOCOL_VERSION` in `packages/protocol/src/index.ts` and `host/crates/protocol/src/lib.rs` for the wire (the Host
refuses any other `v`, `unsupported_version`), or `SCHEMA_VERSION` in `packages/core` for the Session file, with its
migration step. Prefer an additive change and a capability over a bump: a protocol bump cuts every installed
extension off from a newer Host until both are updated.

**CI routing.** The `changes` job (`scripts/ci-changes.ts`) routes by path:

| Path | Runs |
| --- | --- |
| `contract/**` | both sides, and `contract-compat` |
| `host/**` | the host: `cargo` on three platforms, and the Chrome e2e |
| `extensions/`, `packages/`, `scripts/`, `tests/`, `fixtures/`, root files | the extension side: `core`, `extension-chrome`, `extension-firefox`, and the Chrome e2e |
| `*.md`, `docs/**`, `LICENSE` | lint only |
| `.github/workflows/ci.yml`, any other path | both sides |

The Chrome e2e builds the real Host and drives the extension against it (`tests/e2e/host.spec.ts`). It is the one test
of both sides together, so it runs when either changes. `ci-ok`, the one required check, needs `contract-compat` as
well as every other job; a skipped job passes it.

## Considered options

- Keep the schemas where they were and list both paths in the CI rules: the rules had to know that `packages/protocol`
  and `docs/schema` were special, and anything new shared by the two sides had to be added by hand.
- Move the Zod sources into `contract/` too: the wire schemas import the timeline and Change Item schemas from
  `packages/core`, which the extension uses for much more than the wire. The drift check gives the same signal without
  moving them.
- An off-the-shelf JSON Schema diff tool: the ones that exist judge compatibility in one direction (a new reader of old
  data), bring a dependency tree into CI, and do not know which of our unions are message sets. The script is about
  130 lines with its own tests.
- Treat new enum values as additive: true only if every decoder had a catch-all variant. Neither does today; adding one
  is a later, deliberate change that would relax this rule.

## Consequences

- A host-only change no longer runs `core` or `extension-chrome`, and an extension-only change no longer runs the Host
  matrix. A change to `contract/` runs everything.
- The first pull request that adds `contract/` has no base to compare with, and `contract-compat` says so and passes.
- The extension now sends `PROTOCOL_VERSION` in every envelope instead of a literal `1`, so a bump is one constant on
  each side.
- `docs/schema/` keeps a README that points to `contract/`, for links made before the move.
