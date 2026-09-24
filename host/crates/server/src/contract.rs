//! The Host's contract with the timeline schema (#15). The Host stores events and Change Items verbatim and reads
//! fields back by name (store `fields.rs`), so a misspelt or retyped field reads as nothing and nothing complains:
//! `voice_command` was once read by `name`, not `command`. This feeds every generated event fixture
//! (contract/fixtures/event.*.json, one or more per timeline event type, every optional field filled) and
//! the `items.json` push through every reader: the store (upsert, Signals, the timeline), the server's state (the
//! TUI's timeline lines and items), the WebSocket's event check and the MCP item view. Each field they read must
//! exist in contract/session.schema.json (generated from the Zod schema) with the type the reader wants, and
//! must hold such a value in the fixtures.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use inkup_store::fields::{Found, Read, Want, record};
use inkup_store::{ItemFilter, SignalFilter, Store};
use serde_json::Value;

use crate::mcp::agent_item;
use crate::state::{item_view, timeline_entry};
use crate::ws::event_meta;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn load(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every `event.*.json` fixture: (file, session id, event).
fn event_fixtures() -> Vec<(String, String, Value)> {
    let dir = repo().join("contract/fixtures");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("event.") && name.ends_with(".json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|file| {
            let message = load(&dir.join(&file));
            (file, message["session_id"].as_str().unwrap().to_owned(), message["event"].clone())
        })
        .collect()
}

/// Runs every reader over `events` of one Session and `items`, on a fresh store.
fn read_all(session: &str, events: &[Value], items: &Value) -> Vec<Read> {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let ((), reads) = record(|| {
        for event in events {
            let _ = event_meta(event);
            store.upsert_event(None, session, event).unwrap();
            let _ = timeline_entry(event);
        }
        // Reads every screenshot's `screenshot_id` looking for one to withdraw (F3); this one is none of them.
        store.discard_screenshot(None, session, "no-such-screenshot").unwrap();
        store.signals(&SignalFilter::default()).unwrap();
        for event in store.timeline(session, 10_000).unwrap() {
            let _ = timeline_entry(&event);
        }
        let item_session = items["session_id"].as_str().unwrap();
        let run = items["run_id"].as_str().unwrap();
        store.put_items(None, item_session, run, items["items"].as_array().unwrap()).unwrap();
        for item in store.items(&ItemFilter::default()).unwrap() {
            let _ = agent_item(&item);
            let _ = item_view(&item);
        }
    });
    reads
}

/// The subschemas a path can land on: each branch of a union counts.
fn branches(schema: &Value) -> Vec<&Value> {
    match schema.get("anyOf").or_else(|| schema.get("oneOf")).and_then(Value::as_array) {
        Some(options) => options.iter().flat_map(branches).collect(),
        None => vec![schema],
    }
}

fn step<'s>(schemas: &[&'s Value], segment: &str) -> Vec<&'s Value> {
    schemas
        .iter()
        .flat_map(|s| branches(s))
        .filter_map(|s| {
            if segment == "[]" {
                s.get("items")
            } else {
                s.get("properties")
                    .and_then(|p| p.get(segment))
                    .or_else(|| s.get("additionalProperties").filter(|a| a.is_object()))
            }
        })
        .collect()
}

fn json_types(schemas: &[&Value]) -> BTreeSet<String> {
    let mut types = BTreeSet::new();
    for s in schemas.iter().flat_map(|s| branches(s)) {
        match s.get("type") {
            Some(Value::String(t)) => {
                types.insert(t.clone());
            }
            Some(Value::Array(ts)) => types.extend(ts.iter().filter_map(Value::as_str).map(str::to_owned)),
            _ => {}
        }
    }
    types
}

/// The schema of `root`: a timeline event type, or `item` for a Change Item.
fn root_schema<'s>(schema: &'s Value, root: &str) -> Option<&'s Value> {
    if root == "item" {
        return schema.pointer("/properties/change_items/items");
    }
    schema.pointer("/properties/events/items/oneOf")?.as_array()?.iter().find(|event| {
        let kind = &event["properties"]["type"];
        kind["const"] == root || kind["enum"] == serde_json::json!([root])
    })
}

/// What is wrong with reading `path` as `want`, per the schema; None when it is fine.
fn schema_problem(schema: &Value, path: &str, want: Want) -> Option<String> {
    let (root, rest) = path.split_once(':').expect("a root");
    let Some(mut at) = root_schema(schema, root).map(|s| vec![s]) else {
        return Some(format!("{root} is not a timeline event type"));
    };
    for field in rest.split('.') {
        let (name, items) = field.strip_suffix("[]").map_or((field, false), |name| (name, true));
        at = step(&at, name);
        if items {
            at = step(&at, "[]");
        }
        if at.is_empty() {
            return Some(format!("the schema has no `{rest}`"));
        }
    }
    let types = json_types(&at);
    let fits = match want {
        Want::Str => types.contains("string"),
        Want::Int => types.contains("integer"),
        Want::Array => types.contains("array"),
        Want::Object => types.contains("object"),
        Want::Any => true,
    };
    (!fits).then(|| format!("read as {want:?}, but the schema says {types:?}"))
}

/// Every problem with `reads`: a path the schema does not have or types otherwise, a value of the wrong type in a
/// fixture, or a path no fixture fills.
fn problems(reads: &[Read]) -> Vec<String> {
    let schema = load(&repo().join("contract/session.schema.json"));
    let mut by_path: BTreeMap<(&str, Want), Vec<Found>> = BTreeMap::new();
    for read in reads {
        by_path.entry((read.path.as_str(), read.want)).or_default().push(read.found);
    }
    let mut problems = Vec::new();
    for ((path, want), found) in by_path {
        if let Some(problem) = schema_problem(&schema, path, want) {
            problems.push(format!("{path}: {problem}"));
            continue;
        }
        if let Some(wrong) = found.iter().find(|f| !matches!(f, Found::Missing | Found::Null) && !f.satisfies(want)) {
            problems.push(format!("{path}: read as {want:?}, a fixture has {wrong:?}"));
        }
        if !found.iter().any(|f| f.satisfies(want)) {
            problems.push(format!("{path}: read as {want:?}, but no fixture has it (found {found:?})"));
        }
    }
    problems
}

#[test]
fn every_field_the_host_reads_is_in_the_timeline_schema_with_its_type() {
    let fixtures = event_fixtures();
    let items = load(&repo().join("contract/fixtures/items.json"));
    let session = &fixtures[0].1;
    assert!(fixtures.iter().all(|(_, s, _)| s == session), "the event fixtures are one Session");

    // All of them as one Session (a scratched Annotation, dictation, style edits in play), then each alone, so a
    // reader sees every event even when the Session would hide it.
    let events: Vec<Value> = fixtures.iter().map(|(_, _, e)| e.clone()).collect();
    let mut reads = read_all(session, &events, &items);
    for (_, _, event) in &fixtures {
        reads.extend(read_all(session, std::slice::from_ref(event), &items));
    }
    let problems = problems(&reads);
    assert!(problems.is_empty(), "the Host reads fields the timeline schema does not have:\n{}", problems.join("\n"));

    // Every event type the Host reads anything of has fixtures that fed it.
    let read_types: BTreeSet<&str> =
        reads.iter().filter_map(|r| r.path.split_once(':')).map(|(root, _)| root).collect();
    for kind in [
        "session_start",
        "annotation",
        "text_comment",
        "draft_item",
        "draft_action",
        "voice_command",
        "transcript_segment",
        "style_edit",
        "item",
    ] {
        assert!(read_types.contains(kind), "no reads of {kind}");
    }
}

#[test]
fn every_event_the_timeline_can_show_comes_back_from_the_store() {
    // The TUI's timeline shows what `timeline_entry` renders of `Store::timeline`: a type it renders but the store
    // leaves out would never show.
    for (file, session, event) in event_fixtures() {
        if timeline_entry(&event).is_none() {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.upsert_event(None, &session, &event).unwrap();
        assert_eq!(
            store.timeline(&session, 10).unwrap().len(),
            1,
            "{file} renders a timeline line, but the store leaves it out"
        );
    }
}

#[test]
fn a_renamed_field_is_caught() {
    let schema = load(&repo().join("contract/session.schema.json"));
    assert_eq!(schema_problem(&schema, "voice_command:command", Want::Str), None);
    assert!(schema_problem(&schema, "voice_command:name", Want::Str).is_some());
    assert!(schema_problem(&schema, "voice_command:t", Want::Str).is_some(), "a retyped field");
    assert_eq!(schema_problem(&schema, "annotation:candidates[].source", Want::Object), None);
    assert_eq!(schema_problem(&schema, "style_edit:changes.padding", Want::Object), None, "a record's values");
    assert_eq!(schema_problem(&schema, "item:evidence.crops", Want::Array), None);
    let reads = [Read { path: "voice_command:command".into(), want: Want::Str, found: Found::Missing }];
    assert_eq!(problems(&reads).len(), 1, "a field no fixture fills");
}

#[test]
fn nothing_reads_an_event_or_item_field_around_fields() {
    // `event["x"].as_str()` would read past the contract above. The WebSocket's envelope (`value`, already decoded
    // against the protocol schema) is the one exception.
    let patterns = ["\"].as_", "\"].is_", "\"].clone()", "\"] ==", "\").and_then(Value::"];
    let mut offenders = Vec::new();
    for dir in ["crates/store/src", "crates/server/src", "crates/tui/src"] {
        for entry in std::fs::read_dir(repo().join("host").join(dir)).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if matches!(name.as_str(), "fields.rs" | "contract.rs") || path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            for (n, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
                let envelope = name == "ws.rs" && (line.contains("value.get(") || line.contains("value[\""));
                if !envelope && patterns.iter().any(|p| line.contains(p)) {
                    offenders.push(format!("{dir}/{name}:{}: {}", n + 1, line.trim()));
                }
            }
        }
    }
    assert!(offenders.is_empty(), "read these through inkup_store::fields::Fields:\n{}", offenders.join("\n"));
}
