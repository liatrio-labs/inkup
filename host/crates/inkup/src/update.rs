//! Updates (ADR 0008): the daily check behind the TUI's notice, and `inkup update`.
//!
//! How inkup was installed decides how it updates:
//! - by the shell or PowerShell installer (it wrote an install receipt): axoupdater runs the new release's installer
//!   over this copy;
//! - by Homebrew (the binary lives in a Homebrew Cellar): the user chooses once, in config.toml's `[update]`, between
//!   leaving it to `brew upgrade inkup` and updating anyway, which installs a second copy where the installer puts it;
//! - any other way (`cargo install`, a dev build): it says a release exists and how to install it.
//!
//! Before any of those, the skew guard: each release carries its protocol version as a `protocol-version.txt` asset,
//! and when it is newer than what a recently seen paired Client last spoke in `hello`, `inkup update` names those
//! Clients and asks before going on (`--yes` goes on with the warning printed). A release without the asset is not
//! guarded. The daily check's notice says so too.

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use axoupdater::{AxoUpdater, AxoupdateError, ReleaseSource, ReleaseSourceType, Version};
use clap::{Args, ValueEnum};
use inkup_store::{Client, HostConfig, Store};
use tokio::sync::watch;
use toml_edit::{DocumentMut, Item, Table, value};

const APP_NAME: &str = "inkup";
const REPO_OWNER: &str = "liatrio-labs";
const REPO_NAME: &str = "inkup";
/// Set (to anything but `0`) to skip the daily check.
pub const NO_CHECK_ENV: &str = "INKUP_NO_UPDATE_CHECK";
/// When the daily check last ran and what it found, in the data dir.
const CACHE_FILE: &str = "update-check.json";
const DAY: u64 = 24 * 60 * 60;
/// The background check gives up after this; it tries again next start.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const INSTALLER: &str = "https://github.com/liatrio-labs/inkup/releases/latest/download/inkup-installer";
/// The release asset holding the release's `PROTOCOL_VERSION` (dist's `extra-artifacts` in the crate's Cargo.toml).
const PROTOCOL_ASSET: &str = "protocol-version.txt";
/// A Client seen within this long counts for the skew guard; one unseen for longer is likely gone.
const RECENT_MS: i64 = 30 * DAY as i64 * 1000;

#[derive(Args)]
pub struct UpdateArgs {
    /// Only say whether a newer release exists, and how to get it.
    #[arg(long)]
    check: bool,
    /// For a Homebrew install: leave updating to `brew upgrade` (brew), update inkup itself anyway (self), or ask
    /// again next time (ask). Saved in config.toml.
    #[arg(long, value_name = "CHOICE")]
    homebrew: Option<HomebrewArg>,
    /// Update without asking, even when the release speaks a newer protocol than a paired extension.
    #[arg(long, short)]
    yes: bool,
    #[arg(long, env = "INKUP_DATA_DIR")]
    data_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, ValueEnum)]
enum HomebrewArg {
    Brew,
    #[value(name = "self")]
    SelfUpdate,
    Ask,
}

/// What to do with an update when Homebrew installed inkup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomebrewChoice {
    /// Leave it to `brew upgrade inkup`.
    Brew,
    /// Install the release with its installer anyway, next to Homebrew's copy.
    SelfUpdate,
}

impl HomebrewChoice {
    fn as_str(self) -> &'static str {
        match self {
            Self::Brew => "brew",
            Self::SelfUpdate => "self",
        }
    }
}

/// How this copy of inkup was installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// By the shell or PowerShell installer, whose receipt names this executable's directory.
    Installer,
    /// By Homebrew, under this prefix (`/opt/homebrew`, `/usr/local`, `/home/linuxbrew/.linuxbrew`).
    Homebrew { prefix: PathBuf },
    /// Some other way: `cargo install`, a dev build, a copied binary.
    Other,
}

/// The Homebrew prefix `exe` (a canonical path) was installed under, if any. Homebrew keeps each formula at
/// `<prefix>/Cellar/<formula>/<version>/` and links `<prefix>/bin/inkup` to it, so the canonical path runs through
/// `Cellar/inkup`. `cellar` is `$HOMEBREW_CELLAR`, for a Cellar that is not `<prefix>/Cellar`.
pub fn homebrew_prefix(exe: &Path, cellar: Option<&Path>) -> Option<PathBuf> {
    if let Some(cellar) = cellar.filter(|c| c.is_absolute())
        && exe.strip_prefix(cellar).is_ok_and(|rest| rest.starts_with(APP_NAME))
    {
        return Some(cellar.parent().unwrap_or(cellar).to_path_buf());
    }
    let parts: Vec<Component> = exe.components().collect();
    let at = parts.windows(2).rposition(|w| w[0].as_os_str() == "Cellar" && w[1].as_os_str() == APP_NAME)?;
    Some(parts[..at].iter().collect())
}

/// How this process's executable was installed.
pub fn detect() -> Install {
    let exe = std::env::current_exe().and_then(|p| p.canonicalize());
    let cellar = std::env::var_os("HOMEBREW_CELLAR").map(PathBuf::from);
    if let Some(prefix) = exe.as_deref().ok().and_then(|exe| homebrew_prefix(exe, cellar.as_deref())) {
        return Install::Homebrew { prefix };
    }
    let mut updater = AxoUpdater::new_for(APP_NAME);
    if updater.load_receipt().is_ok() && updater.check_receipt_is_for_this_executable().unwrap_or(false) {
        Install::Installer
    } else {
        Install::Other
    }
}

/// Whether the daily check may run: only for a person at a terminal, not in CI, and not when opted out.
pub fn check_allowed(stdout_is_terminal: bool, env: impl Fn(&str) -> Option<String>) -> bool {
    let set = |name: &str| env(name).is_some_and(|v| !v.is_empty() && v != "0");
    stdout_is_terminal && !set("CI") && !set(NO_CHECK_ENV)
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

/// The Homebrew choice saved in config.toml's `[update]` table, if the user made one.
pub fn load_choice(dir: &Path) -> Result<Option<HomebrewChoice>> {
    let doc = read_config(dir)?;
    Ok(match doc.get("update").and_then(|u| u.get("homebrew")).and_then(|v| v.as_str()) {
        Some("brew") => Some(HomebrewChoice::Brew),
        Some("self") => Some(HomebrewChoice::SelfUpdate),
        _ => None,
    })
}

/// Saves the Homebrew choice, or clears it (`None`: ask again). Keeps the rest of the file as it was.
pub fn save_choice(dir: &Path, choice: Option<HomebrewChoice>) -> Result<()> {
    // Creates config.toml, with its header, when it is not there yet.
    HostConfig::load(dir)?;
    let mut doc = read_config(dir)?;
    if !doc.contains_table("update") {
        let mut table = Table::new();
        table.decor_mut().set_prefix(
            "\n# Updates. homebrew = \"brew\" leaves a Homebrew install to `brew upgrade inkup`; \"self\" has\n\
             # `inkup update` install over it anyway. Change it with `inkup update --homebrew brew|self|ask`.\n",
        );
        doc.insert("update", Item::Table(table));
    }
    match choice {
        Some(choice) => doc["update"]["homebrew"] = value(choice.as_str()),
        None => {
            if let Some(table) = doc["update"].as_table_mut() {
                table.remove("homebrew");
            }
        }
    }
    let path = dir.join(inkup_store::CONFIG_FILE);
    let tmp = dir.join(format!("{}.tmp", inkup_store::CONFIG_FILE));
    std::fs::write(&tmp, doc.to_string())?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn read_config(dir: &Path) -> Result<DocumentMut> {
    let text = match std::fs::read_to_string(dir.join(inkup_store::CONFIG_FILE)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    text.parse().context("parse config.toml")
}

fn current_version() -> Version {
    env!("CARGO_PKG_VERSION").parse().expect("the crate version is semver")
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn updater() -> AxoUpdater {
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
/// (`inkup-chrome-v*`, `inkup-firefox-v*`) have no inkup installer, so axoupdater skips them.
async fn latest_release() -> Result<Option<Version>> {
    let mut updater = updater();
    updater.set_current_version(current_version())?;
    match updater.query_new_version().await {
        Ok(version) => Ok(version.cloned()),
        Err(AxoupdateError::NoStableReleases { .. }) => Ok(None),
        Err(error) => Err(error).context("look up inkup releases on GitHub"),
    }
}

/// `latest` if it is newer than this copy.
fn newer(latest: Option<&str>) -> Option<Version> {
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
async fn release_protocol(version: &Version) -> Result<Option<i64>> {
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
fn spoken_protocols(dir: &Path) -> Vec<(Client, i64)> {
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

/// The skew guard's warning, one line per line.
fn skew_warning(latest: &Version, skew: &Skew) -> Vec<String> {
    let mut lines = vec![format!(
        "Warning: inkup {latest} speaks protocol {}. These paired Clients last spoke an older one, and cannot connect \
         to it until their extension is updated:",
        skew.release
    )];
    lines.extend(skew.behind.iter().map(|(name, kind, v)| format!("  {name} ({kind}, protocol {v})")));
    lines.push(
        "Update the extension first (from its store, or chrome://extensions / about:addons), then update inkup.".into(),
    );
    lines
}

/// Asks whether to update anyway. Anything but yes, or no answer, is no.
fn confirm(input: &mut impl BufRead) -> Result<bool> {
    print!("Update inkup anyway? [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    input.read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

/// One line for the TUI: the newer release and what to run.
fn notice(latest: &Version, install: &Install, choice: Option<HomebrewChoice>, skew: Option<&Skew>) -> String {
    let run = match (install, choice) {
        (Install::Homebrew { .. }, None | Some(HomebrewChoice::Brew)) => "brew upgrade inkup",
        _ => "inkup update",
    };
    match skew {
        None => format!("inkup {latest} is out: {run}"),
        Some(skew) => format!(
            "inkup {latest} is out, on protocol {}: update the extension first ({} behind), then {run}",
            skew.release,
            skew.behind.iter().map(|(name, ..)| name.as_str()).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// Starts the daily check in the background and returns at once. The receiver holds the TUI's notice once a newer
/// release is known (from the cache, or from GitHub when the cache is a day old). Offline, or on any error, it stays
/// `None` and nothing is written, so the next start tries again.
pub fn spawn_check(dir: &Path) -> watch::Receiver<Option<String>> {
    let (tx, rx) = watch::channel(None);
    if !check_allowed(std::io::stdout().is_terminal(), |name| std::env::var(name).ok()) {
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
            let install = tokio::task::spawn_blocking(detect).await.unwrap_or(Install::Other);
            let choice = load_choice(&dir).ok().flatten();
            let spoken = {
                let dir = dir.clone();
                tokio::task::spawn_blocking(move || spoken_protocols(&dir)).await.unwrap_or_default()
            };
            let _ = tx.send(Some(notice(&latest, &install, choice, skew(protocol, &spoken).as_ref())));
        }
    });
    rx
}

/// `inkup update`.
pub async fn run(args: UpdateArgs) -> Result<()> {
    let dir = match args.data_dir {
        Some(dir) => dir,
        None => inkup_store::default_data_dir().context("no home directory; pass --data-dir")?,
    };
    if let Some(homebrew) = args.homebrew {
        let choice = match homebrew {
            HomebrewArg::Brew => Some(HomebrewChoice::Brew),
            HomebrewArg::SelfUpdate => Some(HomebrewChoice::SelfUpdate),
            HomebrewArg::Ask => None,
        };
        save_choice(&dir, choice)?;
        println!("{}", describe_choice(choice));
        return Ok(());
    }

    let current = current_version();
    let latest = latest_release().await?;
    let Some(latest) = latest.clone().filter(|latest| *latest > current) else {
        let _ =
            write_cache(&dir, &Checked { at: now(), latest: latest.as_ref().map(ToString::to_string), protocol: None });
        match latest {
            None => println!("inkup {current}: no inkup release is published yet."),
            Some(_) => println!("inkup {current} is up to date."),
        }
        return Ok(());
    };
    println!("inkup {latest} is out; this is {current}.");

    // The skew guard, before any install path. A release without a protocol version is not guarded.
    let protocol = release_protocol(&latest).await.unwrap_or_else(|error| {
        println!("(Could not read inkup {latest}'s protocol version, so the extensions are not checked: {error:#})");
        None
    });
    let _ = write_cache(&dir, &Checked { at: now(), latest: Some(latest.to_string()), protocol });
    if let Some(skew) = skew(protocol, &spoken_protocols(&dir)) {
        for line in skew_warning(&latest, &skew) {
            println!("{line}");
        }
        if args.yes {
            println!("--yes: updating anyway.");
        } else if !args.check && !confirm(&mut std::io::stdin().lock())? {
            println!("Not updated.");
            return Ok(());
        }
    }

    let install = detect();
    match &install {
        Install::Installer if args.check => println!("Run `inkup update` to install it."),
        Install::Installer => update_in_place().await?,
        Install::Homebrew { prefix } => {
            let choice = match load_choice(&dir)? {
                Some(choice) => Some(choice),
                None if !args.check && std::io::stdin().is_terminal() => {
                    let choice = ask_homebrew_choice(prefix)?;
                    save_choice(&dir, Some(choice))?;
                    println!("{}", describe_choice(Some(choice)));
                    Some(choice)
                }
                None => None,
            };
            match choice {
                Some(HomebrewChoice::SelfUpdate) if !args.check => update_over_homebrew(prefix).await?,
                Some(HomebrewChoice::SelfUpdate) => {
                    println!("Run `inkup update` to install it next to Homebrew's copy (you chose to).")
                }
                _ => {
                    println!("inkup was installed with Homebrew: run `brew upgrade inkup`.");
                    println!("(To have inkup update itself instead: inkup update --homebrew self)");
                }
            }
        }
        Install::Other => {
            println!("This copy was not installed by the inkup installer (cargo install, or a dev build),");
            println!("so it does not update itself. Install the release with one of:");
            println!("  curl --proto '=https' --tlsv1.2 -LsSf {INSTALLER}.sh | sh");
            println!("  powershell -ExecutionPolicy Bypass -c \"irm {INSTALLER}.ps1 | iex\"");
            println!("  brew install {REPO_OWNER}/tap/inkup");
        }
    }
    Ok(())
}

fn describe_choice(choice: Option<HomebrewChoice>) -> &'static str {
    match choice {
        Some(HomebrewChoice::Brew) => "Saved: a Homebrew install is left to `brew upgrade inkup`.",
        Some(HomebrewChoice::SelfUpdate) => "Saved: `inkup update` installs over a Homebrew install anyway.",
        None => "Saved: `inkup update` asks what to do with a Homebrew install.",
    }
}

fn ask_homebrew_choice(prefix: &Path) -> Result<HomebrewChoice> {
    let target = installer_dir().map_or_else(|| "~/.cargo/bin".into(), |d| d.join("bin").display().to_string());
    println!("inkup was installed with Homebrew ({}). How should it update?", prefix.display());
    println!("  b  leave it to Homebrew: run `brew upgrade inkup` (recommended)");
    println!("  s  update itself anyway: installs a second copy in {target}, which Homebrew does not track");
    loop {
        print!("[b/s] ");
        std::io::stdout().flush()?;
        let mut answer = String::new();
        if std::io::stdin().lock().read_line(&mut answer)? == 0 {
            bail!("no answer");
        }
        match answer.trim().to_ascii_lowercase().as_str() {
            "b" | "brew" => return Ok(HomebrewChoice::Brew),
            "s" | "self" => return Ok(HomebrewChoice::SelfUpdate),
            _ => {}
        }
    }
}

/// Runs the new release's installer over this copy, where the receipt says it was installed.
async fn update_in_place() -> Result<()> {
    let mut updater = updater();
    updater.load_receipt().context("read the install receipt")?;
    match updater.run().await.context("install the new release")? {
        Some(result) => println!("Updated to inkup {} in {}.", result.new_version, result.install_prefix),
        None => println!("Nothing to update."),
    }
    Ok(())
}

/// The installer's default install dir: `$CARGO_HOME`, else `~/.cargo` (dist's `CARGO_HOME` install path).
fn installer_dir() -> Option<PathBuf> {
    std::env::var_os("CARGO_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| directories::BaseDirs::new().map(|d| d.home_dir().join(".cargo")))
}

/// The user chose to update a Homebrew install anyway. Homebrew's files are Homebrew's, so this does not touch
/// them: the installer puts the release in `~/.cargo/bin` (and writes a receipt), and whichever `inkup` comes first
/// on PATH is the one that runs.
async fn update_over_homebrew(prefix: &Path) -> Result<()> {
    let dir = installer_dir().context("no home directory to install into")?;
    let brew_bin = prefix.join("bin").join(APP_NAME);
    let new_bin = dir.join("bin").join(format!("{APP_NAME}{}", std::env::consts::EXE_SUFFIX));
    println!("Installing into {}. Homebrew's copy at {} stays, and", dir.join("bin").display(), brew_bin.display());
    println!("`brew upgrade` keeps updating it; whichever comes first on PATH runs.");
    let mut updater = updater();
    updater.set_current_version(current_version())?;
    updater.set_install_dir(dir.to_string_lossy().into_owned());
    // The receipt check would refuse: this executable is Homebrew's, not in the install dir.
    updater.always_update(true);
    let result = updater.run().await.context("install the new release")?;
    if let Some(result) = result {
        println!("Installed inkup {} in {}.", result.new_version, result.install_prefix);
    }
    match first_on_path(APP_NAME) {
        Some(first) if same_file(&first, &new_bin) => {
            println!("`inkup` now runs the new copy. Remove Homebrew's so there is one: brew uninstall inkup")
        }
        first => {
            let first = first.map_or_else(|| "nothing".into(), |p| p.display().to_string());
            println!("`inkup` on PATH is still {first}, so it runs the old version.");
            println!(
                "Remove Homebrew's copy (brew uninstall inkup), or put {} first on PATH.",
                dir.join("bin").display()
            );
        }
    }
    Ok(())
}

fn first_on_path(name: &str) -> Option<PathBuf> {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(&file)).find(|p| p.is_file())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn homebrew_installs_are_found_by_their_cellar() {
        let cases = [
            ("/opt/homebrew/Cellar/inkup/0.1.0/bin/inkup", "/opt/homebrew"), // macOS arm64
            ("/usr/local/Cellar/inkup/0.1.0/bin/inkup", "/usr/local"),       // macOS Intel
            ("/home/linuxbrew/.linuxbrew/Cellar/inkup/0.1.0/bin/inkup", "/home/linuxbrew/.linuxbrew"), // Linuxbrew
            ("/home/me/.linuxbrew/Cellar/inkup/0.2.0_1/bin/inkup", "/home/me/.linuxbrew"), // a revision, own prefix
        ];
        for (exe, prefix) in cases {
            assert_eq!(homebrew_prefix(&p(exe), None), Some(p(prefix)), "{exe}");
        }
    }

    #[test]
    fn other_installs_are_not_homebrew() {
        for exe in [
            "/Users/me/.cargo/bin/inkup",
            "/opt/homebrew/bin/inkup", // the link itself: the caller canonicalizes first
            "/opt/homebrew/Cellar/other/1.0/bin/inkup",
            "/Users/me/src/inkup/host/target/debug/inkup",
            "/Users/me/Cellar-notes/inkup/bin/inkup",
        ] {
            assert_eq!(homebrew_prefix(&p(exe), None), None, "{exe}");
        }
    }

    // Unix paths: on Windows `/data/brew-cellar` has no drive, so it is not absolute, and Homebrew does not run there.
    #[cfg(unix)]
    #[test]
    fn a_custom_homebrew_cellar_is_found_through_homebrew_cellar() {
        let exe = p("/data/brew-cellar/inkup/0.1.0/bin/inkup");
        assert_eq!(homebrew_prefix(&exe, Some(&p("/data/brew-cellar"))), Some(p("/data")));
        assert_eq!(homebrew_prefix(&exe, None), None);
        assert_eq!(homebrew_prefix(&p("/data/brew-cellar/other/1/bin/inkup"), Some(&p("/data/brew-cellar"))), None);
    }

    #[test]
    fn the_check_runs_only_at_a_terminal_outside_ci_and_not_opted_out() {
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
    fn the_homebrew_choice_is_saved_changed_and_cleared_keeping_the_rest_of_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_choice(dir.path()).unwrap(), None);
        save_choice(dir.path(), Some(HomebrewChoice::Brew)).unwrap();
        assert_eq!(load_choice(dir.path()).unwrap(), Some(HomebrewChoice::Brew));
        HostConfig::save_network(dir.path(), true).unwrap();
        save_choice(dir.path(), Some(HomebrewChoice::SelfUpdate)).unwrap();
        assert_eq!(load_choice(dir.path()).unwrap(), Some(HomebrewChoice::SelfUpdate));
        assert!(HostConfig::load(dir.path()).unwrap().network, "network mode kept");
        save_choice(dir.path(), None).unwrap();
        assert_eq!(load_choice(dir.path()).unwrap(), None);
        let text = std::fs::read_to_string(dir.path().join(inkup_store::CONFIG_FILE)).unwrap();
        assert!(text.contains("trusted networks only") && text.contains("[update]"), "{text}");
        assert!(text.starts_with("# inkup host settings.\n"), "the header stays on top: {text}");
        assert_eq!(text.matches("# inkup host settings.").count(), 1, "{text}");
    }

    #[test]
    fn the_notice_names_what_to_run() {
        let v: Version = "0.2.0".parse().unwrap();
        let brew = Install::Homebrew { prefix: p("/opt/homebrew") };
        assert_eq!(notice(&v, &Install::Installer, None, None), "inkup 0.2.0 is out: inkup update");
        assert_eq!(notice(&v, &brew, None, None), "inkup 0.2.0 is out: brew upgrade inkup");
        assert_eq!(notice(&v, &brew, Some(HomebrewChoice::SelfUpdate), None), "inkup 0.2.0 is out: inkup update");
        let skew = Skew { release: 2, behind: vec![("Chrome on MacBook".into(), "chrome".into(), 1)] };
        assert_eq!(
            notice(&v, &brew, None, Some(&skew)),
            "inkup 0.2.0 is out, on protocol 2: update the extension first (Chrome on MacBook behind), \
             then brew upgrade inkup"
        );
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

    #[test]
    fn the_warning_names_each_client_and_what_to_do() {
        let v: Version = "0.3.0".parse().unwrap();
        let skew = Skew { release: 2, behind: vec![("Chrome on MacBook".into(), "chrome".into(), 1)] };
        let text = skew_warning(&v, &skew).join("\n");
        assert!(text.contains("inkup 0.3.0 speaks protocol 2"), "{text}");
        assert!(text.contains("  Chrome on MacBook (chrome, protocol 1)"), "{text}");
        assert!(text.contains("Update the extension first"), "{text}");
    }

    #[test]
    fn only_yes_confirms() {
        for (answer, yes) in
            [("y\n", true), ("YES\n", true), ("n\n", false), ("\n", false), ("", false), ("maybe\n", false)]
        {
            assert_eq!(confirm(&mut answer.as_bytes()).unwrap(), yes, "{answer:?}");
        }
    }
}
