//! Pairing approval (ADR 0005, ADR 0006). An unpaired Client's hello becomes a `PairingRequest` on the server's
//! channel; whoever holds the receiver (the TUI, or a terminal prompt in headless `serve`) shows it.
//!
//! - From this machine (loopback): the user answers yes or no.
//! - From another machine (network mode): the Host issues a 6-digit code that the request carries, with a
//!   `inkup://pair` link for a QR code. The user types the code into the Client, which connects again with
//!   it. A code lasts two minutes and survives four wrong guesses; the user can refuse it early.

use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

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
/// Codes waiting at once; a flood of hellos from the LAN cannot fill the TUI.
const MAX_WAITING: usize = 4;

struct Waiting {
    id: u64,
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

    /// A new code for a Client on another machine, unless too many are waiting. Returns its id (for `expire`).
    pub(crate) fn issue(&self, decision: oneshot::Receiver<PairingDecision>) -> Option<(u64, String)> {
        let mut waiting = self.lock();
        self.prune(&mut waiting);
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
        waiting.push(Waiting { id, code: code.clone(), issued: Instant::now(), wrong: 0, decision });
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

    fn issued(codes: &PairingCodes) -> (String, oneshot::Sender<PairingDecision>) {
        let (tx, rx) = oneshot::channel();
        let (_, code) = codes.issue(rx).unwrap();
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
    fn at_most_four_codes_wait() {
        let codes = PairingCodes::new(Duration::from_secs(120));
        let _held: Vec<_> = (0..MAX_WAITING).map(|_| issued(&codes)).collect();
        assert!(codes.issue(oneshot::channel().1).is_none());
    }
}
