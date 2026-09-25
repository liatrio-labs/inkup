//! The real server on an ephemeral port, driven the way a Client drives it: tokio-tungstenite for /ws, reqwest for
//! HTTP, raw TCP where a header must be forged. Messages come from the shared fixture corpus.
mod common;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};

use common::{Host, expect_error, fixture, hello_with, recv, send};
use inkup_protocol::{ErrorCode, ServerMessage};
use inkup_server::PairingDecision;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[tokio::test]
async fn a_client_pairs_reconnects_and_streams_a_session() {
    let host = Host::start(true).await;
    let http = reqwest::Client::new();

    let health: Value = http.get(host.url("/health")).send().await.unwrap().json().await.unwrap();
    // The fixture's version is an example; the host reports its own, so a release bump doesn't break this test.
    let mut expected = fixture("health.json");
    expected["version"] = json!(env!("CARGO_PKG_VERSION"));
    assert_eq!(health, expected);

    let token = host.pair().await;

    // A later connection authenticates with the token alone.
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(welcome) = recv(&mut ws).await else { panic!("expected welcome") };
    assert_eq!(
        welcome.capabilities.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        ["events", "blobs", "items", "resolutions", "discard", "forget", "screenshot_discard"]
    );
    // The store keeps the protocol version the Client spoke, for `inkup update`'s skew guard.
    let spoken = host.store.client_protocol_versions(0).unwrap();
    assert_eq!(spoken.iter().map(|(_, v)| *v).collect::<Vec<_>>(), [inkup_protocol::PROTOCOL_VERSION]);

    // The same session_start twice (an outbox resend) is acked both times and stored once.
    let start = fixture("event.session_start.json");
    for _ in 0..2 {
        send(&mut ws, start.clone()).await;
        let ServerMessage::AckMessage(ack) = recv(&mut ws).await else { panic!("expected ack") };
        assert_eq!(ack.re.as_str(), "m-2");
        assert_eq!(ack.event_id.as_deref().map(String::as_str), start["event"]["id"].as_str());
    }
    let stroke = fixture("event.stroke.json");
    send(&mut ws, stroke.clone()).await;
    let ServerMessage::AckMessage(_) = recv(&mut ws).await else { panic!("expected ack") };
    ws.close(None).await.unwrap();

    let session_id = start["session_id"].as_str().unwrap();
    let sessions: Value =
        http.get(host.url("/api/sessions")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    assert_eq!(sessions[0]["id"], session_id);
    assert_eq!(sessions[0]["url"], start["event"]["url"]);
    assert_eq!(sessions[0]["title"], start["event"]["title"]);
    assert_eq!(sessions[0]["event_count"], 2);

    let events: Value = http
        .get(host.url(&format!("/api/sessions/{session_id}/events")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(events, json!([start["event"], stroke["event"]]));

    host.server.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_read_api_and_blobs_need_a_paired_token() {
    let host = Host::start(true).await;
    let http = reqwest::Client::new();
    for path in ["/api/sessions", "/api/sessions/x/events", "/blobs/shot-1"] {
        let status = http.get(host.url(path)).send().await.unwrap().status();
        assert_eq!(status, 401, "{path} without a token");
        let status = http.get(host.url(path)).bearer_auth("inkc1_forged").send().await.unwrap().status();
        assert_eq!(status, 401, "{path} with a forged token");
    }
    let token = host.pair().await;
    let status = http.get(host.url("/api/sessions/nope/events")).bearer_auth(&token).send().await.unwrap().status();
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_blob_round_trips() {
    let host = Host::start(true).await;
    let http = reqwest::Client::new();
    let token = host.pair().await;
    let png = [0x89, b'P', b'N', b'G', 0, 1, 2, 3];
    let put = http
        .put(host.url("/blobs/cfe8f317-95e0-4c8c-b764-7effdb7adea8?session_id=s1"))
        .bearer_auth(&token)
        .header("content-type", "image/png")
        .body(png.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 201);
    let get =
        http.get(host.url("/blobs/cfe8f317-95e0-4c8c-b764-7effdb7adea8")).bearer_auth(&token).send().await.unwrap();
    assert_eq!(get.status(), 200);
    assert_eq!(get.headers()["content-type"], "image/png");
    assert_eq!(get.bytes().await.unwrap().as_ref(), png);

    // The extension's media ids carry a colon; they round-trip too.
    let put = http.put(host.url("/blobs/s1%3Aaudio")).bearer_auth(&token).body("webm").send().await.unwrap();
    assert_eq!(put.status(), 201);
    let get = http.get(host.url("/blobs/s1:audio")).bearer_auth(&token).send().await.unwrap();
    assert_eq!(get.bytes().await.unwrap().as_ref(), b"webm");
    let bad = http.put(host.url("/blobs/a%0Ab")).bearer_auth(&token).body("x").send().await.unwrap();
    assert_eq!(bad.status(), 400);
}

/// One HTTP/1.1 request with a forged Host header; returns the status line.
fn raw_request(addr: SocketAddr, host: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(addr).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response.lines().next().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn a_non_loopback_host_header_is_refused() {
    let host = Host::start(true).await;
    let addr = host.addr();
    let port = addr.port();
    let status = tokio::task::spawn_blocking(move || {
        (
            raw_request(addr, &format!("127.0.0.1:{port}"), "/health"),
            raw_request(addr, &format!("evil.example:{port}"), "/health"),
            raw_request(addr, "127.0.0.1:1", "/health"),
        )
    })
    .await
    .unwrap();
    assert!(status.0.contains(" 200 "), "{}", status.0);
    assert!(status.1.contains(" 403 "), "rebinding Host served: {}", status.1);
    assert!(status.2.contains(" 403 "), "wrong port served: {}", status.2);

    // The WebSocket upgrade is refused the same way, and from a web page's Origin.
    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    request.headers_mut().insert("host", format!("evil.example:{port}").parse().unwrap());
    let refused = tokio_tungstenite::connect_async(request).await.unwrap_err();
    assert!(refused.to_string().contains("403"), "{refused}");

    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    request.headers_mut().insert("origin", "https://evil.example".parse().unwrap());
    let refused = tokio_tungstenite::connect_async(request).await.unwrap_err();
    assert!(refused.to_string().contains("403"), "{refused}");

    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    request.headers_mut().insert("origin", "chrome-extension://abcdefghijklmnop".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(request).await.is_ok(), "an extension origin is allowed");
}

#[tokio::test]
async fn pairing_waits_for_the_user() {
    let mut host = Host::start(false).await;
    let mut requests = host.server.take_pairing_requests().unwrap();

    let mut ws = host.connect().await;
    send(&mut ws, fixture("hello.unpaired.json")).await;
    let request = requests.recv().await.unwrap();
    assert_eq!(request.prompt(), "Chrome extension \"Chrome on MacBook\" wants to connect");
    request.decide(PairingDecision::Deny);
    expect_error(&mut ws, ErrorCode::PairingDenied).await;

    let mut ws = host.connect().await;
    send(&mut ws, fixture("hello.unpaired.json")).await;
    requests.recv().await.unwrap().decide(PairingDecision::Approve);
    let ServerMessage::PairedMessage(paired) = recv(&mut ws).await else { panic!("expected paired") };
    let ServerMessage::WelcomeMessage(welcome) = recv(&mut ws).await else { panic!("expected welcome") };
    assert_eq!(welcome.client_id.as_str(), paired.client_id.as_str());
}

#[tokio::test]
async fn the_handshake_refuses_what_it_cannot_trust() {
    let host = Host::start(true).await;

    let mut ws = host.connect().await;
    send(&mut ws, hello_with("inkc1_never-paired")).await;
    expect_error(&mut ws, ErrorCode::UnknownToken).await;

    let mut ws = host.connect().await;
    send(&mut ws, fixture("event.session_start.json")).await;
    expect_error(&mut ws, ErrorCode::NotWelcomed).await;

    let mut ws = host.connect().await;
    send(&mut ws, fixture("invalid/hello.future-version.json")).await;
    expect_error(&mut ws, ErrorCode::UnsupportedVersion).await;

    // After welcome, malformed events are refused and the connection stays usable.
    let token = host.pair().await;
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    send(&mut ws, fixture("invalid/event.event-without-id.json")).await;
    expect_error(&mut ws, ErrorCode::BadMessage).await;
    let mut moved = fixture("event.session_start.json");
    send(&mut ws, moved.clone()).await;
    let ServerMessage::AckMessage(_) = recv(&mut ws).await else { panic!("expected ack") };
    moved["session_id"] = json!("another-session");
    send(&mut ws, moved).await;
    expect_error(&mut ws, ErrorCode::Conflict).await;
}

#[tokio::test]
async fn forget_revokes_the_clients_token_and_keeps_its_sessions() {
    let host = Host::start(true).await;
    let http = reqwest::Client::new();
    let token = host.pair().await;
    let other = host.pair().await;

    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    send(&mut ws, fixture("event.session_start.json")).await;
    let ServerMessage::AckMessage(_) = recv(&mut ws).await else { panic!("expected ack") };
    let get = |token: String| http.get(host.url("/api/sessions")).bearer_auth(token).send();
    assert_eq!(get(token.clone()).await.unwrap().status(), 200);

    send(&mut ws, fixture("forget.json")).await;
    let ServerMessage::AckMessage(ack) = recv(&mut ws).await else { panic!("expected ack") };
    assert_eq!(ack.re.as_str(), "c-50");
    assert!(ack.event_id.is_none());
    // The Host closes the connection after the ack.
    let next = tokio::time::timeout(std::time::Duration::from_secs(5), futures_util::StreamExt::next(&mut ws)).await;
    assert!(
        matches!(next, Ok(None | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)) | Err(_)))),
        "{next:?}"
    );

    // The token opens nothing any more: not the WebSocket, not the read API, not blobs.
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    expect_error(&mut ws, ErrorCode::UnknownToken).await;
    assert_eq!(get(token.clone()).await.unwrap().status(), 401);
    let put = http.put(host.url("/blobs/b1?session_id=s1")).bearer_auth(&token).body("x").send().await.unwrap();
    assert_eq!(put.status(), 401);

    // Another Client's token still works, and the forgotten Client's Session stays.
    let sessions: Value = get(other).await.unwrap().json().await.unwrap();
    assert_eq!(sessions[0]["id"], fixture("event.session_start.json")["session_id"]);
    assert_eq!(host.store.clients().unwrap().len(), 1);
}
