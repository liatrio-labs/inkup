//! One host per data dir. Every host mode (the TUI, `serve`, the desktop app) holds an exclusive lock on
//! `host.lock` for as long as it runs, so two servers never share one database. The OS drops the lock when the
//! process dies, however it dies, so there is no stale-pid logic.
//!
//! Once its server has bound, the holder writes `host.json` (mode 0600 on unix): who it is, its port, and the
//! `control_token` the control API (`/api/host/*`) takes. Whoever finds the lock held reads it from there.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Result, StoreError, now_ms, random_hex};

pub const LOCK_FILE: &str = "host.lock";
pub const HOST_FILE: &str = "host.json";
/// The control API's version (`/api/host/*`), in `host.json`. A client that speaks another one stays away.
pub const CONTROL_API: u32 = 2;

/// Which kind of host holds a data dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Tui,
    Serve,
    Desktop,
}

impl HostKind {
    /// How a person would name it: `the desktop app`.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Tui => "inkup TUI",
            Self::Serve => "inkup serve",
            Self::Desktop => "desktop app",
        }
    }
}

/// `host.json`: the running host, as its holder wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostInfo {
    pub pid: u32,
    pub kind: HostKind,
    pub port: u16,
    /// The control API's Bearer token. Only local processes that can read the data dir learn it.
    pub control_token: String,
    pub control_api: u32,
    pub version: String,
    /// Epoch ms.
    pub started_at: i64,
}

impl HostInfo {
    /// `desktop app, pid 4242, port 47823`.
    pub fn describe(&self) -> String {
        format!("{}, pid {}, port {}", self.kind.describe(), self.pid, self.port)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// Another process holds the lock. Its `host.json`, unless it has not written it yet.
    #[error("another host holds this data dir")]
    Held(Option<HostInfo>),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The data dir's lock, held until dropped.
#[derive(Debug)]
pub struct HostLock {
    _file: File,
    dir: PathBuf,
    kind: HostKind,
    control_token: String,
}

impl HostLock {
    /// Takes the lock on `dir` (created if missing), or says who holds it. A `host.json` left by a holder that died
    /// is removed: until `publish`, nobody is reachable.
    pub fn acquire(dir: &Path, kind: HostKind) -> std::result::Result<Self, LockError> {
        std::fs::create_dir_all(dir).map_err(StoreError::from)?;
        let file = private(OpenOptions::new().create(true).truncate(false).write(true))
            .open(dir.join(LOCK_FILE))
            .map_err(StoreError::from)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(LockError::Held(holder(dir)?)),
            Err(TryLockError::Error(e)) => return Err(StoreError::from(e).into()),
        }
        remove_host_file(dir)?;
        Ok(Self { _file: file, dir: dir.to_path_buf(), kind, control_token: random_hex(32)? })
    }

    pub fn kind(&self) -> HostKind {
        self.kind
    }

    /// What the server's control API takes as its Bearer token.
    pub fn control_token(&self) -> &str {
        &self.control_token
    }

    /// Writes `host.json` for the server now bound on `port`; again after a restart on another port.
    pub fn publish(&self, port: u16, version: &str) -> Result<HostInfo> {
        let info = HostInfo {
            pid: std::process::id(),
            kind: self.kind,
            port,
            control_token: self.control_token.clone(),
            control_api: CONTROL_API,
            version: version.to_owned(),
            started_at: now_ms(),
        };
        // Written aside and moved into place, so a reader never sees half of it.
        let aside = self.dir.join(format!("{HOST_FILE}.tmp"));
        let _ = std::fs::remove_file(&aside);
        let mut file = private(OpenOptions::new().create_new(true).write(true)).open(&aside)?;
        file.write_all(&serde_json::to_vec_pretty(&info)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&aside, self.dir.join(HOST_FILE))?;
        Ok(info)
    }
}

impl Drop for HostLock {
    fn drop(&mut self) {
        // Before the lock goes with the file: whoever takes it next finds no one to call.
        let _ = remove_host_file(&self.dir);
    }
}

/// `host.json` in `dir`, if a host wrote one. It says who held the lock; on its own it does not say they still do.
pub fn holder(dir: &Path) -> Result<Option<HostInfo>> {
    match std::fs::read(dir.join(HOST_FILE)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn remove_host_file(dir: &Path) -> Result<()> {
    match std::fs::remove_file(dir.join(HOST_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Only the user can read what holds the control token.
#[cfg(unix)]
fn private(options: &mut OpenOptions) -> &mut OpenOptions {
    std::os::unix::fs::OpenOptionsExt::mode(options, 0o600)
}

#[cfg(not(unix))]
fn private(options: &mut OpenOptions) -> &mut OpenOptions {
    options
}
