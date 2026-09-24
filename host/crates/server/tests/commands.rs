//! The Host's user drives a Client's Session: a command goes out on the Client's socket, and its command_result
//! comes back as the answer. /api/state is what the TUI shows.
mod common;

use common::{Host, fixture, hello_with, recv, send};
use inkup_protocol::ServerMessage;
use inkup_server::{Command, CommandError};
use serde_json::{Value, json};

#[tokio::test]
async fn a_command_reaches_the_client_and_its_answer_comes_back() {
    let host = Host::start(true).await;
    let token = host.pair().await;
    let http = reqwest::Client::new();
    let state = || async {
        http.get(host.url("/api/state")).bearer_auth(&token).send().await.unwrap().json::<Value>().await.unwrap()
    };
    let client_id = state().await["clients"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(state().await["clients"][0]["connected"], false);
    assert_eq!(host.server.hub().command(&client_id, Command::Stop).await, Err(CommandError::NotConnected));

    let mut ws = host.connect().await;
    send(&mut ws, hello_with(&token)).await;
    let ServerMessage::WelcomeMessage(_) = recv(&mut ws).await else { panic!("expected welcome") };
    assert_eq!(state().await["clients"][0]["connected"], true);

    let request = http
        .post(host.url(&format!("/api/clients/{client_id}/commands")))
        .bearer_auth(&token)
        .json(&json!({ "command": "set_draw_mode", "draw_mode": true }))
        .send();
    let answered = tokio::spawn(request);
    let ServerMessage::CommandMessage(command) = recv(&mut ws).await else { panic!("expected a command") };
    assert_eq!(command.command.to_string(), "set_draw_mode");
    assert_eq!(command.draw_mode, Some(true));
    send(
        &mut ws,
        json!({ "v": 1, "type": "command_result", "id": "c-9", "re": command.id, "ok": true, "session_id": "s1", "message": null }),
    )
    .await;
    let response = answered.await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap(), json!({ "ok": true, "session_id": "s1", "message": null }));

    // The Session the Client streams shows as live, with its timeline.
    let mut start = fixture("event.session_start.json");
    start["session_id"] = json!("s1");
    send(&mut ws, start).await;
    let ServerMessage::AckMessage(_) = recv(&mut ws).await else { panic!("expected ack") };
    let snapshot = state().await;
    assert_eq!(snapshot["sessions"][0]["live"], true);
    assert_eq!(snapshot["timeline"]["session_id"], "s1");
    assert_eq!(snapshot["timeline"]["entries"][0]["kind"], "session");

    // A refusal comes back as ok: false with the Client's reason.
    let hub = std::sync::Arc::clone(host.server.hub());
    let id = client_id.clone();
    let pending = tokio::spawn(async move { hub.command(&id, Command::StartSession).await });
    let ServerMessage::CommandMessage(command) = recv(&mut ws).await else { panic!("expected a command") };
    let reason = "A Session is already recording.";
    send(
        &mut ws,
        json!({ "v": 1, "type": "command_result", "id": "c-10", "re": command.id, "ok": false, "session_id": null, "message": reason }),
    )
    .await;
    let outcome = pending.await.unwrap().unwrap();
    assert!(!outcome.ok);
    assert_eq!(outcome.message.as_deref(), Some(reason));

    // Gone: the next command fails at once.
    ws.close(None).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !host.server.hub().connections().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the connection is dropped");
    let status = http
        .post(host.url(&format!("/api/clients/{client_id}/commands")))
        .bearer_auth(&token)
        .json(&json!({ "command": "stop" }))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404);
}
