mod common;

use common::event;
use inkup_store::{Store, StoreError, Upsert, valid_blob_id};
use serde_json::{Value, json};

fn session_start() -> Value {
    event("session_start", json!({}))
}

#[test]
fn reopening_keeps_data_and_the_schema_version() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    store.upsert_event(None, "s1", &session_start()).unwrap();
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    assert_eq!(store.session_events("s1").unwrap().unwrap(), vec![session_start()]);
}

#[test]
fn an_event_is_upserted_on_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.upsert_event(None, "s1", &session_start()).unwrap(), Upsert::Inserted);
    assert_eq!(store.upsert_event(None, "s1", &session_start()).unwrap(), Upsert::Unchanged);
    let mut corrected = session_start();
    corrected["title"] = json!("Pricing");
    assert_eq!(store.upsert_event(None, "s1", &corrected).unwrap(), Upsert::Updated);
    assert_eq!(store.session_events("s1").unwrap().unwrap(), vec![corrected]);

    let sessions = store.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].event_count, 1);
    assert_eq!(sessions[0].title.as_deref(), Some("Pricing"));
    assert_eq!(sessions[0].t0, Some(1790124349836));
}

#[test]
fn an_event_id_cannot_move_to_another_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.upsert_event(None, "s1", &session_start()).unwrap();
    let err = store.upsert_event(None, "s2", &session_start()).unwrap_err();
    assert!(matches!(err, StoreError::Conflict { .. }), "{err}");
    assert!(store.session_events("s2").unwrap().is_none());
}

#[test]
fn events_read_back_in_timeline_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.upsert_event(None, "s1", &event("click", json!({"id": "b", "t": 500}))).unwrap();
    store.upsert_event(None, "s1", &session_start()).unwrap();
    store.upsert_event(None, "s1", &event("click", json!({"id": "c", "t": 500}))).unwrap();
    let ids: Vec<_> = store.session_events("s1").unwrap().unwrap().iter().map(|e| e["id"].clone()).collect();
    assert_eq!(ids, vec![session_start()["id"].clone(), json!("b"), json!("c")]);
}

#[test]
fn malformed_events_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for event in
        [json!({"type": "click", "t": 1}), json!({"id": "x", "t": 1}), json!({"id": "x", "type": "click", "t": -1})]
    {
        assert!(matches!(store.upsert_event(None, "s1", &event), Err(StoreError::InvalidEvent(_))));
    }
    assert!(store.sessions().unwrap().is_empty());
}

#[test]
fn a_token_authenticates_its_client_until_revoked() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let paired = store.pair_client("chrome", "Chrome on MacBook").unwrap();
    assert!(paired.token.starts_with("inkc1_"));
    let client = store.authenticate(&paired.token).unwrap().unwrap();
    assert_eq!(client.id, paired.client.id);
    assert!(store.authenticate("inkc1_not-a-token").unwrap().is_none());

    for file in [inkup_store::DB_FILE.to_owned(), format!("{}-wal", inkup_store::DB_FILE)] {
        let bytes = std::fs::read(dir.path().join(&file)).unwrap_or_default();
        assert!(!bytes.windows(paired.token.len()).any(|w| w == paired.token.as_bytes()), "raw token in {file}");
    }

    assert!(store.revoke_client(&client.id).unwrap());
    assert!(store.authenticate(&paired.token).unwrap().is_none());
}

#[test]
fn a_blob_commits_into_place_and_replaces() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for bytes in [b"first".as_slice(), b"second, longer".as_slice()] {
        let upload = store.blob_upload_path().unwrap();
        std::fs::write(&upload, bytes).unwrap();
        let meta = store.commit_blob("shot-1", Some("s1"), "image/png", upload).unwrap();
        assert_eq!(meta.size, bytes.len() as i64);
        let (meta, path) = store.blob("shot-1").unwrap().unwrap();
        assert_eq!(meta.mime, "image/png");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    assert!(store.blob("missing").unwrap().is_none());
}

#[test]
fn any_blob_id_is_stored_under_a_hashed_file_name() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for id in ["s1:audio", "../inkup.db", "a\\b", "cfe8f317-95e0-4c8c-b764-7effdb7adea8"] {
        let upload = store.blob_upload_path().unwrap();
        std::fs::write(&upload, id).unwrap();
        store.commit_blob(id, None, "application/octet-stream", upload).unwrap();
        let (_, path) = store.blob(id).unwrap().unwrap();
        assert_eq!(path.parent().unwrap(), dir.path().join(inkup_store::BLOB_DIR), "{id}");
        assert_eq!(std::fs::read_to_string(path).unwrap(), id);
    }
    assert!(dir.path().join(inkup_store::DB_FILE).exists(), "the database was not overwritten");
    for id in ["", "a\nb", &"x".repeat(257)] {
        assert!(!valid_blob_id(id), "{id:?}");
    }
}

#[test]
fn an_agent_token_works_until_revoked() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let created = store.create_agent_token("claude-code on laptop").unwrap();
    assert!(created.token.starts_with("ink1_"), "{}", created.token);
    let raw = std::fs::read(dir.path().join(inkup_store::DB_FILE)).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains(&created.token), "only the hash is stored");

    let Some(inkup_store::Bearer::Agent(agent)) = store.authenticate_bearer(&created.token).unwrap() else {
        panic!("the agent token authenticates");
    };
    assert_eq!(agent.name, "claude-code on laptop");
    assert!(store.agent_tokens().unwrap()[0].last_used_at.is_some());
    // A Client's token is a Bearer too; a Client token is not an agent token.
    let paired = store.pair_client("chrome", "Chrome").unwrap();
    assert!(matches!(store.authenticate_bearer(&paired.token).unwrap(), Some(inkup_store::Bearer::Client(_))));
    assert!(store.authenticate_agent(&paired.token).unwrap().is_none());

    assert!(store.revoke_agent_token(&agent.id).unwrap());
    assert!(!store.revoke_agent_token(&agent.id).unwrap());
    assert!(store.authenticate_bearer(&created.token).unwrap().is_none());
    assert!(store.agent_tokens().unwrap().is_empty());
}
