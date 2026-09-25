//! The control API's types (`host.json`, `/api/host/*`): local admin of a running Host, for the desktop app first.
//! The Zod schemas in packages/protocol/src/host-control.ts are the source of truth; `generated` is typify's output
//! for contract/host-control.schema.json, committed and checked by tests/generated.rs.

#[rustfmt::skip]
#[allow(clippy::all, clippy::pedantic, dead_code, unused_imports, missing_docs)]
mod generated;

pub use generated::*;

/// The control API version: `control_api` in `host.json` and in `GET /api/host/state`.
pub const CONTROL_API: i64 = 2;
