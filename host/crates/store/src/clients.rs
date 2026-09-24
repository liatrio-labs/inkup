//! Paired Clients (ADR 0005). A token is shown to its Client once, in `paired`; the store keeps only its SHA-256,
//! so a copied database file cannot impersonate a Client.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{Result, Store, now_ms, random_hex};

/// Tokens carry a version prefix so a future format can be told apart.
const TOKEN_PREFIX: &str = "inkc1_";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Client {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

/// A newly paired Client and its token, which exists nowhere else once sent.
#[derive(Debug, Clone)]
pub struct PairedClient {
    pub client: Client,
    pub token: String,
}

pub(crate) fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl Store {
    pub fn pair_client(&self, kind: &str, name: &str) -> Result<PairedClient> {
        let token = format!("{TOKEN_PREFIX}{}", random_hex(32)?);
        let client = Client {
            id: format!("c-{}", random_hex(8)?),
            kind: kind.to_owned(),
            name: name.to_owned(),
            created_at: now_ms(),
            last_seen_at: None,
        };
        self.conn().execute(
            "INSERT INTO clients (id, kind, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![client.id, client.kind, client.name, token_hash(&token), client.created_at],
        )?;
        Ok(PairedClient { client, token })
    }

    /// The Client a token belongs to, unless it was revoked. Marks it seen.
    pub fn authenticate(&self, token: &str) -> Result<Option<Client>> {
        let conn = self.conn();
        let client = conn
            .query_row(
                "SELECT id, kind, name, created_at, last_seen_at FROM clients
                 WHERE token_sha256 = ?1 AND revoked_at IS NULL",
                [token_hash(token)],
                |row| {
                    Ok(Client {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        name: row.get(2)?,
                        created_at: row.get(3)?,
                        last_seen_at: row.get(4)?,
                    })
                },
            )
            .optional()?;
        if let Some(client) = &client {
            conn.execute("UPDATE clients SET last_seen_at = ?1 WHERE id = ?2", params![now_ms(), client.id])?;
        }
        Ok(client)
    }

    pub fn clients(&self) -> Result<Vec<Client>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, created_at, last_seen_at FROM clients WHERE revoked_at IS NULL ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Client {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                last_seen_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Forgets a Client: its token stops working. Its Sessions stay.
    pub fn revoke_client(&self, client_id: &str) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE clients SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now_ms(), client_id],
        )?;
        Ok(changed == 1)
    }
}
