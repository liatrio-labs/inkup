//! Wire types for the host protocol (ADR 0004): the envelopes a Client and the Host exchange over /ws, and the
//! /health document. The TypeScript Zod schemas in packages/protocol are the source of truth; `generated` is
//! typify's output for their JSON Schema, committed and checked by tests/generated.rs.

#[rustfmt::skip]
#[allow(clippy::all, clippy::pedantic, dead_code, unused_imports, missing_docs)]
mod generated;

pub use generated::*;
use serde_json::{Value, json};

/// Every envelope carries it as `v`.
pub const PROTOCOL_VERSION: i64 = 1;

/// What this Host can do, reported in /health and `welcome`. A Client gates each host feature on one of these.
pub const CAPABILITIES: &[&str] =
    &["events", "blobs", "items", "resolutions", "discard", "forget", "screenshot_discard"];

/// A message the Host builds failed its own schema: a bug, never the Client's fault.
pub type BuildError = serde_json::Error;

fn build(value: Value) -> Result<ServerMessage, BuildError> {
    serde_json::from_value(value)
}

pub fn paired(id: &str, re: &str, client_id: &str, token: &str) -> Result<ServerMessage, BuildError> {
    build(
        json!({ "v": PROTOCOL_VERSION, "type": "paired", "id": id, "re": re, "client_id": client_id, "token": token }),
    )
}

pub fn welcome(id: &str, re: &str, client_id: &str, host_version: &str) -> Result<ServerMessage, BuildError> {
    build(json!({
        "v": PROTOCOL_VERSION, "type": "welcome", "id": id, "re": re,
        "client_id": client_id, "host_version": host_version, "capabilities": CAPABILITIES,
    }))
}

/// `event_id` names the event stored when `re` was an `event`.
pub fn ack(id: &str, re: &str, event_id: Option<&str>) -> Result<ServerMessage, BuildError> {
    let mut ack = json!({ "v": PROTOCOL_VERSION, "type": "ack", "id": id, "re": re });
    if let Some(event_id) = event_id {
        ack["event_id"] = json!(event_id);
    }
    build(ack)
}

/// The fields of a `resolution` push, apart from the envelope.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Resolved {
    pub resolution_id: String,
    pub session_id: String,
    pub run_id: String,
    pub item_id: String,
    pub status: String,
    pub note: String,
    pub source: String,
    /// The agent's MCP client name, when an agent sent it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub created_at: i64,
}

pub fn resolution(id: &str, resolved: &Resolved) -> Result<ServerMessage, BuildError> {
    let mut message = serde_json::to_value(resolved)?;
    message["v"] = json!(PROTOCOL_VERSION);
    message["type"] = json!("resolution");
    message["id"] = json!(id);
    build(message)
}

pub fn error(id: &str, re: Option<&str>, code: ErrorCode, message: &str) -> Result<ServerMessage, BuildError> {
    build(json!({ "v": PROTOCOL_VERSION, "type": "error", "id": id, "re": re, "code": code, "message": message }))
}

/// `hub_name`: what the Host goes by on the network, when it has a name to give.
pub fn health(version: &str, hub_name: Option<&str>) -> Health {
    let mut doc = json!({
        "name": "inkup", "version": version, "protocol_version": PROTOCOL_VERSION, "capabilities": CAPABILITIES,
    });
    if let Some(name) = hub_name {
        doc["hub_name"] = json!(name);
    }
    serde_json::from_value(doc).expect("the /health document matches its schema")
}

/// `draw_mode` goes with `set_draw_mode` only.
pub fn command(id: &str, name: CommandName, draw_mode: Option<bool>) -> Result<ServerMessage, BuildError> {
    let mut message = json!({ "v": PROTOCOL_VERSION, "type": "command", "id": id, "command": name });
    if let Some(on) = draw_mode {
        message["draw_mode"] = json!(on);
    }
    build(message)
}
