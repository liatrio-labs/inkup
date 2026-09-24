//! The shared fixture corpus (contract/fixtures), also decoded by the Vitest contract test. A fixture
//! named `<type>.<case>.json` must decode as that message type and serialize back to the same JSON; every file
//! under invalid/ must be refused.
use std::path::{Path, PathBuf};

use inkup_protocol::{Envelope, Health};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../contract/fixtures")
}

fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

fn load(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).expect("read fixture")).expect("fixture is JSON")
}

fn type_of(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().split('.').next().unwrap().to_owned()
}

fn envelope_type(envelope: &Envelope) -> &'static str {
    match envelope {
        Envelope::HelloMessage(_) => "hello",
        Envelope::EventMessage(_) => "event",
        Envelope::ItemsMessage(_) => "items",
        Envelope::PairedMessage(_) => "paired",
        Envelope::WelcomeMessage(_) => "welcome",
        Envelope::AckMessage(_) => "ack",
        Envelope::ErrorMessage(_) => "error",
        Envelope::ResolutionMessage(_) => "resolution",
        Envelope::CommandMessage(_) => "command",
        Envelope::CommandResultMessage(_) => "command_result",
        Envelope::SessionDiscardMessage(_) => "session_discard",
        Envelope::ForgetMessage(_) => "forget",
        Envelope::ScreenshotDiscardMessage(_) => "screenshot_discard",
    }
}

#[test]
fn every_fixture_decodes_as_its_type_and_round_trips() {
    let files = json_files(&fixtures());
    assert!(files.len() >= 7, "expected the fixture corpus, found {files:?}");
    for path in files {
        let raw = load(&path);
        let back = if type_of(&path) == "health" {
            let health: Health =
                serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            serde_json::to_value(health).unwrap()
        } else {
            let envelope: Envelope =
                serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(envelope_type(&envelope), type_of(&path), "{}", path.display());
            serde_json::to_value(envelope).unwrap()
        };
        assert_eq!(back, raw, "{} does not round-trip", path.display());
    }
}

#[test]
fn the_session_start_event_keeps_every_field() {
    let raw = load(&fixtures().join("event.session_start.json"));
    let Envelope::EventMessage(message) = serde_json::from_value(raw.clone()).unwrap() else {
        panic!("event.session_start.json is not an event");
    };
    assert_eq!(message.event.type_.as_str(), "session_start");
    assert_eq!(message.event.extra["url"], raw["event"]["url"]);
    assert_eq!(message.event.extra["t0"], raw["event"]["t0"]);
}

#[test]
fn every_invalid_fixture_is_refused() {
    let files = json_files(&fixtures().join("invalid"));
    assert!(!files.is_empty());
    for path in files {
        let decoded = serde_json::from_value::<Envelope>(load(&path));
        assert!(decoded.is_err(), "{} decoded as {:?}", path.display(), decoded.unwrap());
    }
}

#[test]
fn host_built_messages_match_the_schema() {
    use inkup_protocol::{CommandName, ErrorCode, Resolved, ack, command, error, health, paired, resolution, welcome};
    paired("h-1", "m-1", "c-1", "tok").unwrap();
    welcome("h-2", "m-1", "c-1", "0.1.0").unwrap();
    ack("h-3", "m-2", Some("e-1")).unwrap();
    ack("h-3", "m-2", None).unwrap();
    error("h-4", None, ErrorCode::BadMessage, "nope").unwrap();
    // A resolution, and an agent starting on an item (E13: in_progress with the agent's name).
    for (id, file) in [("h-12", "resolution.json"), ("h-13", "resolution.in_progress.json")] {
        let fixture = load(&fixtures().join(file));
        let resolved: Resolved = Resolved {
            resolution_id: fixture["resolution_id"].as_str().unwrap().into(),
            session_id: fixture["session_id"].as_str().unwrap().into(),
            run_id: fixture["run_id"].as_str().unwrap().into(),
            item_id: fixture["item_id"].as_str().unwrap().into(),
            status: fixture["status"].as_str().unwrap().into(),
            note: fixture["note"].as_str().unwrap().into(),
            source: fixture["source"].as_str().unwrap().into(),
            agent: fixture["agent"].as_str().map(Into::into),
            created_at: fixture["created_at"].as_i64().unwrap(),
        };
        assert_eq!(serde_json::to_value(resolution(id, &resolved).unwrap()).unwrap(), fixture, "{file}");
    }
    let built = command("h-20", CommandName::SetDrawMode, Some(true)).unwrap();
    assert_eq!(serde_json::to_value(built).unwrap(), load(&fixtures().join("command.json")));
    let doc = serde_json::to_value(health("0.1.0", None)).unwrap();
    assert_eq!(doc, load(&fixtures().join("health.json")));
    let doc = serde_json::to_value(health("0.1.0", Some("inkup on studio-mac"))).unwrap();
    assert_eq!(doc, load(&fixtures().join("health.network.json")));
    let refused =
        error("h-1", Some("m-1"), ErrorCode::WrongPairingCode, "that is not the code inkup shows; 4 tries left");
    assert_eq!(
        serde_json::to_value(refused.unwrap()).unwrap(),
        load(&fixtures().join("error.wrong_pairing_code.json"))
    );
}
