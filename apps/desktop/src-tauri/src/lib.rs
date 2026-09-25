//! The InkUp desktop app: a window and a menubar (tray) item next to the CLI, not instead of it.
//!
//! On launch it finds or hosts (startup.rs): it runs the server in-process when nobody holds the data dir, drives
//! the CLI host when one does, and hands over to the desktop app already running otherwise. The window reads and
//! acts on the host through the app's commands, which go through one `HostLink` (link.rs) in either mode.
//!
//! Closing the window hides it; the app keeps running from the menubar until Quit, which stops the server when
//! the app hosts. Where its icons show (menu bar, Dock) is `[desktop]` in config.toml (`inkup_store::DesktopConfig`).

pub mod link;
pub mod startup;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use anyhow::{Context, Result};
use inkup_protocol::control::{CommandOutcome, CommandRequest, ControlState, NewToken, PairingAnswer};
use inkup_server::{ActivateHook, NetworkHook};
use inkup_store::DesktopConfig;
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry};

use crate::link::HostLink;
use crate::startup::{Hosted, Hosting, Startup, find_or_host};

const MAIN_WINDOW: &str = "main";
const TRAY: &str = "inkup";
/// Sent to the window when the menu bar or Dock setting changes from the tray.
const TOGGLES_EVENT: &str = "desktop-toggles";
/// Sent to the window when the host it talks to changed: taken over, or restarted in or out of network mode.
const VIEW_EVENT: &str = "host-view";

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

/// The tray's items that change while the app runs.
struct TrayItems {
    status: MenuItem<Wry>,
    menubar: CheckMenuItem<Wry>,
    dock: CheckMenuItem<Wry>,
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// What the window shows: `GET /api/host/state` through the link.
#[tauri::command]
async fn host_state(desktop: State<'_, Desktop>, timeline: Option<String>) -> Result<ControlState, String> {
    desktop.link().state(timeline.as_deref()).await.map_err(text)
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
    let _ = app.set_dock_visibility(toggles.dock);
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
    };

    let app = tauri::Builder::default()
        .manage(desktop)
        .invoke_handler(tauri::generate_handler![
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
        ])
        .setup(move |app| {
            let _ = handle.set(app.handle().clone());
            let items = tray(app.handle(), &status, toggles)?;
            let _ = app.state::<Desktop>().tray.set(items);
            show_icons(app.handle(), toggles);
            theme_override(app.handle());
            // Once the hooks can reach the window: scripts wait for these lines.
            eprintln!("{ready}");
            eprintln!("InkUp desktop: menu bar {}, Dock {}", on_off(toggles.menubar), on_off(toggles.dock));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides: the app keeps running from the menubar.
            if let WindowEvent::CloseRequested { api, .. } = event {
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

/// The tray: Show InkUp, where the host is, the menu bar and Dock switches, Quit.
fn tray(app: &AppHandle, status: &str, toggles: Toggles) -> tauri::Result<TrayItems> {
    let show = MenuItem::with_id(app, "show", "Show InkUp", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let menubar = CheckMenuItem::with_id(app, "menubar", "Show in Menu Bar", true, toggles.menubar, None::<&str>)?;
    let dock = CheckMenuItem::with_id(app, "dock", "Show in Dock", true, toggles.dock, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit InkUp", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&show, &status, &separator()?, &menubar, &dock, &separator()?, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY).tooltip("InkUp").menu(&menu).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
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
    })
    .build(app)?;
    Ok(TrayItems { status, menubar, dock })
}

/// On the way out: stop the embedded server and give up the data dir, so the next host starts clean.
fn stop_hosting(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    let hosted = tauri::async_runtime::block_on(async { desktop.hosted.lock().await.take() });
    if let Some(hosted) = hosted {
        tauri::async_runtime::block_on(hosted.shutdown());
    }
}
