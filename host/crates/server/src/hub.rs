//! What the server's parts share while it runs: a change signal that `watch_items` waits on, the pushes the Host
//! sends to connected Clients, the Clients connected now (and a way to send each a command), and the agents
//! currently watching.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use inkup_protocol::CommandName;
use inkup_store::ItemResolution;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

/// How long a Client has to answer a command. Starting a Session opens the microphone, which can take seconds.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// Something the Host's user asks a Client's browser to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    /// Audio, Strokes and screenshots; no video, which needs a click in the browser.
    StartSession,
    Pause,
    Resume,
    Stop,
    SetDrawMode {
        draw_mode: bool,
    },
}

impl Command {
    pub fn name(self) -> CommandName {
        match self {
            Self::StartSession => CommandName::StartSession,
            Self::Pause => CommandName::Pause,
            Self::Resume => CommandName::Resume,
            Self::Stop => CommandName::Stop,
            Self::SetDrawMode { .. } => CommandName::SetDrawMode,
        }
    }

    pub fn draw_mode(self) -> Option<bool> {
        match self {
            Self::SetDrawMode { draw_mode } => Some(draw_mode),
            _ => None,
        }
    }
}

/// The Client's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandOutcome {
    pub ok: bool,
    pub session_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CommandError {
    #[error("that client is not connected")]
    NotConnected,
    #[error("the client did not answer in time")]
    NoAnswer,
}

/// A command on its way to a connection, with where its answer goes.
#[derive(Debug)]
pub struct CommandRequest {
    pub command: Command,
    pub reply: oneshot::Sender<CommandOutcome>,
}

/// A Client with an open, welcomed connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Connected {
    pub client_id: String,
    pub kind: String,
    pub name: String,
    pub since: i64,
}

struct Connection {
    info: Connected,
    serial: u64,
    commands: mpsc::Sender<CommandRequest>,
}

/// A message for connected Clients.
#[derive(Debug, Clone)]
pub enum Push {
    /// An item was resolved; its Session's Client shows the note on the card.
    Resolution(ItemResolution),
}

impl Push {
    /// The Client this is for.
    pub fn client_id(&self) -> Option<&str> {
        match self {
            Self::Resolution(resolution) => resolution.client_id.as_deref(),
        }
    }
}

/// An agent blocked in `watch_items`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Watcher {
    pub id: u64,
    pub url: Option<String>,
    pub session_id: Option<String>,
    pub since: i64,
}

pub struct Hub {
    changes: watch::Sender<u64>,
    /// Bumped whenever what the TUI shows changes: `changes`, and also each stored event, connection, watcher,
    /// token and pairing request. The control API's long-poll waits on it.
    view: watch::Sender<u64>,
    pushes: broadcast::Sender<Push>,
    watchers: Mutex<BTreeMap<u64, Watcher>>,
    next_watcher: AtomicU64,
    connections: Mutex<BTreeMap<String, Connection>>,
    next_connection: AtomicU64,
}

impl Default for Hub {
    fn default() -> Self {
        Self {
            changes: watch::Sender::new(0),
            view: watch::Sender::new(0),
            pushes: broadcast::Sender::new(256),
            watchers: Mutex::new(BTreeMap::new()),
            next_watcher: AtomicU64::new(1),
            connections: Mutex::new(BTreeMap::new()),
            next_connection: AtomicU64::new(1),
        }
    }
}

impl Hub {
    /// Items, Resolutions or Signals changed.
    pub fn changed(&self) {
        self.changes.send_modify(|n| *n += 1);
        self.view_changed();
    }

    /// Something the TUI shows changed that agents do not wait on: an event, a watcher, a token, a pairing request.
    pub fn view_changed(&self) {
        self.view.send_modify(|n| *n += 1);
    }

    pub fn subscribe_view(&self) -> watch::Receiver<u64> {
        self.view.subscribe()
    }

    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Sends to the connected Clients; one that is not connected gets it on its next `welcome` instead.
    pub fn push(&self, push: Push) {
        let _ = self.pushes.send(push);
    }

    pub fn subscribe_pushes(&self) -> broadcast::Receiver<Push> {
        self.pushes.subscribe()
    }

    /// Registers a watcher until the guard drops.
    pub fn watching(&self, url: Option<String>, session_id: Option<String>, since: i64) -> WatchGuard<'_> {
        let id = self.next_watcher.fetch_add(1, Ordering::Relaxed);
        self.lock_watchers().insert(id, Watcher { id, url, session_id, since });
        self.view_changed();
        WatchGuard { hub: self, id }
    }

    pub fn watchers(&self) -> Vec<Watcher> {
        self.lock_watchers().values().cloned().collect()
    }

    fn lock_watchers(&self) -> std::sync::MutexGuard<'_, BTreeMap<u64, Watcher>> {
        self.watchers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registers a welcomed connection until the guard drops. A newer connection of the same Client replaces it.
    pub(crate) fn connected(hub: &Arc<Self>, info: Connected) -> (ConnectionGuard, mpsc::Receiver<CommandRequest>) {
        let (commands, requests) = mpsc::channel(8);
        let serial = hub.next_connection.fetch_add(1, Ordering::Relaxed);
        let client_id = info.client_id.clone();
        hub.lock_connections().insert(client_id.clone(), Connection { info, serial, commands });
        hub.changed();
        (ConnectionGuard { hub: Arc::clone(hub), client_id, serial }, requests)
    }

    /// The Clients connected now.
    pub fn connections(&self) -> Vec<Connected> {
        self.lock_connections().values().map(|c| c.info.clone()).collect()
    }

    /// Sends `command` to the Client's browser and waits for its answer.
    pub async fn command(&self, client_id: &str, command: Command) -> Result<CommandOutcome, CommandError> {
        let sender =
            self.lock_connections().get(client_id).map(|c| c.commands.clone()).ok_or(CommandError::NotConnected)?;
        let (reply, answer) = oneshot::channel();
        sender.send(CommandRequest { command, reply }).await.map_err(|_| CommandError::NotConnected)?;
        match tokio::time::timeout(COMMAND_TIMEOUT, answer).await {
            Ok(Ok(outcome)) => Ok(outcome),
            // The connection closed with the command unanswered.
            Ok(Err(_)) => Err(CommandError::NotConnected),
            Err(_) => Err(CommandError::NoAnswer),
        }
    }

    fn lock_connections(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Connection>> {
        self.connections.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(crate) struct ConnectionGuard {
    hub: Arc<Hub>,
    client_id: String,
    serial: u64,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let mut connections = self.hub.lock_connections();
        if connections.get(&self.client_id).is_some_and(|c| c.serial == self.serial) {
            connections.remove(&self.client_id);
        }
        drop(connections);
        self.hub.changed();
    }
}

pub struct WatchGuard<'a> {
    hub: &'a Hub,
    id: u64,
}

impl Drop for WatchGuard<'_> {
    fn drop(&mut self) {
        self.hub.lock_watchers().remove(&self.id);
        self.hub.view_changed();
    }
}
