//! The daily update check (ADR 0008), for whichever process hosts: the TUI, `inkup serve` and the desktop app. At
//! most once a day, cached in `update-check.json` in the data dir, it asks GitHub for the newest `inkup-v*`
//! release. When that is newer than this copy, the host's notice says so, and says to update the extension first
//! when the release speaks a newer protocol than a recently seen paired Client (the skew guard).
//!
//! What the notice tells the user to run depends on the host: `inkup update` or `brew upgrade inkup` for the CLI
//! (`inkup`'s update.rs), the cask or the DMG for the desktop app. So the caller words it (`spawn_check`'s `notice`).

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
pub use axoupdater::Version;
use axoupdater::{AxoUpdater, AxoupdateError, ReleaseSource, ReleaseSourceType};
use inkup_store::{Client, Store};
use tokio::sync::watch;

pub const APP_NAME: &str = "inkup";
pub const REPO_OWNER: &str = "liatrio-labs";
pub const REPO_NAME: &str = "inkup";
/// Set (to anything but `0`) to skip the daily check.
pub const NO_CHECK_ENV: &str = "INKUP_NO_UPDATE_CHECK";
/// When the daily check last ran and what it found, in the data dir.
pub const CACHE_FILE: &str = "update-check.json";
pub const DAY: u64 = 24 * 60 * 60;
/// The background check gives up after this; it tries again next start.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// The release asset holding the release's `PROTOCOL_VERSION` (dist's `extra-artifacts` in the inkup crate's
/// Cargo.toml).
const PROTOCOL_ASSET: &str = "protocol-version.txt";
/// A Client seen within this long counts for the skew guard; one unseen for longer is likely gone.
const RECENT_MS: i64 = 30 * DAY as i64 * 1000;

/// Whether the daily check may run: only for a person (the CLI at a terminal; the desktop app always has one), not
/// in CI, and not when opted out.
pub fn check_allowed(person: bool, env: impl Fn(&str) -> Option<String>) -> bool {
    let set = |name: &str| env(name).is_some_and(|v| !v.is_empty() && v != "0");
    person && !set("CI") && !set(NO_CHECK_ENV)
}

/// Whether a check last run at `last` (Unix seconds) is a day old at `now`. A clock that went back counts as due.
pub fn is_due(last: Option<u64>, now: u64) -> bool {
    last.is_none_or(|last| now < last || now - last >= DAY)
}

/// What the last check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    /// Unix seconds.
    pub at: u64,
    /// The newest inkup release, or none when none is published.
    pub latest: Option<String>,
    /// The protocol version `latest` speaks, when it is newer than this copy and publishes one.
    pub protocol: Option<i64>,
}

pub fn read_cache(dir: &Path) -> Option<Checked> {
    let text = std::fs::read_to_string(dir.join(CACHE_FILE)).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(Checked {
        at: json.get("checked_at")?.as_u64()?,
        latest: json.get("latest").and_then(|v| v.as_str()).map(str::to_owned),
        protocol: json.get("protocol").and_then(serde_json::Value::as_i64),
    })
}

pub fn write_cache(dir: &Path, checked: &Checked) -> Result<()> {
    let json = serde_json::json!({ "checked_at": checked.at, "latest": checked.latest, "protocol": checked.protocol });
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(CACHE_FILE), format!("{json}\n"))?;
    Ok(())
}

/// This copy's version: the host's, which the desktop app embeds and is versioned by.
pub fn current_version() -> Version {
    env!("CARGO_PKG_VERSION").parse().expect("the crate version is semver")
}

/// Unix seconds.
pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// axoupdater, pointed at this repo's GitHub releases.
pub fn updater() -> AxoUpdater {
    let mut updater = AxoUpdater::new_for(APP_NAME);
    updater.set_release_source(ReleaseSource {
        release_type: ReleaseSourceType::GitHub,
        owner: REPO_OWNER.into(),
        name: REPO_NAME.into(),
        app_name: APP_NAME.into(),
    });
    updater
}

/// The newest stable `inkup-v*` release on GitHub, or `None` when none is published. Extension releases
/// (`inkup-extension-v*`, and `inkup-chrome-v*` or `inkup-firefox-v*` for one store) have no inkup installer, so
/// axoupdater skips them.
pub async fn latest_release() -> Result<Option<Version>> {
    let mut updater = updater();
    updater.set_current_version(current_version())?;
    match updater.query_new_version().await {
        Ok(version) => Ok(version.cloned()),
        Err(AxoupdateError::NoStableReleases { .. }) => Ok(None),
        Err(error) => Err(error).context("look up inkup releases on GitHub"),
    }
}

/// `latest` if it is newer than this copy.
pub fn newer(latest: Option<&str>) -> Option<Version> {
    latest.and_then(|v| v.parse::<Version>().ok()).filter(|v| *v > current_version())
}

/// The GitHub API axoupdater asks: `INKUP_INSTALLER_GHE_BASE_URL` or `INKUP_INSTALLER_GITHUB_BASE_URL` when set (the
/// updater tests point one at a stub), else api.github.com.
fn github_api() -> Result<String> {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    if let Some(base) = env("INKUP_INSTALLER_GHE_BASE_URL") {
        return Ok(reqwest::Url::parse(&base)?.join("api/v3")?.to_string());
    }
    if let Some(base) = env("INKUP_INSTALLER_GITHUB_BASE_URL") {
        let url = reqwest::Url::parse(&base)?;
        let domain = url.domain().context("INKUP_INSTALLER_GITHUB_BASE_URL has no domain")?;
        let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
        return Ok(format!("{}://api.{domain}{port}", url.scheme()));
    }
    Ok("https://api.github.com".into())
}

/// Where a GitHub release (the API's JSON) keeps its protocol version, if it publishes one.
fn protocol_asset_url(release: &serde_json::Value) -> Option<&str> {
    release["assets"]
        .as_array()?
        .iter()
        .find(|asset| asset["name"] == PROTOCOL_ASSET)
        .and_then(|asset| asset["browser_download_url"].as_str())
}

/// The protocol version in a `protocol-version.txt`.
fn parse_protocol(text: &str) -> Option<i64> {
    text.trim().parse().ok().filter(|v| *v > 0)
}

/// The protocol version the `inkup-v<version>` release publishes, or `None` for a release without one (every
/// release before the skew guard).
pub async fn release_protocol(version: &Version) -> Result<Option<i64>> {
    let http = reqwest::Client::builder()
        .user_agent(concat!("inkup/", env!("CARGO_PKG_VERSION")))
        .timeout(CHECK_TIMEOUT)
        .build()?;
    let url = format!("{}/repos/{REPO_OWNER}/{REPO_NAME}/releases/tags/{APP_NAME}-v{version}", github_api()?);
    let release: serde_json::Value = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let Some(asset) = protocol_asset_url(&release) else { return Ok(None) };
    let text = http.get(asset).send().await?.error_for_status()?.text().await?;
    parse_protocol(&text).map(Some).with_context(|| format!("{PROTOCOL_ASSET} holds {:?}", text.trim()))
}

/// The protocol versions recently seen paired Clients last spoke. Empty with no store yet, or one this copy cannot
/// read.
pub fn spoken_protocols(dir: &Path) -> Vec<(Client, i64)> {
    if !dir.join(inkup_store::DB_FILE).exists() {
        return Vec::new();
    }
    let since = i64::try_from(now()).unwrap_or(i64::MAX).saturating_mul(1000) - RECENT_MS;
    match Store::open(dir).and_then(|store| store.client_protocol_versions(since)) {
        Ok(spoken) => spoken,
        Err(error) => {
            tracing::debug!(%error, "could not read the paired Clients' protocol versions");
            Vec::new()
        }
    }
}

/// A release that speaks a newer protocol than some paired Clients: installing it locks them out until their
/// extension is updated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skew {
    /// The release's protocol version.
    pub release: i64,
    /// The Clients behind it: name, kind and the version each last spoke, lowest first.
    pub behind: Vec<(String, String, i64)>,
}

impl Skew {
    /// The notice's middle, before what to run: `, on protocol 2: update the extension first (Chrome behind),`.
    pub fn clause(&self) -> String {
        let names: Vec<&str> = self.behind.iter().map(|(name, ..)| name.as_str()).collect();
        format!(", on protocol {}: update the extension first ({} behind),", self.release, names.join(", "))
    }
}

/// The skew between a release's protocol version and what the paired Clients last spoke. `None` when the release
/// publishes no version, when no Client is paired, or when none is behind.
pub fn skew(release: Option<i64>, spoken: &[(Client, i64)]) -> Option<Skew> {
    let release = release?;
    let behind: Vec<_> = spoken
        .iter()
        .filter(|(_, v)| *v < release)
        .map(|(client, v)| (client.name.clone(), client.kind.clone(), *v))
        .collect();
    (!behind.is_empty()).then_some(Skew { release, behind })
}

/// A release newer than this copy, as the daily check found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub latest: Version,
    /// Set when it speaks a newer protocol than a recently seen paired Client.
    pub skew: Option<Skew>,
}

/// Starts the daily check in the background and returns at once. The receiver holds the host's notice, as
/// `notice` words it (on a blocking thread, with the data dir), once a newer release is known: from the cache, or
/// from GitHub when the cache is a day old. Not `allowed`, offline, or on any error, it stays `None` and nothing is
/// written, so the next start tries again. Call it inside a Tokio runtime.
pub fn spawn_check(
    dir: &Path,
    allowed: bool,
    notice: impl FnOnce(&Path, &Found) -> String + Send + 'static,
) -> watch::Receiver<Option<String>> {
    let (tx, rx) = watch::channel(None);
    if !allowed {
        return rx;
    }
    let dir = dir.to_path_buf();
    tokio::spawn(async move {
        let cached = read_cache(&dir);
        let (latest, protocol) = match cached {
            Some(cached) if !is_due(Some(cached.at), now()) => (cached.latest, cached.protocol),
            _ => match tokio::time::timeout(CHECK_TIMEOUT, latest_release()).await {
                Ok(Ok(latest)) => {
                    // Only a release this copy would update to needs its protocol version.
                    let protocol = match latest.as_ref().filter(|v| **v > current_version()) {
                        Some(version) => release_protocol(version).await.unwrap_or_else(|error| {
                            tracing::debug!(error = format!("{error:#}"), "could not read the release's protocol");
                            None
                        }),
                        None => None,
                    };
                    let latest = latest.map(|v| v.to_string());
                    if let Err(error) = write_cache(&dir, &Checked { at: now(), latest: latest.clone(), protocol }) {
                        tracing::debug!(%error, "could not save the update check");
                    }
                    (latest, protocol)
                }
                Ok(Err(error)) => {
                    tracing::debug!(error = format!("{error:#}"), "update check failed");
                    return;
                }
                Err(_) => {
                    tracing::debug!("update check timed out");
                    return;
                }
            },
        };
        if let Some(latest) = newer(latest.as_deref()) {
            let worded = tokio::task::spawn_blocking(move || {
                let found = Found { latest, skew: skew(protocol, &spoken_protocols(&dir)) };
                notice(&dir, &found)
            })
            .await;
            if let Ok(worded) = worded {
                let _ = tx.send(Some(worded));
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_runs_only_for_a_person_outside_ci_and_not_opted_out() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned())
        };
        assert!(check_allowed(true, env(&[])));
        assert!(!check_allowed(false, env(&[])), "not a terminal");
        assert!(!check_allowed(true, env(&[("CI", "true")])));
        assert!(!check_allowed(true, env(&[(NO_CHECK_ENV, "1")])));
        assert!(check_allowed(true, env(&[(NO_CHECK_ENV, "0"), ("CI", "")])), "0 and empty mean not set");
    }

    #[test]
    fn the_check_runs_at_most_once_a_day() {
        let t = 1_790_000_000;
        assert!(is_due(None, t), "never checked");
        assert!(!is_due(Some(t), t + 60));
        assert!(!is_due(Some(t), t + DAY - 1));
        assert!(is_due(Some(t), t + DAY));
        assert!(is_due(Some(t), t - 10), "the clock went back");
    }

    #[test]
    fn the_cache_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_cache(dir.path()), None);
        for (latest, protocol) in [(Some("0.2.0".to_owned()), Some(2)), (Some("0.2.0".to_owned()), None), (None, None)]
        {
            let checked = Checked { at: 1_790_000_000, latest, protocol };
            write_cache(dir.path(), &checked).unwrap();
            assert_eq!(read_cache(dir.path()), Some(checked));
        }
        std::fs::write(dir.path().join(CACHE_FILE), "not json").unwrap();
        assert_eq!(read_cache(dir.path()), None, "a broken cache means check again");
    }

    #[test]
    fn only_a_newer_release_counts() {
        assert_eq!(newer(Some("0.0.1")), None);
        assert_eq!(newer(Some("not a version")), None);
        assert_eq!(newer(Some("99.0.0")), Some("99.0.0".parse().unwrap()));
    }

    fn client(name: &str, kind: &str) -> Client {
        Client { id: format!("c-{name}"), kind: kind.into(), name: name.into(), created_at: 0, last_seen_at: Some(0) }
    }

    #[test]
    fn a_release_on_a_newer_protocol_than_a_paired_client_is_a_skew() {
        let spoken = [(client("Firefox", "firefox"), 1), (client("Chrome", "chrome"), 2)];
        assert_eq!(
            skew(Some(2), &spoken),
            Some(Skew { release: 2, behind: vec![("Firefox".into(), "firefox".into(), 1)] })
        );
        assert_eq!(
            skew(Some(3), &spoken).map(|s| s.behind.len()),
            Some(2),
            "every Client behind is named, not only the lowest"
        );
        assert_eq!(skew(Some(2), &spoken[1..]), None, "the same version");
        assert_eq!(skew(Some(1), &spoken), None, "an older release: the host still speaks what the Clients speak");
        assert_eq!(skew(Some(2), &[]), None, "no paired Clients");
        assert_eq!(skew(None, &spoken), None, "a release without a protocol version is not guarded");
    }

    #[test]
    fn a_release_without_the_protocol_asset_publishes_no_version() {
        let with = serde_json::json!({ "assets": [
            { "name": "inkup-installer.sh", "browser_download_url": "https://x/inkup-installer.sh" },
            { "name": "protocol-version.txt", "browser_download_url": "https://x/protocol-version.txt" },
        ]});
        assert_eq!(protocol_asset_url(&with), Some("https://x/protocol-version.txt"));
        let without = serde_json::json!({ "assets": [{ "name": "inkup-installer.sh", "browser_download_url": "u" }] });
        assert_eq!(protocol_asset_url(&without), None);
        assert_eq!(protocol_asset_url(&serde_json::json!({})), None);
        assert_eq!(parse_protocol("2\n"), Some(2));
        assert_eq!(parse_protocol(" 1 "), Some(1));
        assert_eq!(parse_protocol("two"), None);
        assert_eq!(parse_protocol("0"), None);
    }

    /// A fresh cache is the day's answer: the notice comes from it without asking GitHub.
    #[tokio::test]
    async fn a_fresh_cache_gives_the_notice_without_asking_github() {
        let dir = tempfile::tempdir().unwrap();
        write_cache(dir.path(), &Checked { at: now(), latest: Some("99.0.0".into()), protocol: None }).unwrap();
        let mut rx = spawn_check(dir.path(), true, |_, found| format!("{} is out", found.latest));
        rx.wait_for(Option::is_some).await.unwrap();
        assert_eq!(rx.borrow().as_deref(), Some("99.0.0 is out"));

        let off = spawn_check(dir.path(), false, |_, _| unreachable!("not allowed"));
        tokio::task::yield_now().await;
        assert_eq!(*off.borrow(), None);
    }
}
