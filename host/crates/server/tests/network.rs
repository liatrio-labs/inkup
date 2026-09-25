//! Network mode (ADR 0006): what a peer on another machine may do. Most tests make every peer count as remote
//! (`every_peer_is_remote`), the peer-address rule without a second machine; one binds every interface and comes
//! in through this machine's LAN address, which the server sees as another machine.
mod common;

use std::time::Duration;

use common::{Host, expect_error, fixture, hello_with, lan_ip, recv, send};
use inkup_protocol::{ErrorCode, ServerMessage};
use inkup_server::{Config, NetworkConfig, PairingDecision, PairingRequest};
use rmcp::ServiceExt;
use rmcp::model::{ClientCapabilities, ClientConfig, Implementation};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::json;

fn remote() -> Config {
    Config { every_peer_is_remote: true, ..Config::default() }
}

fn network(advertise: bool) -> Config {
    let mdns_name = format!("inkup-test-{}", std::process::id());
    Config {
        network: Some(NetworkConfig { mdns_name, hub_id: "hub-test".into(), advertise }),
        hub_name: Some(format!("inkup test {}", std::process::id())),
        ..Config::default()
    }
}

/// The MCP handshake at `url`, with a Bearer token or without.
async fn mcp_handshake(url: String, token: Option<&str>) -> Result<(), String> {
    let mut transport = StreamableHttpClientTransportConfig::with_uri(url);
    if let Some(token) = token {
        transport = transport.auth_header(token);
    }
    let config = ClientConfig::new(ClientCapabilities::default(), Implementation::new("claude-code", "1.0.0"));
    let client = tokio::time::timeout(
        Duration::from_secs(10),
        config.serve(StreamableHttpClientTransport::from_config(transport)),
    )
    .await
    .map_err(|_| "timed out".to_owned())?
    .map_err(|e| e.to_string())?;
    client.list_all_tools().await.map_err(|e| e.to_string())?;
    let _ = client.cancel().await;
    Ok(())
}

async fn mcp_status(url: &str, token: Option<&str>) -> u16 {
    let mut request = reqwest::Client::new()
        .post(url)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "curl", "version": "1" } } }));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap().status().as_u16()
}

#[tokio::test]
async fn mcp_from_another_machine_needs_an_agent_token_until_it_is_revoked() {
    let host = Host::start_with(remote()).await;
    let url = host.url("/mcp");
    assert_eq!(mcp_status(&url, None).await, 401, "no token");
    assert_eq!(mcp_status(&url, Some("ink1_forged")).await, 401, "a forged token");
    assert!(mcp_handshake(url.clone(), None).await.is_err());

    let agent = host.store.create_agent_token("claude-code on laptop").unwrap();
    mcp_handshake(url.clone(), Some(&agent.token)).await.expect("an agent token is let in");
    // A paired Client's token works too (a thick client is its own agent).
    let client = host.store.pair_client("other", "Thick client").unwrap();
    mcp_handshake(url.clone(), Some(&client.token)).await.expect("a Client token is let in");

    host.store.revoke_agent_token(&agent.agent.id).unwrap();
    assert_eq!(mcp_status(&url, Some(&agent.token)).await, 401, "revoked");

    // /health stays open; the read API and blobs want a token as before.
    let http = reqwest::Client::new();
    assert_eq!(http.get(host.url("/health")).send().await.unwrap().status(), 200);
    assert_eq!(http.get(host.url("/api/sessions")).send().await.unwrap().status(), 401);
    let status = http.get(host.url("/api/sessions")).bearer_auth(&client.token).send().await.unwrap().status();
    assert_eq!(status, 200);
}

#[tokio::test]
async fn mcp_from_this_machine_needs_no_token() {
    let host = Host::start_with(network(false)).await;
    mcp_handshake(host.url("/mcp"), None).await.expect("loopback MCP is open");
}

/// A hello from another machine without a code: the Host shows one and asks for it.
async fn ask_for_a_code(host: &Host, requests: &mut tokio::sync::mpsc::Receiver<PairingRequest>) -> PairingRequest {
    let mut ws = host.connect().await;
    send(&mut ws, fixture("hello.unpaired.json")).await;
    expect_error(&mut ws, ErrorCode::PairingCodeRequired).await;
    tokio::time::timeout(Duration::from_secs(5), requests.recv()).await.unwrap().unwrap()
}

async fn hello_with_code(host: &Host, code: &str) -> ServerMessage {
    let mut ws = host.connect().await;
    let mut hello = fixture("hello.pairing_code.json");
    hello["pairing_code"] = json!(code);
    send(&mut ws, hello).await;
    recv(&mut ws).await
}

fn code_error(message: &ServerMessage) -> ErrorCode {
    match message {
        ServerMessage::ErrorMessage(error) => error.code,
        other => panic!("expected an error, got {other:?}"),
    }
}

#[tokio::test]
async fn another_machine_pairs_with_the_code_the_host_shows() {
    let mut host = Host::start_with(Config { auto_approve_pairing: true, ..remote() }).await;
    let mut requests = host.server.take_pairing_requests().unwrap();

    let request = ask_for_a_code(&host, &mut requests).await;
    let remote = request.remote.clone().expect("a remote request carries a code");
    assert_eq!(remote.code.len(), 6);
    assert!(remote.code.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(remote.from.to_string(), "127.0.0.1");
    assert!(remote.link.starts_with("inkup://pair?url=http://") && remote.link.ends_with(&remote.code));
    assert_eq!(request.prompt(), "Chrome extension \"Chrome on MacBook\" from 127.0.0.1 wants to connect");
    assert!(!request.is_cancelled());

    let wrong = if remote.code == "000000" { "000001" } else { "000000" };
    let refused = hello_with_code(&host, wrong).await;
    assert_eq!(code_error(&refused), ErrorCode::WrongPairingCode, "auto-approve does not let a remote Client in");

    let ServerMessage::PairedMessage(paired) = hello_with_code(&host, &remote.code).await else {
        panic!("expected paired");
    };
    assert!(request.is_cancelled(), "the TUI stops showing a used code");
    // The token from pairing by code works like any other.
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(paired.token.as_str())).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    assert_eq!(code_error(&hello_with_code(&host, &remote.code).await), ErrorCode::PairingTimeout, "used once");
}

#[tokio::test]
async fn five_wrong_codes_refuse_the_request() {
    let mut host = Host::start_with(remote()).await;
    let mut requests = host.server.take_pairing_requests().unwrap();
    let request = ask_for_a_code(&host, &mut requests).await;
    let code = request.remote.clone().unwrap().code;
    let wrong = if code == "999999" { "999998" } else { "999999" };
    for _ in 0..4 {
        assert_eq!(code_error(&hello_with_code(&host, wrong).await), ErrorCode::WrongPairingCode);
    }
    assert_eq!(code_error(&hello_with_code(&host, wrong).await), ErrorCode::PairingDenied, "the fifth");
    assert_eq!(code_error(&hello_with_code(&host, &code).await), ErrorCode::PairingTimeout, "the code is gone");
    assert!(request.is_cancelled());

    // Refused in the TUI: the code stops working at once.
    let request = ask_for_a_code(&host, &mut requests).await;
    let code = request.remote.clone().unwrap().code;
    request.decide(PairingDecision::Deny);
    assert_eq!(code_error(&hello_with_code(&host, &code).await), ErrorCode::PairingTimeout);
}

/// A Client that asks again (Connect clicked again, the options page reopened, the window hidden so nobody read the
/// code) gets a new code in place of its last one. Its codes used to stack, and its fifth ask within two minutes was
/// answered `pairing_denied` though nobody refused it: "Pairing was declined at the host".
#[tokio::test]
async fn asking_again_replaces_the_code_and_is_never_denied() {
    let mut host = Host::start_with(remote()).await;
    let mut requests = host.server.take_pairing_requests().unwrap();
    let mut asked = Vec::new();
    for _ in 0..6 {
        asked.push(ask_for_a_code(&host, &mut requests).await);
    }
    let newest = asked.pop().unwrap();
    assert!(asked.iter().all(PairingRequest::is_cancelled), "only the newest code shows");
    let ServerMessage::PairedMessage(_) = hello_with_code(&host, &newest.remote.clone().unwrap().code).await else {
        panic!("expected paired with the newest code");
    };
}

#[tokio::test]
async fn a_code_expires() {
    let mut host = Host::start_with(Config { pairing_code_ttl: Duration::from_millis(300), ..remote() }).await;
    let mut requests = host.server.take_pairing_requests().unwrap();
    let request = ask_for_a_code(&host, &mut requests).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(request.is_cancelled(), "the TUI stops showing an expired code");
    let code = request.remote.clone().unwrap().code;
    assert_eq!(code_error(&hello_with_code(&host, &code).await), ErrorCode::PairingTimeout);
}

#[tokio::test]
async fn a_real_peer_on_the_lan_address_is_another_machine() {
    let Some(ip) = lan_ip().await else { return };
    let mut host = Host::start_with(network(false)).await;
    let mut requests = host.server.take_pairing_requests().unwrap();
    let port = host.addr().port();
    let lan = |path: &str| format!("http://{ip}:{port}{path}");
    let http = reqwest::Client::new();

    // Health is open, under the LAN address as Host.
    let health: serde_json::Value = http.get(lan("/health")).send().await.unwrap().json().await.unwrap();
    assert_eq!(health["hub_name"], format!("inkup test {}", std::process::id()));

    // MCP from the LAN: 401 without a token, in with an agent token; from loopback: open.
    assert_eq!(mcp_status(&lan("/mcp"), None).await, 401);
    let agent = host.store.create_agent_token("codex on desktop").unwrap();
    mcp_handshake(lan("/mcp"), Some(&agent.token)).await.expect("an agent token over the LAN");
    mcp_handshake(host.url("/mcp"), None).await.expect("loopback MCP stays open in network mode");

    // Pairing over the LAN address asks for a code, and the request names the LAN address.
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{ip}:{port}/ws")).await.unwrap();
    send(&mut ws, fixture("hello.unpaired.json")).await;
    expect_error(&mut ws, ErrorCode::PairingCodeRequired).await;
    let request = requests.recv().await.unwrap();
    assert_eq!(request.remote.as_ref().unwrap().from.to_string(), ip.to_string());
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{ip}:{port}/ws")).await.unwrap();
    let mut hello = fixture("hello.pairing_code.json");
    hello["pairing_code"] = json!(request.remote.unwrap().code);
    send(&mut ws, hello).await;
    let ServerMessage::PairedMessage(_) = recv(&mut ws).await else { panic!("expected paired") };
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };

    // A name that is not ours is still refused.
    let status = http.get(lan("/health")).header("host", format!("evil.example:{port}")).send().await.unwrap();
    assert_eq!(status.status(), 403);
}

#[tokio::test]
async fn without_network_mode_only_loopback_is_bound() {
    let Some(ip) = lan_ip().await else { return };
    let host = Host::start(false).await;
    assert!(host.addr().ip().is_loopback());
    let reached = reqwest::Client::new()
        .get(format!("http://{ip}:{}/health", host.addr().port()))
        .timeout(Duration::from_secs(2))
        .send()
        .await;
    assert!(reached.is_err(), "the LAN address must not reach a loopback-only Host");
}

/// A real mDNS browse finds the service and its TXT record, and the Host claims its `.local` name. Skipped on CI,
/// whose runners may have no multicast.
#[tokio::test]
async fn mdns_advertises_the_service_and_claims_the_name() {
    if std::env::var_os("CI").is_some() {
        eprintln!("skipped on CI: needs multicast");
        return;
    }
    if lan_ip().await.is_none() {
        return;
    }
    let config = network(true);
    let mdns_name = config.network.as_ref().unwrap().mdns_name.clone();
    let host = Host::start_with(config).await;
    let port = host.addr().port();

    let browser = mdns_sd::ServiceDaemon::new().expect("an mDNS daemon");
    let events = browser.browse(inkup_server::SERVICE_TYPE).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let found = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(remaining, events.recv_async()).await;
        match event {
            Ok(Ok(mdns_sd::ServiceEvent::ServiceResolved(service)))
                if service.get_property_val_str("id") == Some("hub-test") && service.get_port() == port =>
            {
                break service;
            }
            Ok(Ok(_)) => {}
            other => panic!("no inkup service resolved in 15 s: {other:?}"),
        }
    };
    assert_eq!(found.get_hostname(), format!("{mdns_name}.local."));
    assert_eq!(found.get_property_val_str("name"), Some(format!("inkup test {}", std::process::id()).as_str()));
    assert_eq!(found.get_property_val_str("version"), Some(env!("CARGO_PKG_VERSION")));
    assert_eq!(found.get_property_val_str("protocol_version"), Some("1"));
    let _ = browser.shutdown();

    let network = host.server.network().unwrap();
    for _ in 0..50 {
        if network.claimed_name().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(network.claimed_name(), Some(format!("{mdns_name}.local")));
    assert!(network.pair_link("123456").starts_with(&format!("inkup://pair?url=http://{mdns_name}.local:{port}")));
    host.server.shutdown().await.unwrap();
}
