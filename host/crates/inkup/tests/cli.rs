//! The real binary: `serve` on port 0 prints its address, and `status` finds it.
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

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
