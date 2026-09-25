//! /mcp driven by the real rmcp client over Streamable HTTP, with a paired Client on /ws pushing what an extension
//! pushes: a Session's events, a screenshot, then its Change Items.
mod common;

use std::io::Cursor;
use std::time::Duration;

use common::{Host, Socket, fixture, hello_with, recv, send, timeline_event};
use inkup_protocol::ServerMessage;
use rmcp::model::{CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};

type McpClient = RunningService<RoleClient, ClientConfig>;

async fn mcp(host: &Host) -> McpClient {
    named_mcp(host, "claude-code").await
}

/// An agent whose MCP client calls itself `name` (clientInfo.name).
async fn named_mcp(host: &Host, name: &str) -> McpClient {
    let transport =
        StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(host.url("/mcp")));
    let config = ClientConfig::new(ClientCapabilities::default(), Implementation::new(name, "1.0.0"));
    config.serve(transport).await.expect("the MCP handshake")
}

async fn call(client: &McpClient, tool: &str, args: Value) -> CallToolResult {
    let args = serde_json::from_value(args).unwrap();
    client.call_tool(CallToolRequestParams::new(tool.to_owned()).with_arguments(args)).await.unwrap()
}

/// A tool's JSON answer.
async fn call_json(client: &McpClient, tool: &str, args: Value) -> Value {
    let result = call(client, tool, args).await;
    assert_ne!(result.is_error, Some(true), "{tool} failed: {:?}", result.content);
    let text = &result.content[0].as_text().expect("a text answer").text;
    serde_json::from_str(text).unwrap()
}

/// A paired Client's socket after `welcome`.
async fn client(host: &Host) -> Socket {
    let token = host.pair().await;
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    ws
}

async fn push(ws: &mut Socket, message: Value) {
    send(ws, message).await;
    match recv(ws).await {
        ServerMessage::AckMessage(_) => {}
        other => panic!("expected ack, got {other:?}"),
    }
}

fn event(session_id: &str, id: &str, event: Value) -> Value {
    json!({ "v": 1, "type": "event", "id": format!("m-{id}"), "session_id": session_id, "event": event })
}

fn items(session_id: &str, run_id: &str, items: Value) -> Value {
    let mut message = fixture("items.json");
    message["session_id"] = json!(session_id);
    message["run_id"] = json!(run_id);
    message["items"] = items;
    message
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::RgbaImage::from_pixel(width, height, image::Rgba([200, 30, 30, 255]))
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

#[tokio::test]
async fn an_agent_watches_implements_and_resolves() {
    let host = Host::start(true).await;
    let mut ws = client(&host).await;
    let session = "0b5f7d4e-3f0e-4a8e-9a57-6e1f2d0c9b11";
    let mut start = fixture("event.session_start.json")["event"].clone();
    start["url"] = json!("http://localhost:3000/");
    push(&mut ws, event(session, "1", start)).await;
    push(
        &mut ws,
        event(
            session,
            "2",
            timeline_event(
                "annotation",
                json!({ "id": "ann-1", "t": 1000, "t_end": 1500, "annotation_id": "a1", "index": 1,
                        "url": "http://localhost:3000/", "pick": 0, "screenshot_id": "shot-1",
                        "candidates": [{ "selector": "main .hero a.cta", "tag": "a", "role": "link", "name": "Start", "text": "Start",
                                         "source": { "file": "src/Hero.tsx", "line": 12, "components": ["Hero"] } }],
                        "crop": { "blob_id": "shot-1.crop", "path": "screenshots/shot-1.crop.png" } }),
            ),
        ),
    )
    .await;

    // The screenshot the items cite, as the extension uploads it.
    let token = host.pair().await;
    let put = reqwest::Client::new()
        .put(host.url(&format!("/blobs/shot-1?session_id={session}")))
        .bearer_auth(&token)
        .header("content-type", "image/png")
        .body(png(40, 30))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 201);

    let agent = mcp(&host).await;
    let info = agent.peer_info().expect("server info");
    let instructions = info.instructions.as_deref().unwrap_or_default();
    assert!(instructions.contains("start_item(id) before you touch the code"), "{instructions}");
    assert!(instructions.contains("resolve_item"));
    let mut tools: Vec<String> =
        agent.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
    tools.sort();
    assert_eq!(
        tools,
        ["get_item", "get_screenshot", "list_sessions", "read_items", "resolve_item", "start_item", "watch_items"]
    );

    // Recording: no Change Items yet, one Signal.
    let backlog = call_json(&agent, "read_items", json!({ "url": "http://localhost:3000" })).await;
    assert_eq!(backlog["items"], json!([]));
    assert_eq!(backlog["signals"][0]["id"], "ann-1");
    // E4: the picked element's source and the element crop reach the agent before Process.
    assert_eq!(
        backlog["signals"][0]["element_source"],
        json!({ "file": "src/Hero.tsx", "line": 12, "components": ["Hero"] })
    );
    // `source` is who made the Annotation, never the code source.
    assert_eq!(backlog["signals"][0]["source"], "reviewer");
    assert_eq!(backlog["signals"][0]["crop"], "shot-1.crop");
    let sessions = call_json(&agent, "list_sessions", json!({})).await;
    assert_eq!(sessions["sessions"][0]["state"], "live");
    assert_eq!(sessions["sessions"][0]["origin"], "http://localhost:3000");

    // The agent blocks in watch_items until the Client pushes its Change Items.
    let cursor = backlog["cursor"].as_str().unwrap().to_owned();
    let watching = {
        let agent_cursor = cursor.clone();
        let transport =
            StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(host.url("/mcp")));
        let watcher: McpClient = ClientConfig::default().serve(transport).await.unwrap();
        tokio::spawn(async move {
            let args = json!({ "url": "http://localhost:3000", "cursor": agent_cursor, "timeout_seconds": 30 });
            call_json(&watcher, "watch_items", args).await
        })
    };
    let hub = std::sync::Arc::clone(host.server.hub());
    tokio::time::timeout(Duration::from_secs(5), async {
        while hub.watchers().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the watch is registered");
    assert!(!watching.is_finished(), "watch_items returned before anything new arrived");

    let mut item = fixture("items.json")["items"][0].clone();
    // Grounded as the extension stores it (E4): the Location's source and the element crop.
    item["locations"][0]["source"] = json!({ "file": "src/Hero.tsx", "line": 12, "components": ["Hero"] });
    item["evidence"]["crops"] = json!(["shot-1.crop"]);
    push(&mut ws, items(session, "run-1", json!([item]))).await;
    let woke = tokio::time::timeout(Duration::from_secs(5), watching).await.expect("the push wakes the watch").unwrap();
    assert_eq!(woke["timed_out"], false);
    assert_eq!(woke["items"].as_array().unwrap().len(), 1);
    let found = &woke["items"][0];
    let id = found["id"].as_str().unwrap().to_owned();
    assert_eq!(found["title"], item["title"]);
    assert_eq!(found["agent_prompt"], item["agent_prompt"]);
    assert_eq!(found["screenshots"], json!(["shot-1"]));
    assert_eq!(found["locations"][0]["selector"], "main .hero a.cta");
    assert_eq!(found["locations"][0]["source"]["file"], "src/Hero.tsx");
    assert_eq!(found["crops"], json!(["shot-1.crop"]));
    // The check against the recording, as the extension sent it.
    assert_eq!(found["vetting"], item["vetting"]);
    assert_eq!(found["vetting"]["verdict"], "corrected");
    assert!(hub.watchers().is_empty(), "the watcher is gone once it returns");

    // Change Items supersede the Signals.
    let open = call_json(&agent, "read_items", json!({})).await;
    assert_eq!(open["signals"], json!([]));
    assert_eq!(open["items"][0]["id"], id);

    let shot = call(
        &agent,
        "get_screenshot",
        json!({ "id": "shot-1", "crop": { "x": 10, "y": 5, "width": 20, "height": 100 } }),
    )
    .await;
    let image = shot.content[0].as_image().expect("an image");
    assert_eq!(image.mime_type, "image/png");
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&image.data).unwrap();
    let cropped = image::load_from_memory(&bytes).unwrap();
    assert_eq!((cropped.width(), cropped.height()), (20, 25), "clamped to the image");

    let detail = call_json(&agent, "get_item", json!({ "id": id })).await;
    assert_eq!(detail["item"]["intent"], item["intent"]);
    assert_eq!(detail["session"]["url"], "http://localhost:3000/");

    // Start: In work with the agent's name, pushed to the Client at once; no longer open.
    let started = call_json(&agent, "start_item", json!({ "id": id })).await;
    assert_eq!((started["status"].as_str(), started["agent"].as_str()), (Some("in_progress"), Some("claude-code")));
    let ServerMessage::ResolutionMessage(pushed) = recv(&mut ws).await else { panic!("expected an in_progress push") };
    assert_eq!(pushed.status.to_string(), "in_progress");
    assert_eq!(pushed.agent.as_deref().map(|a| a.to_string()), Some("claude-code".into()));
    assert_eq!(call_json(&agent, "read_items", json!({})).await["items"], json!([]));
    let working = call_json(&agent, "read_items", json!({ "status": "in_progress" })).await;
    assert_eq!(working["items"][0]["id"], id);
    assert_eq!(working["items"][0]["resolution"]["agent"], "claude-code");
    // Idempotent: the same answer, nothing new pushed or stored.
    let again = call_json(&agent, "start_item", json!({ "id": id })).await;
    assert_eq!(again["resolution_id"], started["resolution_id"]);

    // Resolve: the Client that owns the Session gets the note at once.
    let note = "Raised the CTA to 20px text in src/components/Hero.tsx.";
    let resolved = call_json(&agent, "resolve_item", json!({ "id": id, "status": "resolved", "note": note })).await;
    assert_eq!(resolved["status"], "resolved");
    let ServerMessage::ResolutionMessage(pushed) = recv(&mut ws).await else { panic!("expected a resolution push") };
    assert_eq!((pushed.run_id.as_str(), pushed.item_id.as_str()), ("run-1", "item_0001"));
    assert_eq!(pushed.note, note);

    let done = call_json(&agent, "read_items", json!({ "status": "resolved" })).await;
    assert_eq!(done["items"][0]["resolution"]["note"], note);
    assert_eq!(call_json(&agent, "read_items", json!({})).await["items"], json!([]));
    assert_eq!(call_json(&agent, "read_items", json!({ "status": "in_progress" })).await["items"], json!([]));
    // Latest wins; the history keeps both, oldest first.
    let history = call_json(&agent, "get_item", json!({ "id": id })).await;
    assert_eq!(history["status"], "resolved");
    let statuses: Vec<&str> =
        history["resolutions"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["in_progress", "resolved"]);
    assert_eq!(history["resolutions"][0]["agent"], "claude-code");
    // A done item cannot be started again, and says why.
    let reopened = call(&agent, "start_item", json!({ "id": id })).await;
    assert_eq!(reopened.is_error, Some(true));
    let why = &reopened.content[0].as_text().unwrap().text;
    assert!(why.contains("already resolved"), "{why}");

    let refused = call(&agent, "resolve_item", json!({ "id": "item-999", "status": "resolved", "note": "x" })).await;
    assert_eq!(refused.is_error, Some(true));
    agent.cancel().await.unwrap();
}

#[tokio::test]
async fn resolutions_are_replayed_to_their_client_on_connect() {
    let host = Host::start(true).await;
    let token = host.pair().await;
    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    push(&mut ws, items("s1", "run-1", json!([fixture("items.json")["items"][0]]))).await;
    ws.close(None).await.unwrap();

    let agent = mcp(&host).await;
    let open = call_json(&agent, "read_items", json!({})).await;
    let id = open["items"][0]["id"].as_str().unwrap().to_owned();
    call_json(&agent, "resolve_item", json!({ "id": id, "status": "needs_info", "note": "Which breakpoint?" })).await;

    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    let ServerMessage::ResolutionMessage(replayed) = recv(&mut ws).await else { panic!("expected the replay") };
    assert_eq!(replayed.note, "Which breakpoint?");
    assert_eq!(replayed.status.to_string(), "needs_info");
}

#[tokio::test]
async fn results_from_several_origins_carry_a_warning() {
    let host = Host::start(true).await;
    let mut ws = client(&host).await;
    for (session, run, url) in [("s1", "run-1", "http://localhost:3000/"), ("s2", "run-2", "https://example.com/a")] {
        let mut start = fixture("event.session_start.json")["event"].clone();
        start["id"] = json!(format!("start-{session}"));
        start["url"] = json!(url);
        push(&mut ws, event(session, session, start)).await;
        push(&mut ws, items(session, run, json!([fixture("items.json")["items"][0]]))).await;
    }
    let agent = mcp(&host).await;
    let all = call_json(&agent, "read_items", json!({})).await;
    assert_eq!(all["items_total"], 2);
    assert!(all["warning"].as_str().unwrap().contains("2 origins"), "{all}");
    let mine = call_json(&agent, "read_items", json!({ "url": "http://localhost:3000/pricing" })).await;
    assert_eq!(mine["items_total"], 1);
    assert!(mine.get("warning").is_none());

    // A watch with nothing new times out and hands the cursor back.
    let quiet = call_json(&agent, "watch_items", json!({ "cursor": all["cursor"], "timeout_seconds": 1 })).await;
    assert_eq!(quiet["timed_out"], true);
    assert_eq!(quiet["cursor"], all["cursor"]);
}

#[tokio::test]
async fn a_web_page_cannot_reach_mcp() {
    let host = Host::start(true).await;
    let status = reqwest::Client::new()
        .post(host.url("/mcp"))
        .header("origin", "https://evil.example")
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 403);
}

#[tokio::test]
async fn a_discarded_session_is_gone_from_mcp_the_read_api_and_the_blob_store() {
    let host = Host::start(true).await;
    let mut ws = client(&host).await;
    let session = fixture("session_discard.json")["session_id"].as_str().unwrap().to_owned();
    let mut start = fixture("event.session_start.json")["event"].clone();
    start["url"] = json!("http://localhost:3000/");
    push(&mut ws, event(&session, "1", start)).await;
    push(
        &mut ws,
        event(
            &session,
            "2",
            timeline_event(
                "annotation",
                json!({ "id": "ann-1", "t": 1000, "t_end": 1500, "annotation_id": "a1", "index": 1,
                        "url": "http://localhost:3000/", "screenshot_id": "shot-1" }),
            ),
        ),
    )
    .await;
    // Another Session of the same Client, which stays.
    let mut other = fixture("event.session_start.json")["event"].clone();
    other["id"] = json!("start-2");
    push(&mut ws, event("s-kept", "3", other)).await;

    let token = host.pair().await;
    let http = reqwest::Client::new();
    let put = http
        .put(host.url(&format!("/blobs/shot-1?session_id={session}")))
        .bearer_auth(&token)
        .header("content-type", "image/png")
        .body(png(4, 3))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 201);
    push(&mut ws, items(&session, "run-1", fixture("items.json")["items"].clone())).await;
    let agent = mcp(&host).await;
    let ids = |v: Value| {
        v["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>()
    };
    assert!(ids(call_json(&agent, "list_sessions", json!({})).await).contains(&session));

    // Another Client may not discard it.
    let mut stranger = host.connect().await;
    send(&mut stranger, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut stranger).await else { panic!("expected welcome") };
    send(&mut stranger, fixture("session_discard.json")).await;
    let ServerMessage::ErrorMessage(refused) = recv(&mut stranger).await else { panic!("expected a refusal") };
    assert_eq!(refused.code.to_string(), "conflict");

    push(&mut ws, fixture("session_discard.json")).await;
    assert_eq!(ids(call_json(&agent, "list_sessions", json!({})).await), ["s-kept"]);
    let open = call_json(&agent, "read_items", json!({})).await;
    assert_eq!((open["items"].clone(), open["signals"].clone()), (json!([]), json!([])));
    let blob = http.get(host.url("/blobs/shot-1")).bearer_auth(&token).send().await.unwrap();
    assert_eq!(blob.status(), 404);
    let events =
        http.get(host.url(&format!("/api/sessions/{session}/events"))).bearer_auth(&token).send().await.unwrap();
    assert_eq!(events.status(), 404);
    let state: Value = http.get(host.url("/api/state")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
    assert!(!state.to_string().contains(&session), "/api/state still names the Session: {state}");
    assert_eq!(std::fs::read_dir(host.store.dir().join("blobs")).unwrap().count(), 0, "the blob file is deleted");

    // Discarding again (a resend after a dropped ack) is acked and changes nothing.
    push(&mut ws, fixture("session_discard.json")).await;
}

#[tokio::test]
async fn a_discarded_screenshot_is_gone_from_the_read_api_and_the_blob_store() {
    let host = Host::start(true).await;
    let mut ws = client(&host).await;
    let discard = fixture("screenshot_discard.json");
    let session = discard["session_id"].as_str().unwrap().to_owned();
    let dropped = discard["screenshot_id"].as_str().unwrap().to_owned();
    push(&mut ws, event(&session, "1", fixture("event.session_start.json")["event"].clone())).await;
    let shot = |id: &str, shot: &str| {
        json!({ "id": id, "type": "screenshot", "t": 1000, "screenshot_id": shot, "path": format!("screenshots/{shot}.png"),
                "mime": "image/png", "trigger": "annotation", "annotation_id": "a1", "url": "http://localhost:3000/",
                "scroll": { "x": 0, "y": 0 }, "viewport": { "width": 800, "height": 600 }, "dpr": 1 })
    };
    push(&mut ws, event(&session, "2", shot("ev-dropped", &dropped))).await;
    push(&mut ws, event(&session, "3", shot("ev-kept", "shot-kept"))).await;
    let token = host.pair().await;
    let http = reqwest::Client::new();
    for id in [dropped.as_str(), "shot-kept"] {
        let put = http
            .put(host.url(&format!("/blobs/{id}?session_id={session}")))
            .bearer_auth(&token)
            .header("content-type", "image/png")
            .body(png(4, 3))
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), 201);
    }

    // Another Client may not discard it.
    let mut stranger = host.connect().await;
    send(&mut stranger, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut stranger).await else { panic!("expected welcome") };
    send(&mut stranger, discard.clone()).await;
    let ServerMessage::ErrorMessage(refused) = recv(&mut stranger).await else { panic!("expected a refusal") };
    assert_eq!(refused.code.to_string(), "conflict");

    push(&mut ws, discard.clone()).await;
    let blob = |id: String| http.get(host.url(&format!("/blobs/{id}"))).bearer_auth(&token).send();
    assert_eq!(blob(dropped.clone()).await.unwrap().status(), 404);
    assert_eq!(blob("shot-kept".into()).await.unwrap().status(), 200);
    let events: Value = http
        .get(host.url(&format!("/api/sessions/{session}/events")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!events.to_string().contains(&dropped), "the screenshot event is still there: {events}");
    assert!(events.to_string().contains("shot-kept"));
    assert_eq!(
        std::fs::read_dir(host.store.dir().join("blobs")).unwrap().count(),
        1,
        "only the kept blob's file is left"
    );

    // Again (a resend after a dropped ack), and one the Host never had: acked, nothing changes.
    push(&mut ws, discard.clone()).await;
    let mut unknown = discard;
    unknown["id"] = json!("c-42");
    unknown["screenshot_id"] = json!("never-sent");
    push(&mut ws, unknown).await;
    assert_eq!(blob("shot-kept".into()).await.unwrap().status(), 200);
}
