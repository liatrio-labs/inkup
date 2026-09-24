//! Drawing the App: a tab bar (and in network mode a warning line), the current view, a key line, and the
//! overlays (help, details, pairing, tokens, network mode).

use inkup_server::{ItemView, NETWORK_WARNING};
use inkup_store::ItemStatus;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Cell, Clear, Paragraph, Row, Table, TableState, Tabs, Wrap};

use crate::app::{App, NetworkView, Overlay, PairingPrompt, View};
use crate::qr_lines;

const KEYS: &str = "s start  p pause/resume  x stop  d draw  t token  N network  ⏎ details  ? help  q quit";

const HELP: &str = "\
Tab, ←/→, 1-6   switch view
↑/↓, j/k        select
⏎               details of the selected row
s               start an audio-only Session on the focused client's tab
p               pause or resume its Session
x               stop its Session
d               draw mode on or off
t               new agent token (for an agent on another machine)
r               in Tokens: revoke the selected token
N               network mode on or off (restarts the server)
?               this help (Esc closes)
q, Ctrl-C       quit

The focused client: the one selected in Clients, else the owner of the
Session selected in Sessions, else the first connected one.
Agents connect over MCP at /mcp; from another machine with a token.";

pub fn render(frame: &mut Frame, app: &App) {
    let banner = u16::from(app.network.is_some());
    let [header, warning, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(banner),
        Constraint::Min(3),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    if let Some(network) = &app.network {
        frame.render_widget(network_line(network), warning);
    }
    let titles = View::ALL.iter().enumerate().map(|(i, v)| format!("{} {}", i + 1, v.title()));
    let selected = View::ALL.iter().position(|v| *v == app.view).unwrap_or_default();
    let [tabs, address] =
        Layout::horizontal([Constraint::Min(10), Constraint::Length(app.address.len() as u16 + 14)]).areas(header);
    frame.render_widget(Tabs::new(titles).select(selected).highlight_style(Style::new().bold().reversed()), tabs);
    frame.render_widget(Line::from(format!("inkup {}", app.address)).right_aligned().dim(), address);

    match app.view {
        View::Clients => clients(frame, body, app),
        View::Sessions => sessions(frame, body, app),
        View::Timeline => timeline(frame, body, app),
        View::Items => items(frame, body, app),
        View::Watchers => watchers(frame, body, app),
        View::Tokens => tokens(frame, body, app),
    }

    let footer_text = match &app.status {
        Some(status) => Line::from(vec![Span::raw(status.clone()).bold(), Span::raw("   "), Span::raw(KEYS).dim()]),
        None => Line::from(KEYS).dim(),
    };
    frame.render_widget(footer_text, footer);

    if let Some(prompt) = app.pairing.front() {
        pairing(frame, prompt);
    } else {
        match &app.overlay {
            Some(Overlay::Help) => popup(frame, "Keys", Text::from(HELP), 80, 18),
            Some(Overlay::Details) => popup(frame, "Details", details(app), 90, 16),
            Some(Overlay::NewToken(name)) => {
                let text = Text::from(vec![
                    Line::from("Who is it for? It is shown once; the agent sends it as its Bearer token."),
                    Line::from(""),
                    Line::from(vec![Span::raw("Name: "), Span::raw(format!("{name}▏")).bold()]),
                    Line::from(""),
                    Line::from("⏎ create   Esc cancel").dim(),
                ]);
                popup(frame, "New agent token", text, 80, 5);
            }
            Some(Overlay::NewTokenShown { name, token }) => {
                let base = app.network.as_ref().map_or("http://<this machine>:47823", |n| n.base_url.as_str());
                let text = Text::from(vec![
                    Line::from(format!("Token for {name} (shown once):")),
                    Line::from(token.clone()).bold(),
                    Line::from(""),
                    Line::from("On the agent's machine:"),
                    Line::from(format!("inkup mcp install --remote {base} --token {token}")),
                    Line::from(""),
                    Line::from(if app.network.is_some() {
                        "Revoke it in Tokens (6) with r."
                    } else {
                        "It works once network mode is on (N). Revoke it in Tokens (6) with r."
                    })
                    .dim(),
                ]);
                popup(frame, "Agent token", text, 96, 8);
            }
            Some(Overlay::Revoke { name, .. }) => {
                let text = Text::from(vec![
                    Line::from(format!("Revoke the token for {name}? The agent is refused from then on.")),
                    Line::from(""),
                    Line::from("y  revoke   n  keep"),
                ]);
                popup(frame, "Revoke token", text, 72, 3);
            }
            Some(Overlay::Network(on)) => {
                let lines = if *on {
                    vec![
                        Line::from(
                            "Listen on every interface so other machines on this LAN can pair and send Sessions?",
                        ),
                        Line::from(NETWORK_WARNING).bold().fg(Color::Yellow),
                        Line::from(
                            "Agents on other machines need a token (t). The server restarts; Clients reconnect.",
                        ),
                        Line::from(""),
                        Line::from("y  turn it on   n  cancel"),
                    ]
                } else {
                    vec![
                        Line::from("Listen on this machine only? Other machines are cut off."),
                        Line::from("The server restarts; Clients on this machine reconnect."),
                        Line::from(""),
                        Line::from("y  turn it off   n  cancel"),
                    ]
                };
                popup(frame, "Network mode", Text::from(lines), 90, 5);
            }
            None => {}
        }
    }
}

/// The warning, then where other machines find the Host.
fn network_line(network: &NetworkView) -> Line<'static> {
    let mut spans = vec![Span::raw(format!(" {NETWORK_WARNING} ")).bold().fg(Color::Black).bg(Color::Yellow)];
    let name = network.claimed.clone().unwrap_or_else(|| "no .local name yet".into());
    let mut at = vec![name];
    at.extend(network.addresses.iter().cloned());
    spans.push(Span::raw(format!("  {}", at.join(" · "))).dim());
    Line::from(spans)
}

/// A pairing request. From another machine: its code, big, and a QR code of the pair link.
fn pairing(frame: &mut Frame, request: &PairingPrompt) {
    let Some(remote) = &request.remote else {
        let text = Text::from(vec![
            Line::from(request.prompt.clone()).bold(),
            Line::from(""),
            Line::from("y  pair it: it can stream Sessions and receive commands"),
            Line::from("n  decline"),
        ]);
        popup(frame, "Pairing request", text, 64, 6);
        return;
    };
    let (first, second) = remote.code.split_at(remote.code.len() / 2);
    let mut lines = vec![
        Line::from(request.prompt.clone()).bold(),
        Line::from(""),
        Line::from(vec![
            Span::raw("Type this code in the extension:  "),
            Span::raw(format!("{first} {second}")).bold(),
        ]),
    ];
    let qr = qr_lines(&remote.link);
    let area = frame.area();
    // The QR code only when it fits whole: a cut one does not scan.
    let with_qr =
        area.height as usize >= qr.len() + 9 && area.width as usize >= qr.first().map_or(0, |l| l.chars().count()) + 4;
    if with_qr {
        lines.push(Line::from("or scan it with the extension's Scan QR:"));
        lines.extend(qr.into_iter().map(|row| Line::from(row).fg(Color::Black).bg(Color::White)));
    } else {
        lines.push(Line::from("(make the terminal taller to show a QR code)").dim());
    }
    lines.push(Line::from(""));
    lines.push(Line::from("It expires in 2 minutes.  n / Esc  refuse").dim());
    let height = lines.len() as u16;
    popup(frame, "Pairing request from another machine", Text::from(lines), 90, height);
}

fn ago(now_ms: i64, then_ms: Option<i64>) -> String {
    let Some(then) = then_ms else { return "never".into() };
    let seconds = (now_ms - then).max(0) / 1000;
    match seconds {
        0..60 => format!("{seconds} s ago"),
        60..3600 => format!("{} min ago", seconds / 60),
        3600..86_400 => format!("{} h ago", seconds / 3600),
        _ => format!("{} d ago", seconds / 86_400),
    }
}

fn clock(t_ms: i64) -> String {
    let seconds = t_ms.max(0) / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

#[allow(clippy::too_many_arguments)]
fn table<'a>(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    header: &[&'a str],
    widths: &[Constraint],
    rows: Vec<Row<'a>>,
    selected: usize,
    empty: &str,
) {
    let block = Block::bordered().title(format!(" {title} "));
    if rows.is_empty() {
        frame.render_widget(Paragraph::new(empty.to_owned()).dim().block(block), area);
        return;
    }
    let table = Table::new(rows, widths)
        .header(Row::new(header.iter().copied()).style(Style::new().add_modifier(Modifier::BOLD)))
        .row_highlight_style(Style::new().reversed())
        .highlight_symbol("› ")
        .highlight_spacing(ratatui::widgets::HighlightSpacing::Always)
        .block(block);
    frame.render_stateful_widget(table, area, &mut TableState::default().with_selected(Some(selected)));
}

fn clients(frame: &mut Frame, area: Rect, app: &App) {
    let rows = app
        .state
        .clients
        .iter()
        .map(|c| {
            let state = match (c.connected, app.state.live_session_of(&c.id)) {
                (true, Some(s)) if s.paused => "connected, paused",
                (true, Some(_)) => "connected, recording",
                (true, None) => "connected",
                (false, _) => "paired",
            };
            Row::new(vec![
                Cell::from(c.name.clone()),
                Cell::from(c.kind.clone()),
                Cell::from(state),
                Cell::from(ago(app.now_ms, c.last_seen_at)),
            ])
        })
        .collect();
    let widths = [Constraint::Fill(2), Constraint::Length(8), Constraint::Length(22), Constraint::Length(12)];
    table(
        frame,
        area,
        "Clients",
        &["Name", "Kind", "State", "Last seen"],
        &widths,
        rows,
        app.selected(View::Clients),
        "No paired clients. Pair from the extension's Settings; the request shows here.",
    );
}

fn session_state(s: &inkup_store::SessionOverview) -> &'static str {
    match (s.live, s.paused, s.items > 0) {
        (true, true, _) => "paused",
        (true, false, _) => "live",
        (false, _, true) => "processed",
        (false, _, false) => "ended",
    }
}

fn sessions(frame: &mut Frame, area: Rect, app: &App) {
    let rows = app
        .state
        .sessions
        .iter()
        .map(|s| {
            let page =
                s.title.clone().filter(|t| !t.is_empty()).or_else(|| s.url.clone()).unwrap_or_else(|| s.id.clone());
            Row::new(vec![
                Cell::from(page),
                Cell::from(session_state(s)),
                Cell::from(s.annotations.to_string()),
                Cell::from(format!("{}/{}", s.open_items, s.items)),
                Cell::from(ago(app.now_ms, s.t0.or(Some(s.created_at)))),
            ])
        })
        .collect();
    let widths = [
        Constraint::Fill(1),
        Constraint::Length(10),
        Constraint::Length(11),
        Constraint::Length(10),
        Constraint::Length(12),
    ];
    table(
        frame,
        area,
        "Sessions",
        &["Page", "State", "Annotations", "Open/items", "Started"],
        &widths,
        rows,
        app.selected(View::Sessions),
        "No Sessions yet. Start one with s, or from the extension.",
    );
}

fn timeline(frame: &mut Frame, area: Rect, app: &App) {
    let Some(timeline) = &app.state.timeline else {
        let block = Block::bordered().title(" Timeline ");
        frame.render_widget(Paragraph::new("No live Session.").dim().block(block), area);
        return;
    };
    let title = app
        .state
        .sessions
        .iter()
        .find(|s| s.id == timeline.session_id)
        .map(|s| format!("Timeline: {} ({})", s.title.clone().unwrap_or_default(), session_state(s)))
        .unwrap_or_else(|| "Timeline".into());
    let rows = timeline
        .entries
        .iter()
        .map(|e| Row::new(vec![Cell::from(clock(e.t)), Cell::from(e.kind.clone()), Cell::from(e.text.clone())]))
        .collect();
    let widths = [Constraint::Length(6), Constraint::Length(11), Constraint::Fill(1)];
    table(frame, area, &title, &["At", "What", ""], &widths, rows, app.selected(View::Timeline), "Nothing yet.");
}

fn status_label(status: ItemStatus) -> &'static str {
    match status {
        ItemStatus::Open => "open",
        ItemStatus::InProgress => "in work",
        ItemStatus::Resolved => "done",
        ItemStatus::WontFix => "won't fix",
        ItemStatus::NeedsInfo => "needs info",
    }
}

/// In work: who and since when, then the note. Otherwise the note.
fn resolution_line(app: &App, item: &ItemView) -> String {
    let note = item.note.clone().unwrap_or_default();
    if item.status != ItemStatus::InProgress {
        return note;
    }
    let who = item.agent.clone().unwrap_or_else(|| "an agent".into());
    let head = format!("{who}, {}", ago(app.now_ms, item.since));
    if note.is_empty() { head } else { format!("{head}: {note}") }
}

fn items(frame: &mut Frame, area: Rect, app: &App) {
    let rows = app
        .state
        .items
        .iter()
        .map(|i| {
            Row::new(vec![
                Cell::from(i.id.clone()),
                Cell::from(status_label(i.status)),
                Cell::from(i.title.clone()),
                Cell::from(resolution_line(app, i)),
            ])
        })
        .collect();
    let widths = [Constraint::Length(9), Constraint::Length(10), Constraint::Fill(3), Constraint::Fill(2)];
    table(
        frame,
        area,
        "Items",
        &["Id", "Status", "Title", "Resolution"],
        &widths,
        rows,
        app.selected(View::Items),
        "No Change Items yet. They arrive when a Session is processed in the extension.",
    );
}

fn watchers(frame: &mut Frame, area: Rect, app: &App) {
    let rows = app
        .state
        .watchers
        .iter()
        .map(|w| {
            Row::new(vec![
                Cell::from(format!("watch #{}", w.id)),
                Cell::from(w.url.clone().unwrap_or_else(|| "any origin".into())),
                Cell::from(w.session_id.clone().unwrap_or_else(|| "any Session".into())),
            ])
        })
        .collect();
    let widths = [Constraint::Length(10), Constraint::Fill(1), Constraint::Fill(1)];
    table(
        frame,
        area,
        "Agents watching",
        &["Watch", "Origin", "Session"],
        &widths,
        rows,
        app.selected(View::Watchers),
        "No agent is waiting in watch_items. Connect one to /mcp.",
    );
}

fn tokens(frame: &mut Frame, area: Rect, app: &App) {
    let rows = app
        .state
        .agent_tokens
        .iter()
        .map(|t| {
            Row::new(vec![
                Cell::from(t.name.clone()),
                Cell::from(t.id.clone()),
                Cell::from(ago(app.now_ms, Some(t.created_at))),
                Cell::from(ago(app.now_ms, t.last_used_at)),
            ])
        })
        .collect();
    let widths = [Constraint::Fill(1), Constraint::Length(12), Constraint::Length(12), Constraint::Length(12)];
    table(
        frame,
        area,
        "Agent tokens",
        &["For", "Id", "Created", "Last used"],
        &widths,
        rows,
        app.selected(View::Tokens),
        "No agent tokens. Agents on this machine need none; for one on another machine press t (network mode).",
    );
}

/// The selected row in full.
fn details(app: &App) -> Text<'static> {
    let at = app.selected(app.view);
    let lines: Vec<String> = match app.view {
        View::Clients => app.state.clients.get(at).map_or_else(Vec::new, |c| {
            vec![
                format!("{} ({})", c.name, c.kind),
                format!("id: {}", c.id),
                if c.connected { "connected" } else { "not connected" }.to_owned(),
                format!("last seen: {}", ago(app.now_ms, c.last_seen_at)),
            ]
        }),
        View::Sessions => app.state.sessions.get(at).map_or_else(Vec::new, |s| {
            vec![
                s.title.clone().unwrap_or_default(),
                s.url.clone().unwrap_or_default(),
                format!("id: {}", s.id),
                format!("state: {}", session_state(s)),
                format!("{} Annotations, {} Draft Items", s.annotations, s.draft_items),
                format!("{} Change Items, {} open", s.items, s.open_items),
            ]
        }),
        View::Timeline => app
            .state
            .timeline
            .as_ref()
            .and_then(|t| t.entries.get(at))
            .map_or_else(Vec::new, |e| vec![format!("{} {}", clock(e.t), e.kind), e.text.clone()]),
        View::Items => app.state.items.get(at).map_or_else(Vec::new, |i| {
            let mut lines =
                vec![format!("{}  {}  {}", i.id, status_label(i.status), i.category), i.title.clone(), String::new()];
            lines.push(i.prompt.clone());
            if i.status == ItemStatus::InProgress {
                lines.extend([String::new(), format!("In work: {}", resolution_line(app, i))]);
            } else if let Some(note) = &i.note {
                lines.extend([String::new(), format!("Resolution: {note}")]);
            }
            lines
        }),
        View::Tokens => app.state.agent_tokens.get(at).map_or_else(Vec::new, |t| {
            vec![
                format!("token for {}", t.name),
                format!("id: {}", t.id),
                format!("created: {}", ago(app.now_ms, Some(t.created_at))),
                format!("last used: {}", ago(app.now_ms, t.last_used_at)),
                String::new(),
                "r revokes it.".to_owned(),
            ]
        }),
        View::Watchers => app.state.watchers.get(at).map_or_else(Vec::new, |w| {
            vec![
                format!("watch #{}", w.id),
                format!("origin: {}", w.url.clone().unwrap_or_else(|| "any".into())),
                format!("Session: {}", w.session_id.clone().unwrap_or_else(|| "any".into())),
            ]
        }),
    };
    Text::from(lines.into_iter().map(Line::from).collect::<Vec<_>>())
}

fn popup(frame: &mut Frame, title: &str, text: Text<'_>, width: u16, height: u16) {
    let area = frame.area();
    let width = width.min(area.width.saturating_sub(2));
    let height = (height + 2).min(area.height.saturating_sub(2));
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    };
    frame.render_widget(Clear, popup);
    let block = Block::bordered().title(format!(" {title} ")).title_bottom(Line::from(" Esc ").right_aligned());
    frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }).block(block), popup);
}
