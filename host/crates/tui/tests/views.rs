//! Each view rendered with fixture data into ratatui's TestBackend, compared with tests/snapshots/<name>.txt.
//! After a deliberate change to the UI, regenerate: `UPDATE_SNAPSHOTS=1 cargo test -p inkup-tui --test views`.
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use inkup_server::{
    ClientView, Command, HostState, ItemView, PairingDecision, RemotePairing, Timeline, TimelineEntry, Watcher,
};
use inkup_store::{AgentToken, ItemStatus, SessionOverview};
use inkup_tui::{Action, App, NetworkView, Overlay, PairingPrompt, View, render};
use ratatui::Terminal;
use ratatui::backend::TestBackend;

const NOW: i64 = 1_790_000_600_000;

fn session(id: &str, title: &str, live: bool, paused: bool, items: i64, open: i64) -> SessionOverview {
    SessionOverview {
        id: id.into(),
        client_id: Some("c-chrome".into()),
        url: Some(format!("http://localhost:3000/{id}")),
        title: Some(title.into()),
        t0: Some(NOW - 300_000),
        created_at: NOW - 300_000,
        updated_at: NOW - 1_000,
        live,
        paused,
        items,
        open_items: open,
        annotations: 3,
        draft_items: 1,
    }
}

fn state() -> HostState {
    HostState {
        clients: vec![
            ClientView {
                id: "c-chrome".into(),
                kind: "chrome".into(),
                name: "Chrome on macOS".into(),
                connected: true,
                created_at: NOW - 86_400_000,
                last_seen_at: Some(NOW - 2_000),
            },
            ClientView {
                id: "c-firefox".into(),
                kind: "firefox".into(),
                name: "Firefox on Linux".into(),
                connected: false,
                created_at: NOW - 86_400_000,
                last_seen_at: Some(NOW - 7_200_000),
            },
        ],
        sessions: vec![session("pricing", "Pricing", true, false, 0, 0), session("home", "Home", false, false, 2, 1)],
        timeline: Some(Timeline {
            session_id: "pricing".into(),
            entries: vec![
                TimelineEntry { t: 0, kind: "session".into(), text: "started on http://localhost:3000/pricing".into() },
                TimelineEntry { t: 4_200, kind: "said".into(), text: "this button should go in the header".into() },
                TimelineEntry { t: 5_100, kind: "annotation".into(), text: "#1 on button 'Get started'".into() },
                TimelineEntry { t: 9_800, kind: "command".into(), text: "scratch that".into() },
            ],
        }),
        items: vec![
            ItemView {
                id: "item-1".into(),
                session_id: "home".into(),
                title: "Move 'Get started' into the header".into(),
                category: "layout".into(),
                status: ItemStatus::Resolved,
                note: Some("Moved into <header> in Hero.tsx".into()),
                agent: Some("claude-code".into()),
                since: Some(NOW - 600_000),
                prompt: "On / move button.cta into the header.".into(),
            },
            ItemView {
                id: "item-3".into(),
                session_id: "home".into(),
                title: "Make the CTA brand blue".into(),
                category: "style".into(),
                status: ItemStatus::InProgress,
                note: None,
                agent: Some("claude-code".into()),
                since: Some(NOW - 120_000),
                prompt: "Give button.cta var(--brand).".into(),
            },
            ItemView {
                id: "item-2".into(),
                session_id: "home".into(),
                title: "Tighten the pricing table".into(),
                category: "style".into(),
                status: ItemStatus::Open,
                note: None,
                agent: None,
                since: None,
                prompt: "Reduce the padding.".into(),
            },
        ],
        watchers: vec![Watcher { id: 1, url: Some("http://localhost:3000".into()), session_id: None, since: 0 }],
        agent_tokens: vec![AgentToken {
            id: "a-1f2e3d4c".into(),
            name: "codex on desktop".into(),
            created_at: NOW - 86_400_000,
            last_used_at: Some(NOW - 30_000),
        }],
    }
}

fn app() -> App {
    let mut app = App::new("127.0.0.1:47823");
    app.update(state(), NOW);
    app
}

fn screen(app: &App) -> String {
    screen_sized(app, 100, 24)
}

fn screen_sized(app: &App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            let line: String = (0..buffer.area.width).map(|x| buffer[(x, y)].symbol().to_owned()).collect();
            format!("{}\n", line.trim_end())
        })
        .collect()
}

fn check(name: &str, app: &App) {
    check_rendered(name, screen(app));
}

fn check_rendered(name: &str, rendered: String) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots").join(format!("{name}.txt"));
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        rendered == expected,
        "{name} differs from {}; rerun with UPDATE_SNAPSHOTS=1 if intended.\n--- rendered ---\n{rendered}",
        path.display()
    );
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
fn every_view_renders() {
    let mut app = app();
    for view in View::ALL {
        app.view = view;
        check(&view.title().to_lowercase(), &app);
    }
}

#[test]
fn the_overlays_render() {
    let mut app = app();
    app.overlay = Some(Overlay::Help);
    check("help", &app);

    app.overlay = None;
    app.view = View::Items;
    assert_eq!(app.on_key(key(KeyCode::Enter)), Action::None);
    assert_eq!(app.overlay, Some(Overlay::Details));
    check("item-details", &app);
    // An item an agent has in work: who, and since when (E13).
    app.overlay = None;
    app.on_key(key(KeyCode::Down));
    app.on_key(key(KeyCode::Enter));
    check("item-in-work", &app);

    let mut app = self::app();
    app.pairing.push_back(PairingPrompt::from("Chrome extension \"Chrome on MacBook\" wants to connect"));
    check("pairing", &app);
}

fn network_app() -> App {
    let mut app = app();
    app.network = Some(NetworkView {
        claimed: Some("inkup.local".into()),
        addresses: vec!["192.168.7.149".into()],
        base_url: "http://inkup.local:47823".into(),
    });
    app
}

#[test]
fn network_mode_warns_in_the_header() {
    check("network-header", &network_app());
}

#[test]
fn a_pairing_request_from_another_machine_shows_its_code_and_a_qr_code() {
    let mut app = network_app();
    app.pairing.push_back(PairingPrompt {
        prompt: "Firefox extension \"Firefox on ThinkPad\" from 192.168.7.20 wants to connect".into(),
        remote: Some(RemotePairing {
            code: "042917".into(),
            from: "192.168.7.20".parse().unwrap(),
            link: "inkup://pair?url=http://inkup.local:47823&code=042917".into(),
        }),
    });
    check_rendered("pairing-remote", screen_sized(&app, 100, 32));
    // Too short for the QR code: the code alone.
    check("pairing-remote-short", &app);
    // It can be refused, not approved: approval is typing the code on the other machine.
    assert_eq!(app.on_key(key(KeyCode::Char('y'))), Action::None);
    assert_eq!(app.on_key(key(KeyCode::Esc)), Action::Pairing(PairingDecision::Deny));
}

#[test]
fn agent_tokens_are_made_listed_and_revoked() {
    // The list itself is the `tokens` snapshot of every_view_renders.
    let mut app = network_app();
    app.view = View::Tokens;

    assert_eq!(app.on_key(key(KeyCode::Char('t'))), Action::None);
    for c in "claude on laptop".chars() {
        app.on_key(key(KeyCode::Char(c)));
    }
    app.on_key(key(KeyCode::Backspace));
    check("token-new", &app);
    assert_eq!(app.on_key(key(KeyCode::Enter)), Action::CreateToken("claude on lapto".into()));
    app.overlay = Some(Overlay::NewTokenShown { name: "claude on lapto".into(), token: "ink1_0123abcd".into() });
    check("token-shown", &app);
    app.on_key(key(KeyCode::Esc));

    assert_eq!(app.on_key(key(KeyCode::Char('r'))), Action::None);
    assert_eq!(app.overlay, Some(Overlay::Revoke { id: "a-1f2e3d4c".into(), name: "codex on desktop".into() }));
    assert_eq!(app.on_key(key(KeyCode::Char('y'))), Action::RevokeToken("a-1f2e3d4c".into()));
}

#[test]
fn n_switches_network_mode_after_asking() {
    let mut app = app();
    assert_eq!(app.on_key(key(KeyCode::Char('N'))), Action::None);
    assert_eq!(app.overlay, Some(Overlay::Network(true)));
    check("network-confirm", &app);
    assert_eq!(app.on_key(key(KeyCode::Char('y'))), Action::SetNetwork(true));

    let mut app = network_app();
    app.on_key(key(KeyCode::Char('N')));
    assert_eq!(app.on_key(key(KeyCode::Esc)), Action::None);
    assert_eq!(app.overlay, None);
    app.on_key(key(KeyCode::Char('N')));
    assert_eq!(app.on_key(key(KeyCode::Char('y'))), Action::SetNetwork(false));
}

#[test]
fn empty_views_say_what_to_do() {
    let mut app = App::new("127.0.0.1:47823");
    app.update(HostState::default(), NOW);
    check("clients-empty", &app);
}

#[test]
fn a_newer_release_shows_quietly_in_the_key_line() {
    let mut app = App::new("127.0.0.1:47823");
    app.update(HostState::default(), NOW);
    app.update = Some("inkup 0.2.0 is out: inkup update".into());
    check("update-notice", &app);
}

#[test]
fn keys_drive_the_focused_clients_session() {
    let mut app = app();
    // The Chrome client is connected and recording: s refuses, p pauses, d turns draw mode on then off, x stops.
    assert_eq!(app.on_key(key(KeyCode::Char('s'))), Action::None);
    assert_eq!(app.status.as_deref(), Some("Chrome on macOS is already recording."));
    let command = |command| Action::Command { client_id: "c-chrome".into(), command };
    assert_eq!(app.on_key(key(KeyCode::Char('p'))), command(Command::Pause));
    assert_eq!(app.on_key(key(KeyCode::Char('d'))), command(Command::SetDrawMode { draw_mode: true }));
    assert_eq!(app.on_key(key(KeyCode::Char('d'))), command(Command::SetDrawMode { draw_mode: false }));
    assert_eq!(app.on_key(key(KeyCode::Char('x'))), command(Command::Stop));

    // Paused: p resumes.
    let mut paused = state();
    paused.sessions[0].paused = true;
    app.update(paused, NOW);
    assert_eq!(app.on_key(key(KeyCode::Char('p'))), command(Command::Resume));

    // Not recording: s starts. The Firefox client, selected but offline, cannot.
    let mut ended = state();
    ended.sessions[0].live = false;
    app.update(ended, NOW);
    assert_eq!(app.on_key(key(KeyCode::Char('s'))), command(Command::StartSession));
    assert_eq!(app.on_key(key(KeyCode::Down)), Action::None);
    assert_eq!(app.on_key(key(KeyCode::Char('s'))), Action::None);
    assert_eq!(app.status.as_deref(), Some("Firefox on Linux is not connected."));

    // A pairing request takes the keyboard until answered.
    app.pairing.push_back(PairingPrompt::from("Chrome extension wants to connect"));
    assert_eq!(app.on_key(key(KeyCode::Char('q'))), Action::None);
    assert_eq!(app.on_key(key(KeyCode::Char('y'))), Action::Pairing(PairingDecision::Approve));
    assert!(app.pairing.is_empty());
    assert_eq!(app.on_key(key(KeyCode::Tab)), Action::None);
    assert_eq!(app.view, View::Sessions);
    assert_eq!(app.on_key(key(KeyCode::Char('q'))), Action::Quit);
}
