//! Sessions and their timeline events. Every event has a UUID and one writer, so storing is an upsert keyed on
//! the event id: a Client resending its outbox after a reconnect changes nothing.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use crate::fields::Fields;
use crate::{Result, Store, StoreError, now_ms};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upsert {
    Inserted,
    /// The same event again: nothing changed.
    Unchanged,
    /// The same id with a different body (the writer corrected it): the stored body was replaced.
    Updated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub client_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub t0: Option<i64>,
    pub event_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn required_str<'a>(event: &Fields<'a>, field: &str) -> Result<&'a str> {
    event
        .str(field)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| StoreError::InvalidEvent(format!("`{field}` must be a non-empty string")))
}

impl Store {
    /// Stores one timeline event of `session_id`, creating the Session on its first event. A `session_start`
    /// also records the Session's URL, title and t0.
    pub fn upsert_event(&self, client_id: Option<&str>, session_id: &str, event: &Value) -> Result<Upsert> {
        if session_id.is_empty() {
            return Err(StoreError::InvalidEvent("empty session id".into()));
        }
        let fields = Fields::event(event);
        let id = required_str(&fields, "id")?;
        let kind = required_str(&fields, "type")?;
        let t = fields
            .i64("t")
            .filter(|t| *t >= 0)
            .ok_or_else(|| StoreError::InvalidEvent("`t` must be a non-negative integer".into()))?;
        let body = serde_json::to_string(event)?;
        let now = now_ms();

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let existing: Option<(String, String)> = tx
            .query_row("SELECT session_id, body FROM events WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let outcome = match existing {
            Some((owner, _)) if owner != session_id => {
                return Err(StoreError::Conflict { event_id: id.to_owned(), session_id: owner });
            }
            Some((_, stored)) if stored == body => Upsert::Unchanged,
            Some(_) => {
                tx.execute("UPDATE events SET type = ?2, t = ?3, body = ?4 WHERE id = ?1", params![id, kind, t, body])?;
                Upsert::Updated
            }
            None => {
                tx.execute(
                    "INSERT INTO sessions (id, client_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
                     ON CONFLICT(id) DO NOTHING",
                    params![session_id, client_id, now],
                )?;
                tx.execute(
                    "INSERT INTO events (id, session_id, type, t, body, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, session_id, kind, t, body, now],
                )?;
                Upsert::Inserted
            }
        };
        if outcome != Upsert::Unchanged {
            tx.execute("UPDATE sessions SET updated_at = ?2 WHERE id = ?1", params![session_id, now])?;
            if kind == "session_start" {
                tx.execute(
                    "UPDATE sessions SET url = ?2, title = ?3, t0 = ?4 WHERE id = ?1",
                    params![session_id, fields.str("url"), fields.str("title"), fields.i64("t0")],
                )?;
            }
        }
        tx.commit()?;
        Ok(outcome)
    }

    /// Every Session, most recently updated first.
    pub fn sessions(&self) -> Result<Vec<SessionSummary>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.client_id, s.url, s.title, s.t0, s.created_at, s.updated_at,
                    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id)
             FROM sessions s ORDER BY s.updated_at DESC, s.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionSummary {
                id: row.get(0)?,
                client_id: row.get(1)?,
                url: row.get(2)?,
                title: row.get(3)?,
                t0: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                event_count: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A Session's events as stored, in timeline order (by `t`, then arrival). `None` when there is no such
    /// Session.
    pub fn session_events(&self, session_id: &str) -> Result<Option<Vec<Value>>> {
        let conn = self.conn();
        let exists: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)", [session_id], |row| row.get(0))?;
        if !exists {
            return Ok(None);
        }
        let mut stmt = conn.prepare("SELECT body FROM events WHERE session_id = ?1 ORDER BY t, seq")?;
        let bodies =
            stmt.query_map([session_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let events = bodies.iter().map(|body| serde_json::from_str(body)).collect::<serde_json::Result<_>>()?;
        Ok(Some(events))
    }
}

impl Store {
    /// Deletes a Session the reviewer cancelled (E10), with its events, Change Items, their Resolutions and its blobs
    /// (rows and files). Its Signals are derived from its events, so they go too. Returns whether it existed. With
    /// `client_id`, a Session another Client recorded is refused (`NotOwner`).
    pub fn delete_session(&self, client_id: Option<&str>, session_id: &str) -> Result<bool> {
        let blob_ids: Vec<String> = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let owner: Option<Option<String>> = tx
                .query_row("SELECT client_id FROM sessions WHERE id = ?1", [session_id], |row| row.get(0))
                .optional()?;
            if let (Some(Some(owner)), Some(client)) = (&owner, client_id)
                && owner != client
            {
                return Err(StoreError::NotOwner { session_id: session_id.to_owned() });
            }
            let blob_ids = {
                let mut stmt = tx.prepare("SELECT id FROM blobs WHERE session_id = ?1")?;
                stmt.query_map([session_id], |row| row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?
            };
            tx.execute(
                "DELETE FROM resolutions WHERE item_seq IN (SELECT seq FROM items WHERE session_id = ?1)",
                [session_id],
            )?;
            tx.execute("DELETE FROM items WHERE session_id = ?1", [session_id])?;
            tx.execute("DELETE FROM events WHERE session_id = ?1", [session_id])?;
            tx.execute("DELETE FROM blobs WHERE session_id = ?1", [session_id])?;
            let existed = tx.execute("DELETE FROM sessions WHERE id = ?1", [session_id])? > 0;
            tx.commit()?;
            if !existed && blob_ids.is_empty() {
                return Ok(false);
            }
            blob_ids
        };
        // After the commit: a file left behind by a crash here is unreferenced, never a row without its bytes.
        for id in &blob_ids {
            match std::fs::remove_file(self.blob_path(id)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        Ok(true)
    }
}

impl Store {
    /// Withdraws a screenshot no Annotation uses (an Object Select pick dropped with Esc, E7): its `screenshot` event
    /// and its blob (row and file). Returns whether anything was deleted. With `client_id`, a Session another Client
    /// recorded is refused (`NotOwner`); an unknown Session or screenshot deletes nothing.
    pub fn discard_screenshot(&self, client_id: Option<&str>, session_id: &str, screenshot_id: &str) -> Result<bool> {
        let deleted = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let owner: Option<Option<String>> = tx
                .query_row("SELECT client_id FROM sessions WHERE id = ?1", [session_id], |row| row.get(0))
                .optional()?;
            if let (Some(Some(owner)), Some(client)) = (&owner, client_id)
                && owner != client
            {
                return Err(StoreError::NotOwner { session_id: session_id.to_owned() });
            }
            // The event is found by its `screenshot_id`, read like every other field (fields.rs).
            let shots: Vec<(String, String)> = {
                let mut stmt =
                    tx.prepare("SELECT id, body FROM events WHERE session_id = ?1 AND type = 'screenshot'")?;
                stmt.query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            };
            let mut events = 0;
            for (id, body) in shots {
                let event: Value = serde_json::from_str(&body)?;
                if Fields::event(&event).str("screenshot_id") == Some(screenshot_id) {
                    events += tx.execute("DELETE FROM events WHERE id = ?1", [&id])?;
                }
            }
            let blobs = tx.execute(
                "DELETE FROM blobs WHERE id = ?1 AND (session_id = ?2 OR session_id IS NULL)",
                params![screenshot_id, session_id],
            )?;
            if events > 0 {
                tx.execute("UPDATE sessions SET updated_at = ?2 WHERE id = ?1", params![session_id, now_ms()])?;
            }
            tx.commit()?;
            (events, blobs)
        };
        if deleted.1 > 0 {
            match std::fs::remove_file(self.blob_path(screenshot_id)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        Ok(deleted.0 + deleted.1 > 0)
    }
}

/// Event types a live timeline shows: what was said, drawn and commanded, and the Session's own milestones.
pub const TIMELINE_TYPES: &[&str] = &[
    "session_start",
    "session_pause",
    "session_resume",
    "session_end",
    "transcript_segment",
    "annotation",
    "text_comment",
    "voice_command",
    "draft_item",
    "navigation",
];

impl Store {
    /// The latest `limit` events of `TIMELINE_TYPES` in a Session, oldest first. Strokes and the other bulky
    /// events are left out, so this stays cheap to poll while a Session records.
    pub fn timeline(&self, session_id: &str, limit: usize) -> Result<Vec<Value>> {
        let conn = self.conn();
        let placeholders = TIMELINE_TYPES.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT body FROM (SELECT body, t, seq FROM events WHERE session_id = ?1 AND type IN ({placeholders})
             ORDER BY t DESC, seq DESC LIMIT ?2) ORDER BY t, seq"
        ))?;
        let bodies = stmt
            .query_map(params![session_id, limit as i64], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(bodies.iter().map(|body| serde_json::from_str(body)).collect::<serde_json::Result<_>>()?)
    }
}
