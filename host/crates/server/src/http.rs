//! The HTTP routes: /health (open), and blobs and the read API behind a Bearer token.

use axum::Json;
use axum::body::Body;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use inkup_protocol::Health;
use inkup_store::{Item, ItemFilter, SessionSummary, StoreError, valid_blob_id};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::hub::{Command, CommandError, CommandOutcome};
use crate::state::HostState;
use crate::ws::blocking;
use crate::{AppState, VERSION};

/// Screenshots are small; audio and video of a long Session are not. Beyond this an upload is refused.
const MAX_BLOB_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub(crate) async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(inkup_protocol::health(VERSION, state.config.hub_name.as_deref()))
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ApiError {
    #[error("send a paired Client's token or an agent token as `Authorization: Bearer <token>`")]
    Unauthorized,
    #[error("send the control token from host.json as `Authorization: Bearer <token>`")]
    NoControlToken,
    #[error("{0}")]
    Forbidden(&'static str),
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("the upload is larger than {MAX_BLOB_BYTES} bytes")]
    TooLarge,
    #[error("{0}")]
    Command(CommandError),
    #[error("the host failed; see its log")]
    Internal,
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::InvalidBlobId => Self::BadRequest(error.to_string()),
            _ => {
                tracing::error!(%error, "store error");
                Self::Internal
            }
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        tracing::error!(%error, "file error");
        Self::Internal
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Unauthorized | Self::NoControlToken => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Command(CommandError::NotConnected) => StatusCode::NOT_FOUND,
            Self::Command(CommandError::NoAnswer) => StatusCode::GATEWAY_TIMEOUT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(serde_json::json!({ "error": self.to_string() }))).into_response()
    }
}

/// A request carrying a paired Client's token or an agent token.
pub(crate) struct Authed;

impl FromRequestParts<AppState> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(&parts.headers).ok_or(ApiError::Unauthorized)?;
        let known = blocking(&state.store, move |store| store.authenticate_bearer(&token)).await?;
        known.map(|_| Authed).ok_or(ApiError::Unauthorized)
    }
}

pub(crate) fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

pub(crate) async fn sessions(_: Authed, State(state): State<AppState>) -> Result<Json<Vec<SessionSummary>>, ApiError> {
    Ok(Json(blocking(&state.store, |store| store.sessions()).await?))
}

pub(crate) async fn session_events(
    _: Authed,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let events = blocking(&state.store, move |store| store.session_events(&id)).await?;
    events.map(Json).ok_or(ApiError::NotFound)
}

/// What the TUI shows.
pub(crate) async fn state(_: Authed, State(state): State<AppState>) -> Result<Json<HostState>, ApiError> {
    Ok(Json(crate::state::snapshot(&state.store, &state.hub, None).await?))
}

/// Drives a connected Client's Session, as the TUI's keys do; answers with the Client's outcome.
pub(crate) async fn command(
    _: Authed,
    State(state): State<AppState>,
    Path(client_id): Path<String>,
    Json(command): Json<Command>,
) -> Result<Json<CommandOutcome>, ApiError> {
    state.hub.command(&client_id, command).await.map(Json).map_err(ApiError::Command)
}

#[derive(Deserialize)]
pub(crate) struct ItemsQuery {
    session_id: Option<String>,
}

/// Current Change Items with their latest Resolution, as stored.
pub(crate) async fn items(
    _: Authed,
    State(state): State<AppState>,
    Query(query): Query<ItemsQuery>,
) -> Result<Json<Vec<Item>>, ApiError> {
    let filter = ItemFilter { session_id: query.session_id, ..Default::default() };
    Ok(Json(blocking(&state.store, move |store| store.items(&filter)).await?))
}

#[derive(Deserialize)]
pub(crate) struct BlobQuery {
    session_id: Option<String>,
}

/// Streams the body to a file aside, then moves it into place. Idempotent: a resend replaces the bytes.
pub(crate) async fn put_blob(
    _: Authed,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<BlobQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    if !valid_blob_id(&id) {
        return Err(ApiError::BadRequest("invalid blob id".into()));
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let upload = state.store.blob_upload_path()?;
    if let Err(error) = write_body(&upload, body).await {
        let _ = tokio::fs::remove_file(&upload).await;
        return Err(error);
    }
    let meta =
        blocking(&state.store, move |store| store.commit_blob(&id, query.session_id.as_deref(), &mime, upload)).await?;
    Ok((StatusCode::CREATED, Json(meta)).into_response())
}

async fn write_body(path: &std::path::Path, body: Body) -> Result<(), ApiError> {
    let mut file = tokio::fs::File::create(path).await?;
    let mut stream = body.into_data_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::BadRequest(format!("upload interrupted: {e}")))?;
        written += chunk.len() as u64;
        if written > MAX_BLOB_BYTES {
            return Err(ApiError::TooLarge);
        }
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    Ok(())
}

pub(crate) async fn get_blob(
    _: Authed,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let (meta, path) = blocking(&state.store, move |store| store.blob(&id)).await?.ok_or(ApiError::NotFound)?;
    let file = tokio::fs::File::open(path).await?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok(([(header::CONTENT_TYPE, meta.mime), (header::CONTENT_LENGTH, meta.size.to_string())], body).into_response())
}
