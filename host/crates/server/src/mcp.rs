//! `/mcp`: the agents' side of the Host (rmcp, Streamable HTTP). Unauthenticated from this machine (ADR 0005); from
//! another machine in network mode, behind a Bearer token checked in guard.rs (ADR 0006).
//!
//! An agent reads the Change Items a reviewer produced, says it started on one (`start_item`: "In work" on the
//! reviewer's card), implements it, and resolves it with a note that goes back to the card. The tool descriptions below are the agent's instructions, so they say what to do,
//! not only what the tool returns.

use std::collections::BTreeSet;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use inkup_store::fields::Fields;
use inkup_store::{
    Item, ItemFilter, ItemStatus, ResolutionStatus, Signal, SignalFilter, StartItem, Store, StoreError, origin_of,
};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler, schemars, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::VERSION;
use crate::hub::{Hub, Push};
use crate::ws::blocking;

const INSTRUCTIONS: &str = "inkup holds review feedback a person recorded on a web app by talking and \
drawing on it. Processed, it becomes Change Items: what to change, where (CSS selectors), and why, each with a \
self-contained agent_prompt. While a review is still being recorded, its live Annotations, Text Comments and Draft \
Items show up as Signals.\n\nThe loop:\n1. read_items(url=<the app you are working on>) for the backlog of open items.\n2. For \
each item: call start_item(id) before you touch the code, so the reviewer's card says it is in work and other \
agents leave it alone; implement its agent_prompt; then resolve_item(id, status, note): resolved with what you \
changed and where (files, components), wont_fix with why not, or needs_info with the question you need answered. \
The reviewer sees the note on the item's card.\n3. watch_items(url=..., cursor=<cursor from your last call>) to \
wait for new items, and repeat.\nResolve only items you acted on. Items another agent has in work (status \
in_progress) are not open; leave them. Items from another origin than your app are not yours to implement.";

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;
const DEFAULT_WATCH_SECONDS: u64 = 120;
const MAX_WATCH_SECONDS: u64 = 600;
const TRANSCRIPT_CHARS: usize = 600;

#[derive(Debug, Clone, Copy, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum StatusFilter {
    /// No resolution yet: nobody has started on it.
    #[default]
    Open,
    /// An agent called start_item and has not resolved it yet.
    InProgress,
    Resolved,
    WontFix,
    NeedsInfo,
    /// Every status.
    All,
}

impl StatusFilter {
    fn status(self) -> Option<ItemStatus> {
        match self {
            Self::Open => Some(ItemStatus::Open),
            Self::InProgress => Some(ItemStatus::InProgress),
            Self::Resolved => Some(ItemStatus::Resolved),
            Self::WontFix => Some(ItemStatus::WontFix),
            Self::NeedsInfo => Some(ItemStatus::NeedsInfo),
            Self::All => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ResolveStatus {
    /// Implemented; the note says what changed and where.
    Resolved,
    /// Not doing it; the note says why.
    WontFix,
    /// Blocked; the note asks the reviewer a question.
    NeedsInfo,
}

impl From<ResolveStatus> for ResolutionStatus {
    fn from(status: ResolveStatus) -> Self {
        match status {
            ResolveStatus::Resolved => Self::Resolved,
            ResolveStatus::WontFix => Self::WontFix,
            ResolveStatus::NeedsInfo => Self::NeedsInfo,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListSessionsArgs {
    /// Only Sessions on this URL's origin (scheme://host:port), e.g. http://localhost:3000.
    url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ReadItemsArgs {
    /// Which items: open (default: not started, not resolved), in_progress, resolved, wont_fix, needs_info, or all.
    #[serde(default)]
    status: StatusFilter,
    /// Only this Session's items.
    session_id: Option<String>,
    /// Only items from Sessions on this URL's origin, e.g. http://localhost:3000. Pass it whenever you know the app.
    url: Option<String>,
    /// Also return Signals (live Annotations, Text Comments and Draft Items) when reading open items. Default true.
    include_signals: Option<bool>,
    /// At most this many items (and this many Signals). Default 20, at most 100.
    limit: Option<usize>,
    /// Skip this many items (and Signals), for paging.
    offset: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ItemArgs {
    /// The item id, e.g. item-12.
    id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct Crop {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ScreenshotArgs {
    /// The screenshot id: `<id>` of a cited screenshots/<id>.png, or a Signal's `screenshot`.
    id: String,
    /// Only this region, in the image's pixels.
    crop: Option<Crop>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct WatchItemsArgs {
    /// Only items and Signals from Sessions on this URL's origin.
    url: Option<String>,
    /// Only this Session.
    session_id: Option<String>,
    /// How long to wait. Default 120, at most 600.
    timeout_seconds: Option<u64>,
    /// The cursor from your last read_items or watch_items: anything newer than it counts as new.
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct StartItemArgs {
    /// The item id, e.g. item-12.
    id: String,
    /// Optional, shown on the card: what you are about to do.
    note: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ResolveItemArgs {
    /// The item id, e.g. item-12.
    id: String,
    status: ResolveStatus,
    /// Shown to the reviewer on the item's card: what you changed and where, why not, or your question.
    note: String,
}

#[derive(Clone)]
pub(crate) struct Mcp {
    store: Arc<Store>,
    hub: Arc<Hub>,
    #[allow(dead_code, reason = "read by the tool_handler macro")]
    tool_router: ToolRouter<Self>,
}

/// The `/mcp` service. It stops serving when `shutdown` is cancelled.
pub(crate) fn service(
    store: Arc<Store>,
    hub: Arc<Hub>,
    shutdown: CancellationToken,
    network: bool,
) -> StreamableHttpService<Mcp, LocalSessionManager> {
    let mut config = StreamableHttpServerConfig::default().with_cancellation_token(shutdown);
    // rmcp's own Host check knows loopback names only; in network mode guard.rs checks the Host's other names.
    if network {
        config = config.disable_allowed_hosts();
    }
    StreamableHttpService::new(
        move || Ok(Mcp { store: Arc::clone(&store), hub: Arc::clone(&hub), tool_router: Mcp::tool_router() }),
        Arc::default(),
        config,
    )
}

fn failed(error: StoreError) -> ErrorData {
    tracing::error!(%error, "mcp: store error");
    ErrorData::internal_error("the host failed; see its log", None)
}

fn json_result(value: &Value) -> Result<CallToolResult, ErrorData> {
    let text = serde_json::to_string_pretty(value).map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn tool_error(message: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(message.into())]))
}

/// `item-12` or `12`.
fn parse_item_id(id: &str) -> Option<i64> {
    id.trim().strip_prefix("item-").unwrap_or(id.trim()).parse().ok().filter(|seq| *seq > 0)
}

fn item_id(seq: i64) -> String {
    format!("item-{seq}")
}

/// `<item seq>.<event seq>`: what a caller has seen.
fn format_cursor((items, events): (i64, i64)) -> String {
    format!("{items}.{events}")
}

fn parse_cursor(cursor: &str) -> Option<(i64, i64)> {
    let (items, events) = cursor.trim().split_once('.')?;
    Some((items.parse().ok()?, events.parse().ok()?))
}

fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}

/// An item trimmed to what an agent acts on.
pub(crate) fn agent_item(item: &Item) -> Value {
    let body = Fields::item(&item.body);
    let locations: Vec<Value> = body
        .array("locations")
        .iter()
        .map(|l| {
            let mut loc = json!({ "role": l.raw("role"), "element": l.raw("element"), "selector": l.raw("selector"), "url": l.raw("url"), "screenshot": l.raw("screenshot") });
            // Where the page's framework says the element is rendered: file, line and components (E4).
            if let Some(source) = l.get("source").value().filter(|s| s.is_object()) {
                loc["source"] = source.clone();
            }
            loc
        })
        .collect();
    let evidence = body.get("evidence");
    let mut view = json!({
        "id": item_id(item.seq),
        "status": item.status().as_str(),
        "session_id": item.session_id,
        "page": item.session_url,
        "title": body.raw("title"),
        "category": body.raw("category"),
        "intent": body.raw("intent"),
        "agent_prompt": body.raw("agent_prompt"),
        "locations": locations,
        "transcript": truncate(body.str("transcript").unwrap_or_default(), TRANSCRIPT_CHARS),
        "screenshots": evidence.raw("screenshots"),
        "confidence": body.raw("confidence"),
    });
    if let Some(ambiguity) = body.str("ambiguity") {
        view["ambiguity"] = json!(ambiguity);
    }
    // Made from Annotations a script on the page wrote through the page API (E5), not the reviewer.
    if let Some(source) = body.str("source") {
        view["source"] = json!(source);
    }
    // How the item fared when checked against the recording after Process: confirmed, corrected or unverified.
    let vetting = body.get("vetting");
    if let Some(verdict) = vetting.str("verdict") {
        view["vetting"] = json!({ "verdict": verdict, "reason": vetting.str("reason").unwrap_or_default() });
    }
    // Element crops of the item's Annotations, fetched like screenshots (`<id>.crop`).
    let crops = evidence.array("crops");
    if !crops.is_empty() {
        view["crops"] = json!(crops.iter().filter_map(Fields::value).collect::<Vec<_>>());
    }
    if let Some(r) = &item.resolution {
        view["resolution"] = json!({ "status": r.status, "note": r.note, "at": r.created_at });
        if let Some(agent) = &r.agent {
            view["resolution"]["agent"] = json!(agent);
        }
    }
    view
}

/// The connected agent's name, as its MCP client said in `initialize` (clientInfo.name).
fn agent_name(context: &RequestContext<RoleServer>) -> Option<String> {
    context.peer.peer_info().map(|info| info.client_info.name.trim().to_owned()).filter(|name| !name.is_empty())
}

fn page<T>(all: Vec<T>, offset: usize, limit: usize) -> Vec<T> {
    all.into_iter().skip(offset).take(limit).collect()
}

/// A warning when results come from more than one origin and the agent did not say which app it works on.
fn origin_warning(url: Option<&str>, items: &[Item], signals: &[Signal]) -> Option<String> {
    if url.is_some() {
        return None;
    }
    let origins: BTreeSet<String> = items
        .iter()
        .filter_map(|i| i.session_url.as_deref())
        .chain(signals.iter().filter_map(|s| s.url.as_deref()))
        .filter_map(origin_of)
        .collect();
    (origins.len() > 1).then(|| {
        format!(
            "These results span {} origins ({}). Items from another app than the one you are working on are not \
             yours to implement: call again with url set to your app's origin.",
            origins.len(),
            origins.into_iter().collect::<Vec<_>>().join(", ")
        )
    })
}

#[tool_router]
impl Mcp {
    #[tool(description = "List review Sessions, most recent activity first: id, start URL and origin, title, \
        whether it is still being recorded (live), and counts of Change Items (open and total), Annotations and \
        Draft Items. Pass url to see only Sessions on your app's origin.")]
    async fn list_sessions(&self, Parameters(args): Parameters<ListSessionsArgs>) -> Result<CallToolResult, ErrorData> {
        let sessions =
            blocking(&self.store, move |store| store.session_overviews(args.url.as_deref())).await.map_err(failed)?;
        let sessions: Vec<Value> = sessions
            .into_iter()
            .map(|s| {
                let state = if s.live {
                    "live"
                } else if s.items > 0 {
                    "processed"
                } else {
                    "ended"
                };
                json!({
                    "id": s.id, "url": s.url, "origin": s.url.as_deref().and_then(origin_of), "title": s.title,
                    "started_at": s.t0, "state": state, "items": s.items, "open_items": s.open_items,
                    "annotations": s.annotations, "draft_items": s.draft_items,
                })
            })
            .collect();
        json_result(&json!({ "sessions": sessions }))
    }

    #[tool(description = "Read Change Items to implement, trimmed for you: title, intent, agent_prompt (a \
        self-contained instruction: follow it), locations (per role, the CSS selector and a description: subject \
        is what changes, reference is what to match, destination is where it goes; source, when present, is the \
        file, line and components the page's framework says render it: start there), a transcript excerpt of what \
        the reviewer said, and screenshot ids (the agent_prompt cites them as screenshots/<id>.png; fetch one with \
        get_screenshot; crops are the same screenshots cut to the marked element). An item or Signal with source \
        \"page_api\" was annotated by a script on the page, not by the reviewer. status defaults to open (nobody has \
        started it; in_progress lists the ones an agent is working on). When reading \
        open items, Signals come too (include_signals): live Annotations, Text Comments and Draft Items of Sessions \
        that have no Change Items yet. A Signal is a heads-up, not a \
        task: wait for its Change Items unless the person asked you to act on live feedback. Pass url, your app's \
        origin, whenever you know it; results spanning several origins carry a warning. Give the returned cursor \
        to watch_items.")]
    async fn read_items(&self, Parameters(args): Parameters<ReadItemsArgs>) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let offset = args.offset.unwrap_or(0);
        let with_signals =
            args.include_signals.unwrap_or(true) && matches!(args.status, StatusFilter::Open | StatusFilter::All);
        let items_filter = ItemFilter {
            session_id: args.session_id.clone(),
            origin: args.url.clone(),
            status: args.status.status(),
            after_seq: None,
        };
        let signal_filter = SignalFilter { session_id: args.session_id, origin: args.url.clone(), after_seq: None };
        let (items, signals, cursor) = blocking(&self.store, move |store| {
            let cursor = store.cursor()?;
            let signals = if with_signals { store.signals(&signal_filter)? } else { Vec::new() };
            Ok((store.items(&items_filter)?, signals, cursor))
        })
        .await
        .map_err(failed)?;
        let warning = origin_warning(args.url.as_deref(), &items, &signals);
        let (items_total, signals_total) = (items.len(), signals.len());
        let mut result = json!({
            "items": page(items, offset, limit).iter().map(agent_item).collect::<Vec<_>>(),
            "items_total": items_total,
            "cursor": format_cursor(cursor),
        });
        if with_signals {
            result["signals"] = json!(page(signals, offset, limit));
            result["signals_total"] = json!(signals_total);
        }
        if let Some(warning) = warning {
            result["warning"] = json!(warning);
        }
        json_result(&result)
    }

    #[tool(description = "Everything about one Change Item: the item exactly as the review produced it (with the \
        reviewer's edits), its Session (URL, title), its status, and every resolution so far, oldest first.")]
    async fn get_item(&self, Parameters(args): Parameters<ItemArgs>) -> Result<CallToolResult, ErrorData> {
        let Some(seq) = parse_item_id(&args.id) else {
            return tool_error(format!("{} is not an item id; ids look like item-12", args.id));
        };
        let found = blocking(&self.store, move |store| {
            let Some(item) = store.item(seq)? else { return Ok(None) };
            let resolutions = store.resolutions(seq)?;
            let session = store.session_overviews(None)?.into_iter().find(|s| s.id == item.session_id);
            Ok(Some((item, resolutions, session)))
        })
        .await
        .map_err(failed)?;
        let Some((item, resolutions, session)) = found else {
            return tool_error(format!("no item {}", args.id));
        };
        json_result(&json!({
            "id": item_id(item.seq),
            "status": item.status().as_str(),
            "withdrawn": item.withdrawn_at.is_some(),
            "session": session.map(|s| json!({ "id": s.id, "url": s.url, "title": s.title, "live": s.live })),
            "item": item.body,
            "resolutions": resolutions,
        }))
    }

    #[tool(description = "A screenshot as an image, by id: the <id> of a cited screenshots/<id>.png, or a \
        Signal's screenshot. Pass crop {x, y, width, height} in the image's pixels for just that region.")]
    async fn get_screenshot(&self, Parameters(args): Parameters<ScreenshotArgs>) -> Result<CallToolResult, ErrorData> {
        let id = args.id.trim().trim_start_matches("screenshots/").trim_end_matches(".png").to_owned();
        let found = blocking(&self.store, move |store| store.blob(&id)).await.map_err(failed)?;
        let Some((meta, path)) = found else {
            return tool_error(format!("no screenshot {}", args.id));
        };
        if !meta.mime.starts_with("image/") {
            return tool_error(format!("{} is {}, not an image", args.id, meta.mime));
        }
        let bytes = tokio::fs::read(&path).await.map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let (bytes, mime) = match args.crop {
            None => (bytes, meta.mime),
            Some(crop) => match tokio::task::spawn_blocking(move || crop_png(&bytes, &crop)).await {
                Ok(Ok(png)) => (png, "image/png".to_owned()),
                Ok(Err(message)) => return tool_error(message),
                Err(e) => return Err(ErrorData::internal_error(e.to_string(), None)),
            },
        };
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(CallToolResult::success(vec![ContentBlock::image(data, mime)]))
    }

    #[tool(description = "Wait for new open Change Items or Signals, then return them (the same shape as \
        read_items, only what is new). Blocks up to timeout_seconds (default 120, at most 600); with nothing new \
        it returns timed_out: true, and you call it again. Pass the cursor from your last read_items or \
        watch_items so nothing that arrived in between is missed. Pass url (your app's origin) or session_id to \
        watch only those.")]
    async fn watch_items(&self, Parameters(args): Parameters<WatchItemsArgs>) -> Result<CallToolResult, ErrorData> {
        let seconds = args.timeout_seconds.unwrap_or(DEFAULT_WATCH_SECONDS).clamp(1, MAX_WATCH_SECONDS);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        // Subscribed before reading, so a change between the read and the wait still wakes this.
        let mut changes = self.hub.subscribe_changes();
        let since = match args.cursor.as_deref() {
            Some(cursor) => match parse_cursor(cursor) {
                Some(since) => since,
                None => return tool_error(format!("{cursor} is not a cursor from read_items or watch_items")),
            },
            None => blocking(&self.store, |store| store.cursor()).await.map_err(failed)?,
        };
        let _watching = self.hub.watching(args.url.clone(), args.session_id.clone(), since.0);
        loop {
            let (url, session_id) = (args.url.clone(), args.session_id.clone());
            let (items, signals, cursor) = blocking(&self.store, move |store| {
                let cursor = store.cursor()?;
                let items = store.items(&ItemFilter {
                    session_id: session_id.clone(),
                    origin: url.clone(),
                    status: Some(ItemStatus::Open),
                    after_seq: Some(since.0),
                })?;
                let signals = store.signals(&SignalFilter { session_id, origin: url, after_seq: Some(since.1) })?;
                Ok((items, signals, cursor))
            })
            .await
            .map_err(failed)?;
            if !items.is_empty() || !signals.is_empty() {
                let mut result = json!({
                    "timed_out": false,
                    "items": items.iter().map(agent_item).collect::<Vec<_>>(),
                    "signals": signals,
                    "cursor": format_cursor(cursor),
                });
                if let Some(warning) = origin_warning(args.url.as_deref(), &items, &signals) {
                    result["warning"] = json!(warning);
                }
                return json_result(&result);
            }
            tokio::select! {
                changed = changes.changed() => if changed.is_err() {
                    return Err(ErrorData::internal_error("the host is shutting down", None));
                },
                () = tokio::time::sleep_until(deadline) => {
                    return json_result(&json!({
                        "timed_out": true, "items": [], "signals": [], "cursor": format_cursor(since.max(cursor)),
                    }));
                }
            }
        }
    }

    #[tool(description = "Say you are starting on a Change Item, before you change any code for it. The reviewer's \
        card shows it as In work with your name, and read_items and watch_items stop listing it as open, so other \
        agents leave it alone. Calling it again for an item you already started changes nothing. An item already \
        resolved or marked wont_fix cannot be started. When you are done, call resolve_item.")]
    async fn start_item(
        &self,
        Parameters(args): Parameters<StartItemArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let Some(seq) = parse_item_id(&args.id) else {
            return tool_error(format!("{} is not an item id; ids look like item-12", args.id));
        };
        let note = args.note.unwrap_or_default().trim().to_owned();
        let agent = agent_name(&context);
        let outcome = blocking(&self.store, move |store| store.start_item(seq, &note, "mcp", agent.as_deref()))
            .await
            .map_err(failed)?;
        let resolution = match outcome {
            StartItem::NoItem => return tool_error(format!("no item {}", args.id)),
            StartItem::Refused(r) => {
                return tool_error(format!(
                    "{} is already {}{}; it cannot be started again. Read it with get_item.",
                    item_id(seq),
                    if r.status == ResolutionStatus::Resolved { "resolved" } else { "marked wont_fix" },
                    if r.note.is_empty() { String::new() } else { format!(" (\"{}\")", r.note) },
                ));
            }
            StartItem::Unchanged(r) => r,
            StartItem::Started(started) => {
                let r = started.resolution.clone();
                self.hub.push(Push::Resolution(started));
                self.hub.changed();
                r
            }
        };
        let mut result = json!({
            "id": item_id(seq), "status": resolution.status, "since": resolution.created_at,
            "resolution_id": resolution.id,
            "next": "Implement the item's agent_prompt, then call resolve_item with what you changed and where.",
        });
        if let Some(agent) = resolution.agent {
            result["agent"] = json!(agent);
        }
        json_result(&result)
    }

    #[tool(description = "Record what you did with a Change Item, once you are done with it (after start_item). \
        status: resolved (implemented; the note says what changed and where: files and components), wont_fix \
        (not doing it; the note says why), or needs_info (blocked; the note asks the reviewer a question). The \
        reviewer sees the note on the item's card. Items are never deleted; a later resolution replaces the one \
        shown, and every one is kept (get_item lists them). Resolve only items you acted on.")]
    async fn resolve_item(
        &self,
        Parameters(args): Parameters<ResolveItemArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let Some(seq) = parse_item_id(&args.id) else {
            return tool_error(format!("{} is not an item id; ids look like item-12", args.id));
        };
        let note = args.note.trim().to_owned();
        if note.is_empty() {
            return tool_error("write a note: what you changed and where, why not, or your question");
        }
        let status: ResolutionStatus = args.status.into();
        let agent = agent_name(&context);
        let resolved =
            blocking(&self.store, move |store| store.resolve_item(seq, status, &note, "mcp", agent.as_deref()))
                .await
                .map_err(failed)?;
        let Some(resolved) = resolved else {
            return tool_error(format!("no item {}", args.id));
        };
        let result = json!({
            "id": item_id(seq), "status": resolved.resolution.status, "note": resolved.resolution.note,
            "resolution_id": resolved.resolution.id,
        });
        self.hub.push(Push::Resolution(resolved));
        self.hub.changed();
        json_result(&result)
    }
}

fn crop_png(bytes: &[u8], crop: &Crop) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes).map_err(|e| format!("the screenshot could not be read: {e}"))?;
    if crop.width == 0 || crop.height == 0 || crop.x >= image.width() || crop.y >= image.height() {
        return Err(format!("the crop is outside the {}x{} image", image.width(), image.height()));
    }
    let width = crop.width.min(image.width() - crop.x);
    let height = crop.height.min(image.height() - crop.y);
    let mut png = Vec::new();
    image
        .crop_imm(crop.x, crop.y, width, height)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(png)
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("inkup", VERSION))
            .with_instructions(INSTRUCTIONS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_cursors_round_trip() {
        assert_eq!(parse_item_id("item-12"), Some(12));
        assert_eq!(parse_item_id("12"), Some(12));
        assert_eq!(parse_item_id("item_0001"), None);
        assert_eq!(parse_cursor(&format_cursor((3, 41))), Some((3, 41)));
        assert_eq!(parse_cursor("nope"), None);
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
