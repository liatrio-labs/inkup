//! The Host's system of record (ADR 0004): one SQLite file and a folder of blob files in the data dir.
//!
//! - `inkup.db`: Sessions, their timeline events (upserted on event id, so a Client's outbox can resend
//!   freely), blob metadata, Change Items (items.rs), Resolutions and paired Clients.
//! - `blobs/<id>`: screenshot, audio and video bytes.
//! - `config.toml`: the Host's settings (config.rs), which the user may edit.
//! - `host.lock`, `host.json`: which process hosts this data dir (instance.rs).
//!
//! Calls are blocking; async callers run them on a blocking thread.

mod agents;
mod blobs;
mod clients;
mod config;
mod events;
pub mod fields;
pub mod instance;
mod items;
mod schema;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub use agents::{AgentToken, Bearer, NewAgentToken};
pub use blobs::{BlobMeta, valid_blob_id};
pub use clients::{Client, PairedClient};
pub use config::{CONFIG_FILE, DesktopConfig, HostConfig};
pub use events::{SessionSummary, TIMELINE_TYPES, Upsert};
pub use items::{
    Item, ItemFilter, ItemResolution, ItemStatus, PutItems, Resolution, ResolutionStatus, SessionOverview, Signal,
    SignalFilter, StartItem, origin_of,
};

pub const DB_FILE: &str = "inkup.db";
pub const BLOB_DIR: &str = "blobs";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("file: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("no random source: {0}")]
    Random(String),
    #[error("invalid event: {0}")]
    InvalidEvent(String),
    #[error("event {event_id} already belongs to Session {session_id}")]
    Conflict { event_id: String, session_id: String },
    #[error("Session {session_id} was recorded by another client")]
    NotOwner { session_id: String },
    #[error("invalid items: {0}")]
    InvalidItems(String),
    #[error("Process run {run_id} already belongs to Session {session_id}")]
    RunConflict { run_id: String, session_id: String },
    #[error("invalid blob id")]
    InvalidBlobId,
    #[error("{CONFIG_FILE}: {0}")]
    Config(String),
    #[error("the database is at schema version {found}, newer than this host ({known}); update inkup")]
    NewerSchema { found: i64, known: i64 },
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// The per-user data dir: `~/Library/Application Support/dev.inkup.inkup` on macOS,
/// `%APPDATA%\inkup\inkup\data` on Windows, `$XDG_DATA_HOME/inkup` on Linux.
pub fn default_data_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("dev", "inkup", "inkup").map(|dirs| dirs.data_dir().to_path_buf())
}

pub struct Store {
    conn: Mutex<Connection>,
    dir: PathBuf,
}

impl Store {
    /// Opens (creating if needed) the store in `dir` and brings its schema up to date.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir.join(BLOB_DIR))?;
        let mut conn = Connection::open(dir.join(DB_FILE))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        schema::migrate(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn), dir: dir.to_path_buf() })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn schema_version(&self) -> Result<i64> {
        schema::version(&self.conn())
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite half-written (transactions roll back on drop).
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| StoreError::Random(e.to_string()))?;
    Ok(hex::encode(buf))
}
