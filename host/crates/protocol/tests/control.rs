//! The control API's fixtures (contract/fixtures/host-control), also decoded by packages/protocol's Vitest: each
//! decodes as its generated type and serialises back to the same JSON.
use std::path::Path;

use inkup_protocol::control::{Activated, CONTROL_API, ControlState, HostFile};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn load(file: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../contract/fixtures/host-control").join(file);
    serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture")).expect("fixture is JSON")
}

fn round_trips<T: DeserializeOwned + Serialize>(file: &str) {
    let raw = load(file);
    let decoded: T = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{file}: {e}"));
    assert_eq!(serde_json::to_value(decoded).unwrap(), raw, "{file}");
}

#[test]
fn every_fixture_decodes_and_round_trips() {
    round_trips::<HostFile>("host-file.json");
    round_trips::<ControlState>("control-state.json");
    round_trips::<Activated>("activated.json");
}

#[test]
fn a_state_of_another_version_is_refused_but_its_host_json_reads() {
    let mut state = load("control-state.json");
    state["control_api"] = json!(CONTROL_API + 1);
    assert!(serde_json::from_value::<ControlState>(state).is_err());
    let mut file = load("host-file.json");
    file["control_api"] = json!(CONTROL_API + 1);
    let file: HostFile = serde_json::from_value(file).unwrap();
    assert_eq!(file.control_api.get(), (CONTROL_API + 1) as u64);
}

#[test]
fn a_missing_nullable_field_is_refused() {
    let mut state = load("control-state.json");
    state["state"]["sessions"][0].as_object_mut().unwrap().remove("title");
    assert!(serde_json::from_value::<ControlState>(state).is_err());
}
