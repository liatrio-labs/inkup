//! The control API (`/api/host/*`): this machine only, the control token only. A paired Client's token and an agent
//! token are refused, and so is every peer on another machine, in network mode too.
mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Host, expect_error, fixture, hello_with, recv, send};
use inkup_protocol::{ErrorCode, ServerMessage};
use inkup_server::{ActivateHook, Config, Control, NetworkConfig, NetworkHook, lan_addresses};
use inkup_store::instance::{CONTROL_API, HostKind};
use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn control(on_activate: Option<ActivateHook>) -> Option<Control> {
    Some(Control { token: TOKEN.into(), kind: HostKind::Desktop, on_activate, on_network: None, update: None })
}

/// A request with a JSON body, the control token or another.
async fn send_json(method: &str, url: &str, token: Option<&str>, body: Value) -> reqwest::Response {
    let mut request = reqwest::Client::new().request(method.parse().unwrap(), url).json(&body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap()
}

async fn state_of(host: &Host) -> Value {
    get(&host.url("/api/host/state"), Some(TOKEN)).await.json().await.unwrap()
}

/// Every route slice 2 added, with a body it accepts.
fn actions() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        ("GET", "/api/host/changes?since=0", Value::Null),
        ("POST", "/api/host/commands", json!({ "client_id": "c1", "command": "stop" })),
        ("POST", "/api/host/tokens", json!({ "name": "codex" })),
        ("DELETE", "/api/host/tokens/agent-1", Value::Null),
        ("POST", "/api/host/network", json!({ "on": true })),
        ("POST", "/api/host/pairing/1", json!({ "decision": "deny" })),
    ]
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
    assert_eq!(body["network_switch"], false);
    assert_eq!(body["pending_pairing"], json!([]));
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
    for (method, path, body) in actions() {
        assert_eq!(send_json(method, &host.url(path), Some(TOKEN), body).await.status(), 403, "{method} {path}");
    }
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

#[tokio::test]
async fn every_action_wants_the_control_token() {
    let host =
        Host::start_with(Config { auto_approve_pairing: true, control: control(None), ..Config::default() }).await;
    let client = host.pair().await;
    let agent = host.store.create_agent_token("codex on desktop").unwrap().token;
    for (method, path, body) in actions() {
        let url = host.url(path);
        assert_eq!(send_json(method, &url, None, body.clone()).await.status(), 401, "{method} {path}");
        for token in [client.as_str(), agent.as_str(), "nope"] {
            assert_eq!(send_json(method, &url, Some(token), body.clone()).await.status(), 403, "{method} {path}");
        }
        let response = reqwest::Client::new()
            .request(method.parse().unwrap(), &url)
            .bearer_auth(TOKEN)
            .header("origin", "http://evil.example")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403, "{method} {path} from a web page");
    }
}

#[tokio::test]
async fn changes_waits_for_the_next_change() {
    let host = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    let changes = |since: u64| get_changes(&host, since);
    let now = changes(u64::MAX).await;

    // Nothing changed since `now`: the answer waits for a change, then carries the new count.
    let waiting = tokio::spawn(get_changes_at(host.url(&format!("/api/host/changes?since={now}"))));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!waiting.is_finished(), "answered with no change");
    let made = send_json("POST", &host.url("/api/host/tokens"), Some(TOKEN), json!({ "name": "codex" })).await;
    assert_eq!(made.status(), 201);
    let next = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    assert_ne!(next, now);
    // Behind (or from before a restart): answered at once.
    assert_eq!(tokio::time::timeout(Duration::from_secs(1), changes(now)).await.unwrap(), next);
}

#[tokio::test]
async fn a_waiting_window_does_not_hold_up_shutdown() {
    let host = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    let now = get_changes(&host, u64::MAX).await;
    let waiting = tokio::spawn(get_changes_at(host.url(&format!("/api/host/changes?since={now}"))));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let stopped = tokio::time::timeout(Duration::from_secs(5), host.server.shutdown()).await;
    stopped.expect("shut down while a long-poll waited").unwrap();
    assert_eq!(waiting.await.unwrap(), now, "answered, unchanged");
}

async fn get_changes(host: &Host, since: u64) -> u64 {
    get_changes_at(host.url(&format!("/api/host/changes?since={since}"))).await
}

async fn get_changes_at(url: String) -> u64 {
    let response = get(&url, Some(TOKEN)).await;
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()["seq"].as_u64().unwrap()
}

#[tokio::test]
async fn a_command_goes_to_the_client_and_its_answer_comes_back() {
    let host =
        Host::start_with(Config { auto_approve_pairing: true, control: control(None), ..Config::default() }).await;
    let token = host.pair().await;
    let client_id = state_of(&host).await["state"]["clients"][0]["id"].as_str().unwrap().to_owned();
    let commands = host.url("/api/host/commands");
    let stop = json!({ "client_id": client_id, "command": "stop" });
    assert_eq!(send_json("POST", &commands, Some(TOKEN), stop.clone()).await.status(), 404, "not connected");

    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    let asked = json!({ "client_id": client_id, "command": "set_draw_mode", "draw_mode": true });
    let answered = {
        let commands = commands.clone();
        tokio::spawn(async move { send_json("POST", &commands, Some(TOKEN), asked).await })
    };
    let ServerMessage::CommandMessage(command) = recv(&mut ws).await else { panic!("expected a command") };
    assert_eq!(command.command.to_string(), "set_draw_mode");
    assert_eq!(command.draw_mode, Some(true));
    send(
        &mut ws,
        json!({ "v": 1, "type": "command_result", "id": "c-1", "re": command.id, "ok": true, "session_id": "s1", "message": null }),
    )
    .await;
    let response = answered.await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap(), json!({ "ok": true, "session_id": "s1", "message": null }));

    // Draw mode needs its on or off; a command the contract does not know is refused.
    let unsaid = json!({ "client_id": client_id, "command": "set_draw_mode" });
    assert_eq!(send_json("POST", &commands, Some(TOKEN), unsaid).await.status(), 400);
    let unknown = json!({ "client_id": client_id, "command": "reboot" });
    assert!(send_json("POST", &commands, Some(TOKEN), unknown).await.status().is_client_error());
    let nobody = json!({ "client_id": "no-such-client", "command": "stop" });
    assert_eq!(send_json("POST", &commands, Some(TOKEN), nobody).await.status(), 404);
}

#[tokio::test]
async fn a_token_is_shown_once_and_revoked() {
    let host = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    let tokens = host.url("/api/host/tokens");
    let response = send_json("POST", &tokens, Some(TOKEN), json!({ "name": "  claude-code on laptop " })).await;
    assert_eq!(response.status(), 201);
    let made: inkup_protocol::control::NewToken = response.json().await.unwrap();
    assert_eq!(made.name, "claude-code on laptop");
    let secret = made.token.to_string();
    assert!(secret.starts_with("ink1_"), "an agent token starts ink1_");
    let listed = state_of(&host).await["state"]["agent_tokens"].clone();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], made.id);
    assert!(!listed.to_string().contains(&secret), "the state never shows the secret");

    for name in ["", "   "] {
        assert_eq!(send_json("POST", &tokens, Some(TOKEN), json!({ "name": name })).await.status(), 400, "{name:?}");
    }
    let revoke = host.url(&format!("/api/host/tokens/{}", made.id));
    assert_eq!(send_json("DELETE", &revoke, Some(TOKEN), Value::Null).await.status(), 204);
    assert_eq!(state_of(&host).await["state"]["agent_tokens"], json!([]));
    assert_eq!(send_json("DELETE", &revoke, Some(TOKEN), Value::Null).await.status(), 404, "already gone");
}

#[tokio::test]
async fn network_calls_the_hook_or_says_nobody_handled_it() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let hook = {
        let asked = Arc::clone(&asked);
        NetworkHook::new(move |on| asked.lock().unwrap().push(on))
    };
    let with_hook = Control { on_network: Some(hook), ..control(None).unwrap() };
    let host = Host::start_with(Config { control: Some(with_hook), ..Config::default() }).await;
    assert_eq!(state_of(&host).await["network_switch"], true);
    let network = host.url("/api/host/network");
    for on in [true, false] {
        let body: Value = send_json("POST", &network, Some(TOKEN), json!({ "on": on })).await.json().await.unwrap();
        assert_eq!(body, json!({ "handled": true }));
    }
    assert_eq!(*asked.lock().unwrap(), vec![true, false]);
    assert_eq!(send_json("POST", &network, Some(TOKEN), json!({ "on": "yes" })).await.status(), 400);

    let plain = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    assert_eq!(state_of(&plain).await["network_switch"], false);
    let body: Value = send_json("POST", &plain.url("/api/host/network"), Some(TOKEN), json!({ "on": true }))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(body, json!({ "handled": false }));
}

/// The pending request's id, once the state lists one.
async fn pending(host: &Host) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = state_of(host).await;
            if let Some(first) = state["pending_pairing"].get(0) {
                return first.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a pairing request in the state")
}

#[tokio::test]
async fn pairing_is_answered_through_the_control_api() {
    let mut host = Host::start_with(Config { control: control(None), ..Config::default() }).await;
    assert!(host.server.ask_pairing_over_control());
    assert!(!host.server.ask_pairing_over_control(), "taken once");
    assert!(host.server.take_pairing_requests().is_none());

    let mut ws = host.connect().await;
    send(&mut ws, fixture("hello.unpaired.json")).await;
    let request = pending(&host).await;
    assert_eq!(request["prompt"], "Chrome extension \"Chrome on MacBook\" wants to connect");
    assert_eq!(request["remote"], Value::Null);
    let answer = host.url(&format!("/api/host/pairing/{}", request["id"]));
    let approve = json!({ "decision": "approve" });
    assert_eq!(send_json("POST", &answer, Some(TOKEN), approve.clone()).await.status(), 204);
    let ServerMessage::PairedMessage(_) = recv(&mut ws).await else { panic!("expected paired") };
    assert_eq!(state_of(&host).await["pending_pairing"], json!([]));
    assert_eq!(send_json("POST", &answer, Some(TOKEN), approve).await.status(), 404, "answered already");

    let mut ws = host.connect().await;
    send(&mut ws, fixture("hello.unpaired.json")).await;
    let request = pending(&host).await;
    let answer = host.url(&format!("/api/host/pairing/{}", request["id"]));
    assert_eq!(send_json("POST", &answer, Some(TOKEN), json!({ "decision": "maybe" })).await.status(), 400);
    assert_eq!(send_json("POST", &answer, Some(TOKEN), json!({ "decision": "deny" })).await.status(), 204);
    expect_error(&mut ws, ErrorCode::PairingDenied).await;

    // A Client that gives up leaves the list.
    let mut ws = host.connect().await;
    send(&mut ws, fixture("hello.unpaired.json")).await;
    pending(&host).await;
    ws.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while state_of(&host).await["pending_pairing"] != json!([]) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a cancelled request leaves the list");
}

/// Another machine pairs by typing the code the Host shows; the control API can only deny it.
#[tokio::test]
async fn a_request_from_another_machine_shows_its_code_and_can_only_be_denied() {
    let Some(ip) = lan_addresses().into_iter().next() else {
        eprintln!("skipped: no LAN address");
        return;
    };
    let network = NetworkConfig {
        mdns_name: format!("inkup-control-pair-{}", std::process::id()),
        hub_id: "hub-test".into(),
        advertise: false,
    };
    let mut host =
        Host::start_with(Config { network: Some(network), control: control(None), ..Config::default() }).await;
    host.server.ask_pairing_over_control();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{ip}:{}/ws", host.addr().port())).await.unwrap();
    send(&mut ws, fixture("hello.unpaired.json")).await;
    expect_error(&mut ws, ErrorCode::PairingCodeRequired).await;
    let request = pending(&host).await;
    let remote = &request["remote"];
    assert_eq!(remote["from"], ip.to_string());
    assert_eq!(remote["code"].as_str().unwrap().len(), 6);
    assert!(remote["link"].as_str().unwrap().ends_with(remote["code"].as_str().unwrap()));
    serde_json::from_value::<inkup_protocol::control::PairingPrompt>(request.clone()).unwrap();

    let answer = host.url(&format!("/api/host/pairing/{}", request["id"]));
    assert_eq!(send_json("POST", &answer, Some(TOKEN), json!({ "decision": "approve" })).await.status(), 400);
    assert_eq!(send_json("POST", &answer, Some(TOKEN), json!({ "decision": "deny" })).await.status(), 204);
    assert_eq!(state_of(&host).await["pending_pairing"], json!([]));
}
