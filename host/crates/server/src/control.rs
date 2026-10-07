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
//! - `GET /api/host/changes?since=<seq>`: a long-poll on `Hub::subscribe_view`, answered at the next change (or
//!   after `LONG_POLL` with none), so a window refreshes on change rather than on a timer.
//! - `POST /api/host/commands`: a command to a connected Client's Session, as the TUI's keys send.
//! - `POST /api/host/tokens`, `DELETE /api/host/tokens/{id}`: agent tokens, as the TUI makes and revokes them.
//! - `POST /api/host/network`: network mode, through the embedder's `on_network` hook (the desktop app restarts its
//!   server). `{handled: false}` without one: the TUI switches it in its terminal.
//! - `POST /api/host/pairing/{id}`: answers a pairing request, when the embedder has the server ask here
//!   (`Server::ask_pairing_over_control`) rather than on its own screen.
//! - `GET /api/host/items/{id}`: one stored Change Item in full, with every tracker link (ADR 0028), so the desktop
//!   app can build its issue.
//! - `GET /api/host/blobs/{id}`: a stored blob's bytes (a screenshot), to upload with that issue.
//! - `POST /api/host/items/{id}/tracker-links`: records that the item was sent to a tracker, and answers the item.
//!   The token that sent it never comes here: the window holds it (the OS keychain), the Host never does.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::Response;
use inkup_protocol::control::{
    Activated, CONTROL_API, Changes, CommandOutcome, CommandRequest, ControlState, FullItem, NetworkRequest,
    NetworkSwitched, NewToken, NewTokenRequest, PairingAnswer, PairingAnswerDecision, TrackerLink,
};
use inkup_store::fields::Fields;
use inkup_store::instance::HostKind;
use inkup_store::{Item, TrackerLink as StoredLink};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::guard::Peer;
use crate::http::{ApiError, bearer};
use crate::hub::Command;
use crate::network::lan_addresses;
use crate::pairing::{PairingDecision, PairingRequest};
use crate::ws::blocking;
use crate::{AppState, VERSION};

/// How long `changes` waits for a change before it answers anyway.
const LONG_POLL: Duration = Duration::from_secs(25);

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

/// What the embedder does to switch network mode: save it and restart the server in it, after the answer is sent.
#[derive(Clone)]
pub struct NetworkHook(pub Arc<dyn Fn(bool) + Send + Sync>);

impl NetworkHook {
    pub fn new(hook: impl Fn(bool) + Send + Sync + 'static) -> Self {
        Self(Arc::new(hook))
    }
}

impl fmt::Debug for NetworkHook {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NetworkHook")
    }
}

/// The last pairing request id, for every server this process runs. A restarted server (network mode switched)
/// never reuses an id, so a window still showing a request from before the restart cannot answer a new one by
/// mistake: its answer is a 404.
static PAIRING_IDS: AtomicU64 = AtomicU64::new(0);

/// Pairing requests waiting for an answer through the control API, by id.
#[derive(Default)]
pub(crate) struct PairingInbox {
    waiting: Mutex<Vec<(u64, PairingRequest)>>,
}

impl PairingInbox {
    pub(crate) fn push(&self, request: PairingRequest) {
        let id = PAIRING_IDS.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().push((id, request));
    }

    /// The requests still waiting: a Client that gave up, or a code used, refused or expired, needs no answer.
    fn prompts(&self) -> Vec<Value> {
        let mut waiting = self.lock();
        waiting.retain(|(_, request)| !request.is_cancelled());
        waiting
            .iter()
            .map(|(id, request)| {
                json!({
                    "id": id,
                    "prompt": request.prompt(),
                    "client_kind": request.client_kind,
                    "client_name": request.client_name,
                    "remote": request.remote.as_ref().map(|remote| json!({
                        "code": remote.code, "from": remote.from.to_string(), "link": remote.link,
                    })),
                })
            })
            .collect()
    }

    fn take(&self, id: u64, remote_allowed: impl Fn(&PairingRequest) -> bool) -> Result<PairingRequest, ApiError> {
        let mut waiting = self.lock();
        let at = waiting.iter().position(|(found, _)| *found == id).ok_or(ApiError::NotFound)?;
        if !remote_allowed(&waiting[at].1) {
            return Err(ApiError::BadRequest(
                "a request from another machine is approved by typing its code in the Client; it can only be denied"
                    .into(),
            ));
        }
        Ok(waiting.remove(at).1)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(u64, PairingRequest)>> {
        self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The control API's settings. Without them (`Config::control: None`) no token opens it.
#[derive(Debug, Clone)]
pub struct Control {
    /// The Bearer token `/api/host/*` takes: `HostLock::control_token`.
    pub token: String,
    pub kind: HostKind,
    pub on_activate: Option<ActivateHook>,
    /// Set where network mode can be switched through the control API (the desktop app hosting).
    pub on_network: Option<NetworkHook>,
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
        "network_switch": control.on_network.is_some(),
        "pending_pairing": state.inbox.prompts(),
        "state": host,
    });
    typed::<ControlState>(body).map(Json)
}

/// A response built as the contract's type: one that drifts from the schema is the Host's bug, logged.
fn typed<T: DeserializeOwned>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body).map_err(|error| {
        tracing::error!(%error, "a control API response does not match contract/host-control.schema.json");
        ApiError::Internal
    })
}

/// A request body as the contract's type.
fn request<T: DeserializeOwned>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body).map_err(|error| ApiError::BadRequest(error.to_string()))
}

#[derive(Deserialize)]
pub(crate) struct ChangesQuery {
    #[serde(default)]
    since: u64,
}

/// Answers once the view's counter is not `since` (a restarted Host counts from 0 again), or after `LONG_POLL`.
pub(crate) async fn changes(
    _: Controller,
    State(state): State<AppState>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<Changes>, ApiError> {
    let mut view = state.hub.subscribe_view();
    // A server shutting down answers at once, so a waiting window does not hold up its graceful shutdown.
    tokio::select! {
        _ = tokio::time::timeout(LONG_POLL, view.wait_for(|seq| *seq != query.since)) => {}
        () = state.closing.cancelled() => {}
    }
    let seq = *view.borrow();
    typed(json!({ "seq": seq })).map(Json)
}

pub(crate) async fn command(
    _: Controller,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<CommandOutcome>, ApiError> {
    let asked: CommandRequest = request(body)?;
    let mut command = json!({ "command": asked.command });
    if let Some(on) = asked.draw_mode {
        command["draw_mode"] = json!(on);
    }
    let command: Command = request(command)?;
    let outcome = state.hub.command(&asked.client_id, command).await.map_err(ApiError::Command)?;
    typed(serde_json::to_value(outcome).map_err(|_| ApiError::Internal)?).map(Json)
}

pub(crate) async fn create_token(
    _: Controller,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<NewToken>), ApiError> {
    let asked: NewTokenRequest = request(body)?;
    let name = asked.name.trim().to_owned();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name the token for who it is for".into()));
    }
    let made = blocking(&state.store, move |store| store.create_agent_token(&name)).await?;
    state.hub.view_changed();
    let body = json!({
        "id": made.agent.id, "name": made.agent.name, "created_at": made.agent.created_at, "token": made.token,
    });
    Ok((StatusCode::CREATED, Json(typed(body)?)))
}

pub(crate) async fn revoke_token(
    _: Controller,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !blocking(&state.store, move |store| store.revoke_agent_token(&id)).await? {
        return Err(ApiError::NotFound);
    }
    state.hub.view_changed();
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn network(
    Controller(control): Controller,
    Json(body): Json<Value>,
) -> Result<Json<NetworkSwitched>, ApiError> {
    let asked: NetworkRequest = request(body)?;
    let handled = match &control.on_network {
        Some(hook) => {
            (hook.0)(asked.on);
            true
        }
        None => false,
    };
    Ok(Json(NetworkSwitched { handled }))
}

pub(crate) async fn answer_pairing(
    _: Controller,
    State(state): State<AppState>,
    Path(id): Path<u64>,
    Json(body): Json<Value>,
) -> Result<StatusCode, ApiError> {
    let asked: PairingAnswer = request(body)?;
    let decision = match asked.decision {
        PairingAnswerDecision::Approve => PairingDecision::Approve,
        PairingAnswerDecision::Deny => PairingDecision::Deny,
    };
    let request = state.inbox.take(id, |request| request.remote.is_none() || decision == PairingDecision::Deny)?;
    request.decide(decision);
    state.hub.view_changed();
    Ok(StatusCode::NO_CONTENT)
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

/// `item-<seq>`, as `ItemView.id` and agents name an item.
fn item_seq(id: &str) -> Option<i64> {
    id.strip_prefix("item-")?.parse().ok().filter(|seq| *seq > 0)
}

/// An item as `FullItem`: its body with every tracker link, and a body missing its Locations or evidence (a Client
/// stores items verbatim) given empty ones.
fn full_item(mut item: Item, session_name: String) -> Result<FullItem, ApiError> {
    let status = item.status();
    let fields = Fields::item(&item.body);
    let has_locations = fields.raw("locations").is_array();
    let has_screenshots = fields.get("evidence").raw("screenshots").is_array();
    let evidence = fields.get("evidence").value().filter(|e| e.is_object()).cloned();
    let mut body = match std::mem::take(&mut item.body) {
        Value::Object(body) => body,
        _ => serde_json::Map::new(),
    };
    body.entry("id").or_insert_with(|| json!(item.item_id));
    body.entry("title").or_insert_with(|| json!(""));
    if !has_locations {
        body.insert("locations".into(), json!([]));
    }
    if !has_screenshots {
        let mut evidence = evidence.unwrap_or_else(|| json!({}));
        evidence["screenshots"] = json!([]);
        body.insert("evidence".into(), evidence);
    }
    body.insert("tracker_links".into(), json!(item.tracker_links));
    typed(json!({
        "id": format!("item-{}", item.seq),
        "session_id": item.session_id,
        "session_name": session_name,
        "run_id": item.run_id,
        "status": status,
        "withdrawn": item.withdrawn_at.is_some(),
        "item": body,
    }))
}

async fn read_full_item(state: &AppState, seq: i64) -> Result<FullItem, ApiError> {
    let found = blocking(&state.store, move |store| {
        let Some(item) = store.item(seq)? else { return Ok(None) };
        let name = store.session_name(&item.session_id)?;
        Ok(Some((item, name)))
    })
    .await?;
    let (item, name) = found.ok_or(ApiError::NotFound)?;
    full_item(item, name)
}

pub(crate) async fn item(
    _: Controller,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<FullItem>, ApiError> {
    let seq = item_seq(&id).ok_or(ApiError::NotFound)?;
    read_full_item(&state, seq).await.map(Json)
}

pub(crate) async fn blob(
    _: Controller,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    crate::http::blob_response(&state, id).await
}

pub(crate) async fn record_tracker_link(
    _: Controller,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<FullItem>, ApiError> {
    let seq = item_seq(&id).ok_or(ApiError::NotFound)?;
    let asked: TrackerLink = request(body)?;
    let link = StoredLink {
        tracker: asked.tracker.to_string(),
        destination: asked.destination.trim().to_owned(),
        key: asked.key.trim().to_owned(),
        url: asked.url.trim().to_owned(),
        created_at: asked.created_at.trim().to_owned(),
    };
    // The window shows it as a link: a web page only.
    if !(link.url.starts_with("https://") || link.url.starts_with("http://")) {
        return Err(ApiError::BadRequest("a tracker link's url is the issue's web page: http or https".into()));
    }
    let recorded = blocking(&state.store, move |store| store.record_tracker_link(seq, &link)).await?;
    if recorded.is_none() {
        return Err(ApiError::NotFound);
    }
    state.hub.view_changed();
    read_full_item(&state, seq).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::{item_seq, same};

    #[test]
    fn item_ids_are_item_dash_seq() {
        assert_eq!(item_seq("item-12"), Some(12));
        for id in ["item-0", "item--1", "12", "item-x", "item_0001"] {
            assert_eq!(item_seq(id), None, "{id}");
        }
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
        assert!(!same(b"", b"a"));
    }
}
