//! The Clients dot against a real in-process server, read the way the window reads it (`HostLink::state`), in host
//! mode and client mode: no dot, a steady dot once a Client pairs, a pulse while its Session is live, steady while
//! it is paused, and steady again, with the pulse stopped, once the Session ends.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use inkup_desktop::icon::{Clients, Dot, DotDriver, PULSE_BEAT};
use inkup_desktop::link::HostLink;
use inkup_desktop::startup::{Hosting, Startup, find_or_host};
use inkup_protocol::control::{PairingAnswer, PairingAnswerDecision};
use inkup_server::{ActivateHook, Config, Control, NetworkHook};
use inkup_store::Store;
use inkup_store::instance::{HostKind, HostLock};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../../contract/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn hosting() -> Hosting {
    Hosting { advertise: false, ..Hosting::new(0, ActivateHook::new(|| {}), NetworkHook::new(|_| {})) }
}

/// A driver that records the frames it shows.
fn driver() -> (DotDriver, Arc<Mutex<Vec<Dot>>>) {
    let shown = Arc::new(Mutex::new(Vec::new()));
    let driver = {
        let shown = Arc::clone(&shown);
        DotDriver::new(move |dot| shown.lock().unwrap().push(dot))
    };
    (driver, shown)
}

/// What the `host_state` command does: read the state through the link and follow it.
async fn read(link: &HostLink, dot: &DotDriver) -> Clients {
    dot.follow(&link.state(None).await);
    dot.clients()
}

/// Reads until the dot says `want`, as the window's refetches would.
async fn until(link: &HostLink, dot: &DotDriver, want: Clients) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while read(link, dot).await != want {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the dot never said {want:?}"));
}

async fn send(ws: &mut Ws, message: Value) {
    ws.send(Message::text(message.to_string())).await.unwrap();
}

/// The next message of `type`, skipping any other.
async fn next(ws: &mut Ws, kind: &str) -> Value {
    loop {
        let text = ws.next().await.unwrap().unwrap().into_text().unwrap();
        let message: Value = serde_json::from_str(&text).unwrap();
        if message["type"] == kind {
            return message;
        }
    }
}

/// The Client's Session: live, then pulsing, then ended and steady.
async fn live_then_ended(link: &HostLink, dot: &DotDriver, shown: &Mutex<Vec<Dot>>, ws: &mut Ws) {
    let before = shown.lock().unwrap().len();
    send(ws, fixture("event.session_start.json")).await;
    next(ws, "ack").await;
    until(link, dot, Clients::Live).await;
    assert!(dot.pulsing());
    tokio::time::sleep(PULSE_BEAT * 3 + PULSE_BEAT / 2).await;
    // Full at once, then faint and full every half second.
    let pulse = shown.lock().unwrap()[before..].to_vec();
    assert!(pulse.len() >= 3, "{pulse:?}");
    for (i, dot) in pulse.iter().enumerate() {
        assert_eq!(*dot, if i % 2 == 0 { Dot::Full } else { Dot::Faint }, "{pulse:?}");
    }

    // Paused: not sending, so a steady dot and no pulse; resumed, the pulse is back.
    send(ws, fixture("event.session_pause.json")).await;
    next(ws, "ack").await;
    until(link, dot, Clients::Paired).await;
    assert!(!dot.pulsing());
    assert_eq!(shown.lock().unwrap().last(), Some(&Dot::Full), "steady while paused");
    let frames = shown.lock().unwrap().len();
    tokio::time::sleep(PULSE_BEAT * 3).await;
    assert_eq!(shown.lock().unwrap().len(), frames, "no pulse while paused");
    send(ws, fixture("event.session_resume.json")).await;
    next(ws, "ack").await;
    until(link, dot, Clients::Live).await;
    assert!(dot.pulsing());

    send(ws, fixture("event.session_end.json")).await;
    next(ws, "ack").await;
    until(link, dot, Clients::Paired).await;
    assert!(!dot.pulsing());
    assert_eq!(shown.lock().unwrap().last(), Some(&Dot::Full), "steady");
    let frames = shown.lock().unwrap().len();
    tokio::time::sleep(PULSE_BEAT * 3).await;
    assert_eq!(shown.lock().unwrap().len(), frames, "no timer work once no Session is live");
}

#[tokio::test]
async fn the_dot_follows_the_clients_when_the_app_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let Startup::Host { link, hosted } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected host mode");
    };
    let (dot, shown) = driver();
    assert_eq!(read(&link, &dot).await, Clients::Unpaired);
    assert!(shown.lock().unwrap().is_empty(), "no Client, no dot");
    assert!(!dot.pulsing());

    // A Client pairs, asked in the window.
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", link.address())).await.unwrap();
    send(&mut ws, fixture("hello.unpaired.json")).await;
    let pending = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(first) = link.state(None).await.unwrap().pending_pairing.into_iter().next() {
                return first;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let approve = PairingAnswer { decision: PairingAnswerDecision::Approve };
    link.answer_pairing(u64::try_from(pending.id).unwrap(), &approve).await.unwrap();
    next(&mut ws, "paired").await;
    until(&link, &dot, Clients::Paired).await;
    assert_eq!(*shown.lock().unwrap(), [Dot::Full], "a steady dot");
    assert!(!dot.pulsing());

    live_then_ended(&link, &dot, &shown, &mut ws).await;
    hosted.shutdown().await;
}

/// Client mode: `inkup serve` hosts with a Client already paired, and the app reads its state.
#[tokio::test]
async fn the_dot_follows_the_clients_of_a_cli_host() {
    let dir = tempfile::tempdir().unwrap();
    let token = Store::open(dir.path()).unwrap().pair_client("chrome", "Chrome on MacBook").unwrap().token;
    let (lock, server) = cli_host(dir.path()).await;
    let Startup::Client { link, .. } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected client mode");
    };
    let (dot, shown) = driver();
    assert_eq!(read(&link, &dot).await, Clients::Paired, "paired, not connected: still a steady dot");
    assert_eq!(*shown.lock().unwrap(), [Dot::Full]);

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", link.address())).await.unwrap();
    let mut hello = fixture("hello.token.json");
    hello["token"] = token.into();
    send(&mut ws, hello).await;
    next(&mut ws, "welcome").await;
    live_then_ended(&link, &dot, &shown, &mut ws).await;

    // The CLI host goes away: nothing to show.
    server.shutdown().await.unwrap();
    drop(lock);
    assert_eq!(read(&link, &dot).await, Clients::Unpaired);
    assert_eq!(shown.lock().unwrap().last(), Some(&Dot::None));
}

/// What `inkup serve` does: the lock, the server with the control API, then host.json.
async fn cli_host(dir: &Path) -> (HostLock, inkup_server::Server) {
    let lock = HostLock::acquire(dir, HostKind::Serve).unwrap();
    let control = Control {
        token: lock.control_token().into(),
        kind: HostKind::Serve,
        on_activate: None,
        on_network: None,
        update: None,
    };
    let store = Arc::new(Store::open(dir).unwrap());
    let server =
        inkup_server::start(store, Config { port: 0, control: Some(control), ..Config::default() }).await.unwrap();
    lock.publish(server.addr.port(), "0.1.0").unwrap();
    (lock, server)
}
