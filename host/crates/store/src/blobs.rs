//! Blob bytes live as files in `blobs/`, named by the SHA-256 of the blob id, so any id a Client uses (the
//! extension's `<session>:audio`, say) is a safe file name on every OS; the `blobs` table holds the id and its
//! metadata. An upload is written to a temporary file first and renamed into place, so a reader never sees half
//! a blob.

use std::path::PathBuf;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{BLOB_DIR, Result, Store, StoreError, now_ms, random_hex};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlobMeta {
    pub id: String,
    pub session_id: Option<String>,
    pub mime: String,
    pub size: i64,
    pub created_at: i64,
}

/// Blob ids: 1–256 bytes, no control characters.
pub fn valid_blob_id(id: &str) -> bool {
    (1..=256).contains(&id.len()) && !id.chars().any(char::is_control)
}

impl Store {
    /// Where to write an upload before `commit_blob` moves it into place.
    pub fn blob_upload_path(&self) -> Result<PathBuf> {
        Ok(self.dir.join(BLOB_DIR).join(format!(".upload-{}", random_hex(8)?)))
    }

    /// Moves a finished upload into place as blob `id`, replacing any earlier bytes, and records its metadata.
    pub fn commit_blob(&self, id: &str, session_id: Option<&str>, mime: &str, upload: PathBuf) -> Result<BlobMeta> {
        if !valid_blob_id(id) {
            let _ = std::fs::remove_file(&upload);
            return Err(StoreError::InvalidBlobId);
        }
        let size = i64::try_from(std::fs::metadata(&upload)?.len()).unwrap_or(i64::MAX);
        std::fs::rename(&upload, self.blob_path(id))?;
        let meta = BlobMeta {
            id: id.to_owned(),
            session_id: session_id.map(str::to_owned),
            mime: mime.to_owned(),
            size,
            created_at: now_ms(),
        };
        self.conn().execute(
            "INSERT INTO blobs (id, session_id, mime, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, mime = excluded.mime, size = excluded.size",
            params![meta.id, meta.session_id, meta.mime, meta.size, meta.created_at],
        )?;
        Ok(meta)
    }

    /// A blob's metadata and the file holding its bytes.
    pub fn blob(&self, id: &str) -> Result<Option<(BlobMeta, PathBuf)>> {
        if !valid_blob_id(id) {
            return Ok(None);
        }
        let meta = self
            .conn()
            .query_row("SELECT id, session_id, mime, size, created_at FROM blobs WHERE id = ?1", [id], |row| {
                Ok(BlobMeta {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    mime: row.get(2)?,
                    size: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .optional()?;
        Ok(meta.map(|meta| (meta, self.blob_path(id))))
    }

    pub(crate) fn blob_path(&self, id: &str) -> PathBuf {
        self.dir.join(BLOB_DIR).join(hex::encode(Sha256::digest(id.as_bytes())))
    }
}
