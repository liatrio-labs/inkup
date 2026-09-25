//! The control API (`/api/host/*`): local admin for whoever embeds or drives the Host, the desktop app first. Its
//! version is `CONTROL_API` (in `host.json`), apart from the Client protocol's.
//!
//! - Loopback peers only, whatever the network mode, and no web page Origin: guard.rs refuses the rest, and
//!   `Controller` checks the peer again.
//! - Bearer `control_token` only (from `host.json`, which only the user can read). A paired Client's token or an
//!   agent token is refused: they are for Sessions and MCP, not for running the Host.
//!
//! The shapes are the contract's (contract/host-control.schema.json, from packages/protocol/src/host-control.ts):
//! responses are built as `inkup_protocol::control` types, so one that drifts from the schema fails here, loudly,
//! instead of on the client.
//!
//! - `GET /api/host/state?timeline=<session id>`: `HostState` as the TUI shows it, plus the header's facts.
//! - `POST /api/host/activate`: another launch asks this Host to come forward; the embedder's `on_activate` hook
//!   does that (the desktop app shows its window). `{handled: false}` when there is no hook (the TUI, `serve`).

use std::fmt;
use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use inkup_protocol::control::{Activated, CONTROL_API, ControlState};
use inkup_store::instance::HostKind;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::watch;

use crate::guard::Peer;
use crate::http::{ApiError, bearer};
use crate::network::lan_addresses;
use crate::{AppState, VERSION};

/// What the embedder does when another launch asks this Host to come forward.
#[derive(Clone)]
pub struct ActivateHook(pub Arc<dyn Fn() + Send + Sync>);

impl ActivateHook {
    pub fn new(hook: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(hook))
    }
}

impl fmt::Debug for ActivateHook {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ActivateHook")
    }
}

/// The control API's settings. Without them (`Config::control: None`) no token opens it.
#[derive(Debug, Clone)]
pub struct Control {
    /// The Bearer token `/api/host/*` takes: `HostLock::control_token`.
    pub token: String,
    pub kind: HostKind,
    pub on_activate: Option<ActivateHook>,
    /// A newer release, once the background check finds one.
    pub update: Option<watch::Receiver<Option<String>>>,
}

/// A request from this machine with the control token.
pub(crate) struct Controller(Control);

impl FromRequestParts<AppState> for Controller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        // The guard refused other machines already; a request that bypassed it (no Peer) is refused too.
        match parts.extensions.get::<Peer>() {
            Some(peer) if !peer.remote => {}
            _ => return Err(ApiError::Forbidden("the control API is for this machine only")),
        }
        let token = bearer(&parts.headers).ok_or(ApiError::NoControlToken)?;
        match &state.config.control {
            Some(control) if same(token.as_bytes(), control.token.as_bytes()) => Ok(Self(control.clone())),
            _ => Err(ApiError::Forbidden("the control API takes the control token from host.json only")),
        }
    }
}

/// Compares in time independent of where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

#[derive(Deserialize)]
pub(crate) struct StateQuery {
    timeline: Option<String>,
}

pub(crate) async fn state(
    Controller(control): Controller,
    State(state): State<AppState>,
    Query(query): Query<StateQuery>,
) -> Result<Json<ControlState>, ApiError> {
    let host = crate::state::snapshot(&state.store, &state.hub, query.timeline).await?;
    let network = state.network.as_deref().map(|network| {
        json!({
            "claimed": network.claimed_name(),
            "addresses": lan_addresses().iter().map(ToString::to_string).collect::<Vec<_>>(),
            "base_url": network.base_url(),
        })
    });
    let update = control.update.as_ref().and_then(|update| update.borrow().clone());
    let body = json!({
        "control_api": CONTROL_API,
        "kind": control.kind,
        "version": VERSION,
        "address": format!("127.0.0.1:{}", state.port),
        "network": network,
        "update": update,
        "state": host,
    });
    serde_json::from_value::<ControlState>(body).map(Json).map_err(|error| {
        tracing::error!(%error, "the control state does not match contract/host-control.schema.json");
        ApiError::Internal
    })
}

pub(crate) async fn activate(Controller(control): Controller) -> Json<Activated> {
    let handled = match &control.on_activate {
        Some(hook) => {
            (hook.0)();
            true
        }
        None => false,
    };
    Json(Activated { handled })
}

#[cfg(test)]
mod tests {
    use super::same;

    #[test]
    fn tokens_compare_whole() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
        assert!(!same(b"", b"a"));
    }
}
