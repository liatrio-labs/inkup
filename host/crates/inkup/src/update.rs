//! Updates (ADR 0008): the daily check behind the TUI's notice, and `inkup update`.
//!
//! How inkup was installed decides how it updates:
//! - by the shell or PowerShell installer (it wrote an install receipt): axoupdater runs the new release's installer
//!   over this copy;
//! - by Homebrew (the binary lives in a Homebrew Cellar): the user chooses once, in config.toml's `[update]`, between
//!   leaving it to `brew upgrade inkup` and updating anyway, which installs a second copy where the installer puts it;
//! - any other way (`cargo install`, a dev build): it says a release exists and how to install it.

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use axoupdater::{AxoUpdater, AxoupdateError, ReleaseSource, ReleaseSourceType, Version};
use clap::{Args, ValueEnum};
use inkup_store::HostConfig;
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

#[derive(Args)]
pub struct UpdateArgs {
    /// Only say whether a newer release exists, and how to get it.
    #[arg(long)]
    check: bool,
    /// For a Homebrew install: leave updating to `brew upgrade` (brew), update inkup itself anyway (self), or ask
    /// again next time (ask). Saved in config.toml.
    #[arg(long, value_name = "CHOICE")]
    homebrew: Option<HomebrewArg>,
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
}

pub fn read_cache(dir: &Path) -> Option<Checked> {
    let text = std::fs::read_to_string(dir.join(CACHE_FILE)).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(Checked {
        at: json.get("checked_at")?.as_u64()?,
        latest: json.get("latest").and_then(|v| v.as_str()).map(str::to_owned),
    })
}

pub fn write_cache(dir: &Path, checked: &Checked) -> Result<()> {
    let json = serde_json::json!({ "checked_at": checked.at, "latest": checked.latest });
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

/// One line for the TUI: the newer release and what to run.
fn notice(latest: &Version, install: &Install, choice: Option<HomebrewChoice>) -> String {
    let run = match (install, choice) {
        (Install::Homebrew { .. }, None | Some(HomebrewChoice::Brew)) => "brew upgrade inkup",
        _ => "inkup update",
    };
    format!("inkup {latest} is out: {run}")
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
        let latest = match cached {
            Some(cached) if !is_due(Some(cached.at), now()) => cached.latest,
            _ => match tokio::time::timeout(CHECK_TIMEOUT, latest_release()).await {
                Ok(Ok(latest)) => {
                    let latest = latest.map(|v| v.to_string());
                    if let Err(error) = write_cache(&dir, &Checked { at: now(), latest: latest.clone() }) {
                        tracing::debug!(%error, "could not save the update check");
                    }
                    latest
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
            let _ = tx.send(Some(notice(&latest, &install, choice)));
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
    let _ = write_cache(&dir, &Checked { at: now(), latest: latest.as_ref().map(ToString::to_string) });
    let Some(latest) = latest.clone().filter(|latest| *latest > current) else {
        match latest {
            None => println!("inkup {current}: no inkup release is published yet."),
            Some(_) => println!("inkup {current} is up to date."),
        }
        return Ok(());
    };
    println!("inkup {latest} is out; this is {current}.");

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
        for latest in [Some("0.2.0".to_owned()), None] {
            let checked = Checked { at: 1_790_000_000, latest };
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
    }

    #[test]
    fn the_notice_names_what_to_run() {
        let v: Version = "0.2.0".parse().unwrap();
        let brew = Install::Homebrew { prefix: p("/opt/homebrew") };
        assert_eq!(notice(&v, &Install::Installer, None), "inkup 0.2.0 is out: inkup update");
        assert_eq!(notice(&v, &brew, None), "inkup 0.2.0 is out: brew upgrade inkup");
        assert_eq!(notice(&v, &brew, Some(HomebrewChoice::SelfUpdate)), "inkup 0.2.0 is out: inkup update");
        assert_eq!(newer(Some("0.0.1")), None);
        assert_eq!(newer(Some("not a version")), None);
        assert_eq!(newer(Some("99.0.0")), Some("99.0.0".parse().unwrap()));
    }
}
