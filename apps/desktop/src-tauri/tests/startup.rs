//! Find or host, against a real in-process server: host mode, client mode (a CLI host on the data dir), another
//! desktop app (asked to come forward), and a host that speaks another control API.
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use inkup_desktop::link::HostLink;
use inkup_desktop::startup::{Startup, StartupError, find_or_host};
use inkup_server::{ActivateHook, Config, Control, Server};
use inkup_store::Store;
use inkup_store::instance::{HOST_FILE, HostKind, HostLock, holder};

fn no_hook() -> ActivateHook {
    ActivateHook::new(|| {})
}

/// What `inkup serve` does: the lock, the server with the control API, then host.json.
async fn cli_host(dir: &Path) -> (HostLock, Server) {
    let lock = HostLock::acquire(dir, HostKind::Serve).unwrap();
    let control =
        Control { token: lock.control_token().into(), kind: HostKind::Serve, on_activate: None, update: None };
    let store = Arc::new(Store::open(dir).unwrap());
    let server =
        inkup_server::start(store, Config { port: 0, control: Some(control), ..Config::default() }).await.unwrap();
    lock.publish(server.addr.port(), "0.1.0").unwrap();
    (lock, server)
}

#[tokio::test]
async fn nobody_on_the_data_dir_so_the_app_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let Startup::Host { link, hosted } = find_or_host(dir.path(), 0, no_hook()).await.unwrap() else {
        panic!("expected host mode");
    };
    let published = holder(dir.path()).unwrap().expect("host.json");
    assert_eq!(published.kind, HostKind::Desktop);
    assert_eq!(published.port, link.port());
    let state = link.state(None).await.unwrap();
    assert_eq!(state["kind"], "desktop");
    assert_eq!(state["address"], link.address());
    assert_eq!(state["state"]["sessions"], serde_json::json!([]));

    hosted.shutdown().await;
    assert_eq!(holder(dir.path()).unwrap(), None, "Quit gives up the data dir");
    assert!(matches!(find_or_host(dir.path(), 0, no_hook()).await.unwrap(), Startup::Host { .. }));
}

#[tokio::test]
async fn a_cli_host_on_the_data_dir_makes_the_app_its_client() {
    let dir = tempfile::tempdir().unwrap();
    let (_lock, server) = cli_host(dir.path()).await;
    let Startup::Client { link, holder } = find_or_host(dir.path(), 0, no_hook()).await.unwrap() else {
        panic!("expected client mode");
    };
    assert_eq!(holder.kind, HostKind::Serve);
    assert_eq!(link.port(), server.addr.port());
    let state = link.state(None).await.unwrap();
    assert_eq!(state["kind"], "serve");
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
    let Startup::Host { hosted, .. } = find_or_host(dir.path(), 0, hook).await.unwrap() else {
        panic!("expected host mode");
    };
    let Startup::Activated(first) = find_or_host(dir.path(), 0, no_hook()).await.unwrap() else {
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

    let Err(error) = find_or_host(dir.path(), 0, no_hook()).await else { panic!("expected a refusal") };
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
