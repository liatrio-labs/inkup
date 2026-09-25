//! The Host's server (ADR 0004, ADR 0005, ADR 0006). By default it binds 127.0.0.1 only; in network mode it binds
//! every interface and advertises itself on mDNS (network.rs). Either way it refuses any request whose Host header
//! is not one of its own names, so a web page that rebinds its own domain to the Host cannot reach it.
//!
//! - `GET /health`: name, version, protocol version, capabilities, hub name. No token.
//! - `GET /ws`: the Client protocol (packages/protocol): pairing, then timeline events.
//! - `PUT|GET /blobs/{id}`, `GET /api/sessions`, `GET /api/sessions/{id}/events`, `GET /api/items`,
//!   `GET /api/state` (what the TUI shows), `POST /api/clients/{id}/commands` (drive a Client's Session): Bearer
//!   token, a Client's from pairing or an agent token.
//! - `/mcp`: MCP over Streamable HTTP for agents (mcp.rs). No token from this machine; from another machine (network
//!   mode) a Bearer token. Never from a web page origin.
//! - `/api/host/*`: the control API (control.rs). This machine only, with the control token from `host.json`.

#[cfg(test)]
mod contract;
mod control;
mod guard;
mod http;
mod hub;
mod mcp;
mod network;
mod pairing;
mod state;
mod ws;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::{get, put};
use inkup_store::Store;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use control::{ActivateHook, Control};
pub use hub::{Command, CommandError, CommandOutcome, Connected, Hub, Push, Watcher};
pub use network::{
    DEFAULT_MDNS_NAME, MAX_NAME_SUFFIX, NETWORK_WARNING, Network, NetworkConfig, SERVICE_TYPE, lan_addresses,
};
pub use pairing::{PairingDecision, PairingRequest, RemotePairing};
pub use state::{ClientView, HostState, ItemView, Timeline, TimelineEntry, snapshot};

/// The Host's well-known port; Clients look for it here.
pub const DEFAULT_PORT: u16 = 47823;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct Config {
    /// 0 picks a free port (tests).
    pub port: u16,
    /// Network mode (ADR 0006): bind every interface and advertise on mDNS. `None`: loopback only.
    pub network: Option<NetworkConfig>,
    /// What the Host goes by on the network: /health and the mDNS instance name.
    pub hub_name: Option<String>,
    /// Approve every pairing request from this machine without asking. Test-only: any local process could pair.
    /// Pairing from another machine still needs its code.
    pub auto_approve_pairing: bool,
    /// How long a pairing request waits for the user before it fails.
    pub pairing_timeout: Duration,
    /// How long a code for pairing from another machine lasts.
    pub pairing_code_ttl: Duration,
    /// How long a new connection has to send `hello`.
    pub hello_timeout: Duration,
    /// Treat every peer, loopback too, as another machine. Tests only: the rules for other machines, without one.
    pub every_peer_is_remote: bool,
    /// The control API (`/api/host/*`): its token, the host's kind and the activate hook. `None`: closed.
    pub control: Option<Control>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            network: None,
            hub_name: None,
            auto_approve_pairing: false,
            pairing_timeout: Duration::from_secs(120),
            pairing_code_ttl: Duration::from_secs(120),
            hello_timeout: Duration::from_secs(10),
            every_peer_is_remote: false,
            control: None,
        }
    }
}

#[derive(Clone)]
struct AppState {
    store: Arc<Store>,
    config: Arc<Config>,
    port: u16,
    pairing: mpsc::Sender<PairingRequest>,
    codes: Arc<pairing::PairingCodes>,
    hub: Arc<Hub>,
    network: Option<Arc<Network>>,
    /// Ends WebSocket connections on shutdown: an upgraded connection outlives graceful shutdown otherwise.
    closing: CancellationToken,
}

/// A running server.
pub struct Server {
    pub addr: SocketAddr,
    pairing_requests: Option<mpsc::Receiver<PairingRequest>>,
    hub: Arc<Hub>,
    network: Option<Arc<Network>>,
    shutdown: oneshot::Sender<()>,
    mcp_shutdown: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
}

impl Server {
    /// The pairing requests for the user to approve (the TUI, or a terminal prompt). With `auto_approve_pairing`
    /// nothing arrives. Once taken, `None`; if never taken, requests wait until they time out.
    pub fn take_pairing_requests(&mut self) -> Option<mpsc::Receiver<PairingRequest>> {
        self.pairing_requests.take()
    }

    /// What the server's parts share: changes, pushes to Clients, agent watchers.
    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    /// In network mode: the `.local` name and addresses the Host is known by.
    pub fn network(&self) -> Option<&Arc<Network>> {
        self.network.as_ref()
    }

    /// Stops accepting connections, closes the open ones and waits for the server task.
    pub async fn shutdown(self) -> std::io::Result<()> {
        if let Some(network) = &self.network {
            network.shutdown();
        }
        // MCP streams stay open while an agent watches, and Client sockets while a browser is connected; end
        // them so graceful shutdown can finish and a restart finds nothing left over.
        self.mcp_shutdown.cancel();
        let _ = self.shutdown.send(());
        self.task.await.unwrap_or_else(|e| Err(std::io::Error::other(e)))
    }
}

/// Binds 127.0.0.1:`config.port` (every interface in network mode) and serves until `Server::shutdown`.
pub async fn start(store: Arc<Store>, config: Config) -> std::io::Result<Server> {
    let ip = if config.network.is_some() { IpAddr::V4(Ipv4Addr::UNSPECIFIED) } else { IpAddr::V4(Ipv4Addr::LOCALHOST) };
    let listener = TcpListener::bind((ip, config.port)).await?;
    let addr = listener.local_addr()?;
    let (pairing_tx, pairing_rx) = mpsc::channel(8);
    let hub = Arc::new(Hub::default());
    let network = config.network.as_ref().map(|network| {
        let hub_name = config.hub_name.clone().unwrap_or_else(|| "inkup".into());
        Arc::new(Network::start(network, &hub_name, addr.port()))
    });
    let mcp_shutdown = CancellationToken::new();
    let state = AppState {
        store,
        codes: Arc::new(pairing::PairingCodes::new(config.pairing_code_ttl)),
        config: Arc::new(config),
        port: addr.port(),
        pairing: pairing_tx,
        hub: Arc::clone(&hub),
        network: network.clone(),
        closing: mcp_shutdown.child_token(),
    };
    let app = router(state, mcp_shutdown.child_token());
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    tracing::info!(%addr, network = network.is_some(), "inkup host listening");
    Ok(Server { addr, pairing_requests: Some(pairing_rx), hub, network, shutdown: shutdown_tx, mcp_shutdown, task })
}

fn router(state: AppState, mcp_shutdown: CancellationToken) -> Router {
    let network = state.network.is_some();
    let mcp = mcp::service(Arc::clone(&state.store), Arc::clone(&state.hub), mcp_shutdown, network);
    Router::new()
        .route("/health", get(http::health))
        .route("/ws", get(ws::upgrade))
        .route("/blobs/{id}", put(http::put_blob).get(http::get_blob))
        .route("/api/sessions", get(http::sessions))
        .route("/api/sessions/{id}/events", get(http::session_events))
        .route("/api/items", get(http::items))
        .route("/api/state", get(http::state))
        .route("/api/clients/{id}/commands", axum::routing::post(http::command))
        .route("/api/host/state", get(control::state))
        .route("/api/host/activate", axum::routing::post(control::activate))
        .nest_service("/mcp", mcp)
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::guard))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard fails closed: served without `ConnectInfo`, even a loopback caller counts as another machine.
    #[tokio::test]
    async fn without_connect_info_every_peer_needs_a_token() {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Config { port, ..Config::default() };
        let state = AppState {
            store: Arc::new(Store::open(dir.path()).unwrap()),
            codes: Arc::new(pairing::PairingCodes::new(config.pairing_code_ttl)),
            config: Arc::new(config),
            port,
            pairing: mpsc::channel(1).0,
            hub: Arc::new(Hub::default()),
            network: None,
            closing: CancellationToken::new(),
        };
        let app = router(state, CancellationToken::new());
        // `into_make_service`, not `into_make_service_with_connect_info`: requests carry no peer address.
        let server = tokio::spawn(async move { axum::serve(listener, app.into_make_service()).await });

        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        let mcp = client
            .post(format!("{base}/mcp"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(mcp.status(), 401);
        assert_eq!(mcp.headers().get("www-authenticate").unwrap(), "Bearer");
        let api = client.get(format!("{base}/api/sessions")).send().await.unwrap();
        assert_eq!(api.status(), 401);
        let health = client.get(format!("{base}/health")).send().await.unwrap();
        assert_eq!(health.status(), 200, "/health needs no token");
        server.abort();
    }
}
