//! The InkUp desktop app: a window and a menubar (tray) item next to the CLI, not instead of it.
//!
//! On launch it finds or hosts (startup.rs): it runs the server in-process when nobody holds the data dir, drives
//! the CLI host when one does, and hands over to the desktop app already running otherwise. The window reads the
//! host through the app's commands, which go through one `HostLink` (link.rs) in either mode.
//!
//! Closing the window hides it; the app keeps running from the menubar until Quit, which stops the server when
//! the app hosts.

pub mod link;
pub mod startup;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use inkup_server::ActivateHook;
use serde::Serialize;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

use crate::link::HostLink;
use crate::startup::{Hosted, Startup, find_or_host};

const MAIN_WINDOW: &str = "main";

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

struct Desktop {
    link: HostLink,
    view: HostView,
    /// The server, in host mode, until Quit.
    hosted: Mutex<Option<Hosted>>,
}

/// What the window shows: `GET /api/host/state` through the link.
#[tauri::command]
async fn host_state(desktop: State<'_, Desktop>, timeline: Option<String>) -> Result<Value, String> {
    desktop.link.state(timeline.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn host_view(desktop: State<'_, Desktop>) -> HostView {
    desktop.view.clone()
}

/// Shows, raises and focuses the window.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Runs the app until Quit. Returns early, successfully, when another desktop app already runs on the data dir:
/// that one comes forward instead.
pub fn run(launch: Launch) -> Result<()> {
    // The activate hook needs the app, which exists only once Tauri has started; until then it does nothing.
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
    // Tauri's own runtime, so the server runs where the app's commands do.
    let startup = tauri::async_runtime::block_on(find_or_host(&launch.data_dir, launch.port, on_activate))?;
    let data_dir = launch.data_dir.display().to_string();
    let (link, view, hosted) = match startup {
        Startup::Activated(holder) => {
            eprintln!("InkUp is already running ({}): brought it forward.", holder.describe());
            return Ok(());
        }
        Startup::Host { link, hosted } => {
            let view = HostView {
                mode: "host",
                kind: inkup_store::instance::HostKind::Desktop,
                address: link.address(),
                data_dir,
            };
            (link, view, Some(hosted))
        }
        Startup::Client { link, holder } => {
            let view = HostView { mode: "client", kind: holder.kind, address: link.address(), data_dir };
            (link, view, None)
        }
    };
    let status = view.status_line();
    let ready = format!("InkUp desktop: {status} (data dir {})", view.data_dir);

    let app = tauri::Builder::default()
        .manage(Desktop { link, view, hosted: Mutex::new(hosted) })
        .invoke_handler(tauri::generate_handler![host_state, host_view])
        .setup(move |app| {
            let _ = handle.set(app.handle().clone());
            tray(app.handle(), &status)?;
            theme_override(app.handle());
            // Once the activate hook can reach the window: scripts wait for this line.
            eprintln!("{ready}");
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

/// The tray: Show InkUp, where the host is, Quit.
fn tray(app: &AppHandle, status: &str) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show InkUp", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit InkUp", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &status, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("inkup").tooltip("InkUp").menu(&menu).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "show" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

/// On the way out: stop the embedded server and give up the data dir, so the next host starts clean.
fn stop_hosting(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    let hosted = desktop.hosted.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(hosted) = hosted {
        tauri::async_runtime::block_on(hosted.shutdown());
    }
}
