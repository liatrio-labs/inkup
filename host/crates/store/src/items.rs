//! Change Items, their Resolutions, and Signals.
//!
//! - A Client pushes a Session's current Change Items after Process and again after each review edit. The push
//!   replaces the Session's set: an item left out (deleted, merged away, or from an earlier run) is withdrawn,
//!   never deleted, so a Resolution always has its item.
//! - An item's `seq` is its Host id (`item-<seq>` to agents). It is never reused, so it doubles as the cursor that
//!   `watch_items` waits past.
//! - Signals are the live Annotations, Text Comments and Draft Items of a Session that has no Change Items yet. The
//!   first push of items for a Session supersedes them.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::fields::Fields;
use crate::{Result, Store, StoreError, now_ms, random_hex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStatus {
    /// An agent started on the item (`start_item`); a later resolution replaces it.
    InProgress,
    Resolved,
    WontFix,
    NeedsInfo,
}

impl ResolutionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Resolved => "resolved",
            Self::WontFix => "wont_fix",
            Self::NeedsInfo => "needs_info",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "in_progress" => Some(Self::InProgress),
            "resolved" => Some(Self::Resolved),
            "wont_fix" => Some(Self::WontFix),
            "needs_info" => Some(Self::NeedsInfo),
            _ => None,
        }
    }
}

/// An item's latest Resolution, or `Open` when it has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Open,
    InProgress,
    Resolved,
    WontFix,
    NeedsInfo,
}

impl ItemStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::InProgress => "in_progress",
            Self::Resolved => "resolved",
            Self::WontFix => "wont_fix",
            Self::NeedsInfo => "needs_info",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            other => ResolutionStatus::parse(other).map(Self::from),
        }
    }
}

impl From<ResolutionStatus> for ItemStatus {
    fn from(status: ResolutionStatus) -> Self {
        match status {
            ResolutionStatus::InProgress => Self::InProgress,
            ResolutionStatus::Resolved => Self::Resolved,
            ResolutionStatus::WontFix => Self::WontFix,
            ResolutionStatus::NeedsInfo => Self::NeedsInfo,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resolution {
    pub id: String,
    pub status: ResolutionStatus,
    pub note: String,
    /// `mcp` (an agent) or `host` (the Host's user).
    pub source: String,
    /// The agent's MCP client name (clientInfo), when an agent sent it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub seq: i64,
    pub session_id: String,
    pub run_id: String,
    /// The id within its run (`item_0001`, …), as the Client knows it.
    pub item_id: String,
    /// The Change Item as the Client sent it.
    pub body: Value,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub withdrawn_at: Option<i64>,
    /// Where the Session started.
    pub session_url: Option<String>,
    /// The Client that owns the Session.
    pub client_id: Option<String>,
    /// The latest.
    pub resolution: Option<Resolution>,
}

impl Item {
    pub fn status(&self) -> ItemStatus {
        self.resolution.as_ref().map_or(ItemStatus::Open, |r| r.status.into())
    }
}

/// A Resolution with what its Client needs to find the card it belongs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ItemResolution {
    pub resolution: Resolution,
    pub item_seq: i64,
    pub session_id: String,
    pub run_id: String,
    pub item_id: String,
    pub client_id: Option<String>,
}

/// What `start_item` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartItem {
    /// Recorded `in_progress`.
    Started(ItemResolution),
    /// Already in progress: nothing new was recorded.
    Unchanged(Resolution),
    /// Already resolved or won't fix: nothing was recorded.
    Refused(Resolution),
    NoItem,
}

/// Which current (not withdrawn) items to read.
#[derive(Debug, Clone, Default)]
pub struct ItemFilter {
    pub session_id: Option<String>,
    /// Only Sessions that started on this origin (`scheme://host[:port]`).
    pub origin: Option<String>,
    /// `None`: any status.
    pub status: Option<ItemStatus>,
    /// Only items first pushed after this `seq`.
    pub after_seq: Option<i64>,
}

/// Which Signals to read.
#[derive(Debug, Clone, Default)]
pub struct SignalFilter {
    pub session_id: Option<String>,
    pub origin: Option<String>,
    /// Only Signals whose event arrived after this event `seq`.
    pub after_seq: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PutItems {
    /// The seqs of items the Host had not seen before.
    pub added: Vec<i64>,
    pub withdrawn: usize,
}

/// A live Annotation or Draft Item, until Change Items supersede it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Signal {
    /// The event's arrival order; the cursor `watch_items` waits past.
    pub seq: i64,
    /// The event id.
    pub id: String,
    /// `annotation`, `text_comment` or `draft_item`.
    pub kind: String,
    pub session_id: String,
    pub url: Option<String>,
    /// ms since the Session t0.
    pub t: i64,
    /// Annotation number (#n), or Text Comment number (tN).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<i64>,
    /// The element the Annotation picked, the element holding a Text Comment's selection, or the Draft Item's subject.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    /// The screenshot cropped to the picked element (`<screenshot>.crop`), when the Client made one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<String>,
    /// Where the picked element is rendered in the page's code: file, line and components.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_source: Option<Value>,
    /// `page_api`: a script on the page made this Annotation (`window.__inkup`), not the reviewer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// What that script said: its comment and any style or text change it asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_api: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// What the reviewer said around it (Annotation), while the text was selected (Text Comment), or the words the
    /// Draft Item came from.
    pub transcript: String,
    /// The latest exact changes asked for on the Annotation's element (`style_edit`, from the page API): `changes`
    /// (CSS property → from/to) and `text` when it is rewritten.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_changes: Option<Value>,
}

/// A Session with what an agent needs to pick it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionOverview {
    pub id: String,
    pub client_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub t0: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// No `session_end` yet.
    pub live: bool,
    /// Live, and its latest pause is not followed by a resume.
    pub paused: bool,
    /// Current Change Items, and how many of them have no Resolution.
    pub items: i64,
    pub open_items: i64,
    pub annotations: i64,
    pub draft_items: i64,
}

/// `scheme://host[:port]` of a URL, lower-cased; `None` for a URL without one.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if scheme.is_empty() || authority.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()))
}

/// The origin to filter on: the origin of `url` when it has one, else `url` as given.
fn wanted_origin(url: &str) -> String {
    origin_of(url).unwrap_or_else(|| url.trim().to_ascii_lowercase())
}

fn matches_origin(url: Option<&str>, wanted: Option<&str>) -> bool {
    match wanted {
        None => true,
        Some(wanted) => url.and_then(origin_of).is_some_and(|origin| origin == wanted),
    }
}

const ITEM_COLUMNS: &str = "i.seq, i.session_id, i.run_id, i.item_id, i.body, i.position, i.created_at, i.updated_at,
     i.withdrawn_at, s.url, s.client_id, r.id, r.status, r.note, r.source, r.created_at, r.agent
     FROM items i JOIN sessions s ON s.id = i.session_id
     LEFT JOIN resolutions r ON r.seq = (SELECT MAX(seq) FROM resolutions WHERE item_seq = i.seq)";

fn item_from_row(row: &Row<'_>) -> rusqlite::Result<(Item, String)> {
    let resolution = match row.get::<_, Option<String>>(11)? {
        Some(id) => Some(Resolution {
            id,
            status: ResolutionStatus::parse(&row.get::<_, String>(12)?).unwrap_or(ResolutionStatus::Resolved),
            note: row.get(13)?,
            source: row.get(14)?,
            agent: row.get(16)?,
            created_at: row.get(15)?,
        }),
        None => None,
    };
    let body: String = row.get(4)?;
    Ok((
        Item {
            seq: row.get(0)?,
            session_id: row.get(1)?,
            run_id: row.get(2)?,
            item_id: row.get(3)?,
            body: Value::Null,
            position: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            withdrawn_at: row.get(8)?,
            session_url: row.get(9)?,
            client_id: row.get(10)?,
            resolution,
        },
        body,
    ))
}

fn parse_items(rows: Vec<(Item, String)>) -> Result<Vec<Item>> {
    rows.into_iter()
        .map(|(mut item, body)| {
            item.body = serde_json::from_str(&body)?;
            Ok(item)
        })
        .collect()
}

fn text(value: &Fields, field: &str) -> Option<String> {
    value.str(field).map(str::to_owned)
}

/// `button 'Get started'`: a Candidate (or a Text Comment's element) by its role and accessible name.
fn element_label(c: &Fields) -> String {
    let name = c.str("name").filter(|n| !n.is_empty()).or_else(|| c.str("text")).unwrap_or_default();
    format!("{} '{name}'", c.str("role").or_else(|| c.str("tag")).unwrap_or("element"))
}

impl Store {
    /// Replaces `session_id`'s current Change Items with `items` (in review order), all from Process run `run_id`.
    /// Creates the Session if its events have not arrived.
    pub fn put_items(
        &self,
        client_id: Option<&str>,
        session_id: &str,
        run_id: &str,
        items: &[Value],
    ) -> Result<PutItems> {
        if session_id.is_empty() || run_id.is_empty() {
            return Err(StoreError::InvalidItems("empty session or run id".into()));
        }
        let mut ids = HashSet::new();
        for item in items {
            let id = Fields::item(item)
                .str("id")
                .filter(|id| !id.is_empty())
                .ok_or_else(|| StoreError::InvalidItems("every item needs a non-empty string `id`".into()))?;
            if !ids.insert(id) {
                return Err(StoreError::InvalidItems(format!("item id {id} appears twice")));
            }
        }
        let now = now_ms();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let owner: Option<String> = tx
            .query_row("SELECT session_id FROM items WHERE run_id = ?1 LIMIT 1", [run_id], |row| row.get(0))
            .optional()?;
        if let Some(owner) = owner.filter(|owner| owner != session_id) {
            return Err(StoreError::RunConflict { run_id: run_id.to_owned(), session_id: owner });
        }
        tx.execute(
            "INSERT INTO sessions (id, client_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(id) DO UPDATE SET updated_at = ?3",
            params![session_id, client_id, now],
        )?;
        let current: Vec<(i64, String, String)> = {
            let mut stmt =
                tx.prepare("SELECT seq, run_id, item_id FROM items WHERE session_id = ?1 AND withdrawn_at IS NULL")?;
            stmt.query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut outcome = PutItems::default();
        let mut kept = HashSet::new();
        for (position, item) in items.iter().enumerate() {
            let item_id = Fields::item(item).str("id").unwrap_or_default();
            let body = serde_json::to_string(item)?;
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT seq FROM items WHERE run_id = ?1 AND item_id = ?2",
                    params![run_id, item_id],
                    |row| row.get(0),
                )
                .optional()?;
            let seq = match existing {
                Some(seq) => {
                    tx.execute(
                        "UPDATE items SET body = ?2, position = ?3, withdrawn_at = NULL,
                            updated_at = CASE WHEN body = ?2 AND position = ?3 AND withdrawn_at IS NULL
                                              THEN updated_at ELSE ?4 END
                         WHERE seq = ?1",
                        params![seq, body, position as i64, now],
                    )?;
                    seq
                }
                None => {
                    tx.execute(
                        "INSERT INTO items (session_id, run_id, item_id, body, position, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                        params![session_id, run_id, item_id, body, position as i64, now],
                    )?;
                    let seq = tx.last_insert_rowid();
                    outcome.added.push(seq);
                    seq
                }
            };
            kept.insert(seq);
        }
        for (seq, _, _) in current.iter().filter(|(seq, _, _)| !kept.contains(seq)) {
            tx.execute("UPDATE items SET withdrawn_at = ?2, updated_at = ?2 WHERE seq = ?1", params![seq, now])?;
            outcome.withdrawn += 1;
        }
        tx.commit()?;
        Ok(outcome)
    }

    /// Current (not withdrawn) items, newest Session first, each Session's in review order.
    pub fn items(&self, filter: &ItemFilter) -> Result<Vec<Item>> {
        let rows = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!(
                "SELECT {ITEM_COLUMNS}
                 WHERE i.withdrawn_at IS NULL AND (?1 IS NULL OR i.session_id = ?1) AND (?2 IS NULL OR i.seq > ?2)
                 ORDER BY s.created_at DESC, i.session_id, i.position"
            ))?;
            stmt.query_map(params![filter.session_id, filter.after_seq], item_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let origin = filter.origin.as_deref().map(wanted_origin);
        let items = parse_items(rows)?;
        Ok(items
            .into_iter()
            .filter(|item| filter.status.is_none_or(|status| item.status() == status))
            .filter(|item| matches_origin(item.session_url.as_deref(), origin.as_deref()))
            .collect())
    }

    /// One item by its seq, withdrawn or not.
    pub fn item(&self, seq: i64) -> Result<Option<Item>> {
        let row = {
            let conn = self.conn();
            conn.query_row(&format!("SELECT {ITEM_COLUMNS} WHERE i.seq = ?1"), [seq], item_from_row).optional()?
        };
        Ok(parse_items(row.into_iter().collect())?.pop())
    }

    /// Every Resolution of an item, oldest first.
    pub fn resolutions(&self, item_seq: i64) -> Result<Vec<Resolution>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, status, note, source, created_at, agent FROM resolutions WHERE item_seq = ?1 ORDER BY seq",
        )?;
        let rows = stmt.query_map([item_seq], |row| {
            Ok(Resolution {
                id: row.get(0)?,
                status: ResolutionStatus::parse(&row.get::<_, String>(1)?).unwrap_or(ResolutionStatus::Resolved),
                note: row.get(2)?,
                source: row.get(3)?,
                agent: row.get(5)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Records that an agent started on an item (`in_progress`). Idempotent: when the item is already in progress
    /// its current record comes back as `Unchanged`. An item already resolved or won't-fixed is `Refused`; one
    /// that needs info can be started again.
    pub fn start_item(&self, seq: i64, note: &str, source: &str, agent: Option<&str>) -> Result<StartItem> {
        let Some(item) = self.item(seq)? else { return Ok(StartItem::NoItem) };
        match item.resolution {
            Some(r) if matches!(r.status, ResolutionStatus::Resolved | ResolutionStatus::WontFix) => {
                Ok(StartItem::Refused(r))
            }
            Some(r) if r.status == ResolutionStatus::InProgress => Ok(StartItem::Unchanged(r)),
            _ => Ok(self
                .resolve_item(seq, ResolutionStatus::InProgress, note, source, agent)?
                .map_or(StartItem::NoItem, StartItem::Started)),
        }
    }

    /// Records a Resolution. `None` when there is no such item.
    pub fn resolve_item(
        &self,
        seq: i64,
        status: ResolutionStatus,
        note: &str,
        source: &str,
        agent: Option<&str>,
    ) -> Result<Option<ItemResolution>> {
        let id = format!("r-{}", random_hex(8)?);
        let now = now_ms();
        let conn = self.conn();
        let item: Option<(String, String, String, Option<String>)> = conn
            .query_row(
                "SELECT i.session_id, i.run_id, i.item_id, s.client_id FROM items i JOIN sessions s ON s.id = i.session_id
                 WHERE i.seq = ?1",
                [seq],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((session_id, run_id, item_id, client_id)) = item else {
            return Ok(None);
        };
        conn.execute(
            "INSERT INTO resolutions (id, item_seq, status, note, source, agent, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, seq, status.as_str(), note, source, agent, now],
        )?;
        Ok(Some(ItemResolution {
            resolution: Resolution {
                id,
                status,
                note: note.to_owned(),
                source: source.to_owned(),
                agent: agent.map(str::to_owned),
                created_at: now,
            },
            item_seq: seq,
            session_id,
            run_id,
            item_id,
            client_id,
        }))
    }

    /// Every Resolution of the items of `client_id`'s Sessions, oldest first: what a Client is sent on connecting.
    pub fn client_resolutions(&self, client_id: &str) -> Result<Vec<ItemResolution>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.status, r.note, r.source, r.created_at, i.seq, i.session_id, i.run_id, i.item_id, s.client_id,
                r.agent
             FROM resolutions r JOIN items i ON i.seq = r.item_seq JOIN sessions s ON s.id = i.session_id
             WHERE s.client_id = ?1 ORDER BY r.seq",
        )?;
        let rows = stmt.query_map([client_id], |row| {
            Ok(ItemResolution {
                resolution: Resolution {
                    id: row.get(0)?,
                    status: ResolutionStatus::parse(&row.get::<_, String>(1)?).unwrap_or(ResolutionStatus::Resolved),
                    note: row.get(2)?,
                    source: row.get(3)?,
                    agent: row.get(10)?,
                    created_at: row.get(4)?,
                },
                item_seq: row.get(5)?,
                session_id: row.get(6)?,
                run_id: row.get(7)?,
                item_id: row.get(8)?,
                client_id: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The newest item seq and event seq: pass them back as `after_seq` to read only what arrives later.
    pub fn cursor(&self) -> Result<(i64, i64)> {
        let conn = self.conn();
        Ok(conn.query_row(
            "SELECT (SELECT COALESCE(MAX(seq), 0) FROM items), (SELECT COALESCE(MAX(seq), 0) FROM events)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }

    /// Live Annotations, Text Comments and Draft Items of the Sessions that have no current Change Items, in arrival
    /// order. Scratched Annotations and Draft Items, and discarded Draft Items, are left out. An Annotation carries
    /// the latest `style_edit` made on it; an Object Select pick's typed comment is its `intent`.
    pub fn signals(&self, filter: &SignalFilter) -> Result<Vec<Signal>> {
        let rows: Vec<(i64, String, String, i64, String, Option<String>)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT e.seq, e.session_id, e.type, e.t, e.body, s.url FROM events e JOIN sessions s ON s.id = e.session_id
                 WHERE e.type IN ('annotation', 'text_comment', 'draft_item', 'draft_action', 'voice_command', 'transcript_segment', 'style_edit')
                   AND (?1 IS NULL OR e.session_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM items i WHERE i.session_id = e.session_id AND i.withdrawn_at IS NULL)
                 ORDER BY e.seq",
            )?;
            stmt.query_map(params![filter.session_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
            })?
            .collect::<rusqlite::Result<_>>()?
        };
        let origin = filter.origin.as_deref().map(wanted_origin);
        // Per Session: what was scratched or discarded, and the live transcript.
        let mut dropped: HashMap<&str, HashSet<String>> = HashMap::new();
        let mut draft_state: HashMap<(&str, String), bool> = HashMap::new();
        let mut segments: HashMap<&str, Vec<(i64, i64, String)>> = HashMap::new();
        let mut style_edits: HashMap<(&str, String), Value> = HashMap::new();
        let mut events = Vec::new();
        for (seq, session, kind, t, body, url) in &rows {
            events.push((*seq, session.as_str(), kind.as_str(), *t, serde_json::from_str::<Value>(body)?, url));
        }
        for (_, session, kind, t, event, _) in &events {
            let event = Fields::event(event);
            match *kind {
                "voice_command" if event.str("command") == Some("scratch_that") => {
                    if let Some(id) = event.get("target").str("id") {
                        dropped.entry(session).or_default().insert(id.to_owned());
                    }
                }
                "draft_action" => {
                    if let Some(id) = text(&event, "draft_id") {
                        draft_state.insert((session, id), event.str("action") == Some("discard"));
                    }
                }
                // Speech dictated into a comment box (E11) is that comment's text, not the transcript.
                "transcript_segment" if event.is_null("run_id") && event.is_null("target") => {
                    let t_end = event.i64("t_end").unwrap_or(*t);
                    segments.entry(session).or_default().push((*t, t_end, text(&event, "text").unwrap_or_default()));
                }
                "style_edit" => {
                    if let Some(id) = text(&event, "annotation_id") {
                        let mut edit = json!({ "changes": event.raw("changes") });
                        if !event.is_null("text") {
                            edit["text"] = event.raw("text").clone();
                        }
                        style_edits.insert((session, id), edit);
                    }
                }
                _ => {}
            }
        }
        let mut signals = Vec::new();
        for (seq, session, kind, t, event, session_url) in &events {
            let (seq, session, kind, t) = (*seq, *session, *kind, *t);
            if !matches!(kind, "annotation" | "text_comment" | "draft_item") {
                continue;
            }
            if filter.after_seq.is_some_and(|after| seq <= after) {
                continue;
            }
            let event = Fields::event(event);
            // A Draft Item has no page of its own: it is the Session's.
            let url = if kind == "draft_item" { None } else { text(&event, "url") }.or_else(|| (*session_url).clone());
            if !matches_origin(url.as_deref(), origin.as_deref()) {
                continue;
            }
            let signal = if kind == "annotation" {
                let annotation_id = text(&event, "annotation_id").unwrap_or_default();
                if dropped.get(session).is_some_and(|d| d.contains(&annotation_id)) {
                    continue;
                }
                let t_end = event.i64("t_end").unwrap_or(t);
                let picked = event.at("candidates", event.u64("pick"));
                let element = picked.as_ref().map(element_label);
                // What was said from 2 s before the first Stroke to 2 s after the last.
                let said: Vec<&str> = segments
                    .get(session)
                    .into_iter()
                    .flatten()
                    .filter(|(start, end, _)| *start <= t_end + 2000 && *end >= t - 2000)
                    .map(|(_, _, text)| text.as_str())
                    .collect();
                let page_api = event.get("page_api");
                Signal {
                    seq,
                    id: text(&event, "id").unwrap_or_default(),
                    kind: kind.to_owned(),
                    session_id: session.to_owned(),
                    url,
                    t,
                    number: event.i64("index"),
                    element,
                    selector: picked.as_ref().and_then(|c| text(c, "selector")),
                    screenshot: text(&event, "screenshot_id"),
                    crop: text(&event.get("crop"), "blob_id"),
                    element_source: picked
                        .as_ref()
                        .and_then(|c| c.get("source").value().cloned())
                        .filter(Value::is_object),
                    source: text(&event, "source"),
                    page_api: page_api.value().cloned().filter(Value::is_object),
                    title: None,
                    category: None,
                    intent: text(&page_api, "comment").or_else(|| text(&event, "comment")),
                    transcript: said.join(" ... "),
                    style_changes: style_edits.get(&(session, annotation_id)).cloned(),
                }
            } else if kind == "text_comment" {
                let t_end = event.i64("t_end").unwrap_or(t);
                // What was said while the text was selected.
                let said: Vec<&str> = segments
                    .get(session)
                    .into_iter()
                    .flatten()
                    .filter(|(start, end, _)| *start <= t_end && *end >= t)
                    .map(|(_, _, text)| text.as_str())
                    .collect();
                let element = event.get("element");
                let exact = event.get("anchor").text("exact");
                Signal {
                    seq,
                    id: text(&event, "id").unwrap_or_default(),
                    kind: kind.to_owned(),
                    session_id: session.to_owned(),
                    url,
                    t,
                    number: event.i64("index"),
                    element: Some(element_label(&element)),
                    selector: text(&element, "selector"),
                    screenshot: text(&event, "screenshot_id"),
                    crop: None,
                    element_source: None,
                    source: None,
                    page_api: None,
                    title: Some(format!("Comment on \"{exact}\"")),
                    category: Some("copy".to_owned()),
                    intent: text(&event, "comment"),
                    transcript: said.join(" ... "),
                    style_changes: None,
                }
            } else {
                let draft_id = text(&event, "draft_id").unwrap_or_default();
                let discarded = draft_state.get(&(session, draft_id.clone())).copied().unwrap_or(false);
                if discarded || dropped.get(session).is_some_and(|d| d.contains(&draft_id)) {
                    continue;
                }
                let locations = event.array("locations");
                let subject = locations.iter().find(|l| l.str("role") == Some("subject")).or(locations.first());
                Signal {
                    seq,
                    id: text(&event, "id").unwrap_or_default(),
                    kind: kind.to_owned(),
                    session_id: session.to_owned(),
                    url,
                    t,
                    number: None,
                    element: subject.and_then(|l| text(l, "element")),
                    selector: subject.and_then(|l| text(l, "selector")),
                    screenshot: None,
                    crop: None,
                    element_source: None,
                    source: None,
                    page_api: None,
                    title: text(&event, "title"),
                    category: text(&event, "category"),
                    intent: text(&event, "intent"),
                    transcript: text(&event, "transcript").unwrap_or_default(),
                    style_changes: None,
                }
            };
            signals.push(signal);
        }
        Ok(signals)
    }

    /// Every Session with its item and Signal counts, most recently updated first.
    pub fn session_overviews(&self, url: Option<&str>) -> Result<Vec<SessionOverview>> {
        let rows = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT s.id, s.client_id, s.url, s.title, s.t0, s.created_at, s.updated_at,
                    NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type = 'session_end'),
                    (SELECT e.type FROM events e WHERE e.session_id = s.id
                        AND e.type IN ('session_pause', 'session_resume') ORDER BY e.t DESC, e.seq DESC LIMIT 1)
                        IS 'session_pause',
                    (SELECT COUNT(*) FROM items i WHERE i.session_id = s.id AND i.withdrawn_at IS NULL),
                    (SELECT COUNT(*) FROM items i WHERE i.session_id = s.id AND i.withdrawn_at IS NULL
                        AND NOT EXISTS (SELECT 1 FROM resolutions r WHERE r.item_seq = i.seq)),
                    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'annotation'),
                    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'draft_item')
                 FROM sessions s ORDER BY s.updated_at DESC, s.id",
            )?;
            stmt.query_map([], |row| {
                Ok(SessionOverview {
                    id: row.get(0)?,
                    client_id: row.get(1)?,
                    url: row.get(2)?,
                    title: row.get(3)?,
                    t0: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    live: row.get(7)?,
                    paused: row.get::<_, bool>(7)? && row.get::<_, bool>(8)?,
                    items: row.get(9)?,
                    open_items: row.get(10)?,
                    annotations: row.get(11)?,
                    draft_items: row.get(12)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let origin = url.map(wanted_origin);
        Ok(rows.into_iter().filter(|s| matches_origin(s.url.as_deref(), origin.as_deref())).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_scheme_and_authority() {
        assert_eq!(origin_of("http://LocalHost:3000/pricing?x#y").as_deref(), Some("http://localhost:3000"));
        assert_eq!(origin_of("https://example.com").as_deref(), Some("https://example.com"));
        assert_eq!(origin_of("/pricing"), None);
        assert_eq!(wanted_origin("http://localhost:3000/a"), "http://localhost:3000");
    }
}
