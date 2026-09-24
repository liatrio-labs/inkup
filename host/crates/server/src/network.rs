//! Network mode (ADR 0006): the Host listens on every interface, answers to its `.local` name and LAN addresses,
//! and advertises itself on mDNS.
//!
//! - `_inkup._tcp` (DNS-SD) with TXT `id`, `name`, `version`, `protocol_version`, for native Clients that
//!   can browse.
//! - The host name `inkup.local` (then `-2` … `-5` when another machine holds it), which extensions cannot
//!   browse for but can probe: `http://inkup.local:47823/health`.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, RwLock};

use inkup_protocol::PROTOCOL_VERSION;
use mdns_sd::{DaemonEvent, IfKind, ServiceDaemon, ServiceInfo};

use crate::VERSION;

/// What the Host says wherever network mode is on: the TUI header, the `serve` banner.
pub const NETWORK_WARNING: &str = "Network mode: unencrypted on this LAN — trusted networks only";

/// The DNS-SD service type.
pub const SERVICE_TYPE: &str = "_inkup._tcp.local.";
/// The `.local` host name a Host tries first.
pub const DEFAULT_MDNS_NAME: &str = "inkup";
/// `inkup-2.local` … `inkup-5.local` when the name is taken; Clients probe no further.
pub const MAX_NAME_SUFFIX: u32 = 5;

#[derive(Debug, Clone)]
pub struct NetworkConfig {
    /// The `.local` host name to claim, without `.local` (tests use their own, not to take the real one).
    pub mdns_name: String,
    /// This Host's id in the TXT record.
    pub hub_id: String,
    /// Advertise on mDNS. Off in tests that do not need it.
    pub advertise: bool,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self { mdns_name: DEFAULT_MDNS_NAME.into(), hub_id: String::new(), advertise: true }
    }
}

/// What the Host is known by on the LAN while it runs.
pub struct Network {
    port: u16,
    base: String,
    /// The `.local` name claimed (`inkup.local`), once mDNS has probed it; `None` before, or when every
    /// name up to `-5` was taken, or without multicast.
    claimed: Arc<RwLock<Option<String>>>,
    daemon: Option<ServiceDaemon>,
}

impl Network {
    pub(crate) fn start(config: &NetworkConfig, hub_name: &str, port: u16) -> Self {
        let claimed = Arc::new(RwLock::new(None));
        let daemon = if config.advertise {
            match advertise(config, hub_name, port, Arc::clone(&claimed)) {
                Ok(daemon) => Some(daemon),
                Err(error) => {
                    tracing::warn!(%error, "mDNS is unavailable: Clients must be given this Host's address");
                    None
                }
            }
        } else {
            None
        };
        Self { port, base: config.mdns_name.clone(), claimed, daemon }
    }

    /// `inkup.local`, once claimed.
    pub fn claimed_name(&self) -> Option<String> {
        self.claimed.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Where another machine reaches the Host: its `.local` name, else its first LAN address.
    pub fn base_url(&self) -> String {
        let host = self.claimed_name().or_else(|| lan_addresses().first().map(ToString::to_string));
        format!("http://{}:{}", host.unwrap_or_else(|| "127.0.0.1".into()), self.port)
    }

    /// What the TUI's QR code carries: `inkup://pair?url=http://inkup.local:47823&code=042917`.
    pub fn pair_link(&self, code: &str) -> String {
        format!("inkup://pair?url={}&code={code}", self.base_url())
    }

    /// A Host header name another machine may use: one of the `.local` names this Host could hold, or one of its
    /// LAN addresses. Never an arbitrary name, which is what a DNS-rebinding page would send.
    pub(crate) fn serves_name(&self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        let name = name.strip_suffix('.').unwrap_or(&name);
        if let Some(label) = name.strip_suffix(".local") {
            let base = self.base.to_ascii_lowercase();
            return label == base
                || label
                    .strip_prefix(&base)
                    .and_then(|rest| rest.strip_prefix('-'))
                    .and_then(|n| n.parse::<u32>().ok())
                    .is_some_and(|n| (2..=MAX_NAME_SUFFIX).contains(&n));
        }
        name.parse::<Ipv4Addr>().is_ok_and(|ip| lan_addresses().contains(&ip))
    }

    pub(crate) fn shutdown(&self) {
        if let Some(daemon) = &self.daemon {
            let _ = daemon.shutdown();
        }
    }
}

/// This machine's IPv4 addresses on its network interfaces, loopback and link-local excepted.
pub fn lan_addresses() -> Vec<Ipv4Addr> {
    let mut found: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(ip),
            _ => None,
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

fn advertise(
    config: &NetworkConfig,
    hub_name: &str,
    port: u16,
    claimed: Arc<RwLock<Option<String>>>,
) -> Result<ServiceDaemon, mdns_sd::Error> {
    let daemon = ServiceDaemon::new()?;
    // The server listens on IPv4 only.
    daemon.disable_interface(IfKind::IPv6)?;
    let host = format!("{}.local.", config.mdns_name);
    let protocol_version = PROTOCOL_VERSION.to_string();
    let txt = [
        ("id", config.hub_id.as_str()),
        ("name", hub_name),
        ("version", VERSION),
        ("protocol_version", protocol_version.as_str()),
    ];
    let info = ServiceInfo::new(SERVICE_TYPE, hub_name, &host, "", port, &txt[..])?.enable_addr_auto();
    let fullname = info.get_fullname().to_owned();
    let events = daemon.monitor()?;
    daemon.register(info)?;
    let handle = daemon.clone();
    std::thread::Builder::new()
        .name("mdns-monitor".into())
        .spawn(move || watch_names(&handle, &events, host, fullname, &claimed))
        .map_err(|e| mdns_sd::Error::Msg(e.to_string()))?;
    Ok(daemon)
}

/// Follows the daemon's probing: a conflict renames `inkup.local` to `-2`, `-3`, …; the first announcement
/// means the current name is ours. Past `-5` Clients would not find it, so the Host stops advertising.
fn watch_names(
    daemon: &ServiceDaemon,
    events: &mdns_sd::Receiver<DaemonEvent>,
    mut host: String,
    fullname: String,
    claimed: &RwLock<Option<String>>,
) {
    let set = |name: Option<String>| *claimed.write().unwrap_or_else(|p| p.into_inner()) = name;
    while let Ok(event) = events.recv() {
        match event {
            DaemonEvent::NameChange(change) if change.original == host => {
                host = change.new_name;
                if name_suffix(&host) > MAX_NAME_SUFFIX {
                    tracing::warn!(%host, "every .local name up to -{MAX_NAME_SUFFIX} is taken; not advertising");
                    set(None);
                    let _ = daemon.unregister(&fullname);
                    return;
                }
                set(None);
            }
            DaemonEvent::Announce(..) => {
                let name = host.trim_end_matches('.').to_owned();
                if claimed.read().unwrap_or_else(|p| p.into_inner()).as_deref() != Some(name.as_str()) {
                    tracing::info!(%name, "claimed the .local name");
                    set(Some(name));
                }
            }
            DaemonEvent::Error(error) => tracing::debug!(%error, "mDNS"),
            _ => {}
        }
    }
}

/// 1 for `inkup.local.`, N for `inkup-N.local.`.
fn name_suffix(host: &str) -> u32 {
    let label = host.split('.').next().unwrap_or_default();
    label.rsplit_once('-').and_then(|(_, n)| n.parse().ok()).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(base: &str) -> Network {
        Network { port: 47823, base: base.into(), claimed: Arc::default(), daemon: None }
    }

    #[test]
    fn only_our_local_names_and_lan_addresses_are_served() {
        let net = network("inkup");
        for ok in ["inkup.local", "INKUP.local", "inkup-2.local", "inkup-5.local."] {
            assert!(net.serves_name(ok), "{ok}");
        }
        for bad in ["inkup-6.local", "inkup-x.local", "evil.local", "inkup.example", "10.9.9.9"] {
            assert!(!net.serves_name(bad), "{bad}");
        }
        for ip in lan_addresses() {
            assert!(net.serves_name(&ip.to_string()), "{ip}");
        }
    }

    #[test]
    fn the_pair_link_names_the_claimed_host() {
        let net = network("inkup");
        *net.claimed.write().unwrap() = Some("inkup-2.local".into());
        assert_eq!(net.pair_link("042917"), "inkup://pair?url=http://inkup-2.local:47823&code=042917");
        assert_eq!(name_suffix("inkup.local."), 1);
        assert_eq!(name_suffix("inkup-6.local."), 6);
    }
}
