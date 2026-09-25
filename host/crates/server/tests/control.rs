//! The control API (`/api/host/*`): this machine only, the control token only. A paired Client's token and an agent
//! token are refused, and so is every peer on another machine, in network mode too.
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{Host, fixture, hello_with, recv, send};
use inkup_protocol::ServerMessage;
use inkup_server::{ActivateHook, Config, Control, NetworkConfig, lan_addresses};
use inkup_store::instance::{CONTROL_API, HostKind};
use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn control(on_activate: Option<ActivateHook>) -> Option<Control> {
    Some(Control { token: TOKEN.into(), kind: HostKind::Desktop, on_activate, update: None })
}

async fn get(url: &str, token: Option<&str>) -> reqwest::Response {
    let mut request = reqwest::Client::new().get(url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap()
}

async fn post(url: &str, token: Option<&str>) -> reqwest::Response {
    let mut request = reqwest::Client::new().post(url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn only_the_control_token_opens_it() {
    let host =
        Host::start_with(Config { auto_approve_pairing: true, control: control(None), ..Config::default() }).await;
    let state = host.url("/api/host/state");
    let activate = host.url("/api/host/activate");
    let client = host.pair().await;
    let agent = host.store.create_agent_token("codex on desktop").unwrap().token;

    assert_eq!(get(&state, None).await.status(), 401);
    assert_eq!(post(&activate, None).await.status(), 401);
    for (who, token) in [("client", client.as_str()), ("agent", agent.as_str()), ("unknown", "nope")] {
        assert_eq!(get(&state, Some(token)).await.status(), 403, "{who} token on state");
        assert_eq!(post(&activate, Some(token)).await.status(), 403, "{who} token on activate");
    }
    assert_eq!(get(&state, Some(TOKEN)).await.status(), 200);
    // The control token opens nothing else: the read API still wants a Client's or an agent's.
    assert_eq!(get(&host.url("/api/state"), Some(TOKEN)).await.status(), 401);
}

#[tokio::test]
async fn without_control_settings_no_token_opens_it() {
    let host = Host::start(false).await;
    assert_eq!(get(&host.url("/api/host/state"), Some(TOKEN)).await.status(), 403);
    assert_eq!(get(&host.url("/api/host/state"), None).await.status(), 401);
}

/// Built through the contract's generated types (`inkup_protocol::control::ControlState`), so a populated state
/// that drifted from contract/host-control.schema.json would fail here with a 500.
#[tokio::test]
async fn state_is_the_snapshot_plus_the_header() {
    let host =
        Host::start_with(Config { auto_approve_pairing: true, control: control(None), ..Config::default() }).await;
    let token = host.pair().await;
    host.store.create_agent_token("claude-code on laptop").unwrap();
    // A Session with a timeline line and a Change Item, from a paired Client.
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    let start = fixture("event.session_start.json");
    let session = start["session_id"].as_str().unwrap().to_owned();
    for mut message in [start, fixture("items.json")] {
        message["session_id"] = json!(session);
        send(&mut ws, message).await;
        let ServerMessage::AckMessage(_) = recv(&mut ws).await else { panic!("expected ack") };
    }

    let response = get(&host.url("/api/host/state"), Some(TOKEN)).await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    let snapshot = inkup_server::snapshot(&host.store, host.server.hub(), None).await.unwrap();
    assert_eq!(body["state"], serde_json::to_value(&snapshot).unwrap());
    assert_eq!(body["state"]["clients"].as_array().unwrap().len(), 1);
    assert_eq!(body["state"]["sessions"][0]["id"], session);
    assert!(!body["state"]["items"].as_array().unwrap().is_empty(), "{body}");
    assert_eq!(body["state"]["timeline"]["session_id"], session);
    assert_eq!(body["state"]["agent_tokens"].as_array().unwrap().len(), 1);
    assert_eq!(body["control_api"], json!(CONTROL_API));
    assert_eq!(body["kind"], "desktop");
    assert_eq!(body["version"], inkup_server::VERSION);
    assert_eq!(body["address"], format!("127.0.0.1:{}", host.addr().port()));
    assert_eq!(body["network"], Value::Null);
    assert_eq!(body["update"], Value::Null);
    // And it decodes as the contract says.
    serde_json::from_value::<inkup_protocol::control::ControlState>(body).unwrap();
}

#[tokio::test]
async fn activate_calls_the_hook_or_says_nobody_handled_it() {
    let calls = Arc::new(AtomicUsize::new(0));
    let hook = {
        let calls = Arc::clone(&calls);
        ActivateHook::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
        })
    };
    let host = Host::start_with(Config { control: control(Some(hook)), ..Config::default() }).await;
    let body: Value = post(&host.url("/api/host/activate"), Some(TOKEN)).await.json().await.unwrap();
    assert_eq!(body, json!({ "handled": true }));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let plain = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    let body: Value = post(&plain.url("/api/host/activate"), Some(TOKEN)).await.json().await.unwrap();
    assert_eq!(body, json!({ "handled": false }));
}

#[tokio::test]
async fn another_machine_is_refused_even_with_the_control_token() {
    let host =
        Host::start_with(Config { every_peer_is_remote: true, control: control(None), ..Config::default() }).await;
    assert_eq!(get(&host.url("/api/host/state"), Some(TOKEN)).await.status(), 403);
    assert_eq!(post(&host.url("/api/host/activate"), Some(TOKEN)).await.status(), 403);
    // Paths the router does not know are refused before routing too.
    assert_eq!(get(&host.url("/api/host/nothing-here"), Some(TOKEN)).await.status(), 403);
}

#[tokio::test]
async fn a_web_page_origin_is_refused() {
    let host = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    for origin in
        ["http://evil.example", "chrome-extension://abcdef", &format!("http://127.0.0.1:{}", host.addr().port())]
    {
        let response = reqwest::Client::new()
            .get(host.url("/api/host/state"))
            .bearer_auth(TOKEN)
            .header("origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403, "{origin}");
    }
}

/// Network mode for real: bound on every interface and reached through this machine's LAN address, which the Host
/// sees as another machine. Loopback still gets in.
#[tokio::test]
async fn in_network_mode_the_lan_is_refused_and_loopback_is_not() {
    let Some(ip) = lan_addresses().into_iter().next() else {
        eprintln!("skipped: no LAN address");
        return;
    };
    let network = NetworkConfig {
        mdns_name: format!("inkup-control-{}", std::process::id()),
        hub_id: "hub-test".into(),
        advertise: false,
    };
    let host = Host::start_with(Config { network: Some(network), control: control(None), ..Config::default() }).await;
    let port = host.addr().port();
    let lan = format!("http://{ip}:{port}/api/host/state");
    assert_eq!(get(&lan, Some(TOKEN)).await.status(), 403);
    assert_eq!(post(&format!("http://{ip}:{port}/api/host/activate"), Some(TOKEN)).await.status(), 403);
    assert_eq!(get(&host.url("/api/host/state"), Some(TOKEN)).await.status(), 200);
}
