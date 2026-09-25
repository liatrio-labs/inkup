//! The TUI's state and keys, apart from the terminal: what is on screen, and what a key asks the Host to do. Keys
//! return an `Action` instead of doing it, so tests drive them without a server.

use std::collections::{HashMap, VecDeque};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use inkup_server::{ClientView, Command, HostState, PairingDecision, PairingRequest, RemotePairing};
use inkup_store::SessionOverview;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Clients,
    Sessions,
    Timeline,
    Items,
    Watchers,
    Tokens,
}

impl View {
    pub const ALL: [Self; 6] =
        [Self::Clients, Self::Sessions, Self::Timeline, Self::Items, Self::Watchers, Self::Tokens];

    pub fn title(self) -> &'static str {
        match self {
            Self::Clients => "Clients",
            Self::Sessions => "Sessions",
            Self::Timeline => "Timeline",
            Self::Items => "Items",
            Self::Watchers => "Agents",
            Self::Tokens => "Tokens",
        }
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|v| *v == self).unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlay {
    Help,
    Details,
    /// Naming a new agent token; the text typed so far.
    NewToken(String),
    /// A token just made, shown once, with the command that installs it on the agent's machine.
    NewTokenShown {
        name: String,
        token: String,
    },
    /// Asking before a token is revoked.
    Revoke {
        id: String,
        name: String,
    },
    /// Asking before network mode is switched on (or off), which restarts the server.
    Network(bool),
}

/// A pairing request as the TUI shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingPrompt {
    pub prompt: String,
    /// From another machine: the code to type in, and the link for the QR code. Only a refusal needs a key.
    pub remote: Option<RemotePairing>,
}

impl From<&PairingRequest> for PairingPrompt {
    fn from(request: &PairingRequest) -> Self {
        Self { prompt: request.prompt(), remote: request.remote.clone() }
    }
}

impl From<&str> for PairingPrompt {
    fn from(prompt: &str) -> Self {
        Self { prompt: prompt.into(), remote: None }
    }
}

/// Network mode as the header shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkView {
    /// `inkup.local`, once claimed on mDNS.
    pub claimed: Option<String>,
    /// This machine's LAN addresses.
    pub addresses: Vec<String>,
    /// Where another machine reaches the Host: for `mcp install --remote`.
    pub base_url: String,
}

/// What a key asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    Quit,
    /// Send a command to a Client's browser.
    Command {
        client_id: String,
        command: Command,
    },
    /// Answer the oldest pairing request.
    Pairing(PairingDecision),
    /// Make an agent token with this name.
    CreateToken(String),
    RevokeToken(String),
    /// Switch network mode and restart the server.
    SetNetwork(bool),
}

pub struct App {
    /// Shown in the header: where the Host listens.
    pub address: String,
    pub state: HostState,
    pub view: View,
    selected: [usize; View::ALL.len()],
    pub overlay: Option<Overlay>,
    /// The pairing requests waiting, oldest first.
    pub pairing: VecDeque<PairingPrompt>,
    /// Set in network mode: the header warns, and names the Host's `.local` name and addresses.
    pub network: Option<NetworkView>,
    /// The last command's outcome, or a hint.
    pub status: Option<String>,
    /// A newer inkup release and what to run for it, shown quietly in the key line while there is no status.
    pub update: Option<String>,
    /// Draw mode as last set from here, per Session (a Session starts with it off).
    draw_mode: HashMap<String, bool>,
    /// Epoch ms, for "3 min ago".
    pub now_ms: i64,
}

impl App {
    pub fn new(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            state: HostState::default(),
            view: View::Clients,
            selected: [0; View::ALL.len()],
            overlay: None,
            pairing: VecDeque::new(),
            network: None,
            status: None,
            update: None,
            draw_mode: HashMap::new(),
            now_ms: 0,
        }
    }

    /// Replaces the state, keeping each view's selection in range.
    pub fn update(&mut self, state: HostState, now_ms: i64) {
        self.state = state;
        self.now_ms = now_ms;
        for view in View::ALL {
            let len = self.rows(view);
            let selected = &mut self.selected[view.index()];
            *selected = (*selected).min(len.saturating_sub(1));
        }
    }

    pub fn selected(&self, view: View) -> usize {
        self.selected[view.index()]
    }

    /// How many rows a view lists.
    pub fn rows(&self, view: View) -> usize {
        match view {
            View::Clients => self.state.clients.len(),
            View::Sessions => self.state.sessions.len(),
            View::Timeline => self.state.timeline.as_ref().map_or(0, |t| t.entries.len()),
            View::Items => self.state.items.len(),
            View::Watchers => self.state.watchers.len(),
            View::Tokens => self.state.agent_tokens.len(),
        }
    }

    /// The Session whose timeline to show: the one selected in Sessions.
    pub fn timeline_session(&self) -> Option<String> {
        self.state.sessions.get(self.selected(View::Sessions)).map(|s| s.id.clone())
    }

    /// The Client that `s`, `p`, `x` and `d` act on: the one selected in Clients, the owner of the Session selected
    /// in Sessions, or else the first connected one.
    pub fn focused_client(&self) -> Option<&ClientView> {
        let by_id = |id: &str| self.state.clients.iter().find(|c| c.id == id);
        let chosen = match self.view {
            View::Clients => self.state.clients.get(self.selected(View::Clients)),
            View::Sessions => self
                .state
                .sessions
                .get(self.selected(View::Sessions))
                .and_then(|s| s.client_id.as_deref())
                .and_then(by_id),
            _ => None,
        };
        chosen.or_else(|| self.state.clients.iter().find(|c| c.connected))
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Action {
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Action::Quit;
        }
        // A pairing request takes the keyboard until it is answered. One from another machine is answered by
        // typing its code there; here it can only be refused.
        if let Some(front) = self.pairing.front() {
            let remote = front.remote.is_some();
            return match key.code {
                KeyCode::Char('y' | 'Y') if !remote => self.answer_pairing(PairingDecision::Approve),
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.answer_pairing(PairingDecision::Deny),
                _ => Action::None,
            };
        }
        if let Some(overlay) = self.overlay.clone() {
            return self.on_overlay_key(overlay, key);
        }
        match key.code {
            KeyCode::Char('q') => Action::Quit,
            KeyCode::Char('?') => {
                self.overlay = Some(Overlay::Help);
                Action::None
            }
            KeyCode::Enter => {
                if self.rows(self.view) > 0 {
                    self.overlay = Some(Overlay::Details);
                }
                Action::None
            }
            KeyCode::Tab | KeyCode::Right => self.switch(1),
            KeyCode::BackTab | KeyCode::Left => self.switch(View::ALL.len() - 1),
            KeyCode::Char(c @ '1'..='6') => {
                self.view = View::ALL[(c as usize) - ('1' as usize)];
                Action::None
            }
            KeyCode::Down | KeyCode::Char('j') => self.step(1),
            KeyCode::Up | KeyCode::Char('k') => self.step(-1),
            KeyCode::Char('s') => self.start(),
            KeyCode::Char('p') => self.pause_or_resume(),
            KeyCode::Char('x') => self.on_live(|_, _| Some(Command::Stop)),
            KeyCode::Char('d') => self.toggle_draw(),
            KeyCode::Char('t') => {
                self.overlay = Some(Overlay::NewToken(String::new()));
                Action::None
            }
            KeyCode::Char('r') if self.view == View::Tokens => {
                if let Some(token) = self.state.agent_tokens.get(self.selected(View::Tokens)) {
                    self.overlay = Some(Overlay::Revoke { id: token.id.clone(), name: token.name.clone() });
                }
                Action::None
            }
            KeyCode::Char('N') => {
                self.overlay = Some(Overlay::Network(self.network.is_none()));
                Action::None
            }
            _ => Action::None,
        }
    }

    fn on_overlay_key(&mut self, overlay: Overlay, key: KeyEvent) -> Action {
        let close = matches!(key.code, KeyCode::Esc);
        match overlay {
            Overlay::NewToken(mut name) => match key.code {
                KeyCode::Esc => self.overlay = None,
                KeyCode::Enter if !name.trim().is_empty() => {
                    self.overlay = None;
                    return Action::CreateToken(name.trim().to_owned());
                }
                KeyCode::Backspace => {
                    name.pop();
                    self.overlay = Some(Overlay::NewToken(name));
                }
                KeyCode::Char(c) if !c.is_control() && name.chars().count() < 60 => {
                    name.push(c);
                    self.overlay = Some(Overlay::NewToken(name));
                }
                _ => {}
            },
            Overlay::Revoke { id, name } => match key.code {
                KeyCode::Char('y' | 'Y') => {
                    self.overlay = None;
                    self.status = Some(format!("Revoked the token for {name}."));
                    return Action::RevokeToken(id);
                }
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.overlay = None,
                _ => {}
            },
            Overlay::Network(on) => match key.code {
                KeyCode::Char('y' | 'Y') => {
                    self.overlay = None;
                    return Action::SetNetwork(on);
                }
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.overlay = None,
                _ => {}
            },
            Overlay::Help | Overlay::Details | Overlay::NewTokenShown { .. } => {
                if close || matches!(key.code, KeyCode::Enter | KeyCode::Char('q' | '?')) {
                    self.overlay = None;
                }
            }
        }
        Action::None
    }

    fn answer_pairing(&mut self, decision: PairingDecision) -> Action {
        let prompt = self.pairing.pop_front().map(|p| p.prompt).unwrap_or_default();
        self.status = Some(match decision {
            PairingDecision::Approve => format!("Paired: {prompt}"),
            PairingDecision::Deny => format!("Declined: {prompt}"),
        });
        Action::Pairing(decision)
    }

    fn switch(&mut self, by: usize) -> Action {
        self.view = View::ALL[(self.view.index() + by) % View::ALL.len()];
        Action::None
    }

    fn step(&mut self, by: isize) -> Action {
        let len = self.rows(self.view);
        let selected = &mut self.selected[self.view.index()];
        *selected = selected.saturating_add_signed(by).min(len.saturating_sub(1));
        Action::None
    }

    fn start(&mut self) -> Action {
        let Some(client) = self.focused_client() else {
            self.status = Some("No client is connected: pair a browser first.".into());
            return Action::None;
        };
        if !client.connected {
            self.status = Some(format!("{} is not connected.", client.name));
            return Action::None;
        }
        if self.state.live_session_of(&client.id).is_some() {
            self.status = Some(format!("{} is already recording.", client.name));
            return Action::None;
        }
        let client_id = client.id.clone();
        self.status = Some(format!("Starting on {}…", client.name));
        Action::Command { client_id, command: Command::StartSession }
    }

    fn pause_or_resume(&mut self) -> Action {
        self.on_live(|_, session| Some(if session.paused { Command::Resume } else { Command::Pause }))
    }

    fn toggle_draw(&mut self) -> Action {
        let action = self.on_live(|app, session| {
            let on = !app.draw_mode.get(&session.id).copied().unwrap_or(false);
            Some(Command::SetDrawMode { draw_mode: on })
        });
        if let Action::Command { command: Command::SetDrawMode { draw_mode }, .. } = &action
            && let Some(session) = self.focused_client().and_then(|c| self.state.live_session_of(&c.id))
        {
            self.draw_mode.insert(session.id.clone(), *draw_mode);
        }
        action
    }

    /// A command for the focused Client's live Session.
    fn on_live(&mut self, command: impl FnOnce(&Self, &SessionOverview) -> Option<Command>) -> Action {
        let Some(client) = self.focused_client() else {
            self.status = Some("No client is connected.".into());
            return Action::None;
        };
        let Some(session) = self.state.live_session_of(&client.id) else {
            self.status = Some(format!("{} is not recording.", client.name));
            return Action::None;
        };
        if !client.connected {
            self.status = Some(format!("{} is not connected.", client.name));
            return Action::None;
        }
        match command(self, session) {
            Some(command) => Action::Command { client_id: client.id.clone(), command },
            None => Action::None,
        }
    }
}
