//! Install CLI (ADR 0025): the app bundles the `inkup` CLI at `InkUp.app/Contents/MacOS/inkup`, only to put it on
//! PATH. Installing links `/usr/local/bin/inkup` to it, so the CLI updates with the app. The app never runs it.
//!
//! The link is left alone unless it is this app's: a file, or a link to another `inkup` (Homebrew's, another copy of
//! the app), is replaced only when the person confirmed it (`replace`). A link whose target is gone (the app moved or
//! was deleted) is offered again. When `/usr/local/bin` is not writable, the change runs through macOS's
//! administrator prompt (`admin`); the functions take that runner as a parameter, so tests use a temp dir and no prompt.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// Where the link goes: on the default PATH of every macOS shell, and where Homebrew on Intel links its own.
pub const LINK: &str = "/usr/local/bin/inkup";
/// The CLI's file name, in the bundle and on PATH.
pub const NAME: &str = "inkup";
/// How long the login shell may take to say its PATH.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// Marks the PATH line in the login shell's output: its startup files may print too.
const PATH_MARK: &str = "__INKUP_PATH__";

/// What is at the link's path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LinkState {
    /// Nothing: not installed.
    None,
    /// A link to this app's CLI.
    Ours,
    /// A link to a file that is gone: the app it pointed into was moved or deleted.
    Broken { target: String },
    /// A link to another `inkup`: Homebrew's, `cargo install`'s, another copy of the app.
    Other { target: String },
    /// A file or directory, not a link: another install put it there.
    File,
}

/// What the window shows.
#[derive(Debug, Clone, Serialize)]
pub struct CliStatus {
    /// The CLI inside this app, or `None` for a build without it (a development build: scripts/desktop-cli.sh).
    pub bundled: Option<String>,
    pub link: String,
    #[serde(flatten)]
    pub state: LinkState,
    /// Every `inkup` on the login shell's PATH, in PATH order: the first is the one a terminal runs.
    pub on_path: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("this build of the app has no bundled inkup CLI")]
    NotBundled,
    #[error("{link} is not this app's ({state}); confirm to replace it")]
    NotOurs { link: String, state: String },
    #[error("{0} is not this app's link, so it was left alone")]
    NotOursToRemove(String),
    #[error("cancelled: nothing changed")]
    Cancelled,
    #[error("{what}: {error}")]
    Io { what: String, error: io::Error },
    #[error("{link} is still {state} after installing")]
    Unchanged { link: String, state: String },
}

impl LinkState {
    fn describe(&self) -> String {
        match self {
            Self::None => "not there".into(),
            Self::Ours => "this app's link".into(),
            Self::Broken { target } => format!("a link to {target}, which is gone"),
            Self::Other { target } => format!("a link to {target}"),
            Self::File => "a file, not a link".into(),
        }
    }
}

/// The CLI next to this app's executable (`Contents/MacOS/inkup`; `target/<profile>/inkup` in development), if this
/// build bundles it.
pub fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let cli = exe.parent()?.join(NAME);
    cli.is_file().then_some(cli)
}

/// What is at `link`, compared with this app's CLI at `bundled`.
pub fn link_state(link: &Path, bundled: &Path) -> LinkState {
    let Ok(meta) = link.symlink_metadata() else { return LinkState::None };
    if !meta.file_type().is_symlink() {
        return LinkState::File;
    }
    let Ok(target) = std::fs::read_link(link) else { return LinkState::File };
    // A relative target is relative to the link's directory.
    let resolved = link.parent().map_or_else(|| target.clone(), |dir| dir.join(&target));
    let shown = target.display().to_string();
    match (resolved.canonicalize(), bundled.canonicalize()) {
        (Err(_), _) => LinkState::Broken { target: shown },
        (Ok(a), Ok(b)) if a == b => LinkState::Ours,
        _ => LinkState::Other { target: shown },
    }
}

/// Links `link` to `bundled`. Nothing to do when it already is. A file or another link is replaced only with
/// `replace`. Tries as this user first, then through `elevate` (macOS's administrator prompt) when the directory is
/// not writable or not there.
pub fn install(
    link: &Path,
    bundled: &Path,
    replace: bool,
    elevate: impl FnOnce(&str) -> Result<(), CliError>,
) -> Result<LinkState, CliError> {
    let state = link_state(link, bundled);
    match state {
        LinkState::Ours => return Ok(state),
        LinkState::Other { .. } | LinkState::File if !replace => {
            return Err(CliError::NotOurs { link: link.display().to_string(), state: state.describe() });
        }
        _ => {}
    }
    if state == LinkState::File && link.is_dir() {
        // `ln -sf` would put the link inside it.
        return Err(CliError::Io {
            what: format!("replace {}", link.display()),
            error: io::Error::other("it is a directory"),
        });
    }
    match link_as_user(link, bundled) {
        Ok(()) => {}
        Err(error) if needs_admin(&error) => {
            let dir = link.parent().unwrap_or(Path::new("/"));
            elevate(&format!("mkdir -p {} && ln -sf {} {}", sh(dir), sh(bundled), sh(link)))?;
        }
        Err(error) => return Err(CliError::Io { what: format!("link {}", link.display()), error }),
    }
    match link_state(link, bundled) {
        LinkState::Ours => Ok(LinkState::Ours),
        other => Err(CliError::Unchanged { link: link.display().to_string(), state: other.describe() }),
    }
}

/// Removes `link` when it is this app's link, or a link whose target is gone. Anything else is left alone.
pub fn uninstall(
    link: &Path,
    bundled: &Path,
    elevate: impl FnOnce(&str) -> Result<(), CliError>,
) -> Result<LinkState, CliError> {
    match link_state(link, bundled) {
        LinkState::None => return Ok(LinkState::None),
        LinkState::Ours | LinkState::Broken { .. } => {}
        _ => return Err(CliError::NotOursToRemove(link.display().to_string())),
    }
    match std::fs::remove_file(link) {
        Ok(()) => {}
        Err(error) if needs_admin(&error) => elevate(&format!("rm -f {}", sh(link)))?,
        Err(error) => return Err(CliError::Io { what: format!("remove {}", link.display()), error }),
    }
    Ok(link_state(link, bundled))
}

/// A new link beside `link`, renamed over it, so there is never a moment with no `inkup`.
fn link_as_user(link: &Path, bundled: &Path) -> io::Result<()> {
    let dir = link.parent().ok_or_else(|| io::Error::other("the link has no directory"))?;
    let temp = dir.join(format!(".{NAME}-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    std::os::unix::fs::symlink(bundled, &temp)?;
    std::fs::rename(&temp, link).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// Not writable, or not there yet: only an administrator can make `/usr/local/bin`.
fn needs_admin(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound) || error.raw_os_error() == Some(1) // EPERM
}

/// A path as one single-quoted shell word.
pub fn sh(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// The AppleScript that runs `script` as root after macOS's administrator prompt.
pub fn applescript(script: &str) -> String {
    let quoted = script.replace('\\', r"\\").replace('"', r#"\""#);
    format!(r#"do shell script "{quoted}" with administrator privileges"#)
}

/// Runs `script` with administrator privileges: macOS asks for an administrator's password first.
pub fn admin(script: &str) -> Result<(), CliError> {
    let out = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(applescript(script))
        .output()
        .map_err(|error| CliError::Io { what: "ask for an administrator's password".into(), error })?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    // -128: the person pressed Cancel.
    if stderr.contains("(-128)") {
        return Err(CliError::Cancelled);
    }
    Err(CliError::Io { what: "as administrator".into(), error: io::Error::other(stderr.trim().to_owned()) })
}

/// Every `inkup` on `path` (a PATH value), in order, each directory once.
pub fn on_path(path: &OsStr) -> Vec<PathBuf> {
    let mut seen = Vec::new();
    let mut found = Vec::new();
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() || seen.contains(&dir) {
            continue;
        }
        let cli = dir.join(NAME);
        if cli.is_file() {
            found.push(cli);
        }
        seen.push(dir);
    }
    found
}

/// The PATH a terminal gets: the login shell's (an app started from Finder has only launchd's). Falls back to this
/// process's PATH when the shell does not answer in time.
pub async fn login_path() -> std::ffi::OsString {
    let fallback = || std::env::var_os("PATH").unwrap_or_default();
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let child = tokio::process::Command::new(shell)
        .args(["-l", "-i", "-c", &format!("printf '\\n{PATH_MARK}%s\\n' \"$PATH\"")])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(out)) = tokio::time::timeout(SHELL_TIMEOUT, child).await else { return fallback() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| line.strip_prefix(PATH_MARK))
        .filter(|path| !path.is_empty())
        .map_or_else(fallback, Into::into)
}

/// The status the window shows, for `link` and the PATH a terminal gets.
pub async fn status(link: &Path) -> CliStatus {
    let bundled = bundled();
    let state = match &bundled {
        Some(cli) => link_state(link, cli),
        None => link_state(link, Path::new("/nonexistent")),
    };
    let on_path = on_path(&login_path().await).iter().map(|p| p.display().to_string()).collect();
    CliStatus { bundled: bundled.map(|p| p.display().to_string()), link: link.display().to_string(), state, on_path }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    /// A temp dir standing in for `/usr/local/bin`, and a bundled CLI in a fake app.
    struct Fixture {
        dir: tempfile::TempDir,
        bin: PathBuf,
        link: PathBuf,
        bundled: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let macos = dir.path().join("InkUp.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let bundled = macos.join(NAME);
        std::fs::write(&bundled, "#!/bin/sh\n").unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let link = bin.join(NAME);
        Fixture { dir, bin, link, bundled }
    }

    fn no_admin(script: &str) -> Result<(), CliError> {
        panic!("asked for an administrator for {script:?}")
    }

    #[test]
    fn the_four_states_of_the_link() {
        let f = fixture();
        assert_eq!(link_state(&f.link, &f.bundled), LinkState::None);

        symlink(&f.bundled, &f.link).unwrap();
        assert_eq!(link_state(&f.link, &f.bundled), LinkState::Ours);

        // The app moved: the link points at nothing.
        let moved = f.dir.path().join("Moved.app");
        std::fs::rename(f.dir.path().join("InkUp.app"), &moved).unwrap();
        let gone = f.bundled.display().to_string();
        assert_eq!(link_state(&f.link, &moved.join("Contents/MacOS/inkup")), LinkState::Broken { target: gone });

        std::fs::remove_file(&f.link).unwrap();
        let brew = f.dir.path().join("homebrew-inkup");
        std::fs::write(&brew, "").unwrap();
        symlink(&brew, &f.link).unwrap();
        assert_eq!(
            link_state(&f.link, &moved.join("Contents/MacOS/inkup")),
            LinkState::Other { target: brew.display().to_string() }
        );

        std::fs::remove_file(&f.link).unwrap();
        std::fs::write(&f.link, "a copied binary").unwrap();
        assert_eq!(link_state(&f.link, &f.bundled), LinkState::File);
    }

    #[test]
    fn a_relative_link_to_the_app_is_ours() {
        let f = fixture();
        symlink("../InkUp.app/Contents/MacOS/inkup", &f.link).unwrap();
        assert_eq!(link_state(&f.link, &f.bundled), LinkState::Ours);
    }

    #[test]
    fn installing_links_the_bundled_cli_without_asking_when_the_dir_is_writable() {
        let f = fixture();
        assert_eq!(install(&f.link, &f.bundled, false, no_admin).unwrap(), LinkState::Ours);
        assert_eq!(std::fs::read_link(&f.link).unwrap(), f.bundled);
        assert_eq!(install(&f.link, &f.bundled, false, no_admin).unwrap(), LinkState::Ours, "again: nothing to do");
        let leftovers: Vec<_> = std::fs::read_dir(&f.bin).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, [NAME], "no temp link left behind");

        assert_eq!(uninstall(&f.link, &f.bundled, no_admin).unwrap(), LinkState::None);
        assert!(f.link.symlink_metadata().is_err());
        assert_eq!(uninstall(&f.link, &f.bundled, no_admin).unwrap(), LinkState::None, "again: nothing to do");
    }

    #[test]
    fn a_broken_link_is_reinstalled_and_can_be_removed() {
        let f = fixture();
        symlink(f.dir.path().join("Old.app/Contents/MacOS/inkup"), &f.link).unwrap();
        assert!(matches!(link_state(&f.link, &f.bundled), LinkState::Broken { .. }));
        assert_eq!(install(&f.link, &f.bundled, false, no_admin).unwrap(), LinkState::Ours);

        std::fs::remove_file(&f.link).unwrap();
        symlink(f.dir.path().join("Old.app/Contents/MacOS/inkup"), &f.link).unwrap();
        assert_eq!(uninstall(&f.link, &f.bundled, no_admin).unwrap(), LinkState::None);
    }

    #[test]
    fn another_inkup_is_replaced_only_when_confirmed_and_never_removed() {
        let f = fixture();
        let brew = f.dir.path().join("Cellar/inkup/0.5.0/bin/inkup");
        std::fs::create_dir_all(brew.parent().unwrap()).unwrap();
        std::fs::write(&brew, "brew's").unwrap();
        symlink(&brew, &f.link).unwrap();

        let refused = install(&f.link, &f.bundled, false, no_admin).unwrap_err();
        assert!(matches!(refused, CliError::NotOurs { .. }), "{refused}");
        assert_eq!(std::fs::read_link(&f.link).unwrap(), brew, "left alone");
        assert!(matches!(uninstall(&f.link, &f.bundled, no_admin), Err(CliError::NotOursToRemove(_))));
        assert_eq!(std::fs::read_link(&f.link).unwrap(), brew, "left alone");

        assert_eq!(install(&f.link, &f.bundled, true, no_admin).unwrap(), LinkState::Ours);
        assert_eq!(std::fs::read(&brew).unwrap(), b"brew's", "the other copy itself is untouched");

        std::fs::remove_file(&f.link).unwrap();
        std::fs::write(&f.link, "a copied binary").unwrap();
        assert!(matches!(install(&f.link, &f.bundled, false, no_admin), Err(CliError::NotOurs { .. })));
        assert!(matches!(uninstall(&f.link, &f.bundled, no_admin), Err(CliError::NotOursToRemove(_))));
        assert_eq!(std::fs::read(&f.link).unwrap(), b"a copied binary");
        assert_eq!(install(&f.link, &f.bundled, true, no_admin).unwrap(), LinkState::Ours);
    }

    /// A directory the user cannot write (or that does not exist yet) goes through the administrator prompt. The
    /// stand-in runs the script as this user in a shell, after making the directory writable, which is what root can
    /// do.
    #[test]
    fn an_unwritable_or_missing_dir_asks_for_an_administrator() {
        use std::os::unix::fs::PermissionsExt;

        let f = fixture();
        let missing = f.dir.path().join("usr local's/bin");
        let link = missing.join(NAME);
        let mut asked = Vec::new();
        let mut as_root = |script: &str| {
            asked.push(script.to_owned());
            let ok = std::process::Command::new("/bin/sh").arg("-c").arg(script).status().unwrap().success();
            if ok { Ok(()) } else { Err(CliError::Cancelled) }
        };
        assert_eq!(install(&link, &f.bundled, false, &mut as_root).unwrap(), LinkState::Ours);
        assert_eq!(std::fs::read_link(&link).unwrap(), f.bundled);
        assert!(asked[0].starts_with("mkdir -p '"), "{asked:?}");
        assert!(asked[0].contains(r"usr local'\''s/bin"), "quoted for the shell: {asked:?}");

        std::fs::set_permissions(&missing, std::fs::Permissions::from_mode(0o555)).unwrap();
        let mut asked_rm = Vec::new();
        let result = uninstall(&link, &f.bundled, |script: &str| {
            asked_rm.push(script.to_owned());
            std::fs::set_permissions(&missing, std::fs::Permissions::from_mode(0o755)).unwrap();
            let ok = std::process::Command::new("/bin/sh").arg("-c").arg(script).status().unwrap().success();
            if ok { Ok(()) } else { Err(CliError::Cancelled) }
        });
        assert_eq!(result.unwrap(), LinkState::None);
        assert_eq!(asked_rm.len(), 1);
        assert!(asked_rm[0].starts_with("rm -f '"), "{asked_rm:?}");

        // Cancelled at the prompt: nothing changes, and the error says so.
        std::fs::set_permissions(&missing, std::fs::Permissions::from_mode(0o555)).unwrap();
        let cancelled = install(&link, &f.bundled, false, |_: &str| Err(CliError::Cancelled)).unwrap_err();
        assert!(matches!(cancelled, CliError::Cancelled));
        assert!(link.symlink_metadata().is_err());
        std::fs::set_permissions(&missing, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn paths_are_quoted_for_the_shell_and_for_applescript() {
        assert_eq!(
            sh(Path::new("/Applications/InkUp.app/Contents/MacOS/inkup")),
            "'/Applications/InkUp.app/Contents/MacOS/inkup'"
        );
        assert_eq!(sh(Path::new("/a b/it's")), r"'/a b/it'\''s'");
        assert_eq!(
            applescript(r#"ln -sf '/x "y" \z' '/usr/local/bin/inkup'"#),
            r#"do shell script "ln -sf '/x \"y\" \\z' '/usr/local/bin/inkup'" with administrator privileges"#
        );
    }

    #[test]
    fn every_inkup_on_path_in_order() {
        let f = fixture();
        let brew = f.dir.path().join("brew");
        std::fs::create_dir(&brew).unwrap();
        std::fs::write(brew.join(NAME), "").unwrap();
        symlink(&f.bundled, &f.link).unwrap();
        let empty = f.dir.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        let path = std::env::join_paths([&empty, &brew, &f.bin, &brew]).unwrap();
        assert_eq!(on_path(&path), [brew.join(NAME), f.link.clone()]);
        assert!(on_path(OsStr::new("")).is_empty());
    }
}
