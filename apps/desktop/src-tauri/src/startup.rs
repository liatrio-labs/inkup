//! Find or host. One host per data dir (`inkup_store::instance`):
//!
//! - Nobody holds the data dir: the app takes the lock and runs the server in-process (host mode).
//! - The CLI (TUI or `serve`) holds it: the app drives it through the control API (client mode).
//! - Another desktop app holds it: that one is asked to come forward, and this launch ends.
//!
//! Either way the window talks to the host through one `HostLink`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use inkup_server::{ActivateHook, Config, Control, Server};
use inkup_store::instance::{CONTROL_API, HostInfo, HostKind, HostLock, LockError};
use inkup_store::{Store, StoreError};

use crate::link::HostLink;

/// The server this process runs, and the lock it holds for it.
pub struct Hosted {
    pub server: Server,
    pub lock: HostLock,
}

impl Hosted {
    /// Stops the server, then gives up the data dir.
    pub async fn shutdown(self) {
        if let Err(error) = self.server.shutdown().await {
            tracing::warn!(%error, "the server did not stop cleanly");
        }
        drop(self.lock);
    }
}

pub enum Startup {
    /// This process hosts.
    Host { link: HostLink, hosted: Hosted },
    /// The CLI hosts; the app drives it.
    Client { link: HostLink, holder: HostInfo },
    /// Another desktop app hosts; it was asked to come forward.
    Activated(HostInfo),
}

#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    #[error(
        "InkUp {version} ({kind}) is running on this data dir with control API {found}; this app speaks {CONTROL_API}. \
         Update it or the app.",
        version = .0.version, kind = .0.kind.describe(), found = .0.control_api
    )]
    Incompatible(HostInfo),
    #[error("another InkUp host holds this data dir but has not said where it listens; try again in a moment")]
    NoHostFile,
    #[error("the data dir: {0}")]
    Store(#[from] StoreError),
    #[error("listen on 127.0.0.1:{port}: {error} (is another host running on that port?)")]
    Listen { port: u16, error: std::io::Error },
}

/// Hosts `dir` on `port` (0: any free port), or finds who does. `on_activate` is what a later launch's
/// activate does while this process hosts.
pub async fn find_or_host(dir: &Path, port: u16, on_activate: ActivateHook) -> Result<Startup, StartupError> {
    let found = match HostLock::acquire(dir, HostKind::Desktop) {
        Ok(lock) => return host(dir, port, lock, on_activate).await,
        Err(LockError::Store(error)) => return Err(error.into()),
        Err(LockError::Held(found)) => found,
    };
    let holder = match found {
        Some(holder) => holder,
        None => published(dir).await.ok_or(StartupError::NoHostFile)?,
    };
    if holder.control_api != CONTROL_API {
        return Err(StartupError::Incompatible(holder));
    }
    let link = HostLink::to(&holder);
    if holder.kind == HostKind::Desktop {
        if let Err(error) = link.activate().await {
            tracing::warn!(%error, "could not ask the running app to come forward");
        }
        return Ok(Startup::Activated(holder));
    }
    Ok(Startup::Client { link, holder })
}

async fn host(dir: &Path, port: u16, lock: HostLock, on_activate: ActivateHook) -> Result<Startup, StartupError> {
    let store = Arc::new(Store::open(dir)?);
    let control = Control {
        token: lock.control_token().to_owned(),
        kind: HostKind::Desktop,
        on_activate: Some(on_activate),
        update: None,
    };
    // Loopback only for now: network mode needs the pairing prompt, which the window does not have yet.
    let config = Config { port, control: Some(control), ..Config::default() };
    let server = inkup_server::start(store, config).await.map_err(|error| StartupError::Listen { port, error })?;
    let port = server.addr.port();
    lock.publish(port, env!("CARGO_PKG_VERSION"))?;
    tracing::info!(port, dir = %dir.display(), "hosting");
    let link = HostLink::new(port, lock.control_token());
    Ok(Startup::Host { link, hosted: Hosted { server, lock } })
}

/// A holder that has just taken the lock writes `host.json` once its server binds: wait a moment for it.
async fn published(dir: &Path) -> Option<HostInfo> {
    for _ in 0..30 {
        if let Ok(Some(holder)) = inkup_store::instance::holder(dir) {
            return Some(holder);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}
