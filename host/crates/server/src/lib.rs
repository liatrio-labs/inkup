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
//!   mode) a Bearer token. A Remote Host (remote.rs, ADR 0030) requires one from every peer, 127.0.0.1 included.
//!   Never from a web page origin.
//! - `/api/host/*`: the control API (control.rs). This machine only, with the control token from `host.json`.
//!   A Remote Host does not serve it on the public listener; it listens on 127.0.0.1 apart from that bind.
//!   `inkup pairing` issues codes there. With a certificate and key, a Remote Host serves HTTPS on the public
//!   bind (rustls); the certificate is read at start and again only when the process starts over.

#[cfg(test)]
mod contract;
mod control;
mod guard;
mod http;
mod hub;
mod mcp;
mod network;
mod pairing;
mod remote;
mod state;
mod ws;

use std::fmt::Display;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};

use axum::Router;
use axum::routing::{get, put};
use inkup_store::Store;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use control::{ActivateHook, Control, NetworkHook};
pub use hub::{Command, CommandError, CommandOutcome, Connected, Hub, Push, Watcher};
pub use network::{
    DEFAULT_MDNS_NAME, MAX_NAME_SUFFIX, NETWORK_WARNING, Network, NetworkConfig, SERVICE_TYPE, lan_addresses,
};
pub use pairing::{
    OPERATOR_CODE_CAP, OPERATOR_CODE_DIGITS, OPERATOR_GUESS_BUDGET, OPERATOR_TTL_DEFAULT, OPERATOR_TTL_MAX,
    OPERATOR_TTL_MIN, PairingDecision, PairingRequest, RemotePairing,
};
pub use remote::{DEFAULT_BIND, PublicUrl, RemoteHost};
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
    /// Treat every peer, loopback too, as another machine. A Remote Host sets this. Tests set it without one, to
    /// exercise the rules for other machines.
    pub every_peer_is_remote: bool,
    /// A Remote Host (ADR 0030): the https public URL and the bind address. `None`: loopback or Network mode.
    pub remote: Option<RemoteHost>,
    /// PEM certificate and key. Set only with `remote`: the public bind then speaks HTTPS. Both paths, or
    /// neither. Read when the process starts; a restart is what picks up a new file.
    pub tls: Option<TlsMaterial>,
    /// The control API (`/api/host/*`): its token, the host's kind and the activate hook. `None`: closed.
    pub control: Option<Control>,
}

/// Certificate and key a Remote Host serves with. The paths are the ones the operator gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsMaterial {
    pub cert: PathBuf,
    pub key: PathBuf,
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
            remote: None,
            tls: None,
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
    operator_codes: Arc<pairing::OperatorCodes>,
    /// True on a Remote Host, including the loopback control listener, whose `config.remote` is cleared.
    operator_pairing: bool,
    /// The https origin a Pair link names. Set together with `operator_pairing`.
    public_origin: Option<String>,
    hub: Arc<Hub>,
    network: Option<Arc<Network>>,
    /// Pairing requests the control API asks about, once `Server::ask_pairing_over_control` is called.
    inbox: Arc<control::PairingInbox>,
    /// Ends WebSocket connections on shutdown: an upgraded connection outlives graceful shutdown otherwise.
    closing: CancellationToken,
}

/// A running server.
pub struct Server {
    pub addr: SocketAddr,
    /// The loopback control API, when this is a Remote Host and `Config::control` is set. Not the public bind.
    pub control_addr: Option<SocketAddr>,
    pairing_requests: Option<mpsc::Receiver<PairingRequest>>,
    codes: Arc<pairing::PairingCodes>,
    hub: Arc<Hub>,
    network: Option<Arc<Network>>,
    inbox: Arc<control::PairingInbox>,
    shutdown: CancellationToken,
    mcp_shutdown: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
    control_task: Option<JoinHandle<std::io::Result<()>>>,
}

impl Server {
    /// The pairing requests for the user to approve (the TUI, or a terminal prompt). With `auto_approve_pairing`
    /// nothing arrives. Once taken, `None`; if never taken, requests wait until they time out.
    pub fn take_pairing_requests(&mut self) -> Option<mpsc::Receiver<PairingRequest>> {
        self.pairing_requests.take()
    }

    /// Has the control API ask about pairing requests (`pending_pairing` in its state, answered at
    /// `POST /api/host/pairing/{id}`), for an embedder with no screen of its own for them. False once taken.
    pub fn ask_pairing_over_control(&mut self) -> bool {
        let Some(mut requests) = self.pairing_requests.take() else { return false };
        let (inbox, hub) = (Arc::clone(&self.inbox), Arc::clone(&self.hub));
        // Ends with the server: its sender goes with it.
        tokio::spawn(async move {
            while let Some(request) = requests.recv().await {
                inbox.push(request);
                hub.view_changed();
            }
        });
        true
    }

    /// What the server's parts share: changes, pushes to Clients, agent watchers.
    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    /// In network mode: the `.local` name and addresses the Host is known by.
    pub fn network(&self) -> Option<&Arc<Network>> {
        self.network.as_ref()
    }

    /// Pairing codes waiting to be typed. A Remote Host's hello leaves this at zero.
    pub fn pairing_codes_waiting(&self) -> usize {
        self.codes.waiting()
    }

    /// Stops accepting connections, closes the open ones and waits for the server task.
    pub async fn shutdown(self) -> std::io::Result<()> {
        if let Some(network) = &self.network {
            network.shutdown();
        }
        // MCP streams stay open while an agent watches, and Client sockets while a browser is connected; end
        // them so graceful shutdown can finish and a restart finds nothing left over.
        self.mcp_shutdown.cancel();
        self.shutdown.cancel();
        let public = self.task.await.unwrap_or_else(|e| Err(std::io::Error::other(e)));
        let control = match self.control_task {
            Some(task) => task.await.unwrap_or_else(|e| Err(std::io::Error::other(e))),
            None => Ok(()),
        };
        public.and(control)
    }
}

/// Binds 127.0.0.1:`config.port` (every interface in network mode, or `RemoteHost::bind` for a Remote Host) and
/// serves until `Server::shutdown`.
pub async fn start(store: Arc<Store>, mut config: Config) -> std::io::Result<Server> {
    if config.remote.is_some() && config.network.is_some() {
        return Err(std::io::Error::new(ErrorKind::InvalidInput, "a Remote Host does not use network mode"));
    }
    if config.tls.is_some() && config.remote.is_none() {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "TLS is only for a Remote Host; Network mode stays unencrypted",
        ));
    }
    // A bad certificate fails here, before the listen socket exists.
    let tls = match &config.tls {
        Some(material) => Some(load_tls(material)?),
        None => None,
    };
    if config.remote.is_some() {
        config.every_peer_is_remote = true;
    }
    let ip = if let Some(remote) = &config.remote {
        remote.bind
    } else if config.network.is_some() {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let listener = TcpListener::bind((ip, config.port)).await?;
    let addr = listener.local_addr()?;
    let (pairing_tx, pairing_rx) = mpsc::channel(8);
    let hub = Arc::new(Hub::default());
    let network = config.network.as_ref().map(|network| {
        let hub_name = config.hub_name.clone().unwrap_or_else(|| "inkup".into());
        let hub = Arc::clone(&hub);
        Arc::new(Network::start(network, &hub_name, addr.port(), move || hub.view_changed()))
    });
    let mcp_shutdown = CancellationToken::new();
    let shutdown = CancellationToken::new();
    let inbox = Arc::new(control::PairingInbox::default());
    let codes = Arc::new(pairing::PairingCodes::new(config.pairing_code_ttl));
    let operator_codes = Arc::new(pairing::OperatorCodes::new());
    let remote = config.remote.is_some();
    let public_origin = config.remote.as_ref().map(|remote| remote.public_url.origin().to_owned());
    let state = AppState {
        store,
        inbox: Arc::clone(&inbox),
        codes: Arc::clone(&codes),
        operator_codes,
        operator_pairing: remote,
        public_origin,
        config: Arc::new(config),
        port: addr.port(),
        pairing: pairing_tx,
        hub: Arc::clone(&hub),
        network: network.clone(),
        closing: mcp_shutdown.child_token(),
    };
    let (control_addr, control_task) = match (remote, state.config.control.is_some()) {
        (true, true) => {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
            let control_addr = listener.local_addr()?;
            let control_state = control_state(&state, control_addr.port());
            let stop = shutdown.clone();
            // `/health` here is plain HTTP on loopback, so `inkup status` and the image health check can
            // reach a Host whose public port speaks HTTPS.
            let app = finish(control_routes(Router::new()).route("/health", get(http::health)), control_state, None);
            let task = tokio::spawn(async move {
                axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                    .with_graceful_shutdown(async move { stop.cancelled().await })
                    .await
            });
            (Some(control_addr), Some(task))
        }
        _ => (None, None),
    };
    let app = router(state, mcp_shutdown.child_token());
    let stop = shutdown.clone();
    let task = if let Some(config) = tls {
        let listener = RustlsListener::new(listener, config)?;
        // No `ConnectInfo`: axum's `Connected` for `SocketAddr` cannot be implemented for a listener this crate
        // defines. A missing peer fails closed (guard.rs), which is what a Remote Host already requires.
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .with_graceful_shutdown(async move { stop.cancelled().await })
                .await
        })
    } else {
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move { stop.cancelled().await })
                .await
        })
    };
    tracing::info!(%addr, ?control_addr, network = network.is_some(), remote, "inkup host listening");
    Ok(Server {
        addr,
        control_addr,
        pairing_requests: Some(pairing_rx),
        codes,
        hub,
        network,
        inbox,
        shutdown,
        mcp_shutdown,
        task,
        control_task,
    })
}

/// The control listener is loopback, and loopback is a boundary there: the public listener is the one a proxy
/// dials, and it does not serve `/api/host/*`.
fn control_state(state: &AppState, port: u16) -> AppState {
    let mut config = (*state.config).clone();
    config.every_peer_is_remote = false;
    config.remote = None;
    config.network = None;
    AppState { config: Arc::new(config), port, ..state.clone() }
}

fn router(state: AppState, mcp_shutdown: CancellationToken) -> Router {
    let remote = state.config.remote.is_some();
    let mcp = mcp::service(
        Arc::clone(&state.store),
        Arc::clone(&state.hub),
        mcp_shutdown,
        state.network.is_some() || remote,
        remote,
    );
    // A Remote Host's public listener has no control routes, so a proxy on 127.0.0.1 cannot reach them.
    let app = if remote { public_routes(Router::new()) } else { control_routes(public_routes(Router::new())) };
    finish(app, state, Some(mcp))
}

fn public_routes(app: Router<AppState>) -> Router<AppState> {
    app.route("/health", get(http::health))
        .route("/ws", get(ws::upgrade))
        .route("/blobs/{id}", put(http::put_blob).get(http::get_blob))
        .route("/api/sessions", get(http::sessions))
        .route("/api/sessions/{id}/events", get(http::session_events))
        .route("/api/items", get(http::items))
        .route("/api/state", get(http::state))
        .route("/api/clients/{id}/commands", axum::routing::post(http::command))
}

fn control_routes(app: Router<AppState>) -> Router<AppState> {
    app.route("/api/host/state", get(control::state))
        .route("/api/host/activate", axum::routing::post(control::activate))
        .route("/api/host/changes", get(control::changes))
        .route("/api/host/commands", axum::routing::post(control::command))
        .route("/api/host/tokens", axum::routing::post(control::create_token))
        .route("/api/host/tokens/{id}", axum::routing::delete(control::revoke_token))
        .route("/api/host/network", axum::routing::post(control::network))
        .route(
            "/api/host/pairing/codes",
            axum::routing::get(control::list_pairing_codes).post(control::create_pairing_code),
        )
        .route("/api/host/pairing/codes/{id}", axum::routing::delete(control::revoke_pairing_code))
        .route("/api/host/pairing/{id}", axum::routing::post(control::answer_pairing))
        .route("/api/host/items/{id}", get(control::item))
        .route("/api/host/items/{id}/tracker-links", axum::routing::post(control::record_tracker_link))
        .route("/api/host/blobs/{id}", get(control::blob))
}

fn finish(app: Router<AppState>, state: AppState, mcp: Option<mcp::Service>) -> Router {
    let app = match mcp {
        Some(mcp) => app.nest_service("/mcp", mcp),
        None => app,
    };
    app.layer(axum::middleware::from_fn_with_state(state.clone(), guard::guard)).with_state(state)
}

/// Reads the PEM pair into a rustls config. Failure names the path and does not touch a socket.
fn load_tls(material: &TlsMaterial) -> std::io::Result<Arc<rustls::ServerConfig>> {
    // The process may already have installed one (the update client's reqwest). A second install is an error
    // we ignore; with none installed, `ServerConfig::builder` has no provider.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let certs = read_certs(&material.cert)?;
    let key = read_key(&material.key)?;
    let config =
        rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key).map_err(|error| {
            std::io::Error::new(
                ErrorKind::InvalidInput,
                format!("{} and {}: {error}", material.cert.display(), material.key.display()),
            )
        })?;
    Ok(Arc::new(config))
}

fn read_certs(path: &Path) -> std::io::Result<Vec<CertificateDer<'static>>> {
    let bytes = std::fs::read(path).map_err(|error| tls_error(path, error))?;
    let mut reader = std::io::BufReader::new(bytes.as_slice());
    let certs =
        rustls_pemfile::certs(&mut reader).collect::<Result<Vec<_>, _>>().map_err(|error| tls_error(path, error))?;
    if certs.is_empty() {
        return Err(tls_error(path, "no certificate in the PEM"));
    }
    Ok(certs)
}

fn read_key(path: &Path) -> std::io::Result<PrivateKeyDer<'static>> {
    let bytes = std::fs::read(path).map_err(|error| tls_error(path, error))?;
    let mut reader = std::io::BufReader::new(bytes.as_slice());
    rustls_pemfile::private_key(&mut reader)
        .map_err(|error| tls_error(path, error))?
        .ok_or_else(|| tls_error(path, "no private key in the PEM"))
}

fn tls_error(path: &Path, error: impl Display) -> std::io::Error {
    std::io::Error::new(ErrorKind::InvalidInput, format!("{}: {error}", path.display()))
}

/// How long one socket may sit in the handshake. A client that never sends a ClientHello must not hold the
/// listener: axum calls `accept` one at a time.
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The public listener once a Remote Host terminates TLS itself. The control listener stays plain HTTP.
///
/// Handshakes run beside the accept loop. Finished streams arrive on a channel, so an idle TCP socket cannot
/// stall every other HTTPS request.
struct RustlsListener {
    local_addr: SocketAddr,
    ready: mpsc::Receiver<(tokio_rustls::server::TlsStream<tokio::net::TcpStream>, SocketAddr)>,
    accept_loop: tokio::task::JoinHandle<()>,
}

impl RustlsListener {
    fn new(tcp: TcpListener, config: Arc<rustls::ServerConfig>) -> std::io::Result<Self> {
        let local_addr = tcp.local_addr()?;
        let acceptor = tokio_rustls::TlsAcceptor::from(config);
        let (tx, ready) = mpsc::channel(32);
        let accept_loop = tokio::spawn(async move {
            loop {
                let (sock, addr) = match tcp.accept().await {
                    Ok(pair) => pair,
                    Err(error) => {
                        tracing::debug!(%error, "accept failed");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(sock)).await {
                        Ok(Ok(stream)) => {
                            // The listener is gone: this handshake has nowhere to go.
                            let _ = tx.send((stream, addr)).await;
                        }
                        Ok(Err(error)) => tracing::debug!(%error, "tls handshake failed"),
                        Err(_) => tracing::debug!(%addr, "tls handshake timed out"),
                    }
                });
            }
        });
        Ok(Self { local_addr, ready, accept_loop })
    }
}

impl Drop for RustlsListener {
    fn drop(&mut self) {
        self.accept_loop.abort();
    }
}

impl axum::serve::Listener for RustlsListener {
    type Io = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.ready.recv().await {
            Some(pair) => pair,
            // The accept loop has stopped. Stay pending so shutdown can win the select.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        Ok(self.local_addr)
    }
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
            operator_codes: Arc::new(pairing::OperatorCodes::new()),
            operator_pairing: false,
            public_origin: None,
            config: Arc::new(config),
            port,
            pairing: mpsc::channel(1).0,
            hub: Arc::new(Hub::default()),
            network: None,
            inbox: Arc::default(),
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
