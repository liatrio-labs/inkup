//! A Remote Host (ADR 0030): an https public URL, a token from every peer, no hello-issued pairing code.
mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use common::{Host, fixture, lan_tests_enabled, recv, send};
use inkup_protocol::{ErrorCode, ServerMessage};
use inkup_server::{Config, Control, PublicUrl, RemoteHost};
use inkup_store::instance::HostKind;
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const CONTROL: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn remote_host() -> Config {
    Config {
        remote: Some(RemoteHost {
            public_url: PublicUrl::parse("https://review.example").unwrap(),
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        }),
        hub_name: None,
        control: Some(Control {
            token: CONTROL.into(),
            kind: HostKind::Serve,
            on_activate: None,
            on_network: None,
            update: None,
        }),
        ..Config::default()
    }
}

async fn exchange(addr: std::net::SocketAddr, request: &str) -> (u16, String) {
    let mut sock = TcpStream::connect(addr).await.unwrap();
    sock.write_all(request.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    sock.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
    (status, text)
}

fn initialize(host: &str, extra: &str) -> String {
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}"#;
    format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn every_peer_needs_a_token_and_health_omits_the_machine_name() {
    let host = Host::start_with(remote_host()).await;
    let addr = host.addr();
    let port = addr.port();
    let http = reqwest::Client::new();

    let missing = http.post(host.url("/mcp")).header("accept", "application/json, text/event-stream").header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}"#)
        .send().await.unwrap();
    assert_eq!(missing.status(), 401);
    assert_eq!(missing.headers().get("www-authenticate").unwrap(), "Bearer");
    assert_eq!(http.get(host.url("/api/sessions")).send().await.unwrap().status(), 401);
    assert_eq!(http.get(host.url("/blobs/shot-1")).send().await.unwrap().status(), 401);

    let health: Value = http.get(host.url("/health")).send().await.unwrap().json().await.unwrap();
    assert!(health.get("hub_name").is_none(), "a Remote Host omits the machine name: {health}");
    assert_ne!(health["name"], "review.example");

    let agent = host.store.create_agent_token("reviewer-a").unwrap();
    let authed = http.post(host.url("/mcp")).bearer_auth(&agent.token).header("accept", "application/json, text/event-stream").header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}"#)
        .send().await.unwrap();
    assert_eq!(authed.status(), 200, "an Agent token is let in from loopback");
    let client = host.store.pair_client("chrome", "Chrome").unwrap();
    let client_status = http.post(host.url("/mcp")).bearer_auth(&client.token).header("accept", "application/json, text/event-stream").header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}"#)
        .send().await.unwrap().status();
    assert_eq!(client_status, 200, "a Client token is let in");

    let (status, _) =
        exchange(addr, &format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")).await;
    assert_eq!(status, 200, "a loopback health check still uses the bind port");
}

#[tokio::test]
async fn the_operator_can_set_a_hub_name_that_is_not_derived_from_the_url() {
    let mut config = remote_host();
    config.hub_name = Some("review desk".into());
    let host = Host::start_with(config).await;
    let health: Value = reqwest::get(host.url("/health")).await.unwrap().json().await.unwrap();
    assert_eq!(health["hub_name"], "review desk");
    assert_ne!(health["hub_name"], "review.example");
}

#[tokio::test]
async fn the_control_api_is_on_loopback_and_not_on_the_public_listener() {
    let host = Host::start_with(remote_host()).await;
    let public_status = reqwest::Client::new()
        .get(host.url("/api/host/state"))
        .bearer_auth(CONTROL)
        .header("x-forwarded-for", "127.0.0.1")
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(public_status, 404, "the public listener does not mount the control API");
    for path in ["/api/host/state", "/api/host/activate", "/api/host/tokens", "/api/host/network"] {
        let status = reqwest::Client::new().get(host.url(path)).bearer_auth(CONTROL).send().await.unwrap().status();
        assert_eq!(status, 404, "{path} is not mounted on the public listener");
    }

    let control = host.server.control_addr.expect("a loopback control listener");
    let url = format!("http://{control}/api/host/state");
    let http = reqwest::Client::new();
    assert_eq!(http.get(&url).send().await.unwrap().status(), 401);
    assert_eq!(http.get(&url).bearer_auth(CONTROL).send().await.unwrap().status(), 200);
    let origin = http.get(&url).bearer_auth(CONTROL).header("origin", "https://review.example").send().await.unwrap();
    assert_eq!(origin.status(), 403, "an Origin is still refused");
}

#[tokio::test]
async fn the_public_host_is_admitted_and_forwarded_headers_are_not_credentials() {
    let host = Host::start_with(remote_host()).await;
    let addr = host.addr();
    let port = addr.port();

    for host_header in ["review.example", "review.example:443"] {
        let (status, _) =
            exchange(addr, &format!("GET /health HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(status, 200, "{host_header}");
    }
    let refused = ["evil.example".to_owned(), "inkup.local".to_owned(), format!("review.example:{port}")];
    for host_header in &refused {
        let (status, body) =
            exchange(addr, &format!("GET /health HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(status, 403, "{host_header}: {body}");
    }
    let (status, _) = exchange(
        addr,
        "GET /health HTTP/1.1\r\nHost: evil.example\r\nX-Forwarded-Host: review.example\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(status, 403, "X-Forwarded-Host is not the Host header");

    let (status, body) = exchange(
        addr,
        &initialize(
            &format!("127.0.0.1:{port}"),
            "X-Forwarded-For: 127.0.0.1\r\nX-Forwarded-Proto: https\r\nX-Forwarded-User: reviewer\r\n",
        ),
    )
    .await;
    assert_eq!(status, 401, "a forwarded loopback address still needs a token: {body}");

    let (status, _) = exchange(
        addr,
        "GET /ws HTTP/1.1\r\nHost: review.example\r\nOrigin: https://review.example\r\nConnection: close\r\nUpgrade: websocket\r\n\r\n",
    )
    .await;
    assert_eq!(status, 403, "the public site's Origin is not an exception");

    let agent = host.store.create_agent_token("gateway").unwrap();
    let (status, body) =
        exchange(addr, &initialize("review.example", &format!("Authorization: Bearer {}\r\n", agent.token))).await;
    assert_eq!(status, 200, "the public name reaches /mcp once rmcp's allowlist is off: {body}");
}

#[tokio::test]
async fn a_hello_never_issues_a_pairing_code() {
    let mut config = remote_host();
    config.auto_approve_pairing = true;
    let mut host = Host::start_with(config).await;
    let mut requests = host.server.take_pairing_requests().unwrap();

    for _ in 0..6 {
        let mut ws = host.connect().await;
        send(&mut ws, fixture("hello.unpaired.json")).await;
        match recv(&mut ws).await {
            ServerMessage::ErrorMessage(error) => {
                assert_eq!(error.code, ErrorCode::PairingDenied, "{}", error.message);
                assert!(error.message.contains("operator running `inkup pairing`"), "{}", error.message);
            }
            other => panic!("expected pairing_denied, got {other:?}"),
        }
    }
    let mut hello = fixture("hello.pairing_code.json");
    hello["pairing_code"] = json!("000000");
    let mut ws = host.connect().await;
    send(&mut ws, hello).await;
    match recv(&mut ws).await {
        ServerMessage::ErrorMessage(error) => assert_eq!(error.code, ErrorCode::PairingDenied, "{}", error.message),
        other => panic!("expected pairing_denied, got {other:?}"),
    }
    assert_eq!(host.server.pairing_codes_waiting(), 0, "nothing a caller sends fills the pairing store");
    let arrived = tokio::time::timeout(Duration::from_millis(200), requests.recv()).await;
    assert!(arrived.is_err(), "no pairing request is shown");
}

#[tokio::test]
async fn a_resolution_is_named_for_the_agent_token() {
    let host = Host::start_with(remote_host()).await;
    let message = fixture("items.json");
    let session = message["session_id"].as_str().unwrap();
    let seq = host
        .store
        .put_items(None, session, message["run_id"].as_str().unwrap(), &[message["items"][0].clone()])
        .unwrap()
        .added[0];
    let id = format!("item-{seq}");
    let agent = host.store.create_agent_token("reviewer-a").unwrap();

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(host.url("/mcp")).auth_header(&agent.token),
    );
    let client = ClientConfig::new(ClientCapabilities::default(), Implementation::new("cursor-agent", "1.0.0"))
        .serve(transport)
        .await
        .expect("an Agent token completes the MCP handshake");
    let started = call_json(&client, "start_item", json!({ "id": id })).await;
    assert_eq!(started["agent"], "reviewer-a");
    let detail = call_json(&client, "get_item", json!({ "id": id })).await;
    assert_eq!(detail["resolutions"][0]["agent"], "reviewer-a");
    assert_eq!(detail["resolutions"][0]["client_name"], "cursor-agent");
    client.cancel().await.unwrap();

    // A Client token keeps clientInfo.name as the agent. That is not an Agent token.
    let mut other = message["items"][0].clone();
    other["id"] = json!("item_0002");
    let seq = host.store.put_items(None, session, message["run_id"].as_str().unwrap(), &[other]).unwrap().added[0];
    let id = format!("item-{seq}");
    let paired = host.store.pair_client("chrome", "Chrome").unwrap();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(host.url("/mcp")).auth_header(&paired.token),
    );
    let client = ClientConfig::new(ClientCapabilities::default(), Implementation::new("cursor-agent", "1.0.0"))
        .serve(transport)
        .await
        .unwrap();
    let started = call_json(&client, "start_item", json!({ "id": id })).await;
    assert_eq!(started["agent"], "cursor-agent");
    let detail = call_json(&client, "get_item", json!({ "id": id })).await;
    assert!(detail["resolutions"][0].get("client_name").is_none(), "{}", detail["resolutions"][0]);
    client.cancel().await.unwrap();
}

async fn call_json(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>,
    tool: &str,
    args: Value,
) -> Value {
    let args = serde_json::from_value(args).unwrap();
    let result = client.call_tool(CallToolRequestParams::new(tool.to_owned()).with_arguments(args)).await.unwrap();
    assert_ne!(result.is_error, Some(true), "{tool} failed: {:?}", result.content);
    let text = &result.content[0].as_text().expect("text").text;
    serde_json::from_str(text).unwrap()
}

#[tokio::test]
async fn the_default_bind_is_every_interface() {
    if !lan_tests_enabled() {
        return;
    }
    let mut config = remote_host();
    config.remote.as_mut().unwrap().bind = inkup_server::DEFAULT_BIND;
    let host = Host::start_with(config).await;
    assert!(host.server.addr.ip().is_unspecified(), "{}", host.server.addr);
}
