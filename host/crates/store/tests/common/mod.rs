//! The generated event fixtures (contract/fixtures/event.*.json, `pnpm -C packages/protocol
//! fixtures:events`): real timeline events of every type, the shapes the extension sends.
#![allow(dead_code, reason = "each test binary uses a different subset")]
use std::path::PathBuf;

use serde_json::Value;

pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contract/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// The event of `event.<name>.json`, with `patch` merged over it (objects field by field; anything else replaced).
pub fn event(name: &str, patch: Value) -> Value {
    let mut event = fixture(&format!("event.{name}.json"))["event"].take();
    merge(&mut event, patch);
    event
}

/// The Change Item of `items.json`, with `patch` merged over it.
pub fn item(patch: Value) -> Value {
    let mut item = fixture("items.json")["items"][0].take();
    merge(&mut item, patch);
    item
}

fn merge(into: &mut Value, patch: Value) {
    match (into, patch) {
        (Value::Object(into), Value::Object(patch)) => {
            for (key, value) in patch {
                merge(into.entry(key).or_insert(Value::Null), value);
            }
        }
        (into, patch) => *into = patch,
    }
}
