//! The Host as its user sees it: Clients, Sessions, the live timeline, items and agent watchers. The TUI renders
//! this, and `GET /api/state` returns it, so what a test reads is what the TUI shows.

use std::sync::Arc;

use inkup_store::fields::Fields;
use inkup_store::{AgentToken, Item, ItemFilter, ItemStatus, SessionOverview, Store, StoreError};
use serde::Serialize;
use serde_json::Value;

use crate::hub::{Hub, Watcher};
use crate::ws::blocking;

/// How many timeline entries and items a snapshot carries.
const TIMELINE_ENTRIES: usize = 200;
const ITEMS: usize = 500;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct HostState {
    pub clients: Vec<ClientView>,
    /// Most recently updated first.
    pub sessions: Vec<SessionOverview>,
    /// The timeline of the Session asked for, else of the newest live Session.
    pub timeline: Option<Timeline>,
    pub items: Vec<ItemView>,
    pub watchers: Vec<Watcher>,
    /// The agent tokens not revoked (no secrets: those are shown once, when made).
    pub agent_tokens: Vec<AgentToken>,
}

impl HostState {
    /// The newest live Session of a Client.
    pub fn live_session_of(&self, client_id: &str) -> Option<&SessionOverview> {
        self.sessions.iter().find(|s| s.live && s.client_id.as_deref() == Some(client_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientView {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub connected: bool,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Timeline {
    pub session_id: String,
    pub entries: Vec<TimelineEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineEntry {
    /// ms since the Session t0.
    pub t: i64,
    /// `said`, `annotation`, `command`, `draft` or `session`.
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemView {
    /// `item-<seq>`, as agents see it.
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub category: String,
    pub status: ItemStatus,
    /// The latest resolution's note.
    pub note: Option<String>,
    /// The agent (MCP client name) behind the latest resolution, when an agent sent it.
    pub agent: Option<String>,
    /// When the latest resolution was made (epoch ms): for In work, since when.
    pub since: Option<i64>,
    pub prompt: String,
}

/// Reads the state. `timeline_session` picks the Session whose timeline to include.
pub async fn snapshot(
    store: &Arc<Store>,
    hub: &Hub,
    timeline_session: Option<String>,
) -> Result<HostState, StoreError> {
    let connected: Vec<String> = hub.connections().into_iter().map(|c| c.client_id).collect();
    let (clients, sessions, timeline, items, agent_tokens) = blocking(store, move |store| {
        let sessions = store.session_overviews(None)?;
        let timeline_id = timeline_session.or_else(|| sessions.iter().find(|s| s.live).map(|s| s.id.clone()));
        let timeline = match timeline_id {
            Some(id) => Some((id.clone(), store.timeline(&id, TIMELINE_ENTRIES)?)),
            None => None,
        };
        let mut items = store.items(&ItemFilter::default())?;
        items.truncate(ITEMS);
        Ok((store.clients()?, sessions, timeline, items, store.agent_tokens()?))
    })
    .await?;
    let clients = clients
        .into_iter()
        .map(|c| ClientView {
            connected: connected.contains(&c.id),
            id: c.id,
            kind: c.kind,
            name: c.name,
            created_at: c.created_at,
            last_seen_at: c.last_seen_at,
        })
        .collect();
    let timeline = timeline.map(|(session_id, events)| Timeline {
        session_id,
        entries: events.iter().filter_map(timeline_entry).collect(),
    });
    let items = items.iter().map(item_view).collect();
    Ok(HostState { clients, sessions, timeline, items, watchers: hub.watchers(), agent_tokens })
}

pub(crate) fn item_view(item: &Item) -> ItemView {
    let body = Fields::item(&item.body);
    ItemView {
        id: format!("item-{}", item.seq),
        session_id: item.session_id.clone(),
        title: body.text("title"),
        category: body.text("category"),
        status: item.status(),
        note: item.resolution.as_ref().map(|r| r.note.clone()).filter(|note| !note.is_empty()),
        agent: item.resolution.as_ref().and_then(|r| r.agent.clone()),
        since: item.resolution.as_ref().map(|r| r.created_at),
        prompt: body.text("agent_prompt"),
    }
}

/// One line of the live timeline for a stored event.
pub(crate) fn timeline_entry(value: &Value) -> Option<TimelineEntry> {
    let event = Fields::event(value);
    let t = event.i64("t").unwrap_or_default();
    let (kind, line) = match event.str("type")? {
        "session_start" => ("session", format!("started on {}", event.text("url"))),
        "session_pause" => ("session", "paused".to_owned()),
        "session_resume" => ("session", "resumed".to_owned()),
        "session_end" => ("session", format!("ended ({})", event.text("reason").replace('_', " "))),
        "navigation" => ("session", format!("went to {}", event.text("url"))),
        // Dictated into a comment box (E11): it shows as that Annotation's or Text Comment's comment.
        "transcript_segment" if !event.is_null("target") => return None,
        "transcript_segment" => ("said", event.text("text")),
        "voice_command" => ("command", event.text("command").replace('_', " ")),
        "draft_item" => ("draft", event.text("title")),
        "text_comment" => (
            "comment",
            format!(
                "t{} on '{}': {}",
                event.i64("index").unwrap_or_default(),
                event.get("anchor").text("exact"),
                event.text("comment")
            ),
        ),
        "annotation" => {
            let target = match event.at("candidates", event.u64("pick")) {
                Some(c) => {
                    let name = c.str("name").filter(|n| !n.is_empty()).or_else(|| c.str("text")).unwrap_or_default();
                    format!("{} '{name}'", c.str("role").or_else(|| c.str("tag")).unwrap_or("element"))
                }
                None => "a region".to_owned(),
            };
            let index = event.i64("index").unwrap_or_default();
            match event.str("comment").filter(|c| !c.is_empty()) {
                // An Object Select pick with what the reviewer typed about it.
                Some(comment) => ("annotation", format!("#{index} on {target}: \"{comment}\"")),
                None => ("annotation", format!("#{index} on {target}")),
            }
        }
        _ => return None,
    };
    Some(TimelineEntry { t, kind: kind.to_owned(), text: line })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// The generated fixture `event.<name>.json` (packages/protocol/fixtures), with `patch`'s fields set over it.
    fn fixture(json: &str, patch: Value) -> Value {
        let mut event = serde_json::from_str::<Value>(json).unwrap()["event"].take();
        for (key, value) in patch.as_object().unwrap() {
            event[key] = value.clone();
        }
        event
    }

    macro_rules! event {
        ($name:literal, $patch:expr) => {
            fixture(include_str!(concat!("../../../../packages/protocol/fixtures/event.", $name, ".json")), $patch)
        };
    }

    #[test]
    fn timeline_lines_say_what_happened() {
        let said = event!("transcript_segment", json!({ "t": 1200, "text": "make this bigger" }));
        assert_eq!(timeline_entry(&said).unwrap().text, "make this bigger");
        let annotation = event!("annotation", json!({ "t": 1500, "index": 2, "comment": null }));
        assert_eq!(timeline_entry(&annotation).unwrap().text, "#2 on button 'Get started'");
        let picked =
            event!("annotation.object_select", json!({ "t": 1500, "index": 3, "comment": "Make this roomier" }));
        assert_eq!(timeline_entry(&picked).unwrap().text, "#3 on button 'Get started': \"Make this roomier\"");
        let command = event!("voice_command", json!({ "t": 1600 }));
        assert_eq!(
            timeline_entry(&command).unwrap(),
            TimelineEntry { t: 1600, kind: "command".into(), text: "scratch that".into() }
        );
        let comment = event!(
            "text_comment",
            json!({ "t": 1700, "index": 1, "anchor": { "exact": "Ship reviews" }, "comment": "This should say Pricing plans" })
        );
        assert_eq!(
            timeline_entry(&comment).unwrap(),
            TimelineEntry {
                t: 1700,
                kind: "comment".into(),
                text: "t1 on 'Ship reviews': This should say Pricing plans".into()
            }
        );
        assert!(timeline_entry(&event!("stroke", json!({ "t": 1 }))).is_none());
    }
}
