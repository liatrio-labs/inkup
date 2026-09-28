//! `inkup update`'s skew guard, on the real binary against a stub GitHub API (axoupdater's
//! `INKUP_INSTALLER_GHE_BASE_URL`). A dev build does not update itself, so going on means it prints the install
//! commands; stopping means it prints "Not updated.".
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};

use inkup_store::Store;

const BIN: &str = env!("CARGO_BIN_EXE_inkup");
const TAG: &str = "inkup-v99.0.0";
/// What a dev build prints when it goes on past the guard.
const WENT_ON: &str = "does not update itself";

/// Serves one newer release, with or without `protocol-version.txt` (holding `protocol`), until the test ends.
fn stub_github(protocol: Option<i64>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let download = format!("{base}download/");
    let mut assets = vec![serde_json::json!({
        "url": "u", "name": "inkup-installer.sh", "browser_download_url": format!("{download}inkup-installer.sh")
    })];
    if protocol.is_some() {
        assets.push(serde_json::json!({
            "url": "u", "name": "protocol-version.txt",
            "browser_download_url": format!("{download}protocol-version.txt")
        }));
    }
    let release = serde_json::json!({
        "tag_name": TAG, "name": TAG, "url": "u", "prerelease": false, "assets": assets
    })
    .to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = String::new();
            BufReader::new(&stream).read_line(&mut request).unwrap_or_default();
            let path = request.split_whitespace().nth(1).unwrap_or_default().to_owned();
            let (status, body) = if path == "/api/v3/repos/liatrio-labs/inkup/releases/latest"
                || path == format!("/api/v3/repos/liatrio-labs/inkup/releases/tags/{TAG}")
            {
                ("200 OK", release.clone())
            } else if path == "/download/protocol-version.txt" && protocol.is_some() {
                ("200 OK", format!("{}\n", protocol.unwrap()))
            } else {
                ("404 Not Found", "{}".to_owned())
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    base
}

/// A data dir with one paired Client that last spoke protocol 1.
fn paired_on_protocol_1() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let client = store.pair_client("chrome", "Chrome on MacBook").unwrap().client;
    store.record_hello(&client.id, 1).unwrap();
    dir
}

/// Runs `inkup update` with `args` against the stub, feeding `stdin`. Returns (success, stdout).
fn update(base: &str, dir: &Path, args: &[&str], stdin: &str) -> (bool, String) {
    let receipts = tempfile::tempdir().unwrap();
    let mut child = Command::new(BIN)
        .arg("update")
        .args(args)
        .arg("--data-dir")
        .arg(dir)
        .env("INKUP_INSTALLER_GHE_BASE_URL", base)
        .env_remove("INKUP_INSTALLER_GITHUB_BASE_URL")
        .env_remove("HOMEBREW_CELLAR")
        // No install receipt, so this is a dev build whatever is installed on the machine.
        .env("AXOUPDATER_CONFIG_PATH", receipts.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let mut stdout = String::new();
    child.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();
    (child.wait().unwrap().success(), stdout)
}

#[test]
fn a_newer_protocol_warns_and_declining_stops_the_update() {
    let base = stub_github(Some(2));
    let dir = paired_on_protocol_1();
    let (ok, out) = update(&base, dir.path(), &[], "n\n");
    assert!(ok, "{out}");
    assert!(out.contains("inkup 99.0.0 is out"), "{out}");
    assert!(out.contains("Warning: inkup 99.0.0 speaks protocol 2"), "{out}");
    assert!(out.contains("  Chrome on MacBook (chrome, protocol 1)"), "{out}");
    assert!(out.contains("Update the extension first"), "{out}");
    assert!(out.contains("Update inkup anyway? [y/N]"), "{out}");
    assert!(out.contains("Not updated."), "{out}");
    assert!(!out.contains(WENT_ON), "{out}");

    let (_, out) = update(&base, dir.path(), &[], "");
    assert!(out.contains("Not updated."), "no answer is no: {out}");
}

#[test]
fn confirming_goes_on_with_the_update() {
    let base = stub_github(Some(2));
    let dir = paired_on_protocol_1();
    let (ok, out) = update(&base, dir.path(), &[], "y\n");
    assert!(ok, "{out}");
    assert!(out.contains("Warning: inkup 99.0.0 speaks protocol 2"), "{out}");
    assert!(out.contains(WENT_ON) && !out.contains("Not updated."), "{out}");
}

#[test]
fn yes_goes_on_with_the_warning_printed_and_without_asking() {
    let base = stub_github(Some(2));
    let dir = paired_on_protocol_1();
    let (ok, out) = update(&base, dir.path(), &["--yes"], "");
    assert!(ok, "{out}");
    assert!(out.contains("Warning: inkup 99.0.0 speaks protocol 2"), "{out}");
    assert!(out.contains("--yes: updating anyway."), "{out}");
    assert!(!out.contains("[y/N]"), "{out}");
    assert!(out.contains(WENT_ON), "{out}");
}

#[test]
fn check_warns_without_asking() {
    let base = stub_github(Some(2));
    let dir = paired_on_protocol_1();
    let (ok, out) = update(&base, dir.path(), &["--check"], "");
    assert!(ok, "{out}");
    assert!(out.contains("Warning: inkup 99.0.0 speaks protocol 2"), "{out}");
    assert!(!out.contains("[y/N]") && !out.contains("Not updated."), "{out}");
}

#[test]
fn no_guard_without_the_asset_without_clients_or_on_the_same_protocol() {
    let dir = paired_on_protocol_1();
    let empty = tempfile::tempdir().unwrap();
    for (base, dir) in
        [(stub_github(None), dir.path()), (stub_github(Some(2)), empty.path()), (stub_github(Some(1)), dir.path())]
    {
        let (ok, out) = update(&base, dir, &[], "");
        assert!(ok, "{out}");
        assert!(out.contains("inkup 99.0.0 is out"), "{out}");
        assert!(!out.contains("Warning") && !out.contains("[y/N]"), "{out}");
        assert!(out.contains(WENT_ON), "{out}");
    }
}

/// The copy the desktop app bundles, run through the `/usr/local/bin/inkup` link Install CLI makes: it never updates
/// itself (that would break the app's signature), and says to update the app instead, past the skew guard too.
#[cfg(unix)]
#[test]
fn the_copy_inside_the_app_is_left_to_the_app() {
    let base = stub_github(None);
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let macos = root.path().join("InkUp.app/Contents/MacOS");
    std::fs::create_dir_all(&macos).unwrap();
    let bundled = macos.join("inkup");
    std::fs::copy(BIN, &bundled).unwrap();
    let before = std::fs::read(&bundled).unwrap();
    let bin = root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::os::unix::fs::symlink(&bundled, bin.join("inkup")).unwrap();

    let out = Command::new(bin.join("inkup"))
        .args(["update", "--yes", "--data-dir"])
        .arg(dir.path())
        .env("INKUP_INSTALLER_GHE_BASE_URL", &base)
        .env_remove("INKUP_INSTALLER_GITHUB_BASE_URL")
        .env("AXOUPDATER_CONFIG_PATH", dir.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let out = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(out.contains("inkup 99.0.0 is out"), "{out}");
    let app = root.path().canonicalize().unwrap().join("InkUp.app");
    assert!(
        out.contains(&format!("This inkup is the one inside {}, so it updates with the app.", app.display())),
        "{out}"
    );
    // The cask when this machine's Homebrew installed the app, else the release's DMG.
    assert!(
        out.contains("Update the app: brew upgrade --cask inkup")
            || out.contains(
                "Update the app: install InkUp_99.0.0_universal.dmg from github.com/liatrio-labs/inkup/releases"
            ),
        "{out}"
    );
    assert!(!out.contains(WENT_ON) && !out.contains("Updated to"), "{out}");
    assert_eq!(std::fs::read(&bundled).unwrap(), before, "the app's copy is untouched");
}
