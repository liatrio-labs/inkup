//! The host's terminal UI (`inkup` with no subcommand): Clients, Sessions, the live timeline, items, the
//! agents watching and agent tokens, with keys that drive a Client's Session. Pairing requests are answered here,
//! and network mode is switched here. Headless `serve` uses `prompt_pairing`, a line prompt, instead.

pub mod app;
mod ui;

use std::collections::VecDeque;
use std::io::{IsTerminal, Write};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crossterm::event::{Event, EventStream, KeyEventKind};
use futures_util::StreamExt;
use inkup_server::{Command, Hub, Network, PairingDecision, PairingRequest, lan_addresses};
use inkup_store::Store;
use ratatui::DefaultTerminal;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

pub use app::{Action, App, NetworkView, Overlay, PairingPrompt, View};
pub use ui::render;

/// How often the screen reads the store again.
const REFRESH: Duration = Duration::from_millis(500);

pub type Terminal = DefaultTerminal;

/// Takes over the terminal (alternate screen, raw mode) until `restore`.
pub fn init() -> Terminal {
    ratatui::init()
}

pub fn restore() {
    ratatui::restore();
}

/// What the TUI shows of a running server.
pub struct Running {
    /// Where the Host listens, for the header.
    pub address: String,
    pub store: Arc<Store>,
    pub hub: Arc<Hub>,
    pub requests: mpsc::Receiver<PairingRequest>,
    /// Set in network mode.
    pub network: Option<Arc<Network>>,
}

/// Why the TUI stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Quit,
    /// The user switched network mode: restart the server with it on (or off), then run the TUI again.
    SwitchNetwork(bool),
}

/// Runs the TUI on `terminal` until the user quits or switches network mode. The caller owns the terminal
/// (`ratatui::init`, `ratatui::restore`) so a restart does not flash the screen.
pub async fn run(terminal: &mut DefaultTerminal, running: Running) -> std::io::Result<Exit> {
    let app = App::new(running.address.clone());
    event_loop(terminal, app, running).await
}

fn network_view(network: &Network) -> NetworkView {
    NetworkView {
        claimed: network.claimed_name(),
        addresses: lan_addresses().iter().map(ToString::to_string).collect(),
        base_url: network.base_url(),
    }
}

/// The QR code of `text` as rows of half-block characters, a row of characters to two rows of modules, with a
/// two-module margin (the standard four is too tall for a terminal; readers manage with two). Dark modules are
/// `█`/`▀`/`▄`, so print it dark on light: the TUI styles it black on white.
pub fn qr_lines(text: &str) -> Vec<String> {
    use qrcode::render::unicode::Dense1x2;
    let Ok(code) = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::L) else {
        return Vec::new();
    };
    let rows: Vec<String> =
        code.render::<Dense1x2>().quiet_zone(false).build().lines().map(|row| format!("  {row}  ")).collect();
    let blank = " ".repeat(rows.first().map_or(0, |r| r.chars().count()));
    std::iter::once(blank.clone()).chain(rows).chain(std::iter::once(blank)).collect()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn describe(command: Command) -> &'static str {
    match command {
        Command::StartSession => "Started",
        Command::Pause => "Paused",
        Command::Resume => "Resumed",
        Command::Stop => "Stopped",
        Command::SetDrawMode { draw_mode: true } => "Draw mode on",
        Command::SetDrawMode { draw_mode: false } => "Draw mode off",
    }
}

async fn event_loop(terminal: &mut DefaultTerminal, mut app: App, running: Running) -> std::io::Result<Exit> {
    let Running { store, hub, mut requests, network, .. } = running;
    app.network = network.as_deref().map(network_view);
    let mut events = EventStream::new();
    let mut tick = tokio::time::interval(REFRESH);
    let mut pending: VecDeque<PairingRequest> = VecDeque::new();
    let (outcome_tx, mut outcomes) = mpsc::channel::<String>(16);
    loop {
        terminal.draw(|frame| render(frame, &app))?;
        tokio::select! {
            _ = tick.tick() => {
                // A Client that gave up waiting needs no answer, nor a code that was used, refused or expired.
                pending.retain(|r| !r.is_cancelled());
                app.pairing = pending.iter().map(PairingPrompt::from).collect();
                app.network = network.as_deref().map(network_view);
                match inkup_server::snapshot(&store, &hub, app.timeline_session()).await {
                    Ok(state) => app.update(state, now_ms()),
                    Err(error) => app.status = Some(format!("Could not read the store: {error}")),
                }
            }
            Some(request) = requests.recv() => {
                app.pairing.push_back(PairingPrompt::from(&request));
                pending.push_back(request);
            }
            Some(outcome) = outcomes.recv() => {
                app.status = Some(outcome);
                tick.reset_immediately();
            }
            event = events.next() => match event {
                None => return Ok(Exit::Quit),
                Some(Err(error)) => return Err(error),
                Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => match app.on_key(key) {
                    Action::None => {}
                    Action::Quit => return Ok(Exit::Quit),
                    Action::SetNetwork(on) => return Ok(Exit::SwitchNetwork(on)),
                    Action::CreateToken(name) => {
                        match store.create_agent_token(&name) {
                            Ok(made) => app.overlay = Some(Overlay::NewTokenShown { name, token: made.token }),
                            Err(error) => app.status = Some(format!("Could not make the token: {error}")),
                        }
                        tick.reset_immediately();
                    }
                    Action::RevokeToken(id) => {
                        if let Err(error) = store.revoke_agent_token(&id) {
                            app.status = Some(format!("Could not revoke the token: {error}"));
                        }
                        tick.reset_immediately();
                    }
                    Action::Pairing(decision) => {
                        if let Some(request) = pending.pop_front() {
                            request.decide(decision);
                        }
                    }
                    Action::Command { client_id, command } => {
                        let (hub, outcome_tx) = (Arc::clone(&hub), outcome_tx.clone());
                        tokio::spawn(async move {
                            let outcome = match hub.command(&client_id, command).await {
                                Ok(outcome) if outcome.ok => format!("{}.", describe(command)),
                                Ok(outcome) => outcome.message.unwrap_or_else(|| "The browser refused.".into()),
                                Err(error) => format!("{error}."),
                            };
                            let _ = outcome_tx.send(outcome).await;
                        });
                    }
                },
                Some(Ok(_)) => {}
            },
        }
    }
}

/// Asks on the terminal about each pairing request: `<prompt> [y/N]`. Without a terminal every request is denied,
/// since nobody could have approved it. A request from another machine is not asked about: its code and QR code
/// are printed for the user to type or scan on that machine. `print_codes` (tests only) also prints each code as a
/// `pairing code: <code>` line on stdout.
pub async fn prompt_pairing(mut requests: mpsc::Receiver<PairingRequest>, print_codes: bool) {
    let interactive = std::io::stdin().is_terminal();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(request) = requests.recv().await {
        if request.is_cancelled() {
            continue;
        }
        if let Some(remote) = &request.remote {
            eprintln!("\n{}", request.prompt());
            eprintln!(
                "Type this code in the extension: {}   (or scan the QR code; it expires in 2 minutes)",
                remote.code
            );
            for row in qr_lines(&remote.link) {
                eprintln!("\x1b[30;47m{row}\x1b[0m");
            }
            eprintln!("{}\n", remote.link);
            if print_codes {
                println!("pairing code: {}", remote.code);
                let _ = std::io::stdout().flush();
            }
            // Dropped unanswered: the code stays valid until it is used or expires.
            continue;
        }
        if !interactive {
            tracing::warn!(prompt = %request.prompt(), "denied: no terminal to approve pairing on");
            request.decide(PairingDecision::Deny);
            continue;
        }
        eprint!("{} [y/N] ", request.prompt());
        let _ = std::io::stderr().flush();
        let answer = lines.next_line().await.ok().flatten().unwrap_or_default();
        request.decide(decision(&answer));
    }
}

fn decision(answer: &str) -> PairingDecision {
    match answer.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => PairingDecision::Approve,
        _ => PairingDecision::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rows as a bitmap (a character is two modules tall), read back by a real QR reader.
    fn decode(rows: &[String]) -> String {
        let grid: Vec<Vec<char>> = rows.iter().map(|r| r.chars().collect()).collect();
        let (width, height) = (grid[0].len(), grid.len() * 2);
        const SCALE: usize = 4;
        let mut image = rqrr::PreparedImage::prepare_from_greyscale(width * SCALE, height * SCALE, |x, y| {
            let c = grid[y / SCALE / 2][x / SCALE];
            let top = (y / SCALE).is_multiple_of(2);
            let dark = matches!((c, top), ('█', _) | ('▀', true) | ('▄', false));
            if dark { 0 } else { 255 }
        });
        let grids = image.detect_grids();
        assert_eq!(grids.len(), 1, "one QR code");
        grids[0].decode().expect("the QR code decodes").1
    }

    #[test]
    fn the_qr_code_reads_back_as_the_pair_link() {
        let link = "inkup://pair?url=http://inkup.local:47823&code=042917";
        let rows = qr_lines(link);
        // Version 3 (29 modules) at level L, a two-module margin: 17 rows, 33 columns.
        assert_eq!(rows.len(), 17);
        assert!(rows.iter().all(|r| r.chars().count() == 33), "{rows:?}");
        assert_eq!(decode(&rows), link);
    }

    #[test]
    fn only_an_explicit_yes_approves() {
        for yes in ["y", "Y", "yes", " yes \n"] {
            assert_eq!(decision(yes), PairingDecision::Approve, "{yes:?}");
        }
        for no in ["", "n", "no", "yep", "sure"] {
            assert_eq!(decision(no), PairingDecision::Deny, "{no:?}");
        }
    }
}
