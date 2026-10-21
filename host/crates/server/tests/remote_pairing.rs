//! Operator-issued pairing codes on a Remote Host (ADR 0030). A hello never mints one.
mod common;

use std::time::Duration;

use common::{Host, fixture, recv, send};
use inkup_protocol::{ErrorCode, ServerMessage};
use inkup_server::{
    Config, Control, OPERATOR_CODE_CAP, OPERATOR_GUESS_BUDGET, OPERATOR_TTL_DEFAULT, PublicUrl, RemoteHost,
};
use inkup_store::instance::HostKind;
use serde_json::{Value, json};

const CONTROL: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn remote_config() -> Config {
    Config {
        remote: Some(RemoteHost {
            public_url: PublicUrl::parse("https://review.example").unwrap(),
            bind: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        }),
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

fn control_url(host: &Host, path: &str) -> String {
    let addr = host.server.control_addr.expect("a loopback control listener");
    format!("http://{addr}{path}")
}

async fn create(host: &Host, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .post(control_url(host, "/api/host/pairing/codes"))
        .bearer_auth(CONTROL)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

async fn list(host: &Host) -> Value {
    reqwest::Client::new()
        .get(control_url(host, "/api/host/pairing/codes"))
        .bearer_auth(CONTROL)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn redeem(host: &Host, code: &str) -> Result<String, (ErrorCode, String)> {
    let mut hello = fixture("hello.pairing_code.json");
    hello["pairing_code"] = json!(code);
    let mut ws = host.connect().await;
    send(&mut ws, hello).await;
    match recv(&mut ws).await {
        ServerMessage::PairedMessage(paired) => Ok(paired.token.to_string()),
        ServerMessage::ErrorMessage(error) => Err((error.code, error.message.to_string())),
        other => panic!("expected paired or error, got {other:?}"),
    }
}

fn wrong_code(avoid: &[&str]) -> String {
    for candidate in ["000000", "111111", "222222", "333333"] {
        if !avoid.contains(&candidate) {
            return candidate.to_owned();
        }
    }
    "444444".to_owned()
}

#[tokio::test]
async fn a_created_code_pairs_once_and_the_public_listener_cannot_issue_one() {
    let host = Host::start_with(remote_config()).await;
    let public_status = reqwest::Client::new()
        .post(host.url("/api/host/pairing/codes"))
        .bearer_auth(CONTROL)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(public_status, 404, "the public listener does not mount pairing codes");

    let (status, made) = create(&host, json!({ "label": "reviewer" })).await;
    assert_eq!(status, 201, "{made}");
    let code = made["code"].as_str().unwrap().to_owned();
    let link = made["link"].as_str().unwrap();
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()), "{code}");
    assert_eq!(link, format!("inkup://pair?url=https://review.example&code={code}"));
    assert_ne!(made["id"].as_str().unwrap(), code);

    let token = redeem(&host, &code).await.expect("a valid code pairs");
    assert!(!token.is_empty());
    let again = redeem(&host, &code).await.expect_err("a code works once");
    assert_eq!(again.0, ErrorCode::PairingDenied);
    assert_eq!(host.server.pairing_codes_waiting(), 0, "a hello still does not fill the network-mode store");
}

#[tokio::test]
async fn wrong_expired_revoked_and_burned_codes_are_the_same_error() {
    let host = Host::start_with(remote_config()).await;
    let (status, older) = create(&host, json!({ "label": "older" })).await;
    assert_eq!(status, 201, "{older}");
    let older_code = older["code"].as_str().unwrap().to_owned();
    let (status, kept_made) = create(&host, json!({ "label": "kept" })).await;
    assert_eq!(status, 201, "{kept_made}");
    let kept = kept_made["code"].as_str().unwrap().to_owned();
    let kept_id = kept_made["id"].as_str().unwrap().to_owned();

    // A miss is charged to the oldest code only. Hellos with no code do not create one or move a budget.
    let wrong = wrong_code(&[older_code.as_str(), kept.as_str()]);
    let err = redeem(&host, &wrong).await.expect_err("a wrong guess");
    assert_eq!(err.0, ErrorCode::PairingDenied);
    let guesses = |body: &Value, id: &str| {
        body["codes"].as_array().unwrap().iter().find(|code| code["id"] == id).unwrap()["guesses_left"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(guesses(&list(&host).await, &kept_id), u64::from(OPERATOR_GUESS_BUDGET));
    for _ in 0..3 {
        let mut ws = host.connect().await;
        send(&mut ws, fixture("hello.unpaired.json")).await;
        match recv(&mut ws).await {
            ServerMessage::ErrorMessage(error) => assert_eq!(error.code, ErrorCode::PairingDenied),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(guesses(&list(&host).await, &kept_id), u64::from(OPERATOR_GUESS_BUDGET));
    assert_eq!(host.server.pairing_codes_waiting(), 0);
    for _ in 1..OPERATOR_GUESS_BUDGET {
        assert_eq!(redeem(&host, &wrong).await.expect_err("a wrong guess").0, ErrorCode::PairingDenied);
    }
    assert!(list(&host).await["codes"].as_array().unwrap().iter().all(|code| code["id"] != older["id"]));

    let (status, short_made) = create(&host, json!({ "ttl_secs": 1, "label": "short" })).await;
    assert_eq!(status, 201, "{short_made}");
    let short = short_made["code"].as_str().unwrap().to_owned();
    tokio::time::sleep(Duration::from_millis(1100)).await;

    let (status, revoked_made) = create(&host, json!({})).await;
    assert_eq!(status, 201, "{revoked_made}");
    let revoked_code = revoked_made["code"].as_str().unwrap().to_owned();
    let revoked_id = revoked_made["id"].as_str().unwrap();
    let status = reqwest::Client::new()
        .delete(control_url(&host, &format!("/api/host/pairing/codes/{revoked_id}")))
        .bearer_auth(CONTROL)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 204);

    let unknown =
        redeem(&host, &wrong_code(&[older_code.as_str(), kept.as_str(), short.as_str()])).await.expect_err("unknown");
    let expired = redeem(&host, &short).await.expect_err("expired");
    let revoked = redeem(&host, &revoked_code).await.expect_err("revoked");
    let burned = redeem(&host, &older_code).await.expect_err("burned");
    assert_eq!(unknown, expired);
    assert_eq!(unknown, revoked);
    assert_eq!(unknown, burned);
    assert!(unknown.1.contains("operator running `inkup pairing`"), "{}", unknown.1);
    assert!(!unknown.1.contains("expired") && !unknown.1.contains("tries"), "{}", unknown.1);

    let kept_token = redeem(&host, &kept).await.expect("the other code still pairs");
    assert!(!kept_token.is_empty());
}

#[tokio::test]
async fn the_cap_refuses_another_code_and_list_never_shows_the_secret() {
    let host = Host::start_with(remote_config()).await;
    let mut secrets = Vec::new();
    for n in 0..OPERATOR_CODE_CAP {
        let (status, made) = create(&host, json!({ "label": format!("c{n}") })).await;
        assert_eq!(status, 201, "{made}");
        secrets.push(made["code"].as_str().unwrap().to_owned());
    }
    let (status, refused) = create(&host, json!({})).await;
    assert_eq!(status, 400, "{refused}");
    assert!(refused["error"].as_str().unwrap().contains("outstanding"), "{refused}");
    assert!(refused["error"].as_str().unwrap().contains(&OPERATOR_CODE_CAP.to_string()), "{refused}");

    let listed = list(&host).await;
    for secret in &secrets {
        assert!(listed["codes"].as_array().unwrap().iter().all(|code| {
            code.get("code").is_none()
                && code["id"].as_str() != Some(secret.as_str())
                && code["label"].as_str().is_none_or(|label| !label.contains(secret))
        }));
    }
    assert_eq!(listed["codes"].as_array().unwrap().len(), OPERATOR_CODE_CAP);

    let (status, too_long) = create(&host, json!({ "ttl_secs": OPERATOR_TTL_DEFAULT.as_secs() + 1 })).await;
    assert_eq!(status, 400, "{too_long}");
    let (status, zero) = create(&host, json!({ "ttl_secs": 0 })).await;
    assert_eq!(status, 400, "{zero}");
}

#[tokio::test]
async fn loopback_refuses_operator_codes() {
    let host = Host::start_with(Config {
        control: Some(Control {
            token: CONTROL.into(),
            kind: HostKind::Serve,
            on_activate: None,
            on_network: None,
            update: None,
        }),
        ..Config::default()
    })
    .await;
    let response = reqwest::Client::new()
        .post(host.url("/api/host/pairing/codes"))
        .bearer_auth(CONTROL)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("loopback and Network mode keep today's pairing"), "{body}");
}
