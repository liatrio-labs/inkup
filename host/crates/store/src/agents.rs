//! Agent tokens (ADR 0006). In network mode an agent on another machine sends one as its Bearer token to `/mcp`;
//! loopback agents need none. Created by `inkup token create` or in the TUI, shown once, stored as SHA-256,
//! revoked in the TUI.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::clients::{Client, token_hash};
use crate::{Result, Store, now_ms, random_hex};

/// Told apart from a Client's `inkc1_` token at a glance.
const TOKEN_PREFIX: &str = "ink1_";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentToken {
    pub id: String,
    /// Who it is for, as the user named it (`claude-code on laptop`).
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// A new agent token and its secret, which exists nowhere else once shown.
#[derive(Debug, Clone)]
pub struct NewAgentToken {
    pub agent: AgentToken,
    pub token: String,
}

/// Whose Bearer token a request carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bearer {
    Client(Client),
    Agent(AgentToken),
}

impl Store {
    pub fn create_agent_token(&self, name: &str) -> Result<NewAgentToken> {
        let token = format!("{TOKEN_PREFIX}{}", random_hex(32)?);
        let agent = AgentToken {
            id: format!("a-{}", random_hex(4)?),
            name: name.to_owned(),
            created_at: now_ms(),
            last_used_at: None,
        };
        self.conn().execute(
            "INSERT INTO agent_tokens (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![agent.id, agent.name, token_hash(&token), agent.created_at],
        )?;
        Ok(NewAgentToken { agent, token })
    }

    /// Agent tokens not revoked, oldest first.
    pub fn agent_tokens(&self) -> Result<Vec<AgentToken>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, last_used_at FROM agent_tokens WHERE revoked_at IS NULL ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AgentToken { id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?, last_used_at: row.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The token stops working at once.
    pub fn revoke_agent_token(&self, id: &str) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE agent_tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now_ms(), id],
        )?;
        Ok(changed == 1)
    }

    /// The agent a token belongs to, unless revoked. Marks it used.
    pub fn authenticate_agent(&self, token: &str) -> Result<Option<AgentToken>> {
        let conn = self.conn();
        let agent = conn
            .query_row(
                "SELECT id, name, created_at, last_used_at FROM agent_tokens
                 WHERE token_sha256 = ?1 AND revoked_at IS NULL",
                [token_hash(token)],
                |row| {
                    Ok(AgentToken {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        created_at: row.get(2)?,
                        last_used_at: row.get(3)?,
                    })
                },
            )
            .optional()?;
        if let Some(agent) = &agent {
            conn.execute("UPDATE agent_tokens SET last_used_at = ?1 WHERE id = ?2", params![now_ms(), agent.id])?;
        }
        Ok(agent)
    }

    /// A paired Client's token or an agent token.
    pub fn authenticate_bearer(&self, token: &str) -> Result<Option<Bearer>> {
        if let Some(client) = self.authenticate(token)? {
            return Ok(Some(Bearer::Client(client)));
        }
        Ok(self.authenticate_agent(token)?.map(Bearer::Agent))
    }
}
