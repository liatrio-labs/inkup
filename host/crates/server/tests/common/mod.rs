//! Shared by the server's integration tests: the real server on an ephemeral port, and a Client's WebSocket.
#![allow(dead_code, reason = "each test binary uses a different subset")]
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use inkup_protocol::{ErrorCode, ServerMessage};
use inkup_server::{Config, Server};
use inkup_store::Store;
use serde_json::{Value, json};
use tokio::net::TcpStream as TokioTcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Socket = WebSocketStream<MaybeTlsStream<TokioTcpStream>>;

pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contract/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// The timeline event of the generated `event.<name>.json` (`pnpm -C packages/protocol fixtures:events`), with `patch`
/// merged over it: objects field by field, anything else replaced.
pub fn timeline_event(name: &str, patch: Value) -> Value {
    fn merge(into: &mut Value, patch: Value) {
        match (into, patch) {
            (Value::Object(into), Value::Object(patch)) => {
                for (key, value) in patch {
                    merge(into.entry(key).or_insert(Value::Null), value);
                }
            }
            (into, patch) => *into = patch,
        }
    }
    let mut event = fixture(&format!("event.{name}.json"))["event"].take();
    merge(&mut event, patch);
    event
}

pub struct Host {
    pub server: Server,
    pub store: Arc<Store>,
    _dir: tempfile::TempDir,
}

impl Host {
    pub async fn start(auto_approve_pairing: bool) -> Self {
        Self::start_with(Config { auto_approve_pairing, ..Config::default() }).await
    }

    /// Port 0 and a short pairing timeout over `config`.
    pub async fn start_with(config: Config) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let config = Config { port: 0, pairing_timeout: Duration::from_secs(5), ..config };
        let server = inkup_server::start(Arc::clone(&store), config).await.unwrap();
        Self { server, store, _dir: dir }
    }

    /// On loopback, also when the server binds every interface.
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.server.addr.port()))
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr())
    }

    pub async fn connect(&self) -> Socket {
        tokio_tungstenite::connect_async(format!("ws://{}/ws", self.addr())).await.unwrap().0
    }

    /// Pairs a new Client over a real WebSocket and returns its token.
    pub async fn pair(&self) -> String {
        let mut ws = self.connect().await;
        send(&mut ws, fixture("hello.unpaired.json")).await;
        let ServerMessage::PairedMessage(paired) = recv(&mut ws).await else { panic!("expected paired") };
        assert_eq!(paired.re.as_str(), "m-1");
        let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome after paired") };
        paired.token.to_string()
    }
}

pub async fn send(ws: &mut Socket, message: Value) {
    ws.send(Message::text(message.to_string())).await.unwrap();
}

pub async fn recv(ws: &mut Socket) -> ServerMessage {
    let next = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("a reply in time");
    match next.expect("socket open").unwrap() {
        Message::Text(text) => serde_json::from_str(&text).unwrap_or_else(|e| panic!("{text}: {e}")),
        other => panic!("expected a text message, got {other:?}"),
    }
}

pub async fn expect_error(ws: &mut Socket, code: ErrorCode) {
    match recv(ws).await {
        ServerMessage::ErrorMessage(error) => assert_eq!(error.code, code, "{}", error.message),
        other => panic!("expected error {code:?}, got {other:?}"),
    }
}

pub fn hello_with(token: &str) -> Value {
    let mut hello = fixture("hello.token.json");
    hello["token"] = json!(token);
    hello
}

/// This machine's first LAN address, if it has one and a connection to it gets through. A firewall can hold a new test
/// binary's incoming data until someone answers the macOS "accept incoming connections?" prompt; the tests that go
/// through the LAN address would then wait forever, so they skip instead. CI has no such firewall and runs them.
pub async fn lan_ip() -> Option<std::net::Ipv4Addr> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Some(ip) = inkup_server::lan_addresses().into_iter().next() else {
        eprintln!("skipped: this machine has no LAN address");
        return None;
    };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let probe = async {
        let (mut client, (mut server, _)) =
            tokio::try_join!(TokioTcpStream::connect((ip, port)), listener.accept()).ok()?;
        client.write_all(b"?").await.ok()?;
        let mut byte = [0u8; 1];
        server.read_exact(&mut byte).await.ok()
    };
    if tokio::time::timeout(Duration::from_secs(3), probe).await.ok().flatten().is_none() {
        eprintln!("skipped: the LAN address {ip} doesn't get through (a firewall prompt for this test binary?)");
        return None;
    }
    Some(ip)
}
