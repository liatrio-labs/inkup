//! `inkup mcp install` against a temporary HOME: it writes each agent's config next to what is already
//! there, is idempotent, follows --port, writes project configs with --project, and --reset takes it all back out.
use std::fs;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};

const URL: &str = "http://127.0.0.1:47823/mcp";

fn run(home: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_inkup"))
        .arg("mcp")
        .arg("install")
        .args(args)
        .current_dir(cwd)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("CODEX_HOME")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn ok(home: &Path, cwd: &Path, args: &[&str]) -> String {
    let output = run(home, cwd, args);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(output.status.success(), "{args:?} failed:\n{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    stdout
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

const CLAUDE: &str = r#"{
  "numStartups": 12,
  "mcpServers": {
    "other": { "type": "stdio", "command": "other-mcp" }
  },
  "projects": {}
}
"#;
const CODEX: &str = "# my settings\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other-mcp\"\n";

#[test]
fn installs_for_each_agent_found_then_resets() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    fs::write(home.join(".claude.json"), CLAUDE).unwrap();
    fs::create_dir(home.join(".cursor")).unwrap();
    fs::create_dir(home.join(".codex")).unwrap();
    fs::write(home.join(".codex/config.toml"), CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(home.join(".claude.json"), fs::Permissions::from_mode(0o600)).unwrap();
    }

    // Non-interactive (no terminal): every agent found.
    let out = ok(home, home, &["--yes"]);
    assert_eq!(out.lines().filter(|l| l.contains("added inkup")).count(), 3, "{out}");

    let claude = read_json(&home.join(".claude.json"));
    assert_eq!(claude["mcpServers"]["inkup"], json!({ "type": "http", "url": URL }));
    assert_eq!(claude["mcpServers"]["other"], json!({ "type": "stdio", "command": "other-mcp" }));
    assert_eq!(claude["numStartups"], 12);
    let keys: Vec<&String> = claude.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["numStartups", "mcpServers", "projects"], "key order is kept");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(home.join(".claude.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "~/.claude.json stays private");
    }
    assert_eq!(read_json(&home.join(".cursor/mcp.json")), json!({ "mcpServers": { "inkup": { "url": URL } } }));
    let codex = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert_eq!(codex, format!("{CODEX}\n[mcp_servers.inkup]\nurl = \"{URL}\"\n"));

    // Again: nothing changes.
    let out = ok(home, home, &["--yes"]);
    assert_eq!(out.lines().filter(|l| l.contains("already points at")).count(), 3, "{out}");
    assert_eq!(fs::read_to_string(home.join(".codex/config.toml")).unwrap(), codex);

    // Another port: one agent, updated.
    let out = ok(home, home, &["--agent", "cursor", "--port", "5000"]);
    assert!(out.contains("Cursor: updated inkup to http://127.0.0.1:5000/mcp"), "{out}");
    assert_eq!(read_json(&home.join(".cursor/mcp.json"))["mcpServers"]["inkup"]["url"], "http://127.0.0.1:5000/mcp");

    // --reset takes inkup out and leaves the rest as it was.
    let out = ok(home, home, &["--reset", "--yes"]);
    assert_eq!(out.lines().filter(|l| l.contains("removed inkup")).count(), 3, "{out}");
    assert_eq!(read_json(&home.join(".claude.json")), serde_json::from_str::<Value>(CLAUDE).unwrap());
    assert_eq!(read_json(&home.join(".cursor/mcp.json")), json!({ "mcpServers": {} }));
    assert_eq!(fs::read_to_string(home.join(".codex/config.toml")).unwrap(), CODEX);
    let out = ok(home, home, &["--reset", "--yes"]);
    assert_eq!(out.lines().filter(|l| l.contains("no inkup entry")).count(), 3, "{out}");
}

#[test]
fn project_configs_go_in_the_project() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let (home, project) = (home.path(), project.path());

    // --project with no DIR is the current directory; the user's own configs are not touched.
    let out = ok(home, project, &["--project", "--yes"]);
    assert!(out.contains("Claude Code asks once"), "{out}");
    assert_eq!(
        read_json(&project.join(".mcp.json")),
        json!({ "mcpServers": { "inkup": { "type": "http", "url": URL } } })
    );
    assert_eq!(read_json(&project.join(".cursor/mcp.json")), json!({ "mcpServers": { "inkup": { "url": URL } } }));
    assert_eq!(
        fs::read_to_string(project.join(".codex/config.toml")).unwrap(),
        format!("[mcp_servers.inkup]\nurl = \"{URL}\"\n")
    );
    assert!(!home.join(".claude.json").exists());

    let dir = project.to_str().unwrap();
    ok(home, home, &["--project", dir, "--agent", "codex", "--reset"]);
    assert_eq!(fs::read_to_string(project.join(".codex/config.toml")).unwrap(), "");
    assert!(read_json(&project.join(".mcp.json"))["mcpServers"]["inkup"].is_object(), "only Codex was reset");
}

#[test]
fn with_no_agent_found_it_asks_for_one() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), home.path(), &["--yes"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("name one with --agent"));

    // Named explicitly, it creates the config.
    ok(home.path(), home.path(), &["--agent", "claude-code"]);
    assert_eq!(
        read_json(&home.path().join(".claude.json")),
        json!({ "mcpServers": { "inkup": { "type": "http", "url": URL } } })
    );
}

#[test]
fn a_config_it_cannot_read_is_left_alone() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join(".cursor")).unwrap();
    fs::write(home.path().join(".cursor/mcp.json"), "{ not json").unwrap();
    let output = run(home.path(), home.path(), &["--agent", "cursor"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not valid JSON"));
    assert_eq!(fs::read_to_string(home.path().join(".cursor/mcp.json")).unwrap(), "{ not json");
}

#[test]
fn remote_writes_the_hubs_url_and_the_agent_token_header() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let remote = "http://inkup.local:47823";
    let url = "http://inkup.local:47823/mcp";
    let out = ok(
        home,
        home,
        &["--remote", remote, "--token", "ink1_abc", "--agent", "claude-code", "--agent", "cursor", "--agent", "codex"],
    );
    assert_eq!(out.lines().filter(|l| l.contains("added inkup")).count(), 3, "{out}");
    let bearer = json!({ "Authorization": "Bearer ink1_abc" });
    assert_eq!(
        read_json(&home.join(".claude.json"))["mcpServers"]["inkup"],
        json!({ "type": "http", "url": url, "headers": bearer })
    );
    assert_eq!(
        read_json(&home.join(".cursor/mcp.json"))["mcpServers"]["inkup"],
        json!({ "url": url, "headers": bearer })
    );
    assert_eq!(
        fs::read_to_string(home.join(".codex/config.toml")).unwrap(),
        format!("[mcp_servers.inkup]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"Bearer ink1_abc\" }}\n")
    );
    // Again with the same token: nothing changes.
    let out = ok(home, home, &["--remote", remote, "--token", "ink1_abc", "--agent", "claude-code"]);
    assert!(out.contains("already points at"), "{out}");

    // Without a token it is refused, naming where one comes from.
    let output = run(home, home, &["--remote", remote, "--agent", "cursor"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("inkup token create"));
}
