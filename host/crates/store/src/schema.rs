//! Forward-only migrations. `schema_migrations` records each version applied; a migration never changes once
//! released, so the next change is a new entry at the end of `MIGRATIONS`.

use rusqlite::{Connection, params};

use crate::{Result, StoreError, now_ms};

const MIGRATIONS: &[&str] = &[
    // 1: H0. Items and resolutions are filled from H3 on.
    r"
    CREATE TABLE clients (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        name          TEXT NOT NULL,
        token_sha256  TEXT NOT NULL UNIQUE,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER,
        revoked_at    INTEGER
    );
    CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        client_id   TEXT REFERENCES clients(id),
        url         TEXT,
        title       TEXT,
        t0          INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE TABLE events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        type         TEXT NOT NULL,
        t            INTEGER NOT NULL,
        body         TEXT NOT NULL,
        received_at  INTEGER NOT NULL
    );
    CREATE INDEX events_by_session ON events(session_id, t, seq);
    CREATE TABLE blobs (
        id          TEXT PRIMARY KEY,
        session_id  TEXT,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE TABLE items (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        run_id      TEXT,
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE TABLE resolutions (
        id          TEXT PRIMARY KEY,
        item_id     TEXT NOT NULL REFERENCES items(id),
        status      TEXT NOT NULL CHECK (status IN ('resolved', 'wont_fix', 'needs_info')),
        note        TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX resolutions_by_item ON resolutions(item_id, created_at);
    ",
    // 2: H3. Items and resolutions were never written before this, so they are rebuilt for the item model:
    // an item is keyed by its Process run and its id in that run, and `seq` (never reused) is the id agents see
    // and the cursor `watch_items` waits past. Items are withdrawn, never deleted.
    r"
    DROP TABLE resolutions;
    DROP TABLE items;
    CREATE TABLE items (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        run_id        TEXT NOT NULL,
        item_id       TEXT NOT NULL,
        body          TEXT NOT NULL,
        position      INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        withdrawn_at  INTEGER,
        UNIQUE (run_id, item_id)
    );
    CREATE INDEX items_by_session ON items(session_id, withdrawn_at, position);
    CREATE TABLE resolutions (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL UNIQUE,
        item_seq    INTEGER NOT NULL REFERENCES items(seq),
        status      TEXT NOT NULL CHECK (status IN ('resolved', 'wont_fix', 'needs_info')),
        note        TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX resolutions_by_item ON resolutions(item_seq, seq);
    ",
    // 3: E13. An agent can say it started on an item (`in_progress`), with its MCP client name (`agent`). SQLite
    // cannot change a CHECK in place, so the table is copied over.
    r"
    CREATE TABLE resolutions_v3 (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL UNIQUE,
        item_seq    INTEGER NOT NULL REFERENCES items(seq),
        status      TEXT NOT NULL CHECK (status IN ('in_progress', 'resolved', 'wont_fix', 'needs_info')),
        note        TEXT NOT NULL,
        source      TEXT NOT NULL,
        agent       TEXT,
        created_at  INTEGER NOT NULL
    );
    INSERT INTO resolutions_v3 (seq, id, item_seq, status, note, source, created_at)
        SELECT seq, id, item_seq, status, note, source, created_at FROM resolutions;
    DROP TABLE resolutions;
    ALTER TABLE resolutions_v3 RENAME TO resolutions;
    CREATE INDEX resolutions_by_item ON resolutions(item_seq, seq);
    ",
    // 4: H5. Agent tokens: what an agent on another machine sends as its Bearer token to /mcp in network mode
    // (ADR 0006). Like a Client's token, only its SHA-256 is kept.
    r"
    CREATE TABLE agent_tokens (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        token_sha256  TEXT NOT NULL UNIQUE,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        revoked_at    INTEGER
    );
    ",
];

pub(crate) fn known_version() -> i64 {
    MIGRATIONS.len() as i64
}

pub(crate) fn version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| row.get(0))?)
}

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )?;
    let found = version(conn)?;
    if found > known_version() {
        return Err(StoreError::NewerSchema { found, known: known_version() });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(found as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![index as i64 + 1, now_ms()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v3_keeps_the_resolutions_written_before_it() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for sql in &MIGRATIONS[..2] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations VALUES (1, 0), (2, 0);
             INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', 0, 0);
             INSERT INTO items (session_id, run_id, item_id, body, position, created_at, updated_at)
                 VALUES ('s1', 'r1', 'item_0001', '{}', 0, 0, 0);
             INSERT INTO resolutions (id, item_seq, status, note, source, created_at)
                 VALUES ('r-1', 1, 'resolved', 'Done', 'mcp', 5);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(version(&conn).unwrap(), known_version());
        let kept: (String, String, Option<String>) = conn
            .query_row("SELECT id, status, agent FROM resolutions WHERE item_seq = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(kept, ("r-1".into(), "resolved".into(), None));
        conn.execute(
            "INSERT INTO resolutions (id, item_seq, status, note, source, agent, created_at)
             VALUES ('r-2', 1, 'in_progress', '', 'mcp', 'claude-code', 6)",
            [],
        )
        .unwrap();
    }
}
