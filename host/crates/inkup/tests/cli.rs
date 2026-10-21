//! The real binary: `serve` on port 0 prints its address, and `status` finds it.
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

#[path = "../../server/tests/common/lan.rs"]
mod lan;

const BIN: &str = env!("CARGO_BIN_EXE_inkup");

struct Serve(Child);

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn serve_prints_its_address_and_status_finds_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut serve = Serve(
        Command::new(BIN)
            .args(["serve", "--port", "0", "--auto-approve-pairing", "--data-dir"])
            .arg(dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(serve.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let port = line.trim().rsplit(':').next().unwrap().to_owned();
    assert!(line.starts_with("inkup listening on http://127.0.0.1:"), "{line}");

    let status = Command::new(BIN).args(["status", "--port", &port, "--data-dir"]).arg(dir.path()).output().unwrap();
    let stdout = String::from_utf8_lossy(&status.stdout);
    assert!(status.status.success(), "{stdout}");
    assert!(stdout.contains(&format!("running: inkup {} on 127.0.0.1:{port}", env!("CARGO_PKG_VERSION"))), "{stdout}");
    assert!(stdout.contains("0 Sessions, 0 paired Clients"), "{stdout}");
}

#[test]
fn status_fails_when_no_host_runs() {
    let dir = tempfile::tempdir().unwrap();
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let status =
        Command::new(BIN).args(["status", "--port", &free.to_string(), "--data-dir"]).arg(dir.path()).output().unwrap();
    assert!(!status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("not running"));
}

fn serve(dir: &std::path::Path, args: &[&str]) -> Serve {
    Serve(
        Command::new(BIN)
            .args(["serve", "--port", "0", "--data-dir"])
            .arg(dir)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}

#[test]
fn auto_approve_is_refused_in_network_mode() {
    let dir = tempfile::tempdir().unwrap();
    let mut refused = serve(dir.path(), &["--network", "--auto-approve-pairing"]);
    let status = refused.0.wait().unwrap();
    assert!(!status.success());
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut refused.0.stderr.take().unwrap(), &mut stderr).unwrap();
    assert!(stderr.contains("--auto-approve-pairing is refused in network mode"), "{stderr}");
}

/// The test-only flag: in network mode each pairing code from another machine is a stdout line, and the banner
/// warns. Reached through this machine's LAN address, which the Host sees as another machine.
#[test]
fn network_mode_prints_codes_for_tests_and_warns() {
    if !lan::lan_tests_enabled() {
        return;
    }
    let Some(ip) = inkup_server::lan_addresses().into_iter().next() else {
        eprintln!("skipped: no LAN address");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let name = format!("inkup-cli-{}", std::process::id());
    let mut host =
        serve(dir.path(), &["--network", "--auto-approve-pairing", "--print-pairing-codes", "--mdns-name", &name]);
    let mut stdout = BufReader::new(host.0.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on http://127.0.0.1:"), "{line}");
    let port: u16 = line.trim().rsplit(':').next().unwrap().parse().unwrap();
    let mut stderr = BufReader::new(host.0.stderr.take().unwrap());
    let mut banner = String::new();
    while !banner.contains("other machines:") {
        let mut next = String::new();
        assert!(stderr.read_line(&mut next).unwrap() > 0, "banner ended early: {banner}");
        banner += &next;
    }
    assert!(banner.contains(inkup_server::NETWORK_WARNING), "{banner}");

    // A hello from the LAN address gets pairing_code_required, and the code appears on stdout.
    let url = format!("ws://{ip}:{port}/ws");
    let hello = r#"{"v":1,"type":"hello","id":"m-1","client_kind":"chrome","client_name":"LAN test"}"#;
    let (mut ws, _) = tungstenite::connect(url.as_str()).unwrap();
    ws.send(tungstenite::Message::text(hello)).unwrap();
    let reply = ws.read().unwrap().into_text().unwrap();
    assert!(reply.contains("pairing_code_required"), "{reply}");
    let mut code = String::new();
    stdout.read_line(&mut code).unwrap();
    let code = code.trim().strip_prefix("pairing code: ").expect("a pairing code line").to_owned();
    assert_eq!(code.len(), 6);

    let (mut ws, _) = tungstenite::connect(url.as_str()).unwrap();
    let hello = hello.replace(r#""LAN test"}"#, &format!(r#""LAN test","pairing_code":"{code}"}}"#));
    ws.send(tungstenite::Message::text(hello)).unwrap();
    let reply = ws.read().unwrap().into_text().unwrap();
    assert!(reply.contains(r#""type":"paired""#), "{reply}");
}

#[test]
fn agent_tokens_are_created_listed_and_revoked() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(BIN).args(["token"]).args(args).arg("--data-dir").arg(dir.path()).output().unwrap();
        (output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let (ok, token) = run(&["create", "--name", "codex on desktop"]);
    assert!(ok);
    assert!(token.trim().starts_with("ink1_"), "{token}");
    let (_, list) = run(&["list"]);
    assert!(list.contains("codex on desktop") && list.contains("never used"), "{list}");
    let id = list.split_whitespace().next().unwrap().to_owned();
    assert_eq!(run(&["revoke", &id]), (true, format!("revoked {id}\n")));
    assert!(!run(&["revoke", &id]).0, "already revoked");
    assert_eq!(run(&["list"]).1, "");
}

/// `serve` on `dir` (port 0), once it has printed its address: the port.
fn serving(dir: &std::path::Path) -> (Serve, u16) {
    let mut host = serve(dir, &["--auto-approve-pairing"]);
    let mut line = String::new();
    BufReader::new(host.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on http://127.0.0.1:"), "{line}");
    let port = line.trim().rsplit(':').next().unwrap().parse().unwrap();
    (host, port)
}

/// A host on `dir` that must refuse to start: its exit and stderr.
fn refused(args: &[&str], dir: &std::path::Path) -> (std::process::ExitStatus, String) {
    let output = Command::new(BIN)
        .args(args)
        .arg("--data-dir")
        .arg(dir)
        .env_remove("INKUP_DATA_DIR")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (output.status, String::from_utf8_lossy(&output.stderr).into_owned())
}

#[test]
fn a_second_host_on_the_same_data_dir_says_who_runs_and_exits_1() {
    let dir = tempfile::tempdir().unwrap();
    let (first, port) = serving(dir.path());
    let pid = first.0.id();
    let expected = format!(
        "InkUp is already running (inkup serve, pid {pid}, port {port}). Use --data-dir for a separate instance."
    );
    let (status, stderr) = refused(&["serve", "--port", "0"], dir.path());
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(&expected), "{stderr}");
    // The TUI too, and before it asks for a terminal.
    let (status, stderr) = refused(&["--port", "0"], dir.path());
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(&expected), "{stderr}");
}

#[test]
fn hosts_on_different_data_dirs_both_run() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (_a, port_a) = serving(a.path());
    let (_b, port_b) = serving(b.path());
    assert_ne!(port_a, port_b);
}

#[test]
fn a_killed_host_leaves_the_data_dir_free() {
    let dir = tempfile::tempdir().unwrap();
    let (mut first, _) = serving(dir.path());
    // SIGKILL on unix, TerminateProcess on Windows: no chance to clean up.
    first.0.kill().unwrap();
    first.0.wait().unwrap();
    let (_second, port) = serving(dir.path());
    let info = inkup_store::instance::holder(dir.path()).unwrap().expect("host.json");
    assert_eq!(info.port, port);
}

/// SIGTERM, as `kill` or a service manager stops it, gives up the data dir like Ctrl-C: no stale host.json.
#[cfg(unix)]
#[test]
fn serve_gives_up_the_data_dir_on_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let (mut host, _) = serving(dir.path());
    assert!(inkup_store::instance::holder(dir.path()).unwrap().is_some());
    let pid = host.0.id().to_string();
    assert!(Command::new("kill").args(["-TERM", &pid]).status().unwrap().success());
    let exit = host.0.wait().unwrap();
    assert!(exit.success(), "{exit:?}");
    assert!(!dir.path().join(inkup_store::instance::HOST_FILE).exists(), "host.json is left behind");
}

#[test]
fn host_json_names_the_holder_and_status_prints_it() {
    let dir = tempfile::tempdir().unwrap();
    let (host, port) = serving(dir.path());
    let info = inkup_store::instance::holder(dir.path()).unwrap().expect("host.json");
    assert_eq!((info.pid, info.port, info.kind), (host.0.id(), port, inkup_store::instance::HostKind::Serve));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.path().join(inkup_store::instance::HOST_FILE);
        assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // No --port: the holder's port, from host.json.
    let status = Command::new(BIN).args(["status", "--data-dir"]).arg(dir.path()).output().unwrap();
    let stdout = String::from_utf8_lossy(&status.stdout);
    assert!(status.status.success(), "{stdout}");
    assert!(stdout.contains(&format!("host: inkup serve, pid {}, port {port}", host.0.id())), "{stdout}");
}

fn write_remote(dir: &std::path::Path, extra: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("config.toml"), extra).unwrap();
}

#[test]
fn remote_without_https_or_with_auto_approve_exits_1() {
    let dir = tempfile::tempdir().unwrap();
    let (status, stderr) = refused(&["serve", "--remote", "--port", "0"], dir.path());
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("https public URL"), "{stderr}");

    let (status, stderr) =
        refused(&["serve", "--remote", "--public-url", "http://review.example", "--port", "0"], dir.path());
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("must be https://"), "{stderr}");
    assert!(stderr.contains("not http://"), "{stderr}");

    let (status, stderr) = refused(
        &["serve", "--remote", "--public-url", "https://review.example", "--auto-approve-pairing", "--port", "0"],
        dir.path(),
    );
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("--auto-approve-pairing is refused on a Remote Host"), "{stderr}");

    let (status, stderr) = refused(
        &["serve", "--remote", "--network", "--public-url", "https://review.example", "--port", "0"],
        dir.path(),
    );
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("--remote and --network"), "{stderr}");
}

#[test]
fn a_remote_host_prints_the_public_url_and_omits_the_machine_name() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = serve(dir.path(), &["--remote", "--public-url", "https://review.example", "--bind", "127.0.0.1"]);
    let mut stdout = BufReader::new(host.0.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on http://127.0.0.1:"), "{line}");
    let port: u16 = line.trim().rsplit(':').next().unwrap().parse().unwrap();
    let mut stderr = String::new();
    let mut err = BufReader::new(host.0.stderr.take().unwrap());
    let mut banner = String::new();
    while !banner.contains("inkup pairing") {
        let mut next = String::new();
        assert!(err.read_line(&mut next).unwrap() > 0, "banner ended early: {banner}");
        banner += &next;
    }
    stderr.clone_from(&banner);
    assert!(banner.contains("Remote Host: put this behind HTTPS (a reverse proxy or your gateway)"), "{stderr}");
    assert!(banner.contains("public URL: https://review.example\n"), "{stderr}");
    assert!(banner.contains("MCP for agents: https://review.example/mcp"), "{stderr}");
    assert!(banner.contains("inkup token create --name <agent>"), "{stderr}");
    assert!(banner.contains(&format!("data dir: {}", dir.path().display())), "{stderr}");
    assert!(!banner.contains("inkup://pair"), "{stderr}");

    let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    use std::io::{Read, Write};
    write!(sock, "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").unwrap();
    let mut body = String::new();
    sock.read_to_string(&mut body).unwrap();
    assert!(!body.contains("hub_name"), "{body}");
    let status = Command::new(BIN).args(["status", "--data-dir"]).arg(dir.path()).output().unwrap();
    assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
}

#[test]
fn config_toml_starts_a_remote_host_and_can_set_the_hub_name() {
    let dir = tempfile::tempdir().unwrap();
    write_remote(dir.path(), "remote = true\npublic_url = \"https://review.example\"\nhub_name = \"review desk\"\n");
    let mut host = serve(dir.path(), &["--bind", "127.0.0.1"]);
    let mut line = String::new();
    BufReader::new(host.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on http://127.0.0.1:"), "{line}");
    let port: u16 = line.trim().rsplit(':').next().unwrap().parse().unwrap();
    let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    use std::io::{Read, Write};
    write!(sock, "GET /health HTTP/1.1\r\nHost: review.example\r\nConnection: close\r\n\r\n").unwrap();
    let mut body = String::new();
    sock.read_to_string(&mut body).unwrap();
    assert!(body.contains("\"hub_name\":\"review desk\""), "{body}");
    assert!(!body.contains("review.example\""), "{body}");
}

#[test]
fn token_create_honors_a_remote_flag_without_config() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(BIN)
        .args([
            "token",
            "create",
            "--name",
            "reviewer-a",
            "--remote",
            "--public-url",
            "https://review.example",
            "--data-dir",
        ])
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("inkup mcp install --remote https://review.example --token <token>"), "{stderr}");
}

#[test]
fn token_create_names_the_public_url_when_a_remote_host_is_configured() {
    let dir = tempfile::tempdir().unwrap();
    write_remote(dir.path(), "remote = true\npublic_url = \"https://review.example\"\n");
    let output = Command::new(BIN)
        .args(["token", "create", "--name", "reviewer-a", "--data-dir"])
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("inkup mcp install --remote https://review.example --token <token>"), "{stderr}");
}

#[test]
fn the_tui_refuses_a_remote_host() {
    let dir = tempfile::tempdir().unwrap();
    write_remote(dir.path(), "remote = true\npublic_url = \"https://review.example\"\n");
    let (status, stderr) = refused(&["--port", "0"], dir.path());
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("no TUI"), "{stderr}");
}

#[test]
fn the_default_remote_bind_is_every_interface() {
    if !lan::lan_tests_enabled() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut host = serve(dir.path(), &["--remote", "--public-url", "https://review.example"]);
    let mut line = String::new();
    BufReader::new(host.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on http://0.0.0.0:"), "{line}");
}

fn run(args: &[&str], dir: &std::path::Path) -> (bool, String, String) {
    let output = Command::new(BIN)
        .args(args)
        .arg("--data-dir")
        .arg(dir)
        .env_remove("INKUP_DATA_DIR")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn pem_pair(dir: &std::path::Path, name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let cert = dir.join(format!("{name}-cert.pem"));
    let key = dir.join(format!("{name}-key.pem"));
    let output = Command::new("openssl")
        .args(["req", "-x509", "-newkey", "rsa:2048", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .args(["-days", "1", "-nodes", "-subj", "/CN=localhost"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    (cert, key)
}

#[test]
fn pairing_help_says_codes_live_in_memory_and_serve_help_says_no_hot_reload() {
    let pairing = Command::new(BIN).args(["pairing", "--help"]).output().unwrap();
    let text = String::from_utf8_lossy(&pairing.stdout);
    assert!(pairing.status.success(), "{text}");
    assert!(text.contains("memory"), "{text}");
    assert!(text.to_ascii_lowercase().contains("restart"), "{text}");
    let serve = Command::new(BIN).args(["serve", "--help"]).output().unwrap();
    let text = String::from_utf8_lossy(&serve.stdout);
    assert!(text.contains("hot reload"), "{text}");
}

#[test]
fn pairing_create_fails_with_no_host_and_outside_a_remote_host() {
    let dir = tempfile::tempdir().unwrap();
    let (ok, _stdout, stderr) = run(&["pairing", "create"], dir.path());
    assert!(!ok);
    assert!(stderr.contains("no Host is running"), "{stderr}");

    let (_host, _port) = serving(dir.path());
    let (ok, _stdout, stderr) = run(&["pairing", "create"], dir.path());
    assert!(!ok);
    assert!(stderr.contains("loopback and Network mode keep today's pairing"), "{stderr}");
}

#[test]
fn pairing_create_prints_a_code_a_pair_link_and_a_qr_code() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = serve(dir.path(), &["--remote", "--public-url", "https://review.example", "--bind", "127.0.0.1"]);
    let mut line = String::new();
    BufReader::new(host.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on http://127.0.0.1:"), "{line}");
    let port: u16 = line.trim().rsplit(':').next().unwrap().parse().unwrap();

    let (ok, stdout, stderr) = run(&["pairing", "create", "--name", "reviewer", "--ttl", "15m"], dir.path());
    assert!(ok, "{stderr}");
    let code = stdout.lines().find_map(|line| line.strip_prefix("code: ")).expect("a code").to_owned();
    let id = stdout.lines().find_map(|line| line.strip_prefix("id: ")).expect("an id").to_owned();
    let link = format!("inkup://pair?url=https://review.example&code={code}");
    assert!(stdout.contains(&link), "{stdout}");
    assert!(stdout.contains('█') || stdout.contains('▀') || stdout.contains('▄'), "a QR code\n{stdout}");

    let (ok, listed, stderr) = run(&["pairing", "list"], dir.path());
    assert!(ok, "{stderr}");
    assert!(listed.contains(&id) && listed.contains("reviewer") && listed.contains("guesses left"), "{listed}");
    assert!(!listed.contains(&code), "{listed}");

    let hello = format!(
        r#"{{"v":1,"type":"hello","id":"m-1","client_kind":"chrome","client_name":"Reviewer","pairing_code":"{code}"}}"#
    );
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut ws, _) = tungstenite::connect(url.as_str()).unwrap();
    ws.send(tungstenite::Message::text(hello.clone())).unwrap();
    let reply = ws.read().unwrap().into_text().unwrap();
    assert!(reply.contains(r#""type":"paired""#), "{reply}");
    let (mut ws, _) = tungstenite::connect(url.as_str()).unwrap();
    ws.send(tungstenite::Message::text(hello)).unwrap();
    let reply = ws.read().unwrap().into_text().unwrap();
    assert!(reply.contains("pairing_denied"), "{reply}");
}

#[test]
fn tls_flags_fail_alone_without_remote_and_on_an_unreadable_key() {
    let dir = tempfile::tempdir().unwrap();
    let (cert, key) = pem_pair(dir.path(), "host");
    let (status, stderr) = refused(
        &[
            "serve",
            "--remote",
            "--public-url",
            "https://review.example",
            "--tls-cert",
            cert.to_str().unwrap(),
            "--port",
            "0",
        ],
        dir.path(),
    );
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(cert.to_str().unwrap()) && stderr.contains("both or neither"), "{stderr}");

    let (status, stderr) = refused(
        &["serve", "--tls-cert", cert.to_str().unwrap(), "--tls-key", key.to_str().unwrap(), "--port", "0"],
        dir.path(),
    );
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("Network mode stays unencrypted"), "{stderr}");

    let missing = dir.path().join("missing-key.pem");
    let output = Command::new(BIN)
        .args([
            "serve",
            "--remote",
            "--public-url",
            "https://review.example",
            "--bind",
            "127.0.0.1",
            "--tls-cert",
            cert.to_str().unwrap(),
            "--tls-key",
            missing.to_str().unwrap(),
            "--port",
            "0",
            "--data-dir",
        ])
        .arg(dir.path())
        .env_remove("INKUP_DATA_DIR")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(&missing.display().to_string()), "{stderr}");
    assert!(!stdout.contains("inkup listening"), "{stdout}");
}

#[test]
fn a_certificate_serves_https_and_the_banner_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let (cert, key) = pem_pair(dir.path(), "host");
    let mut host = serve(
        dir.path(),
        &[
            "--remote",
            "--public-url",
            "https://review.example",
            "--bind",
            "127.0.0.1",
            "--tls-cert",
            cert.to_str().unwrap(),
            "--tls-key",
            key.to_str().unwrap(),
        ],
    );
    let mut line = String::new();
    BufReader::new(host.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on https://127.0.0.1:"), "{line}");
    let mut banner = String::new();
    let mut err = BufReader::new(host.0.stderr.take().unwrap());
    while !banner.contains("inkup pairing") {
        let mut next = String::new();
        assert!(err.read_line(&mut next).unwrap() > 0, "banner ended early: {banner}");
        banner += &next;
    }
    let expected = format!("HTTPS (certificate from {})", cert.display());
    assert!(banner.contains(&expected), "{banner}");
    assert!(!banner.contains("put this behind HTTPS"), "{banner}");

    write_remote(
        dir.path(),
        &format!(
            "remote = true\npublic_url = \"https://review.example\"\ntls_cert = \"{}\"\ntls_key = \"{}\"\n",
            cert.display(),
            key.display()
        ),
    );
    drop(host);
    let mut host = serve(dir.path(), &["--bind", "127.0.0.1"]);
    let mut line = String::new();
    BufReader::new(host.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("inkup listening on https://127.0.0.1:"), "{line}");
}
