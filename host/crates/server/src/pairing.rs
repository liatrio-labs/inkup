//! Pairing approval (ADR 0005, ADR 0006, ADR 0030). An unpaired Client's hello becomes a `PairingRequest` on the
//! server's channel; whoever holds the receiver (the TUI, or a terminal prompt in headless `serve`) shows it.
//!
//! - From this machine (loopback): the user answers yes or no.
//! - From another machine (network mode): the Host issues a 6-digit code that the request carries, with a
//!   `inkup://pair` link for a QR code. The user types the code into the Client, which connects again with
//!   it. A code lasts two minutes and survives four wrong guesses; the user can refuse it early. A machine that asks
//!   again gets a new code in place of its last one.
//! - On a Remote Host the operator issues the code (`inkup pairing`). A hello never does. Each code has its own
//!   guess budget and expiry, and it lives only in this process.

use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingDecision {
    Approve,
    Deny,
}

/// A pairing request from another machine: the code its user must type, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePairing {
    pub code: String,
    pub from: IpAddr,
    /// `inkup://pair?url=…&code=…`, for the QR code.
    pub link: String,
}

#[derive(Debug)]
pub struct PairingRequest {
    pub client_kind: String,
    pub client_name: String,
    /// Set when the Client is on another machine: show the code; only a refusal needs an answer.
    pub remote: Option<RemotePairing>,
    respond: oneshot::Sender<PairingDecision>,
}

impl PairingRequest {
    pub(crate) fn new(client_kind: String, client_name: String) -> (Self, oneshot::Receiver<PairingDecision>) {
        let (respond, decision) = oneshot::channel();
        (Self { client_kind, client_name, remote: None, respond }, decision)
    }

    /// Answers the request. Dropping a local request unanswered denies it; dropping a remote one leaves its code
    /// valid until it expires.
    pub fn decide(self, decision: PairingDecision) {
        let _ = self.respond.send(decision);
    }

    /// No need to ask any more: the Client stopped waiting (closed, or the request timed out), or its code was
    /// used, expired or refused.
    pub fn is_cancelled(&self) -> bool {
        self.respond.is_closed()
    }

    /// "Chrome extension "Work laptop" wants to connect", with "from 192.168.1.20" for another machine.
    pub fn prompt(&self) -> String {
        let kind = match self.client_kind.as_str() {
            "chrome" => "Chrome extension",
            "firefox" => "Firefox extension",
            "safari" => "Safari extension",
            _ => "A client",
        };
        // The name comes from the Client: control characters could rewrite the terminal the prompt is shown in.
        let name: String = self.client_name.chars().filter(|c| !c.is_control()).collect();
        match &self.remote {
            Some(remote) => format!("{kind} \"{name}\" from {} wants to connect", remote.from),
            None => format!("{kind} \"{name}\" wants to connect"),
        }
    }
}

/// A code is refused at its fifth wrong guess.
pub(crate) const MAX_WRONG_CODES: u32 = 5;
/// Codes waiting at once, one per machine; a flood of hellos from the LAN cannot fill the TUI.
const MAX_WAITING: usize = 4;

struct Waiting {
    id: u64,
    /// The machine that asked: asking again replaces its code.
    from: IpAddr,
    code: String,
    issued: Instant,
    wrong: u32,
    /// The user's answer in the TUI; only a refusal matters. Dropping it tells the TUI the request is gone.
    decision: oneshot::Receiver<PairingDecision>,
}

/// What came of a code a Client sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Redeemed {
    Paired,
    Wrong {
        tries_left: u32,
    },
    /// That guess was the fifth wrong one.
    Refused,
    /// No code is waiting: none was asked for, or it expired, was used or was refused.
    NoneWaiting,
}

/// The codes issued to Clients on other machines, waiting to be typed in.
pub(crate) struct PairingCodes {
    ttl: Duration,
    next: AtomicU64,
    waiting: Mutex<Vec<Waiting>>,
}

impl PairingCodes {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self { ttl, next: AtomicU64::new(1), waiting: Mutex::new(Vec::new()) }
    }

    pub(crate) fn ttl(&self) -> Duration {
        self.ttl
    }

    /// Codes still waiting, after expired and refused ones are dropped.
    pub(crate) fn waiting(&self) -> usize {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        waiting.len()
    }

    /// A new code for a Client on another machine, unless too many machines are waiting. Returns its id (for
    /// `expire`). The machine's earlier code, if one waits, is dropped: its Client asked again (Connect clicked
    /// twice, the options page reopened), and stacking its codes would refuse its fifth ask as if the user had.
    pub(crate) fn issue(&self, from: IpAddr, decision: oneshot::Receiver<PairingDecision>) -> Option<(u64, String)> {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        waiting.retain(|w| w.from != from);
        if waiting.len() >= MAX_WAITING {
            return None;
        }
        let code = loop {
            let code = random_code()?;
            if !waiting.iter().any(|w| w.code == code) {
                break code;
            }
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        waiting.push(Waiting { id, from, code: code.clone(), issued: Instant::now(), wrong: 0, decision });
        Some((id, code))
    }

    /// Drops a code once its time is up, so the TUI stops showing it.
    pub(crate) fn expire(&self, id: u64) {
        self.lock().retain(|w| w.id != id);
    }

    /// A Client's guess. A right one uses the code up. A wrong one counts against every waiting code, so guessing
    /// across several requests gains nothing.
    pub(crate) fn redeem(&self, code: &str) -> Redeemed {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        if let Some(at) = waiting.iter().position(|w| w.code == code) {
            waiting.remove(at);
            return Redeemed::Paired;
        }
        if waiting.is_empty() {
            return Redeemed::NoneWaiting;
        }
        for w in waiting.iter_mut() {
            w.wrong += 1;
        }
        waiting.retain(|w| w.wrong < MAX_WRONG_CODES);
        match waiting.iter().map(|w| MAX_WRONG_CODES - w.wrong).min() {
            Some(tries_left) => Redeemed::Wrong { tries_left },
            None => Redeemed::Refused,
        }
    }

    /// Drops expired codes and the ones the user refused.
    fn prune(&self, waiting: &mut Vec<Waiting>) {
        waiting.retain_mut(|w| {
            w.issued.elapsed() < self.ttl && !matches!(w.decision.try_recv(), Ok(PairingDecision::Deny))
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Waiting>> {
        self.waiting.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Wrong guesses one operator-issued code survives. The fifth burns it.
pub const OPERATOR_GUESS_BUDGET: u32 = 5;
/// Operator-issued codes waiting at once. More than this is refused until one expires or is revoked.
pub const OPERATOR_CODE_CAP: usize = 10;
/// Decimal digits in an operator-issued code. The hello's `pairing_code` is `^[0-9]{6}$`, so this is the
/// whole space: 1_000_000 values. Five guesses, not reset by another hello, cannot search it (ADR 0030).
pub const OPERATOR_CODE_DIGITS: usize = 6;
/// What `inkup pairing create` uses when no lifetime is given.
pub const OPERATOR_TTL_DEFAULT: Duration = Duration::from_secs(15 * 60);
/// The longest lifetime `inkup pairing create` accepts.
pub const OPERATOR_TTL_MAX: Duration = Duration::from_secs(24 * 60 * 60);
/// The shortest lifetime the control API accepts.
pub const OPERATOR_TTL_MIN: Duration = Duration::from_secs(1);

/// Why an operator code was not issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IssueError {
    /// [`OPERATOR_CODE_CAP`] codes are already waiting.
    Cap,
    /// The process could not draw random bytes.
    Random,
}

/// A code just issued. `code` is shown once; list and revoke only have `id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IssuedCode {
    pub id: String,
    /// Six digits. Shown once, at creation. Not the id `pairing list` prints.
    pub code: String,
    pub label: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub guesses_left: u32,
}

/// One outstanding operator-issued code, without its secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OperatorCodeView {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub guesses_left: u32,
}

struct OperatorCode {
    id: String,
    /// The six-digit code. Not returned by list.
    secret: String,
    label: String,
    issued: Instant,
    ttl: Duration,
    created_at: i64,
    expires_at: i64,
    wrong: u32,
}

/// Operator-issued pairing codes for a Remote Host. Memory only: dropping this burns them.
pub(crate) struct OperatorCodes {
    waiting: Mutex<Vec<OperatorCode>>,
}

impl OperatorCodes {
    pub(crate) fn new() -> Self {
        Self { waiting: Mutex::new(Vec::new()) }
    }

    /// A new code, unless the cap is reached. The control API rejects a lifetime outside
    /// [`OPERATOR_TTL_MIN`]..=[`OPERATOR_TTL_MAX`] before it calls this; a zero lifetime expires at once.
    pub(crate) fn issue(&self, label: &str, ttl: Duration) -> Result<IssuedCode, IssueError> {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        if waiting.len() >= OPERATOR_CODE_CAP {
            return Err(IssueError::Cap);
        }
        // Stop after a few draws. A comparison that calls every code a match would otherwise spin here, and a
        // real collision in 1_000_000 values does not need more than this.
        let code = draw_unique(8, random_code, |code| {
            waiting.iter().any(|held| secret_eq(held.secret.as_bytes(), code.as_bytes()))
        })?;
        let id =
            draw_unique(8, || random_bytes(4).map(|bytes| hex(&bytes)), |id| waiting.iter().any(|code| code.id == id))?;
        let label = clean_label(label);
        let created_at = now_ms();
        let expires_at = created_at.saturating_add(i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX));
        waiting.push(OperatorCode {
            id: id.clone(),
            secret: code.clone(),
            label: label.clone(),
            issued: Instant::now(),
            ttl,
            created_at,
            expires_at,
            wrong: 0,
        });
        Ok(IssuedCode { id, code, label, created_at, expires_at, guesses_left: OPERATOR_GUESS_BUDGET })
    }

    /// Outstanding codes, secrets omitted. Expired ones are dropped first.
    pub(crate) fn list(&self) -> Vec<OperatorCodeView> {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        waiting
            .iter()
            .map(|code| OperatorCodeView {
                id: code.id.clone(),
                label: code.label.clone(),
                created_at: code.created_at,
                expires_at: code.expires_at,
                guesses_left: OPERATOR_GUESS_BUDGET.saturating_sub(code.wrong),
            })
            .collect()
    }

    /// Burns one code. False when no outstanding code has that id.
    pub(crate) fn revoke(&self, id: &str) -> bool {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        let before = waiting.len();
        waiting.retain(|code| code.id != id);
        waiting.len() != before
    }

    /// A Client's guess. A right one uses that code up. A wrong one counts against the oldest outstanding code
    /// only, so it cannot spend every code's budget or reset one. Nothing here creates or extends a code.
    /// Every failure looks the same to the caller: this returns false.
    pub(crate) fn redeem(&self, submitted: &str) -> bool {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
        let mut found = None;
        for (at, code) in waiting.iter().enumerate() {
            if secret_eq(submitted.as_bytes(), code.secret.as_bytes()) {
                found = Some(at);
            }
        }
        if let Some(at) = found {
            waiting.remove(at);
            return true;
        }
        if let Some(oldest) = waiting.first_mut() {
            oldest.wrong += 1;
            if oldest.wrong >= OPERATOR_GUESS_BUDGET {
                waiting.remove(0);
            }
        }
        false
    }

    fn prune(&self, waiting: &mut Vec<OperatorCode>) {
        waiting.retain(|code| code.issued.elapsed() < code.ttl);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<OperatorCode>> {
        self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Equal in time that does not stop at the first differing byte. A length mismatch still walks the overlap.
fn secret_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = u8::from(a.len() != b.len());
    for (left, right) in a.iter().zip(b) {
        diff |= left ^ right;
    }
    diff == 0
}

fn clean_label(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(80).collect::<String>().trim().to_owned()
}

/// A fresh value that `taken` rejects, or [`IssueError::Random`] when drawing fails or every draw is taken.
fn draw_unique(
    tries: u32,
    mut fresh: impl FnMut() -> Option<String>,
    taken: impl Fn(&str) -> bool,
) -> Result<String, IssueError> {
    for _ in 0..tries {
        let value = fresh().ok_or(IssueError::Random)?;
        if !taken(&value) {
            return Ok(value);
        }
    }
    Err(IssueError::Random)
}

fn random_bytes(n: usize) -> Option<Vec<u8>> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Six digits, every code equally likely.
fn random_code() -> Option<String> {
    loop {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).ok()?;
        let n = u32::from_le_bytes(bytes);
        // 4_294_000_000 is a multiple of 1_000_000: drawing again above it removes the modulo bias.
        if n < 4_294_000_000 {
            return Some(format!("{:06}", n % 1_000_000));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_drops_control_characters_from_the_client_name() {
        let (request, _) = PairingRequest::new("chrome".into(), "Work\u{1b}[2J laptop".into());
        assert_eq!(request.prompt(), "Chrome extension \"Work[2J laptop\" wants to connect");
    }

    fn machine(n: u8) -> IpAddr {
        IpAddr::from([192, 168, 1, n])
    }

    fn issued(codes: &PairingCodes) -> (String, oneshot::Sender<PairingDecision>) {
        issued_to(codes, machine(20))
    }

    fn issued_to(codes: &PairingCodes, from: IpAddr) -> (String, oneshot::Sender<PairingDecision>) {
        let (tx, rx) = oneshot::channel();
        let (_, code) = codes.issue(from, rx).unwrap();
        (code, tx)
    }

    #[test]
    fn a_code_is_refused_at_the_fifth_wrong_guess() {
        let codes = PairingCodes::new(Duration::from_secs(120));
        let (code, _tx) = issued(&codes);
        assert_eq!(code.len(), 6);
        for left in (1..MAX_WRONG_CODES).rev() {
            assert_eq!(codes.redeem("abcdef"), Redeemed::Wrong { tries_left: left });
        }
        assert_eq!(codes.redeem("abcdef"), Redeemed::Refused);
        assert_eq!(codes.redeem(&code), Redeemed::NoneWaiting);

        let (code, _tx) = issued(&codes);
        assert_eq!(codes.redeem("abcdef"), Redeemed::Wrong { tries_left: 4 });
        assert_eq!(codes.redeem(&code), Redeemed::Paired);
        assert_eq!(codes.redeem(&code), Redeemed::NoneWaiting, "a code works once");
    }

    #[test]
    fn a_refused_or_expired_code_is_gone() {
        let codes = PairingCodes::new(Duration::from_secs(120));
        let (code, tx) = issued(&codes);
        tx.send(PairingDecision::Deny).unwrap();
        assert_eq!(codes.redeem(&code), Redeemed::NoneWaiting);

        let codes = PairingCodes::new(Duration::ZERO);
        let (code, _tx) = issued(&codes);
        assert_eq!(codes.redeem(&code), Redeemed::NoneWaiting);
    }

    #[test]
    fn at_most_four_machines_wait() {
        let codes = PairingCodes::new(Duration::from_secs(120));
        let held: Vec<_> = (1..=4).map(|n| issued_to(&codes, machine(n))).collect();
        assert_eq!(held.len(), MAX_WAITING);
        assert!(codes.issue(machine(5), oneshot::channel().1).is_none());
    }

    #[test]
    fn a_machine_that_asks_again_gets_a_new_code_in_place_of_its_last() {
        let codes = PairingCodes::new(Duration::from_secs(120));
        let (first, first_tx) = issued(&codes);
        let held: Vec<_> = (0..MAX_WAITING + 2).map(|_| issued(&codes)).collect();
        assert!(first_tx.is_closed(), "the code it replaced stops showing");
        assert_eq!(codes.redeem(&first), Redeemed::Wrong { tries_left: MAX_WRONG_CODES - 1 });
        let (newest, _) = held.last().unwrap();
        assert_eq!(codes.redeem(newest), Redeemed::Paired);
    }

    #[test]
    fn an_operator_code_is_single_use_and_a_wrong_guess_stays_on_that_code() {
        let codes = OperatorCodes::new();
        let ttl = OPERATOR_TTL_DEFAULT;
        let first = codes.issue("reviewer", ttl).unwrap();
        let second = codes.issue("other", ttl).unwrap();
        assert_eq!(first.code.len(), OPERATOR_CODE_DIGITS);
        assert!(first.code.chars().all(|c| c.is_ascii_digit()));
        assert_ne!(first.code, second.code);
        let wrong = if first.code == "000000" { "111111" } else { "000000" };
        assert!(!codes.redeem(wrong));
        let listed = codes.list();
        assert_eq!(listed.iter().find(|code| code.id == first.id).unwrap().guesses_left, OPERATOR_GUESS_BUDGET - 1);
        assert_eq!(listed.iter().find(|code| code.id == second.id).unwrap().guesses_left, OPERATOR_GUESS_BUDGET);
        assert!(listed.iter().all(|code| code.id != first.code && code.label != first.code));
        assert!(codes.redeem(&first.code));
        assert!(!codes.redeem(&first.code), "a code works once");
        assert!(codes.redeem(&second.code));
    }

    #[test]
    fn five_wrong_guesses_burn_only_that_operator_code() {
        let codes = OperatorCodes::new();
        let issued = codes.issue("reviewer", OPERATOR_TTL_DEFAULT).unwrap();
        let other = codes.issue("other", OPERATOR_TTL_DEFAULT).unwrap();
        let wrong = if issued.code == "000000" || other.code == "000000" { "111111" } else { "000000" };
        for _ in 0..OPERATOR_GUESS_BUDGET {
            assert!(!codes.redeem(wrong));
        }
        assert!(!codes.redeem(&issued.code), "the budget burned it");
        assert!(codes.list().iter().all(|code| code.id != issued.id));
        assert!(codes.redeem(&other.code));
        assert!(!codes.redeem("not-a-code"));
    }

    #[test]
    fn an_expired_or_revoked_operator_code_is_gone_and_the_cap_holds() {
        let codes = OperatorCodes::new();
        let issued = codes.issue("reviewer", Duration::ZERO).unwrap();
        assert!(!codes.redeem(&issued.code));
        assert!(codes.list().is_empty());

        let issued = codes.issue("reviewer", OPERATOR_TTL_DEFAULT).unwrap();
        assert!(codes.revoke(&issued.id));
        assert!(!codes.revoke(&issued.id));
        assert!(!codes.redeem(&issued.code));

        let held: Vec<_> =
            (0..OPERATOR_CODE_CAP).map(|n| codes.issue(&format!("c{n}"), OPERATOR_TTL_DEFAULT).unwrap()).collect();
        assert_eq!(held.len(), OPERATOR_CODE_CAP);
        assert_eq!(codes.issue("one more", OPERATOR_TTL_DEFAULT).unwrap_err(), IssueError::Cap);
        assert!(codes.revoke(&held[0].id));
        assert!(codes.issue("one more", OPERATOR_TTL_DEFAULT).is_ok());
    }

    #[test]
    fn drawing_a_code_stops_when_every_value_is_taken() {
        let error = draw_unique(3, || Some("000000".into()), |_| true).unwrap_err();
        assert_eq!(error, IssueError::Random);
    }

    #[test]
    fn a_label_drops_control_characters_and_list_never_carries_the_secret() {
        let codes = OperatorCodes::new();
        let issued = codes.issue("lab\u{1b}[2J top", OPERATOR_TTL_DEFAULT).unwrap();
        assert_eq!(issued.label, "lab[2J top");
        let view = codes.list().pop().unwrap();
        assert_ne!(view.id, issued.code);
        assert!(!view.label.contains(&issued.code));
        assert_eq!(view.guesses_left, OPERATOR_GUESS_BUDGET);
    }
}
