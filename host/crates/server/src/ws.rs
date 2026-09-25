//! `/ws`: the Client protocol (packages/protocol/src/index.ts).
//!
//! 1. The Client's first message is `hello`. With a known token it gets `welcome`. Without one, the user is
//!    asked to approve pairing; on yes it gets `paired{token}` then `welcome`. A Client on another machine is
//!    answered `pairing_code_required` while the Host shows a code, and pairs by sending `hello{pairing_code}` on
//!    a new connection (pairing.rs). Any other outcome is an `error` and the connection closes.
//! 2. After `welcome`, the Host replays the Resolutions of the Client's Sessions, then pushes new ones as they
//!    are made.
//! 3. Each `event` is upserted on its event id, and each `items` replaces the Session's Change Items; both are
//!    answered with `ack`.
//! 4. A `session_discard` deletes one of the Client's Sessions with everything the Host held for it (E10), and is
//!    answered with `ack`.
//! 5. A `screenshot_discard` deletes a screenshot no Annotation uses (a dropped Object Select pick, E7): its blob and
//!    its `screenshot` event. Answered with `ack`, an unknown one too.
//! 6. The Host's user can drive the Client's Session: a `command` goes out and its `command_result` answers it.
//! 7. A `forget` (the reviewer chose Forget in the Client) revokes the Client's token; the Host acks it and closes
//!    the connection. The Client's Sessions stay.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Extension;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use inkup_protocol::{
    self as protocol, CommandResultMessage, ErrorCode, EventMessage, ForgetMessage, HelloMessage, ItemsMessage,
    PROTOCOL_VERSION, Resolved, ScreenshotDiscardMessage, ServerMessage, SessionDiscardMessage,
};
use inkup_store::fields::Fields;
use inkup_store::{Client, ItemResolution, Store, StoreError, Upsert};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::guard::Peer;
use crate::hub::{CommandOutcome, CommandRequest, Connected, Hub, Push};
use crate::pairing::{MAX_WRONG_CODES, PairingDecision, PairingRequest, Redeemed, RemotePairing};
use crate::{AppState, VERSION};

pub(crate) async fn upgrade(
    State(state): State<AppState>,
    Extension(peer): Extension<Peer>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        let closing = state.closing.clone();
        let mut connection = Connection { socket, state, peer, sent: 0, commands: HashMap::new() };
        let result = tokio::select! {
            result = connection.run() => result,
            () = closing.cancelled() => Err("the host is shutting down".into()),
        };
        if let Err(reason) = result {
            tracing::debug!(reason, "client connection closed");
        }
        let _ = connection
            .socket
            .send(Message::Close(Some(CloseFrame { code: 1000, reason: Utf8Bytes::from_static("") })))
            .await;
    })
}

/// A refusal to send as `error`: the message it answers (if readable), the code and a human-readable reason.
struct Refusal {
    re: Option<String>,
    code: ErrorCode,
    message: String,
}

impl Refusal {
    fn new(re: Option<&str>, code: ErrorCode, message: impl Into<String>) -> Self {
        Self { re: re.map(str::to_owned), code, message: message.into() }
    }
}

enum Incoming {
    Hello(HelloMessage),
    Event { id: String, session_id: String, event: Value },
    Items { id: String, session_id: String, run_id: String, items: Vec<Value> },
    Discard { id: String, session_id: String },
    Forget { id: String },
    ScreenshotDiscard { id: String, session_id: String, screenshot_id: String },
    CommandResult(CommandResultMessage),
}

/// Event types that make or change a Signal: `watch_items` looks again when one arrives.
const SIGNAL_EVENTS: &[&str] = &["annotation", "text_comment", "draft_item", "draft_action", "voice_command"];

/// An event's id, and whether it makes or changes a Signal.
pub(crate) fn event_meta(event: &Value) -> (String, bool) {
    let fields = Fields::event(event);
    (fields.text("id"), fields.str("type").is_some_and(|kind| SIGNAL_EVENTS.contains(&kind)))
}

/// Reads one client message, refusing anything that does not match the schema.
fn decode(text: &str) -> Result<Incoming, Refusal> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| Refusal::new(None, ErrorCode::BadMessage, format!("expected a JSON envelope: {e}")))?;
    let re = value.get("id").and_then(Value::as_str).map(str::to_owned);
    let re = re.as_deref();
    if value.get("v").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return Err(Refusal::new(
            re,
            ErrorCode::UnsupportedVersion,
            format!("this host speaks protocol version {PROTOCOL_VERSION}"),
        ));
    }
    let bad = |e: serde_json::Error| Refusal::new(re, ErrorCode::BadMessage, e.to_string());
    match value.get("type").and_then(Value::as_str) {
        Some("hello") => Ok(Incoming::Hello(serde_json::from_value(value).map_err(bad)?)),
        Some("event") => {
            let message: EventMessage = serde_json::from_value(value.clone()).map_err(bad)?;
            Ok(Incoming::Event {
                id: message.id.to_string(),
                session_id: message.session_id.to_string(),
                event: value["event"].clone(),
            })
        }
        Some("items") => {
            let message: ItemsMessage = serde_json::from_value(value.clone()).map_err(bad)?;
            let items = value["items"].as_array().cloned().unwrap_or_default();
            Ok(Incoming::Items {
                id: message.id.to_string(),
                session_id: message.session_id.to_string(),
                run_id: message.run_id.to_string(),
                items,
            })
        }
        Some("session_discard") => {
            let message: SessionDiscardMessage = serde_json::from_value(value).map_err(bad)?;
            Ok(Incoming::Discard { id: message.id.to_string(), session_id: message.session_id.to_string() })
        }
        Some("forget") => {
            let message: ForgetMessage = serde_json::from_value(value).map_err(bad)?;
            Ok(Incoming::Forget { id: message.id.to_string() })
        }
        Some("screenshot_discard") => {
            let message: ScreenshotDiscardMessage = serde_json::from_value(value).map_err(bad)?;
            Ok(Incoming::ScreenshotDiscard {
                id: message.id.to_string(),
                session_id: message.session_id.to_string(),
                screenshot_id: message.screenshot_id.to_string(),
            })
        }
        Some("command_result") => Ok(Incoming::CommandResult(serde_json::from_value(value).map_err(bad)?)),
        other => Err(Refusal::new(re, ErrorCode::BadMessage, format!("unknown message type {other:?}"))),
    }
}

/// What came of a message after `welcome`: `Forgotten` ends the connection.
#[derive(Debug, PartialEq, Eq)]
enum Answered {
    Replied,
    Forgotten,
}

struct Connection {
    socket: WebSocket,
    state: AppState,
    peer: Peer,
    sent: u64,
    /// Commands sent and not answered yet, by message id.
    commands: HashMap<String, oneshot::Sender<CommandOutcome>>,
}

impl Connection {
    async fn run(&mut self) -> Result<(), String> {
        let client = match self.handshake().await {
            Ok(client) => client,
            Err(refusal) => {
                let code = format!("{:?}", refusal.code);
                self.refuse(refusal).await?;
                return Err(format!("handshake refused: {code}"));
            }
        };
        tracing::info!(client = %client.id, name = %client.name, "client connected");
        let connected = Connected {
            client_id: client.id.clone(),
            kind: client.kind.clone(),
            name: client.name.clone(),
            since: now(),
        };
        let (_connected, mut commands) = Hub::connected(&self.state.hub, connected);
        // Subscribed before the replay, so a Resolution made meanwhile is sent at least once.
        let mut pushes = self.state.hub.subscribe_pushes();
        self.replay_resolutions(&client).await?;
        loop {
            tokio::select! {
                text = self.next_text() => {
                    let Some(text) = text? else { return Ok(()) };
                    if self.answer(&client, &text).await? == Answered::Forgotten {
                        return Ok(());
                    }
                }
                Some(request) = commands.recv() => self.send_command(request).await?,
                push = pushes.recv() => match push {
                    Ok(push) if push.client_id() == Some(client.id.as_str()) => self.send_push(push).await?,
                    Ok(_) => {}
                    // Too far behind to know what was missed: send them all again (the Client keeps them by id).
                    Err(RecvError::Lagged(_)) => self.replay_resolutions(&client).await?,
                    Err(RecvError::Closed) => return Ok(()),
                },
            }
        }
    }

    async fn answer(&mut self, client: &Client, text: &str) -> Result<Answered, String> {
        let reply = match decode(text) {
            Ok(Incoming::Forget { id }) => {
                let reply = self.forget(client, id).await;
                let forgotten = reply.is_ok();
                match reply {
                    Ok(ack) => self.send(ack).await?,
                    Err(refusal) => self.refuse(refusal).await?,
                }
                return Ok(if forgotten { Answered::Forgotten } else { Answered::Replied });
            }
            Ok(Incoming::Event { id, session_id, event }) => self.store_event(client, id, session_id, event).await,
            Ok(Incoming::Items { id, session_id, run_id, items }) => {
                self.store_items(client, id, session_id, run_id, items).await
            }
            Ok(Incoming::Discard { id, session_id }) => self.discard_session(client, id, session_id).await,
            Ok(Incoming::ScreenshotDiscard { id, session_id, screenshot_id }) => {
                self.discard_screenshot(client, id, session_id, screenshot_id).await
            }
            Ok(Incoming::CommandResult(result)) => {
                if let Some(reply) = self.commands.remove(result.re.as_str()) {
                    let outcome = CommandOutcome {
                        ok: result.ok,
                        session_id: result.session_id.map(|id| id.to_string()),
                        message: result.message,
                    };
                    let _ = reply.send(outcome);
                }
                return Ok(Answered::Replied);
            }
            Ok(Incoming::Hello(hello)) => {
                Err(Refusal::new(Some(&hello.id), ErrorCode::BadMessage, "already welcomed on this connection"))
            }
            Err(refusal) => Err(refusal),
        };
        match reply {
            Ok(ack) => self.send(ack).await?,
            Err(refusal) => self.refuse(refusal).await?,
        }
        Ok(Answered::Replied)
    }

    /// Revokes the Client's token: this connection ends after the ack, and the token opens nothing from then on.
    async fn forget(&mut self, client: &Client, re: String) -> Result<ServerMessage, Refusal> {
        let client_id = client.id.clone();
        blocking(&self.state.store, move |store| store.revoke_client(&client_id))
            .await
            .map_err(|e| internal(&re, e))?;
        tracing::info!(client = %client.id, "client forgot the host; its token is revoked");
        protocol::ack(&self.next_id(), &re, None).map_err(|e| internal(&re, e))
    }

    async fn send_command(&mut self, request: CommandRequest) -> Result<(), String> {
        let id = self.next_id();
        let message =
            protocol::command(&id, request.command.name(), request.command.draw_mode()).map_err(|e| e.to_string())?;
        self.commands.insert(id, request.reply);
        self.send(message).await
    }

    async fn replay_resolutions(&mut self, client: &Client) -> Result<(), String> {
        let client_id = client.id.clone();
        let resolutions = blocking(&self.state.store, move |store| store.client_resolutions(&client_id))
            .await
            .map_err(|e| e.to_string())?;
        for resolution in resolutions {
            self.send_push(Push::Resolution(resolution)).await?;
        }
        Ok(())
    }

    async fn send_push(&mut self, push: Push) -> Result<(), String> {
        let message = match push {
            Push::Resolution(resolution) => {
                protocol::resolution(&self.next_id(), &resolved(resolution)).map_err(|e| e.to_string())?
            }
        };
        self.send(message).await
    }

    async fn handshake(&mut self) -> Result<Client, Refusal> {
        let hello_timeout = self.state.config.hello_timeout;
        let text = match timeout(hello_timeout, self.next_text()).await {
            Ok(Ok(Some(text))) => text,
            Ok(_) => return Err(Refusal::new(None, ErrorCode::BadMessage, "closed before hello")),
            Err(_) => return Err(Refusal::new(None, ErrorCode::BadMessage, "no hello in time")),
        };
        let hello = match decode(&text)? {
            Incoming::Hello(hello) => hello,
            Incoming::Event { id, .. }
            | Incoming::Items { id, .. }
            | Incoming::Discard { id, .. }
            | Incoming::ScreenshotDiscard { id, .. }
            | Incoming::Forget { id } => {
                return Err(Refusal::new(Some(&id), ErrorCode::NotWelcomed, "send hello first"));
            }
            Incoming::CommandResult(result) => {
                return Err(Refusal::new(Some(&result.id), ErrorCode::NotWelcomed, "send hello first"));
            }
        };
        let re = hello.id.to_string();
        let client = match &hello.token {
            Some(token) => {
                let token = token.to_string();
                blocking(&self.state.store, move |store| store.authenticate(&token))
                    .await
                    .map_err(|e| internal(&re, e))?
                    .ok_or_else(|| {
                        Refusal::new(
                            Some(&re),
                            ErrorCode::UnknownToken,
                            "this token is not paired with the host; pair again",
                        )
                    })?
            }
            None => self.pair(&hello).await?,
        };
        // For `inkup update`'s skew guard (ADR 0008).
        let (client_id, version) = (client.id.clone(), *hello.v);
        blocking(&self.state.store, move |store| store.record_hello(&client_id, version))
            .await
            .map_err(|e| internal(&re, e))?;
        let welcome = protocol::welcome(&self.next_id(), &re, &client.id, VERSION).map_err(|e| internal(&re, e))?;
        self.send(welcome).await.map_err(|e| Refusal::new(Some(&re), ErrorCode::Internal, e))?;
        Ok(client)
    }

    /// Asks the user (or the auto-approve flag) and, on yes, pairs the Client and sends `paired`. From another
    /// machine the Client pairs with the code the Host shows instead.
    async fn pair(&mut self, hello: &HelloMessage) -> Result<Client, Refusal> {
        let re = hello.id.to_string();
        let kind = hello.client_kind.to_string();
        let name = hello.client_name.to_string();
        if self.peer.remote {
            match &hello.pairing_code {
                Some(code) => self.check_code(&re, code.as_str())?,
                None => return Err(self.issue_code(&re, kind, name)),
            }
        } else {
            let decision = if self.state.config.auto_approve_pairing {
                PairingDecision::Approve
            } else {
                self.ask_user(&re, kind.clone(), name.clone()).await?
            };
            if decision == PairingDecision::Deny {
                return Err(Refusal::new(Some(&re), ErrorCode::PairingDenied, "the user declined to pair this client"));
            }
        }
        let paired = blocking(&self.state.store, move |store| store.pair_client(&kind, &name))
            .await
            .map_err(|e| internal(&re, e))?;
        let message =
            protocol::paired(&self.next_id(), &re, &paired.client.id, &paired.token).map_err(|e| internal(&re, e))?;
        self.send(message).await.map_err(|e| Refusal::new(Some(&re), ErrorCode::Internal, e))?;
        tracing::info!(client = %paired.client.id, "client paired");
        Ok(paired.client)
    }

    /// Shows a new code on the Host for a Client on another machine, and tells the Client to come back with it.
    fn issue_code(&self, re: &str, kind: String, name: String) -> Refusal {
        let (mut request, decision) = PairingRequest::new(kind, name);
        let Some((id, code)) = self.state.codes.issue(self.peer.ip, decision) else {
            return Refusal::new(
                Some(re),
                ErrorCode::PairingDenied,
                "too many pairing requests are waiting; try again later",
            );
        };
        let link = self.state.network.as_ref().map_or_else(
            || format!("inkup://pair?url=http://127.0.0.1:{}&code={code}", self.state.port),
            |network| network.pair_link(&code),
        );
        request.remote = Some(RemotePairing { code, from: self.peer.ip, link });
        tracing::info!(prompt = %request.prompt(), "pairing request from another machine");
        // Nobody showing codes (a full queue) leaves the request to expire; the Client cannot guess its way in.
        let _ = self.state.pairing.try_send(request);
        let codes = std::sync::Arc::clone(&self.state.codes);
        tokio::spawn(async move {
            tokio::time::sleep(codes.ttl()).await;
            codes.expire(id);
        });
        Refusal::new(Some(re), ErrorCode::PairingCodeRequired, "enter the 6-digit code inkup shows, then connect again")
    }

    fn check_code(&self, re: &str, code: &str) -> Result<(), Refusal> {
        match self.state.codes.redeem(code) {
            Redeemed::Paired => Ok(()),
            Redeemed::Wrong { tries_left } => Err(Refusal::new(
                Some(re),
                ErrorCode::WrongPairingCode,
                format!("that is not the code inkup shows; {tries_left} tries left"),
            )),
            Redeemed::Refused => {
                tracing::warn!(peer = %self.peer.ip, "a pairing code was refused after {MAX_WRONG_CODES} wrong guesses");
                Err(Refusal::new(
                    Some(re),
                    ErrorCode::PairingDenied,
                    format!("{MAX_WRONG_CODES} wrong codes: pairing refused; ask for a new code"),
                ))
            }
            Redeemed::NoneWaiting => Err(Refusal::new(
                Some(re),
                ErrorCode::PairingTimeout,
                "no pairing code is waiting: it expired, was used or was refused; ask for a new one",
            )),
        }
    }

    async fn ask_user(&mut self, re: &str, kind: String, name: String) -> Result<PairingDecision, Refusal> {
        let (request, decision) = PairingRequest::new(kind, name);
        tracing::info!(prompt = %request.prompt(), "pairing request");
        let approver = self.state.pairing.clone();
        let asked = async move {
            approver.send(request).await.map_err(|_| ())?;
            decision.await.map_err(|_| ())
        };
        tokio::select! {
            decided = timeout(self.state.config.pairing_timeout, asked) => match decided {
                Ok(Ok(decision)) => Ok(decision),
                // Nobody holds the approval channel, or the request was dropped unanswered.
                Ok(Err(())) => Ok(PairingDecision::Deny),
                Err(_) => Err(Refusal::new(Some(re), ErrorCode::PairingTimeout, "nobody answered the pairing request")),
            },
            // The Client gave up while the user was deciding.
            () = closed(&mut self.socket) => Err(Refusal::new(Some(re), ErrorCode::BadMessage, "closed while pairing")),
        }
    }

    async fn store_event(
        &mut self,
        client: &Client,
        re: String,
        session_id: String,
        event: Value,
    ) -> Result<ServerMessage, Refusal> {
        let (event_id, signal) = event_meta(&event);
        let client_id = client.id.clone();
        let stored =
            blocking(&self.state.store, move |store| store.upsert_event(Some(&client_id), &session_id, &event)).await;
        match stored {
            Ok(upsert) => {
                if signal && upsert != Upsert::Unchanged {
                    self.state.hub.changed();
                } else if upsert != Upsert::Unchanged {
                    self.state.hub.view_changed();
                }
                protocol::ack(&self.next_id(), &re, Some(&event_id)).map_err(|e| internal(&re, e))
            }
            Err(e @ StoreError::Conflict { .. }) => Err(Refusal::new(Some(&re), ErrorCode::Conflict, e.to_string())),
            Err(e @ StoreError::InvalidEvent(_)) => Err(Refusal::new(Some(&re), ErrorCode::BadMessage, e.to_string())),
            Err(e) => Err(internal(&re, e)),
        }
    }

    async fn store_items(
        &mut self,
        client: &Client,
        re: String,
        session_id: String,
        run_id: String,
        items: Vec<Value>,
    ) -> Result<ServerMessage, Refusal> {
        let client_id = client.id.clone();
        let stored =
            blocking(&self.state.store, move |store| store.put_items(Some(&client_id), &session_id, &run_id, &items))
                .await;
        match stored {
            Ok(put) => {
                if !put.added.is_empty() || put.withdrawn > 0 {
                    self.state.hub.changed();
                }
                protocol::ack(&self.next_id(), &re, None).map_err(|e| internal(&re, e))
            }
            Err(e @ StoreError::RunConflict { .. }) => Err(Refusal::new(Some(&re), ErrorCode::Conflict, e.to_string())),
            Err(e @ StoreError::InvalidItems(_)) => Err(Refusal::new(Some(&re), ErrorCode::BadMessage, e.to_string())),
            Err(e) => Err(internal(&re, e)),
        }
    }

    async fn discard_session(
        &mut self,
        client: &Client,
        re: String,
        session_id: String,
    ) -> Result<ServerMessage, Refusal> {
        let client_id = client.id.clone();
        let deleted =
            blocking(&self.state.store, move |store| store.delete_session(Some(&client_id), &session_id)).await;
        match deleted {
            Ok(existed) => {
                if existed {
                    self.state.hub.changed();
                }
                protocol::ack(&self.next_id(), &re, None).map_err(|e| internal(&re, e))
            }
            Err(e @ StoreError::NotOwner { .. }) => Err(Refusal::new(Some(&re), ErrorCode::Conflict, e.to_string())),
            Err(e) => Err(internal(&re, e)),
        }
    }

    async fn discard_screenshot(
        &mut self,
        client: &Client,
        re: String,
        session_id: String,
        screenshot_id: String,
    ) -> Result<ServerMessage, Refusal> {
        let client_id = client.id.clone();
        let deleted = blocking(&self.state.store, move |store| {
            store.discard_screenshot(Some(&client_id), &session_id, &screenshot_id)
        })
        .await;
        match deleted {
            Ok(existed) => {
                if existed {
                    self.state.hub.changed();
                }
                protocol::ack(&self.next_id(), &re, None).map_err(|e| internal(&re, e))
            }
            Err(e @ StoreError::NotOwner { .. }) => Err(Refusal::new(Some(&re), ErrorCode::Conflict, e.to_string())),
            Err(e) => Err(internal(&re, e)),
        }
    }

    /// The next text message, `None` once the Client closes. Binary frames are refused.
    async fn next_text(&mut self) -> Result<Option<String>, String> {
        loop {
            match self.socket.recv().await {
                None | Some(Ok(Message::Close(_))) => return Ok(None),
                Some(Err(e)) => return Err(e.to_string()),
                Some(Ok(Message::Text(text))) => return Ok(Some(text.to_string())),
                Some(Ok(Message::Binary(_))) => {
                    self.refuse(Refusal::new(
                        None,
                        ErrorCode::BadMessage,
                        "binary frames are not part of the protocol",
                    ))
                    .await?;
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            }
        }
    }

    async fn refuse(&mut self, refusal: Refusal) -> Result<(), String> {
        let message = protocol::error(&self.next_id(), refusal.re.as_deref(), refusal.code, &refusal.message)
            .map_err(|e| e.to_string())?;
        self.send(message).await
    }

    async fn send(&mut self, message: ServerMessage) -> Result<(), String> {
        let text = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        self.socket.send(Message::Text(text.into())).await.map_err(|e| e.to_string())
    }

    fn next_id(&mut self) -> String {
        self.sent += 1;
        format!("h-{}", self.sent)
    }
}

/// Resolves once the Client closes; anything it sends meanwhile (before `welcome`) is dropped.
async fn closed(socket: &mut WebSocket) {
    while let Some(Ok(message)) = socket.recv().await {
        if matches!(message, Message::Close(_)) {
            return;
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn resolved(r: ItemResolution) -> Resolved {
    Resolved {
        resolution_id: r.resolution.id,
        session_id: r.session_id,
        run_id: r.run_id,
        item_id: r.item_id,
        status: r.resolution.status.as_str().to_owned(),
        note: r.resolution.note,
        source: r.resolution.source,
        agent: r.resolution.agent,
        created_at: r.resolution.created_at,
    }
}

fn internal(re: &str, error: impl std::fmt::Display) -> Refusal {
    tracing::error!(%error, "internal error");
    Refusal::new(Some(re), ErrorCode::Internal, "the host failed; see its log")
}

/// Runs a store call on a blocking thread.
pub(crate) async fn blocking<T: Send + 'static>(
    store: &Arc<Store>,
    call: impl FnOnce(&Store) -> inkup_store::Result<T> + Send + 'static,
) -> inkup_store::Result<T> {
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || call(&store))
        .await
        .unwrap_or_else(|e| Err(StoreError::Io(std::io::Error::other(e))))
}
