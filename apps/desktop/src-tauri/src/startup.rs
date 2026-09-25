//! Find or host. One host per data dir (`inkup_store::instance`):
//!
//! - Nobody holds the data dir: the app takes the lock and runs the server in-process (host mode).
//! - The CLI (TUI or `serve`) holds it: the app drives it through the control API (client mode).
//! - Another desktop app holds it: that one is asked to come forward, and this launch ends.
//!
//! Either way the window talks to the host through one `HostLink`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use inkup_server::{ActivateHook, Config, Control, NetworkConfig, NetworkHook, Server};
use inkup_store::instance::{CONTROL_API, HostInfo, HostKind, HostLock, LockError};
use inkup_store::{HostConfig, Store, StoreError};

use crate::link::HostLink;

/// How this process hosts, when it does.
#[derive(Clone)]
pub struct Hosting {
    /// 0: any free port.
    pub port: u16,
    /// What a later launch's activate does: show the window.
    pub on_activate: ActivateHook,
    /// What the window's network switch does: `Hosted::switch_network`, on the app's side.
    pub on_network: NetworkHook,
    /// Advertise on mDNS in network mode. Tests turn it off.
    pub advertise: bool,
}

impl Hosting {
    pub fn new(port: u16, on_activate: ActivateHook, on_network: NetworkHook) -> Self {
        Self { port, on_activate, on_network, advertise: true }
    }
}

/// The server this process runs, and the lock it holds for it.
pub struct Hosted {
    pub server: Server,
    pub lock: HostLock,
    dir: PathBuf,
    store: Arc<Store>,
    hosting: Hosting,
}

impl Hosted {
    /// Stops the server, then gives up the data dir.
    pub async fn shutdown(self) {
        if let Err(error) = self.server.shutdown().await {
            tracing::warn!(%error, "the server did not stop cleanly");
        }
        drop(self.lock);
    }

    /// Saves network mode in config.toml and restarts the server in it, on the same port and still holding the
    /// data dir. Connected Clients reconnect, as they do when the TUI switches. If the port cannot be bound on
    /// every interface, the setting goes back and the server comes back on loopback.
    pub async fn switch_network(self, on: bool) -> Result<Self, StartupError> {
        let Self { server, lock, dir, store, mut hosting } = self;
        hosting.port = server.addr.port();
        if let Err(error) = server.shutdown().await {
            tracing::warn!(%error, "the server did not stop cleanly");
        }
        HostConfig::save_network(&dir, on)?;
        match serve(&dir, &lock, Arc::clone(&store), &hosting).await {
            Ok(server) => Ok(Self { server, lock, dir, store, hosting }),
            Err(error) if on => {
                tracing::warn!(%error, "network mode did not start; back to this machine only");
                HostConfig::save_network(&dir, false)?;
                let server = serve(&dir, &lock, Arc::clone(&store), &hosting).await?;
                Ok(Self { server, lock, dir, store, hosting })
            }
            Err(error) => Err(error),
        }
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
    #[error("listen on port {port}: {error} (is another host running on that port?)")]
    Listen { port: u16, error: std::io::Error },
}

/// Hosts `dir` as `hosting` says, or finds who does.
pub async fn find_or_host(dir: &Path, hosting: &Hosting) -> Result<Startup, StartupError> {
    let found = match HostLock::acquire(dir, HostKind::Desktop) {
        Ok(lock) => return host(dir, lock, hosting).await,
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

async fn host(dir: &Path, lock: HostLock, hosting: &Hosting) -> Result<Startup, StartupError> {
    let store = Arc::new(Store::open(dir)?);
    let server = serve(dir, &lock, Arc::clone(&store), hosting).await?;
    lock.publish(server.addr.port(), env!("CARGO_PKG_VERSION"))?;
    let link = HostLink::new(server.addr.port(), lock.control_token());
    let hosted = Hosted { server, lock, dir: dir.to_owned(), store, hosting: hosting.clone() };
    Ok(Startup::Host { link, hosted })
}

/// Starts the server as config.toml says (network mode or this machine only), with pairing asked in the window.
/// A restart binds the same port, so `host.json` stays as `host` published it.
async fn serve(dir: &Path, lock: &HostLock, store: Arc<Store>, hosting: &Hosting) -> Result<Server, StartupError> {
    let settings = HostConfig::load(dir)?;
    let network = settings.network.then(|| NetworkConfig {
        hub_id: settings.hub_id,
        advertise: hosting.advertise,
        ..NetworkConfig::default()
    });
    let control = Control {
        token: lock.control_token().to_owned(),
        kind: HostKind::Desktop,
        on_activate: Some(hosting.on_activate.clone()),
        on_network: Some(hosting.on_network.clone()),
        update: None,
    };
    let port = hosting.port;
    let config = Config { port, network, hub_name: Some(hub_name()), control: Some(control), ..Config::default() };
    let mut server = inkup_server::start(store, config).await.map_err(|error| StartupError::Listen { port, error })?;
    server.ask_pairing_over_control();
    tracing::info!(port = server.addr.port(), network = settings.network, dir = %dir.display(), "hosting");
    Ok(server)
}

/// What the Host is called on the LAN, as the CLI names it: `inkup on <machine>`.
fn hub_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let host = host.split('.').next().unwrap_or_default();
    if host.is_empty() { "inkup".into() } else { format!("inkup on {host}") }
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
