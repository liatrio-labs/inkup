//! The InkUp desktop app: a window and a menubar (tray) item next to the CLI, not instead of it.
//!
//! On launch it finds or hosts (startup.rs): it runs the server in-process when nobody holds the data dir, drives
//! the CLI host when one does, and hands over to the desktop app already running otherwise. The window reads and
//! acts on the host through the app's commands, which go through one `HostLink` (link.rs) in either mode.
//!
//! Closing the window hides it; the app keeps running from the menubar until Quit, which stops the server when
//! the app hosts. Where its icons show (menu bar, Dock) is `[desktop]` in config.toml (`inkup_store::DesktopConfig`).
//! What they show (the Clients dot, the development stripes) is icon.rs.
//!
//! On macOS the app bundles the `inkup` CLI, and Install CLI links it onto PATH (cli.rs). It never runs it.
//!
//! Tracker push (ADR 0028): the window sends Change Items to GitHub, Linear or Jira with the packages/core adapters,
//! on `tauri-plugin-http`'s fetch (scoped to the trackers' hosts in capabilities/default.json). Their tokens are in
//! the OS keychain (keychain.rs). The host serves the item and its screenshots, and records the link.
//!
//! The panel spike (spec 03, Unit 1, throwaway): the tray's "Spike overlay", "Spike: catch pointer" and "Spike:
//! close" open a transparent, non-activating panel on every display through `inkup_macos::Panels` ([`spike`]).
//! Those tray items, their menu handling and their commands are registered only in a development build
//! ([`icon::DEVELOPMENT`], true when `INKUP_RELEASE_BUILD` is unset). A release build does not ship them.

#[cfg(unix)]
pub mod cli;
#[cfg(target_os = "macos")]
mod dock;
pub mod icon;
pub mod keychain;
pub mod link;
pub mod startup;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use anyhow::{Context, Result};
use inkup_macos::{OsPanels, Panels};
use inkup_protocol::control::{
    CommandOutcome, CommandRequest, ControlState, FullItem, NewToken, PairingAnswer, TrackerLink,
};
use inkup_server::{ActivateHook, NetworkHook};
use inkup_store::DesktopConfig;
use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry};

use crate::icon::{Dot, DotDriver, Frames};
use crate::link::HostLink;
use crate::startup::{Hosted, Hosting, Startup, find_or_host};

const MAIN_WINDOW: &str = "main";
const TRAY: &str = "inkup";
/// Sent to the window when the menu bar or Dock setting changes from the tray.
const TOGGLES_EVENT: &str = "desktop-toggles";
/// Sent to the window when the host it talks to changed: taken over, or restarted in or out of network mode.
const VIEW_EVENT: &str = "host-view";
/// The app icon the tray and Dock pictures are drawn from.
const APP_ICON: &[u8] = include_bytes!("../icons/icon.png");
/// The menu bar icon in pixels: 18 pt at 2x.
const TRAY_SIZE: u32 = 36;
/// The Dock icon in pixels: 256 pt at 2x, as big as the Dock magnifies.
const DOCK_SIZE: u32 = 512;

/// Where the app runs: the data dir and the port to host on.
pub struct Launch {
    pub data_dir: PathBuf,
    pub port: u16,
}

/// Host or client, as the header and the tray say it.
#[derive(Debug, Clone, Serialize)]
pub struct HostView {
    /// `host`: this app runs the server. `client`: the CLI does.
    pub mode: &'static str,
    /// Who hosts: `desktop`, `tui` or `serve`.
    pub kind: inkup_store::instance::HostKind,
    pub address: String,
    pub data_dir: String,
}

impl HostView {
    fn status_line(&self) -> String {
        match self.mode {
            "host" => format!("Hosting on {}", self.address),
            _ => format!("Client of {} on {}", self.kind.describe(), self.address),
        }
    }
}

/// The menu bar and Dock settings, as the window's switches show them.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Toggles {
    pub menubar: bool,
    pub dock: bool,
}

impl From<DesktopConfig> for Toggles {
    fn from(config: DesktopConfig) -> Self {
        Self { menubar: config.menubar, dock: config.dock }
    }
}

/// The host this window talks to, and how the header says it. Replaced when "Host here" takes over.
#[derive(Clone)]
struct Current {
    link: HostLink,
    view: HostView,
}

struct Desktop {
    data_dir: PathBuf,
    hosting: Hosting,
    current: RwLock<Current>,
    /// The server, in host mode, until Quit.
    hosted: tokio::sync::Mutex<Option<Hosted>>,
    toggles: Mutex<Toggles>,
    tray: OnceLock<TrayItems>,
    /// The Clients dot, from each host state the window reads.
    dot: DotDriver,
    icons: Icons,
}

impl Desktop {
    fn current(&self) -> Current {
        self.current.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn link(&self) -> HostLink {
        self.current().link
    }

    fn toggles(&self) -> Toggles {
        *self.toggles.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The tray and Dock pictures, one per frame of the dot.
struct Icons {
    tray: Frames<Image<'static>>,
    /// macOS: a PNG for the Dock tile, or `None` for the bundled icon. Elsewhere: the window's taskbar icon.
    #[cfg(target_os = "macos")]
    dock: Frames<Option<Vec<u8>>>,
    #[cfg(not(target_os = "macos"))]
    dock: Frames<Image<'static>>,
}

impl Icons {
    fn new() -> Self {
        let base = Arc::new(
            image::load_from_memory_with_format(APP_ICON, image::ImageFormat::Png)
                .expect("the bundled icon is a PNG")
                .to_rgba8(),
        );
        let development = icon::DEVELOPMENT;
        let tray = {
            let base = Arc::clone(&base);
            Frames::new(move |dot| {
                let img = icon::compose(&base, TRAY_SIZE, development, dot);
                Image::new_owned(img.into_raw(), TRAY_SIZE, TRAY_SIZE)
            })
        };
        #[cfg(target_os = "macos")]
        let dock = Frames::new(move |dot| {
            // A release build with no dot keeps the bundled icon.
            if !development && dot == Dot::None {
                return None;
            }
            let mut png = Vec::new();
            let img = icon::compose(&base, DOCK_SIZE, development, dot);
            img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
            Some(png)
        });
        #[cfg(not(target_os = "macos"))]
        let dock = Frames::new(move |dot| {
            let img = icon::compose(&base, DOCK_SIZE, development, dot);
            Image::new_owned(img.into_raw(), DOCK_SIZE, DOCK_SIZE)
        });
        Self { tray, dock }
    }
}

/// Puts a frame of the dot on the tray and the Dock. Main thread only.
fn show_dot(app: &AppHandle, dot: Dot) {
    let desktop = app.state::<Desktop>();
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_icon(Some(desktop.icons.tray.get(dot).clone()));
    }
    #[cfg(target_os = "macos")]
    dock::show(desktop.icons.dock.get(dot).as_deref());
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_icon(desktop.icons.dock.get(dot).clone());
    }
}

/// The tray's items that change while the app runs.
struct TrayItems {
    status: MenuItem<Wry>,
    menubar: CheckMenuItem<Wry>,
    dock: CheckMenuItem<Wry>,
    /// "Spike: catch pointer", present only while [`spike::surface`] lists it (a development build).
    spike_catch: Option<CheckMenuItem<Wry>>,
}

impl TrayItems {
    fn set_spike_catch(&self, on: bool) {
        if let Some(item) = &self.spike_catch {
            let _ = item.set_checked(on);
        }
    }

    /// The check flipped on click: this is the new state. Absent in a release build.
    fn spike_catch_checked(&self) -> bool {
        self.spike_catch.as_ref().is_some_and(|item| item.is_checked().unwrap_or(false))
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// What the window shows: `GET /api/host/state` through the link. Each read also sets the Clients dot, so the
/// icons follow the window's long-poll with no loop of their own.
#[tauri::command]
async fn host_state(desktop: State<'_, Desktop>, timeline: Option<String>) -> Result<ControlState, String> {
    let state = desktop.link().state(timeline.as_deref()).await;
    desktop.dot.follow(&state);
    state.map_err(text)
}

#[tauri::command]
fn host_view(desktop: State<'_, Desktop>) -> HostView {
    desktop.current().view
}

/// Waits for the host's next change after `since`: the window refetches on it.
#[tauri::command]
async fn host_changes(desktop: State<'_, Desktop>, since: u64) -> Result<u64, String> {
    desktop.link().changes(since).await.map_err(text)
}

#[tauri::command]
async fn send_command(desktop: State<'_, Desktop>, request: CommandRequest) -> Result<CommandOutcome, String> {
    desktop.link().command(&request).await.map_err(text)
}

#[tauri::command]
async fn create_token(desktop: State<'_, Desktop>, name: String) -> Result<NewToken, String> {
    desktop.link().create_token(&name).await.map_err(text)
}

#[tauri::command]
async fn revoke_token(desktop: State<'_, Desktop>, id: String) -> Result<(), String> {
    desktop.link().revoke_token(&id).await.map_err(text)
}

/// Network mode, host mode only: the host restarts in it (`Hosted::switch_network`).
#[tauri::command]
async fn set_network(desktop: State<'_, Desktop>, on: bool) -> Result<bool, String> {
    desktop.link().network(on).await.map_err(text)
}

#[tauri::command]
async fn answer_pairing(desktop: State<'_, Desktop>, id: u64, answer: PairingAnswer) -> Result<(), String> {
    desktop.link().answer_pairing(id, &answer).await.map_err(text)
}

/// One stored Change Item in full, to send to a tracker.
#[tauri::command]
async fn host_item(desktop: State<'_, Desktop>, id: String) -> Result<FullItem, String> {
    desktop.link().item(&id).await.map_err(text)
}

/// A screenshot's bytes, as an ArrayBuffer in the window.
#[tauri::command]
async fn host_screenshot(desktop: State<'_, Desktop>, id: String) -> Result<tauri::ipc::Response, String> {
    desktop.link().blob(&id).await.map(tauri::ipc::Response::new).map_err(text)
}

/// Records the issue an item was sent to; answers the item with it.
#[tauri::command]
async fn record_tracker_link(desktop: State<'_, Desktop>, id: String, link: TrackerLink) -> Result<FullItem, String> {
    desktop.link().record_tracker_link(&id, &link).await.map_err(text)
}

/// A pairing link as a QR code: an SVG the window shows in an `<img>`.
#[tauri::command]
fn pairing_qr(link: String) -> Result<String, String> {
    let code = qrcode::QrCode::with_error_correction_level(link, qrcode::EcLevel::M).map_err(text)?;
    Ok(code.render::<qrcode::render::svg::Color<'_>>().min_dimensions(160, 160).quiet_zone(true).build())
}

/// "Host here", after the host went away: tries the data dir again. The app hosts when it is free, or becomes
/// the client of whoever took it first.
#[tauri::command]
async fn host_here(app: AppHandle, desktop: State<'_, Desktop>) -> Result<HostView, String> {
    let mut hosted = desktop.hosted.lock().await;
    if hosted.is_some() {
        return Ok(desktop.current().view);
    }
    let data_dir = desktop.data_dir.display().to_string();
    let current = match find_or_host(&desktop.data_dir, &desktop.hosting).await.map_err(text)? {
        Startup::Host { link, hosted: started } => {
            *hosted = Some(started);
            let view = host_view_of(&link, data_dir);
            Current { link, view }
        }
        Startup::Client { link, holder } => {
            let view = HostView { mode: "client", kind: holder.kind, address: link.address(), data_dir };
            Current { link, view }
        }
        Startup::Activated(holder) => {
            return Err(format!("{} holds this data dir now and was brought forward", holder.describe()));
        }
    };
    let view = current.view.clone();
    // Scripts wait for this line.
    eprintln!("InkUp desktop: Host here: {}", view.status_line());
    *desktop.current.write().unwrap_or_else(|p| p.into_inner()) = current;
    if let Some(tray) = desktop.tray.get() {
        let _ = tray.status.set_text(view.status_line());
    }
    let _ = app.emit(VIEW_EVENT, &view);
    Ok(view)
}

/// Install CLI: where `/usr/local/bin/inkup` points and which `inkup` a terminal runs. `None` outside macOS, where the
/// app bundles no CLI.
#[tauri::command]
async fn cli_status() -> Option<install_cli::Status> {
    install_cli::status().await
}

/// Links `/usr/local/bin/inkup` to this app's CLI, through macOS's administrator prompt when needed. `replace`: the
/// person confirmed replacing another `inkup` there.
#[tauri::command]
async fn install_cli(replace: bool) -> Result<Option<install_cli::Status>, String> {
    install_cli::install(replace).await
}

/// Removes the link when it is this app's (or points at nothing).
#[tauri::command]
async fn uninstall_cli() -> Result<Option<install_cli::Status>, String> {
    install_cli::uninstall().await
}

/// The CLI commands on macOS, and their "not here" answers elsewhere.
#[cfg(target_os = "macos")]
mod install_cli {
    use std::path::Path;

    use crate::cli::{self, CliError, LinkState};

    pub type Status = cli::CliStatus;

    pub async fn status() -> Option<Status> {
        Some(cli::status(Path::new(cli::LINK)).await)
    }

    pub async fn install(replace: bool) -> Result<Option<Status>, String> {
        change(move |link, bundled| cli::install(link, bundled, replace, cli::admin)).await
    }

    pub async fn uninstall() -> Result<Option<Status>, String> {
        change(|link, bundled| cli::uninstall(link, bundled, cli::admin)).await
    }

    /// Runs `change` off the async runtime (the administrator prompt blocks), then reads the status again.
    async fn change(
        change: impl FnOnce(&Path, &Path) -> Result<LinkState, CliError> + Send + 'static,
    ) -> Result<Option<Status>, String> {
        let bundled = cli::bundled().ok_or_else(|| CliError::NotBundled.to_string())?;
        let done = tauri::async_runtime::spawn_blocking(move || change(Path::new(cli::LINK), &bundled)).await;
        let state = done.map_err(super::text)?.map_err(super::text)?;
        // Scripts wait for this line.
        eprintln!("InkUp desktop: CLI link {state:?}");
        Ok(status().await)
    }
}

#[cfg(not(target_os = "macos"))]
mod install_cli {
    #[derive(serde::Serialize)]
    pub struct Status;

    const MACOS_ONLY: &str = "the app bundles the inkup CLI on macOS only";

    pub async fn status() -> Option<Status> {
        None
    }

    pub async fn install(_replace: bool) -> Result<Option<Status>, String> {
        Err(MACOS_ONLY.into())
    }

    pub async fn uninstall() -> Result<Option<Status>, String> {
        Err(MACOS_ONLY.into())
    }
}

#[tauri::command]
fn desktop_toggles(desktop: State<'_, Desktop>) -> Toggles {
    desktop.toggles()
}

#[tauri::command]
fn set_desktop_toggles(app: AppHandle, toggles: Toggles) -> Result<Toggles, String> {
    apply_toggles(&app, toggles).map_err(text)
}

/// Saves the menu bar and Dock settings, then shows or hides the icons and keeps the tray's checks and the
/// window's switches in step. Both off is refused (by the store), and nothing changes.
fn apply_toggles(app: &AppHandle, toggles: Toggles) -> Result<Toggles> {
    let desktop = app.state::<Desktop>();
    DesktopConfig { menubar: toggles.menubar, dock: toggles.dock }.save(&desktop.data_dir)?;
    *desktop.toggles.lock().unwrap_or_else(|p| p.into_inner()) = toggles;
    show_icons(app, toggles);
    // Scripts wait for this line.
    eprintln!("InkUp desktop: menu bar {}, Dock {}", on_off(toggles.menubar), on_off(toggles.dock));
    let _ = app.emit(TOGGLES_EVENT, toggles);
    Ok(toggles)
}

/// The icons as `toggles` says, and the tray's checks to match; the last one on cannot be turned off.
fn show_icons(app: &AppHandle, toggles: Toggles) {
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_visible(toggles.menubar);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_dock_visibility(toggles.dock);
        // A Dock icon shown again starts from the bundle's: put the drawn one back.
        if toggles.dock {
            let desktop = app.state::<Desktop>();
            dock::show(desktop.icons.dock.get(desktop.dot.clients().resting()).as_deref());
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_skip_taskbar(!toggles.dock);
    }
    if let Some(items) = app.state::<Desktop>().tray.get() {
        let _ = items.menubar.set_checked(toggles.menubar);
        let _ = items.dock.set_checked(toggles.dock);
        let _ = items.menubar.set_enabled(toggles.dock);
        let _ = items.dock.set_enabled(toggles.menubar);
    }
}

fn host_view_of(link: &HostLink, data_dir: String) -> HostView {
    HostView { mode: "host", kind: inkup_store::instance::HostKind::Desktop, address: link.address(), data_dir }
}

/// Shows, raises and focuses the window.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The window's network switch, after the control API answered: restart the server in or out of network mode.
async fn switch_network(app: AppHandle, on: bool) {
    let desktop = app.state::<Desktop>();
    let mut hosted = desktop.hosted.lock().await;
    let Some(running) = hosted.take() else { return };
    match running.switch_network(on).await {
        Ok(restarted) => {
            let network = restarted.server.addr.ip().is_unspecified();
            // Scripts wait for this line.
            eprintln!("InkUp desktop: network mode {}", on_off(network));
            *hosted = Some(restarted);
        }
        Err(error) => tracing::error!(%error, "the server did not come back after switching network mode"),
    }
    let _ = app.emit(VIEW_EVENT, desktop.current().view);
}

/// Runs the app until Quit. Returns early, successfully, when another desktop app already runs on the data dir:
/// that one comes forward instead.
pub fn run(launch: Launch) -> Result<()> {
    // The hooks need the app, which exists only once Tauri has started; until then they do nothing.
    let handle: Arc<OnceLock<AppHandle>> = Arc::default();
    let on_activate = {
        let handle = Arc::clone(&handle);
        ActivateHook::new(move || {
            if let Some(app) = handle.get() {
                tracing::info!("another launch asked for the window: showing it");
                let app = app.clone();
                // Window calls belong on the main thread; the hook runs on a server task.
                let _ = app.clone().run_on_main_thread(move || show_main(&app));
            } else {
                tracing::info!("another launch asked for the window before it was up; it shows on start");
            }
        })
    };
    let on_network = {
        let handle = Arc::clone(&handle);
        // On a task of its own: the restart stops the server this request came in on, once it has answered.
        NetworkHook::new(move |on| match handle.get() {
            Some(app) => drop(tauri::async_runtime::spawn(switch_network(app.clone(), on))),
            None => tracing::warn!("network mode asked for before the app was up"),
        })
    };
    let dot = {
        let handle = Arc::clone(&handle);
        // The pulse calls this on a task; the icons change on the main thread.
        DotDriver::new(move |dot| {
            if let Some(app) = handle.get() {
                let app = app.clone();
                let _ = app.clone().run_on_main_thread(move || show_dot(&app, dot));
            }
        })
    };
    let hosting = Hosting::new(launch.port, on_activate, on_network);
    // Tauri's own runtime, so the server runs where the app's commands do.
    let startup = tauri::async_runtime::block_on(find_or_host(&launch.data_dir, &hosting))?;
    let data_dir = launch.data_dir.display().to_string();
    let (current, hosted) = match startup {
        Startup::Activated(holder) => {
            eprintln!("InkUp is already running ({}): brought it forward.", holder.describe());
            return Ok(());
        }
        Startup::Host { link, hosted } => {
            let view = host_view_of(&link, data_dir);
            (Current { link, view }, Some(hosted))
        }
        Startup::Client { link, holder } => {
            let view = HostView { mode: "client", kind: holder.kind, address: link.address(), data_dir };
            (Current { link, view }, None)
        }
    };
    let toggles = Toggles::from(DesktopConfig::load(&launch.data_dir).context("read config.toml")?);
    let status = current.view.status_line();
    let ready = format!("InkUp desktop: {status} (data dir {})", current.view.data_dir);
    let desktop = Desktop {
        data_dir: launch.data_dir,
        hosting,
        current: RwLock::new(current),
        hosted: tokio::sync::Mutex::new(hosted),
        toggles: Mutex::new(toggles),
        tray: OnceLock::new(),
        dot,
        icons: Icons::new(),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(desktop)
        .invoke_handler(command_handler(icon::DEVELOPMENT))
        .setup(move |app| {
            let _ = handle.set(app.handle().clone());
            let items = tray(app.handle(), &status, toggles)?;
            let _ = app.state::<Desktop>().tray.set(items);
            show_icons(app.handle(), toggles);
            // Development stripes from the start; the dot follows the first host state.
            show_dot(app.handle(), Dot::None);
            theme_override(app.handle());
            // Once the hooks can reach the window: scripts wait for these lines.
            eprintln!("{ready}");
            eprintln!("InkUp desktop: menu bar {}, Dock {}", on_off(toggles.menubar), on_off(toggles.dock));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it: the app keeps running from the menubar. Spike panels really close.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == MAIN_WINDOW
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .context("start the app")?;
    app.run(|app, event| match event {
        // macOS: the Dock icon clicked while the window is hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => stop_hosting(app),
        _ => {}
    });
    Ok(())
}

fn on_off(on: bool) -> &'static str {
    if on { "on" } else { "off" }
}

/// `INKUP_DESKTOP_THEME=light|dark` pins the window's appearance, for screenshots of both on one machine. Without
/// it the window follows the system, as the UI's tokens do (`prefers-color-scheme`).
fn theme_override(app: &AppHandle) {
    let theme = match std::env::var("INKUP_DESKTOP_THEME").as_deref() {
        Ok("light") => tauri::Theme::Light,
        Ok("dark") => tauri::Theme::Dark,
        _ => return,
    };
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_theme(Some(theme));
    }
}

/// The app's commands. The panel spike's three are registered only when [`spike::surface`] lists them: a
/// development build (`icon::DEVELOPMENT`) and not a release build (`INKUP_RELEASE_BUILD` set).
fn command_handler(development: bool) -> impl Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static {
    macro_rules! commands {
        ($($spike:ident),*) => {
            tauri::generate_handler![
                host_state,
                host_view,
                host_changes,
                send_command,
                create_token,
                revoke_token,
                set_network,
                answer_pairing,
                pairing_qr,
                host_here,
                desktop_toggles,
                set_desktop_toggles,
                cli_status,
                install_cli,
                uninstall_cli,
                host_item,
                host_screenshot,
                record_tracker_link,
                keychain::tracker_secret,
                keychain::set_tracker_secret,
                $($spike),*
            ]
        };
    }
    // The runtime is known only once the closure is typed: `invoke_handler` infers it, a bare `let` does not.
    let release: Box<dyn Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync> = Box::new(commands!());
    let with_spike: Box<dyn Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync> =
        Box::new(commands!(spike_overlay_show, spike_overlay_catch, spike_overlay_close));
    // `surface` is the gate: an empty command list means the release handler, which has no spike commands.
    let include_spike = spike::surface(development).has_commands();
    move |invoke| if include_spike { with_spike(invoke) } else { release(invoke) }
}

/// The tray: Show InkUp, where the host is, the menu bar and Dock switches, and Quit. A development build also has
/// the panel spike's three items; [`spike::surface`] leaves them out of a release build.
fn tray(app: &AppHandle, status: &str, toggles: Toggles) -> tauri::Result<TrayItems> {
    let show = MenuItem::with_id(app, "show", "Show InkUp", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let menubar = CheckMenuItem::with_id(app, "menubar", "Show in Menu Bar", true, toggles.menubar, None::<&str>)?;
    let dock = CheckMenuItem::with_id(app, "dock", "Show in Dock", true, toggles.dock, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit InkUp", true, None::<&str>)?;
    let sep_status = PredefinedMenuItem::separator(app)?;
    let sep_toggles = PredefinedMenuItem::separator(app)?;
    // The spike items exist only when the surface lists them. A release build's menu ends at Quit.
    let spike = spike::surface(icon::DEVELOPMENT);
    let spike_show_item = spike
        .has_tray("spike-show")
        .then(|| MenuItem::with_id(app, "spike-show", "Spike overlay", true, None::<&str>))
        .transpose()?;
    let spike_catch_item = spike
        .has_tray("spike-catch")
        .then(|| CheckMenuItem::with_id(app, "spike-catch", "Spike: catch pointer", true, false, None::<&str>))
        .transpose()?;
    let spike_close_item = spike
        .has_tray("spike-close")
        .then(|| MenuItem::with_id(app, "spike-close", "Spike: close", true, None::<&str>))
        .transpose()?;
    let sep_spike = if spike.tray.is_empty() { None } else { Some(PredefinedMenuItem::separator(app)?) };

    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&show, &status, &sep_status, &menubar, &dock, &sep_toggles];
    if let Some(item) = &spike_show_item {
        items.push(item);
    }
    if let Some(item) = &spike_catch_item {
        items.push(item);
    }
    if let Some(item) = &spike_close_item {
        items.push(item);
    }
    if let Some(item) = &sep_spike {
        items.push(item);
    }
    items.push(&quit);
    let menu = Menu::with_items(app, &items)?;
    let icon = app.state::<Desktop>().icons.tray.get(Dot::None).clone();
    // Not a template image: macOS would draw a template in the menu bar's one colour, and the dot has to stay green
    // (and the development stripes yellow). The full-colour app icon reads on light and dark menu bars as it is.
    let tray = TrayIconBuilder::with_id(TRAY).tooltip("InkUp").menu(&menu).show_menu_on_left_click(true);
    let tray = tray.icon(icon).icon_as_template(false);
    tray.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        // Same gate as the items: a release build's surface lists no spike ids, so these arms never run.
        if spike::surface(icon::DEVELOPMENT).has_tray(id) {
            match id {
                // Menu events come on the main thread, where the panels are made. Each logs its own outcome.
                "spike-show" => drop(spike_show(app)),
                "spike-catch" => {
                    let on = app.state::<Desktop>().tray.get().is_some_and(TrayItems::spike_catch_checked);
                    drop(spike_catch(app, on));
                }
                "spike-close" => drop(spike_close(app)),
                _ => {}
            }
            return;
        }
        match id {
            "show" => show_main(app),
            "quit" => app.exit(0),
            id @ ("menubar" | "dock") => {
                let mut toggles = app.state::<Desktop>().toggles();
                if id == "menubar" {
                    toggles.menubar = !toggles.menubar;
                } else {
                    toggles.dock = !toggles.dock;
                }
                if let Err(error) = apply_toggles(app, toggles) {
                    tracing::warn!(%error, "menu bar and Dock settings not saved");
                    // The check flipped on click: put it back.
                    show_icons(app, app.state::<Desktop>().toggles());
                }
            }
            _ => {}
        }
    })
    .build(app)?;
    Ok(TrayItems { status, menubar, dock, spike_catch: spike_catch_item })
}

/// On the way out: stop the embedded server and give up the data dir, so the next host starts clean.
fn stop_hosting(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    let hosted = tauri::async_runtime::block_on(async { desktop.hosted.lock().await.take() });
    if let Some(hosted) = hosted {
        tauri::async_runtime::block_on(hosted.shutdown());
    }
}

/// A panel as the spike commands answer it.
#[derive(Debug, Clone, Serialize)]
struct SpikePanel {
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    click_through: bool,
    /// The window rules AppKit says this panel breaks: empty when it keeps them all.
    broken: Vec<&'static str>,
}

impl From<&inkup_macos::PanelInfo> for SpikePanel {
    fn from(panel: &inkup_macos::PanelInfo) -> Self {
        let b = panel.bounds;
        Self {
            label: panel.label.clone(),
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            click_through: panel.click_through,
            broken: panel.observed.broken(&inkup_macos::PANEL),
        }
    }
}

/// Each show's windows get new labels.
static SPIKE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The connected displays from Tauri's monitor list, in points.
fn spike_displays(app: &AppHandle) -> Result<Vec<spike::Display>, String> {
    let monitors = app.available_monitors().map_err(text)?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let scale = monitor.scale_factor();
            let (position, size) = (monitor.position(), monitor.size());
            spike::Display {
                name: monitor.name().cloned().unwrap_or_else(|| format!("display {}", index + 1)),
                bounds: inkup_macos::Bounds {
                    x: f64::from(position.x) / scale,
                    y: f64::from(position.y) / scale,
                    width: f64::from(size.width) / scale,
                    height: f64::from(size.height) / scale,
                },
            }
        })
        .collect())
}

/// `display` for the page's query string: letters and digits as they are, everything else percent-encoded.
fn query_value(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => char::from(b).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A hidden, transparent webview window over `display`, for Panels to turn into a panel and show.
fn spike_window(app: &AppHandle, label: &str, display: &spike::Display) -> Result<inkup_macos::NativeWindow, String> {
    let url = tauri::WebviewUrl::App(format!("spike.html?display={}", query_value(&display.name)).into());
    let b = display.bounds;
    let window = tauri::WebviewWindowBuilder::new(app, label, url)
        .title(format!("InkUp spike on {}", display.name))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        // Shown by the panel, without activating the app.
        .visible(false)
        .focused(false)
        // A click while InkUp is in the background reaches the canvas.
        .accept_first_mouse(true)
        .position(b.x, b.y)
        .inner_size(b.width, b.height)
        .build()
        .map_err(text)?;
    native_window(&window)
}

#[cfg(target_os = "macos")]
fn native_window(window: &tauri::WebviewWindow) -> Result<inkup_macos::NativeWindow, String> {
    window.ns_window().map(inkup_macos::NativeWindow).map_err(text)
}

#[cfg(not(target_os = "macos"))]
fn native_window(_window: &tauri::WebviewWindow) -> Result<inkup_macos::NativeWindow, String> {
    Err(inkup_macos::Error::Unsupported.to_string())
}

/// Drops Tauri's side of every spike window that is still there.
fn destroy_spike_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(spike::LABEL_PREFIX) {
            let _ = window.destroy();
        }
    }
}

/// "Spike overlay": a panel on every display, click-through. Main thread.
fn spike_show(app: &AppHandle) -> Result<Vec<SpikePanel>, String> {
    let result = (|| {
        if !cfg!(target_os = "macos") {
            return Err(inkup_macos::Error::Unsupported.to_string());
        }
        spike::close(&OsPanels)?;
        destroy_spike_windows(app);
        let displays = spike_displays(app)?;
        let generation = SPIKE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        spike::show(&OsPanels, generation, &displays, |label, display| spike_window(app, label, display))
    })();
    if let Some(items) = app.state::<Desktop>().tray.get() {
        items.set_spike_catch(false);
    }
    match result {
        Ok(shown) => {
            // Scripts and the smoke read these lines.
            eprintln!("InkUp desktop: spike overlay on {} displays", shown.len());
            for panel in &shown {
                eprintln!("InkUp desktop: spike panel {}", spike::describe(panel));
            }
            Ok(shown.iter().map(SpikePanel::from).collect())
        }
        Err(error) => {
            eprintln!("InkUp desktop: spike overlay failed: {error}");
            Err(error)
        }
    }
}

/// "Spike: catch pointer": on, a drag draws on the panels; off, it reaches the app underneath. Main thread.
fn spike_catch(app: &AppHandle, on: bool) -> Result<(), String> {
    let result = spike::catch(&OsPanels, on);
    if let Some(items) = app.state::<Desktop>().tray.get() {
        items.set_spike_catch(on && result.is_ok());
    }
    match &result {
        Ok(()) if on => eprintln!("InkUp desktop: spike panels catch the pointer"),
        Ok(()) => eprintln!("InkUp desktop: spike panels let the pointer through"),
        Err(error) => eprintln!("InkUp desktop: spike catch failed: {error}"),
    }
    result
}

/// "Spike: close": closes every panel, then (half a second on, once AppKit has let go of them) logs how many are
/// still among NSApplication.windows, which should be none. Main thread.
fn spike_close(app: &AppHandle) -> Result<(), String> {
    let result = spike::close(&OsPanels);
    destroy_spike_windows(app);
    if let Some(items) = app.state::<Desktop>().tray.get() {
        items.set_spike_catch(false);
    }
    match &result {
        Ok(()) => {
            eprintln!("InkUp desktop: spike overlay closed");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let _ = app.run_on_main_thread(|| match OsPanels.list() {
                    Ok(left) => eprintln!("InkUp desktop: spike panels left in NSApplication.windows: {}", left.len()),
                    Err(error) => eprintln!("InkUp desktop: spike panels could not be counted: {error}"),
                });
            });
        }
        Err(error) => eprintln!("InkUp desktop: spike close failed: {error}"),
    }
    result
}

/// Runs `call` on the main thread, where AppKit and window creation belong, and waits for its answer.
async fn on_main<T: Send + 'static>(
    app: AppHandle,
    call: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (answer, answered) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = answer.send(call(&handle));
    })
    .map_err(text)?;
    answered.await.map_err(text)?
}

/// Opens the spike panels, one per display, click-through. Answers each panel and any window rule it breaks.
#[tauri::command]
async fn spike_overlay_show(app: AppHandle) -> Result<Vec<SpikePanel>, String> {
    on_main(app, spike_show).await
}

/// `on`: the panels catch the pointer, so a drag draws; off: click-through.
#[tauri::command]
async fn spike_overlay_catch(app: AppHandle, on: bool) -> Result<(), String> {
    on_main(app, move |app| spike_catch(app, on)).await
}

/// Closes every spike panel.
#[tauri::command]
async fn spike_overlay_close(app: AppHandle) -> Result<(), String> {
    on_main(app, spike_close).await
}

/// The panel spike (spec 03, Unit 1): one transparent, non-activating panel per display, opened, toggled and closed
/// from the tray and three commands, to prove a webview panel can be the overlay. Throwaway: the overlay replaces it.
///
/// The logic is generic over [`Panels`] and takes the displays and a window maker, so a test drives it with a
/// recording double; the app passes [`inkup_macos::OsPanels`], Tauri's monitors and a webview window per display.
///
/// [`surface`] is what a build ships. The app registers commands, adds tray items and handles their menu events
/// only for what it returns, and a release build (`icon::DEVELOPMENT` false) gets nothing.
pub mod spike {
    use inkup_macos::{Bounds, NativeWindow, PanelInfo, Panels};

    /// Command names and tray ids the spike adds.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Surface {
        pub commands: &'static [&'static str],
        pub tray: &'static [&'static str],
    }

    const COMMANDS: &[&str] = &["spike_overlay_show", "spike_overlay_catch", "spike_overlay_close"];
    const TRAY: &[&str] = &["spike-show", "spike-catch", "spike-close"];

    /// What this build ships of the spike.
    ///
    /// `development` is [`crate::icon::DEVELOPMENT`]: true when `INKUP_RELEASE_BUILD` is unset (debug builds,
    /// `desktop:dev`, a local release build) and false for the release workflow's build. False leaves both lists
    /// empty. The app registers commands, adds tray items and handles menu events only from this, so removing the
    /// `development` check here would ship the spike.
    pub fn surface(development: bool) -> Surface {
        if development { Surface { commands: COMMANDS, tray: TRAY } } else { Surface { commands: &[], tray: &[] } }
    }

    impl Surface {
        /// The invoke handler registers the spike commands only when this is true.
        pub fn has_commands(self) -> bool {
            !self.commands.is_empty()
        }

        /// The tray adds an item, and the menu handler runs it, only when this is true.
        pub fn has_tray(self, id: &str) -> bool {
            self.tray.contains(&id)
        }
    }

    /// Spike windows are labelled `spike-<generation>-<n>` (capabilities/spike.json): n counts the displays from 0,
    /// and each show is a new generation, so a window still being torn down never holds a label a new one needs.
    pub const LABEL_PREFIX: &str = "spike-";

    /// A connected display: what the label says, and where it is in points (top-left origin).
    #[derive(Debug, Clone, PartialEq)]
    pub struct Display {
        pub name: String,
        pub bounds: Bounds,
    }

    pub fn label(generation: u64, index: usize) -> String {
        format!("{LABEL_PREFIX}{generation}-{index}")
    }

    /// Opens one panel per display, closing any already open first: `make_window` makes the display's window
    /// (labelled for it), and `panels` turns it into a click-through panel over the display.
    pub fn show<P: Panels + ?Sized>(
        panels: &P,
        generation: u64,
        displays: &[Display],
        mut make_window: impl FnMut(&str, &Display) -> Result<NativeWindow, String>,
    ) -> Result<Vec<PanelInfo>, String> {
        close(panels)?;
        let mut shown = Vec::with_capacity(displays.len());
        for (index, display) in displays.iter().enumerate() {
            let label = label(generation, index);
            let window = make_window(&label, display)?;
            shown.push(panels.create(&label, display.bounds, window).map_err(|e| e.to_string())?);
        }
        Ok(shown)
    }

    /// `on`: every panel catches the pointer, so a drag draws. Off: click-through again, so it reaches the app.
    pub fn catch<P: Panels + ?Sized>(panels: &P, on: bool) -> Result<(), String> {
        panels.set_click_through(!on).map_err(|e| e.to_string())
    }

    /// Closes every panel.
    pub fn close<P: Panels + ?Sized>(panels: &P) -> Result<(), String> {
        panels.close_all().map_err(|e| e.to_string())
    }

    /// One line per panel for the log the smoke reads: where it is, whether it lets the pointer through, and
    /// which window rule AppKit says it breaks, if any.
    pub fn describe(panel: &PanelInfo) -> String {
        let b = panel.bounds;
        let broken = panel.observed.broken(&inkup_macos::PANEL);
        let rules =
            if broken.is_empty() { "rules kept".to_owned() } else { format!("rules broken: {}", broken.join(", ")) };
        format!(
            "{} at {},{} {}x{}: click-through {}, level {}, key {}, {rules}",
            panel.label,
            b.x,
            b.y,
            b.width,
            b.height,
            if panel.click_through { "on" } else { "off" },
            panel.observed.level,
            if panel.observed.key { "yes" } else { "no" },
        )
    }

    #[cfg(test)]
    mod tests {
        use std::cell::RefCell;

        use inkup_macos::{Error, Observed, PANEL};

        use super::*;

        /// Records every call and keeps the panels it was asked to open.
        #[derive(Default)]
        struct Recording {
            calls: RefCell<Vec<String>>,
            open: RefCell<Vec<PanelInfo>>,
        }

        impl Panels for Recording {
            fn create(&self, label: &str, bounds: Bounds, window: NativeWindow) -> Result<PanelInfo, Error> {
                self.calls.borrow_mut().push(format!("create {label} {:?}", window.0));
                let panel = PanelInfo {
                    label: label.to_owned(),
                    bounds,
                    click_through: PANEL.ignores_mouse_events,
                    observed: Observed::of(&PANEL),
                };
                self.open.borrow_mut().push(panel.clone());
                Ok(panel)
            }
            fn set_click_through(&self, on: bool) -> Result<(), Error> {
                self.calls.borrow_mut().push(format!("click-through {on}"));
                self.open.borrow_mut().iter_mut().for_each(|panel| panel.click_through = on);
                Ok(())
            }
            fn close_all(&self) -> Result<(), Error> {
                self.calls.borrow_mut().push("close all".into());
                self.open.borrow_mut().clear();
                Ok(())
            }
            fn list(&self) -> Result<Vec<PanelInfo>, Error> {
                Ok(self.open.borrow().clone())
            }
        }

        fn two_displays() -> Vec<Display> {
            vec![
                Display {
                    name: "Built-in Retina Display".into(),
                    bounds: Bounds { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
                },
                Display {
                    name: "LG HDR 4K".into(),
                    bounds: Bounds { x: 1512.0, y: -100.0, width: 1920.0, height: 1080.0 },
                },
            ]
        }

        /// A window per label, at a made-up address the double only records.
        fn windows(made: &RefCell<Vec<String>>) -> impl FnMut(&str, &Display) -> Result<NativeWindow, String> + '_ {
            move |label, display| {
                made.borrow_mut().push(format!("{label} for {}", display.name));
                let address = 0x1000 * made.borrow().len();
                Ok(NativeWindow(std::ptr::without_provenance_mut(address)))
            }
        }

        #[test]
        fn spike_show_opens_one_click_through_panel_per_display_at_its_bounds() {
            let panels = Recording::default();
            let made = RefCell::default();
            let shown = show(&panels, 1, &two_displays(), windows(&made)).unwrap();
            assert_eq!(*made.borrow(), ["spike-1-0 for Built-in Retina Display", "spike-1-1 for LG HDR 4K"]);
            let open = panels.list().unwrap();
            assert_eq!(open, shown);
            assert_eq!(open.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), ["spike-1-0", "spike-1-1"]);
            assert_eq!(
                open.iter().map(|p| p.bounds).collect::<Vec<_>>(),
                two_displays().iter().map(|d| d.bounds).collect::<Vec<_>>()
            );
            assert!(open.iter().all(|p| p.click_through), "every panel starts click-through");
            assert_eq!(*panels.calls.borrow(), ["close all", "create spike-1-0 0x1000", "create spike-1-1 0x2000"]);
        }

        #[test]
        fn spike_catch_toggles_every_panel_at_once() {
            let panels = Recording::default();
            let made = RefCell::default();
            show(&panels, 1, &two_displays(), windows(&made)).unwrap();
            catch(&panels, true).unwrap();
            assert!(
                panels.list().unwrap().iter().all(|p| !p.click_through),
                "catching: no panel lets the pointer through"
            );
            catch(&panels, false).unwrap();
            assert!(panels.list().unwrap().iter().all(|p| p.click_through), "click-through again on every panel");
        }

        #[test]
        fn spike_close_leaves_no_panel_open_and_show_again_never_doubles_up() {
            let panels = Recording::default();
            let made = RefCell::default();
            show(&panels, 1, &two_displays(), windows(&made)).unwrap();
            close(&panels).unwrap();
            assert!(panels.list().unwrap().is_empty());
            show(&panels, 1, &two_displays(), windows(&made)).unwrap();
            show(&panels, 1, &two_displays(), windows(&made)).unwrap();
            assert_eq!(panels.list().unwrap().len(), 2);
        }

        #[test]
        fn spike_reports_unsupported_and_window_failures() {
            struct Unsupported;
            impl Panels for Unsupported {
                fn create(&self, _: &str, _: Bounds, _: NativeWindow) -> Result<PanelInfo, Error> {
                    Err(Error::Unsupported)
                }
                fn set_click_through(&self, _: bool) -> Result<(), Error> {
                    Err(Error::Unsupported)
                }
                fn close_all(&self) -> Result<(), Error> {
                    Err(Error::Unsupported)
                }
                fn list(&self) -> Result<Vec<PanelInfo>, Error> {
                    Err(Error::Unsupported)
                }
            }
            let made = RefCell::default();
            let error = show(&Unsupported, 1, &two_displays(), windows(&made)).unwrap_err();
            assert_eq!(error, "Drawing over other apps works on macOS only.");
            assert!(made.borrow().is_empty(), "no window is made where panels are unsupported");

            let panels = Recording::default();
            let failed = show(&panels, 1, &two_displays(), |_, _| Err("the window did not open".to_owned()));
            assert_eq!(failed.unwrap_err(), "the window did not open");
        }

        #[test]
        fn spike_describes_each_panel_for_the_smoke_log() {
            let panel = PanelInfo {
                label: "spike-1-1".into(),
                bounds: Bounds { x: 1512.0, y: -100.0, width: 1920.0, height: 1080.0 },
                click_through: true,
                observed: Observed::of(&PANEL),
            };
            assert_eq!(
                describe(&panel),
                "spike-1-1 at 1512,-100 1920x1080: click-through on, level 25, key no, rules kept"
            );
            let broken = PanelInfo { observed: Observed { level: 0, main: true, ..panel.observed }, ..panel };
            assert!(describe(&broken).ends_with("rules broken: wrong window level, took main window status"));
        }

        #[test]
        fn spike_surface_ships_nothing_unless_the_build_is_a_development_build() {
            // The same flag `icon::DEVELOPMENT` is: unset means development, set means the release workflow.
            let release = surface(crate::icon::is_development(Some("1")));
            assert!(release.commands.is_empty(), "a release build must not register the spike commands");
            assert!(release.tray.is_empty(), "a release build must not add the spike tray items");
            assert!(!release.has_commands());
            for id in ["spike-show", "spike-catch", "spike-close"] {
                assert!(!release.has_tray(id), "{id} would ship in a release build");
            }

            let dev = surface(crate::icon::is_development(None));
            assert_eq!(dev.commands, ["spike_overlay_show", "spike_overlay_catch", "spike_overlay_close"]);
            assert_eq!(dev.tray, ["spike-show", "spike-catch", "spike-close"]);
            assert!(dev.has_commands());
            assert!(dev.tray.iter().all(|id| dev.has_tray(id)));
        }
    }
}
