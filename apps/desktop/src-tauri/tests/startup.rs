//! Find or host, against a real in-process server: host mode, client mode (a CLI host on the data dir), another
//! desktop app (asked to come forward), a host that speaks another control API, a CLI host that goes away
//! ("Host here"), and network mode switched from the window.
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use inkup_desktop::link::HostLink;
use inkup_desktop::startup::{Hosting, Startup, StartupError, find_or_host};
use inkup_protocol::control::{PairingAnswer, PairingAnswerDecision};
use inkup_server::{ActivateHook, Config, Control, NetworkHook, Server};
use inkup_store::instance::{HOST_FILE, HostKind, HostLock, holder};
use inkup_store::{HostConfig, Store};
use inkup_update_check::{Checked, now, write_cache};

/// Any free port, hooks that do nothing, no mDNS.
fn hosting() -> Hosting {
    with_activate(ActivateHook::new(|| {}))
}

fn with_activate(on_activate: ActivateHook) -> Hosting {
    Hosting { advertise: false, update_check: false, ..Hosting::new(0, on_activate, NetworkHook::new(|_| {})) }
}

/// What `inkup serve` does: the lock, the server with the control API, then host.json.
async fn cli_host(dir: &Path) -> (HostLock, Server) {
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

#[tokio::test]
async fn nobody_on_the_data_dir_so_the_app_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let Startup::Host { link, hosted } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected host mode");
    };
    let published = holder(dir.path()).unwrap().expect("host.json");
    assert_eq!(published.kind, HostKind::Desktop);
    assert_eq!(published.port, link.port());
    let state = link.state(None).await.unwrap();
    assert_eq!(state.kind.to_string(), "desktop");
    assert_eq!(state.address, link.address());
    assert!(state.state.sessions.is_empty());

    hosted.shutdown().await;
    assert_eq!(holder(dir.path()).unwrap(), None, "Quit gives up the data dir");
    assert!(matches!(find_or_host(dir.path(), &hosting()).await.unwrap(), Startup::Host { .. }));
}

#[tokio::test]
async fn a_cli_host_on_the_data_dir_makes_the_app_its_client() {
    let dir = tempfile::tempdir().unwrap();
    let (_lock, server) = cli_host(dir.path()).await;
    let Startup::Client { link, holder } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected client mode");
    };
    assert_eq!(holder.kind, HostKind::Serve);
    assert_eq!(link.port(), server.addr.port());
    let state = link.state(None).await.unwrap();
    assert_eq!(state.kind.to_string(), "serve");
    // The CLI host has no window to bring forward.
    assert!(!link.activate().await.unwrap());
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_second_app_on_the_data_dir_brings_the_first_forward() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let hook = {
        let calls = Arc::clone(&calls);
        ActivateHook::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
        })
    };
    let Startup::Host { hosted, .. } = find_or_host(dir.path(), &with_activate(hook)).await.unwrap() else {
        panic!("expected host mode");
    };
    let Startup::Activated(first) = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected the second launch to hand over");
    };
    assert_eq!(first.kind, HostKind::Desktop);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    hosted.shutdown().await;
}

#[tokio::test]
async fn a_host_with_another_control_api_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (lock, server) = cli_host(dir.path()).await;
    let file = dir.path().join(HOST_FILE);
    let mut info: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    info["control_api"] = 99.into();
    info["version"] = "9.0.0".into();
    std::fs::write(&file, info.to_string()).unwrap();

    let Err(error) = find_or_host(dir.path(), &hosting()).await else { panic!("expected a refusal") };
    assert!(matches!(error, StartupError::Incompatible(_)));
    let message = error.to_string();
    assert!(message.contains("InkUp 9.0.0 (inkup serve)"), "{message}");
    assert!(message.contains("Update it or the app"), "{message}");
    server.shutdown().await.unwrap();
    drop(lock);
}

#[tokio::test]
async fn the_link_needs_the_control_token() {
    let dir = tempfile::tempdir().unwrap();
    let (_lock, server) = cli_host(dir.path()).await;
    let wrong = HostLink::new(server.addr.port(), "not-the-token");
    let error = wrong.state(None).await.unwrap_err().to_string();
    assert!(error.contains("refused (403)"), "{error}");
    server.shutdown().await.unwrap();
}

/// The window's "Host here" after the CLI host quits: the data dir is free, so the app hosts it.
#[tokio::test]
async fn once_the_cli_host_quits_the_app_can_host_here() {
    let dir = tempfile::tempdir().unwrap();
    let (lock, server) = cli_host(dir.path()).await;
    let Startup::Client { link, .. } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected client mode");
    };
    server.shutdown().await.unwrap();
    drop(lock);
    assert!(link.state(None).await.is_err(), "the window sees the host gone");

    let Startup::Host { link, hosted } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected host mode");
    };
    assert_eq!(holder(dir.path()).unwrap().unwrap().kind, HostKind::Desktop);
    assert_eq!(link.state(None).await.unwrap().kind.to_string(), "desktop");
    hosted.shutdown().await;
}

/// The app hosting asks about pairing in the window: pending in the state, answered through the link.
#[tokio::test]
async fn the_app_hosting_asks_about_pairing_in_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let Startup::Host { link, hosted } = find_or_host(dir.path(), &hosting()).await.unwrap() else {
        panic!("expected host mode");
    };
    let hello =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contract/fixtures/hello.unpaired.json"))
            .unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", link.address())).await.unwrap();
    ws.send(hello.into()).await.unwrap();
    let pending = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(first) = link.state(None).await.unwrap().pending_pairing.into_iter().next() {
                return first;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(pending.remote.is_none());
    let approve = PairingAnswer { decision: PairingAnswerDecision::Approve };
    link.answer_pairing(u64::try_from(pending.id).unwrap(), &approve).await.unwrap();
    let paired = ws.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(paired.contains("\"paired\""), "{paired}");
    hosted.shutdown().await;
}

/// The window's network switch: saved in config.toml, the server back on the same port on every interface,
/// host.json unchanged, and off again.
#[tokio::test]
async fn network_mode_restarts_the_server_on_the_same_port() {
    let dir = tempfile::tempdir().unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let on_network = {
        let asked = Arc::clone(&asked);
        NetworkHook::new(move |on| asked.lock().unwrap().push(on))
    };
    let hosting = Hosting { on_network, ..hosting() };
    let Startup::Host { link, hosted } = find_or_host(dir.path(), &hosting).await.unwrap() else {
        panic!("expected host mode");
    };
    let state = link.state(None).await.unwrap();
    assert!(state.network_switch && state.network.is_none());
    // The window asks through the control API; the hook is the app's cue to restart.
    assert!(link.network(true).await.unwrap());
    assert_eq!(*asked.lock().unwrap(), vec![true]);

    let before = holder(dir.path()).unwrap().unwrap();
    let hosted = hosted.switch_network(true).await.unwrap();
    assert!(HostConfig::load(dir.path()).unwrap().network, "saved");
    assert!(hosted.server.addr.ip().is_unspecified(), "every interface");
    assert_eq!(hosted.server.addr.port(), link.port());
    assert_eq!(holder(dir.path()).unwrap().unwrap(), before, "host.json unchanged");
    assert!(link.state(None).await.unwrap().network.is_some(), "the same link reads it");

    let hosted = hosted.switch_network(false).await.unwrap();
    assert!(!HostConfig::load(dir.path()).unwrap().network);
    assert!(hosted.server.addr.ip().is_loopback());
    assert!(link.state(None).await.unwrap().network.is_none());
    hosted.shutdown().await;

    // A restart of the app hosts as config.toml says.
    HostConfig::save_network(dir.path(), true).unwrap();
    let Startup::Host { hosted, .. } = find_or_host(dir.path(), &hosting).await.unwrap() else {
        panic!("expected host mode");
    };
    assert!(hosted.server.addr.ip().is_unspecified());
    hosted.shutdown().await;
}

/// The app hosting runs the daily update check, as the TUI and `serve` do: the window's "Update available" reads
/// it from the state, and it outlives a network-mode restart. A fresh cache stands in for GitHub.
#[tokio::test]
async fn the_app_hosting_checks_for_updates() {
    let dir = tempfile::tempdir().unwrap();
    write_cache(dir.path(), &Checked { at: now(), latest: Some("99.0.0".into()), protocol: None }).unwrap();
    let hosting = Hosting { update_check: true, ..hosting() };
    let Startup::Host { link, hosted } = find_or_host(dir.path(), &hosting).await.unwrap() else {
        panic!("expected host mode");
    };
    let update = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(update) = link.state(None).await.unwrap().update {
                return update;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the state carries the update notice");
    assert!(update.starts_with("InkUp 99.0.0 is out: "), "{update}");

    let hosted = hosted.switch_network(false).await.unwrap();
    assert_eq!(link.state(None).await.unwrap().update.as_deref(), Some(update.as_str()), "kept across a restart");
    hosted.shutdown().await;
}
