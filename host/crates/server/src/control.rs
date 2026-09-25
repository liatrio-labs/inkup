//! The control API (`/api/host/*`): local admin for whoever embeds or drives the Host, the desktop app first. Its
//! version is `CONTROL_API` (in `host.json`), apart from the Client protocol's.
//!
//! - Loopback peers only, whatever the network mode, and no web page Origin: guard.rs refuses the rest, and
//!   `Controller` checks the peer again.
//! - Bearer `control_token` only (from `host.json`, which only the user can read). A paired Client's token or an
//!   agent token is refused: they are for Sessions and MCP, not for running the Host.
//!
//! - `GET /api/host/state?timeline=<session id>`: `HostState` as the TUI shows it, plus the header's facts.
//! - `POST /api/host/activate`: another launch asks this Host to come forward; the embedder's `on_activate` hook
//!   does that (the desktop app shows its window). `{handled: false}` when there is no hook (the TUI, `serve`).

use std::fmt;
use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use inkup_store::instance::{CONTROL_API, HostKind};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::guard::Peer;
use crate::http::{ApiError, bearer};
use crate::network::lan_addresses;
use crate::state::HostState;
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

/// Network mode as the header shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetworkView {
    /// `inkup.local`, once claimed on mDNS.
    pub claimed: Option<String>,
    /// This machine's LAN addresses.
    pub addresses: Vec<String>,
    /// Where another machine reaches the Host.
    pub base_url: String,
}

/// `GET /api/host/state`.
#[derive(Debug, Clone, Serialize)]
pub struct ControlState {
    pub control_api: u32,
    pub kind: HostKind,
    pub version: String,
    /// `127.0.0.1:<port>`.
    pub address: String,
    /// Set in network mode.
    pub network: Option<NetworkView>,
    /// A newer release, as the TUI's key line says it.
    pub update: Option<String>,
    pub state: HostState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activated {
    pub handled: bool,
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
    let network = state.network.as_deref().map(|network| NetworkView {
        claimed: network.claimed_name(),
        addresses: lan_addresses().iter().map(ToString::to_string).collect(),
        base_url: network.base_url(),
    });
    Ok(Json(ControlState {
        control_api: CONTROL_API,
        kind: control.kind,
        version: VERSION.to_owned(),
        address: format!("127.0.0.1:{}", state.port),
        network,
        update: control.update.as_ref().and_then(|update| update.borrow().clone()),
        state: host,
    }))
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
