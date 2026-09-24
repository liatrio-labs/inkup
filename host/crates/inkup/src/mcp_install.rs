//! `inkup mcp install`: adds the host's MCP endpoint to an agent's config, or with `--reset` takes it out.
//! Only the `inkup` entry is touched; the rest of each file (other servers, settings, key order, TOML
//! comments) is kept, and the file is replaced atomically.
//!
//! `--remote http://inkup.local:47823 --token <agent token>` points an agent on another machine at a Host in
//! network mode (ADR 0006): the entry carries an `Authorization: Bearer` header (`headers` for Claude Code and
//! Cursor, `http_headers` for Codex).
//!
//! | agent       | user config                          | `--project <dir>`          |
//! |-------------|--------------------------------------|----------------------------|
//! | Claude Code | `~/.claude.json` `mcpServers`        | `<dir>/.mcp.json`          |
//! | Cursor      | `~/.cursor/mcp.json` `mcpServers`    | `<dir>/.cursor/mcp.json`   |
//! | Codex       | `$CODEX_HOME/config.toml` (`~/.codex`) `[mcp_servers]` | `<dir>/.codex/config.toml` |

use std::fs;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use serde_json::{Map, Value, json};

/// The entry's name in every agent's config.
pub const SERVER_NAME: &str = "inkup";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Agent {
    ClaudeCode,
    Cursor,
    Codex,
}

impl Agent {
    const ALL: [Self; 3] = [Self::ClaudeCode, Self::Cursor, Self::Codex];

    fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
            Self::Codex => "Codex",
        }
    }

    fn codex_home(home: &Path) -> PathBuf {
        std::env::var_os("CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from)
    }

    /// Whether the agent looks installed for this user.
    fn detected(self, home: &Path) -> bool {
        match self {
            Self::ClaudeCode => home.join(".claude.json").exists() || home.join(".claude").is_dir(),
            Self::Cursor => home.join(".cursor").is_dir(),
            Self::Codex => Self::codex_home(home).is_dir(),
        }
    }

    fn config_path(self, home: &Path, project: Option<&Path>) -> PathBuf {
        match (self, project) {
            (Self::ClaudeCode, None) => home.join(".claude.json"),
            (Self::ClaudeCode, Some(dir)) => dir.join(".mcp.json"),
            (Self::Cursor, None) => home.join(".cursor/mcp.json"),
            (Self::Cursor, Some(dir)) => dir.join(".cursor/mcp.json"),
            (Self::Codex, None) => Self::codex_home(home).join("config.toml"),
            (Self::Codex, Some(dir)) => dir.join(".codex/config.toml"),
        }
    }

    /// The JSON entry for the JSON-configured agents.
    fn json_entry(self, endpoint: &Endpoint) -> Value {
        let mut entry = match self {
            Self::ClaudeCode => json!({ "type": "http", "url": endpoint.url }),
            Self::Cursor | Self::Codex => json!({ "url": endpoint.url }),
        };
        if let Some(authorization) = endpoint.authorization() {
            entry["headers"] = json!({ "Authorization": authorization });
        }
        entry
    }
}

/// Where the agent finds the Host's MCP, and the token it sends when that is another machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub url: String,
    pub token: Option<String>,
}

impl Endpoint {
    fn authorization(&self) -> Option<String> {
        self.token.as_ref().map(|token| format!("Bearer {token}"))
    }
}

#[derive(Args)]
pub struct InstallArgs {
    /// The agent to configure; repeat for several. Without it: the agents found in your home directory (asked
    /// one by one on a terminal, all of them with --yes).
    #[arg(long, value_enum)]
    agent: Vec<Agent>,
    /// Write the project's config in DIR (default: the current directory) instead of your user config.
    #[arg(long, value_name = "DIR", num_args = 0..=1, default_missing_value = ".")]
    project: Option<PathBuf>,
    /// Take the inkup entry out instead of adding it.
    #[arg(long)]
    reset: bool,
    /// Non-interactive: ask nothing.
    #[arg(long, short = 'y')]
    yes: bool,
    /// The port the host listens on.
    #[arg(long, default_value_t = inkup_server::DEFAULT_PORT)]
    port: u16,
    /// A Host on another machine, in network mode: `http://inkup.local:47823`. Needs --token.
    #[arg(long, value_name = "URL", conflicts_with = "port")]
    remote: Option<String>,
    /// The agent token for --remote, from `inkup token create` (or the TUI) on the Host.
    #[arg(long, env = "INKUP_TOKEN", hide_env_values = true, requires = "remote")]
    token: Option<String>,
}

impl InstallArgs {
    fn endpoint(&self) -> Result<Endpoint> {
        let Some(remote) = &self.remote else {
            return Ok(Endpoint { url: format!("http://127.0.0.1:{}/mcp", self.port), token: None });
        };
        let base = remote.trim().trim_end_matches('/');
        let base = base.strip_suffix("/mcp").unwrap_or(base);
        if !base.starts_with("http://") && !base.starts_with("https://") {
            bail!("--remote takes the Host's address, like http://inkup.local:47823");
        }
        let token = match &self.token {
            Some(token) if !token.trim().is_empty() => token.trim().to_owned(),
            _ if self.reset => String::new(),
            _ => bail!(
                "--remote needs --token: run `inkup token create --name <agent>` on the Host (or press t in its TUI)"
            ),
        };
        Ok(Endpoint { url: format!("{base}/mcp"), token: Some(token).filter(|t| !t.is_empty()) })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Added,
    Updated,
    Unchanged,
    Removed,
    Absent,
}

pub fn install(args: InstallArgs) -> Result<()> {
    let home = std::env::home_dir().context("no home directory")?;
    let endpoint = args.endpoint()?;
    let url = endpoint.url.clone();
    let project = match &args.project {
        Some(dir) => Some(std::path::absolute(dir).with_context(|| format!("resolve {}", dir.display()))?),
        None => None,
    };
    let agents = choose_agents(&args, &home, project.as_deref())?;
    if agents.is_empty() {
        println!("Nothing to do.");
        return Ok(());
    }
    for agent in agents {
        let path = agent.config_path(&home, project.as_deref());
        let change = apply(agent, &path, &endpoint, args.reset)
            .with_context(|| format!("{}: {}", agent.label(), path.display()))?;
        let what = match change {
            Change::Added => format!("added {SERVER_NAME} ({url}) to"),
            Change::Updated => format!("updated {SERVER_NAME} to {url} in"),
            Change::Unchanged => format!("{SERVER_NAME} already points at {url} in"),
            Change::Removed => format!("removed {SERVER_NAME} from"),
            Change::Absent => format!("no {SERVER_NAME} entry in"),
        };
        println!("{}: {what} {}", agent.label(), path.display());
    }
    if !args.reset {
        println!("Agents reach the host while it runs: start it with `inkup`.");
        if project.is_some() {
            println!("Claude Code asks once before it uses a project's .mcp.json servers.");
            if endpoint.token.is_some() {
                println!("The project config now holds the agent token: keep it out of version control.");
            }
        }
    }
    Ok(())
}

fn choose_agents(args: &InstallArgs, home: &Path, project: Option<&Path>) -> Result<Vec<Agent>> {
    if !args.agent.is_empty() {
        let mut agents = args.agent.clone();
        agents.dedup();
        return Ok(agents);
    }
    // A project config does not depend on what this user has installed; a reset looks wherever an entry could be.
    let found: Vec<Agent> =
        Agent::ALL.into_iter().filter(|a| project.is_some() || args.reset || a.detected(home)).collect();
    if found.is_empty() {
        bail!("found no Claude Code, Cursor or Codex config in {}; name one with --agent", home.display());
    }
    if args.yes || !std::io::stdin().is_terminal() {
        return Ok(found);
    }
    let verb = if args.reset { "Remove inkup from" } else { "Add inkup to" };
    let mut chosen = Vec::new();
    let mut lines = std::io::stdin().lock().lines();
    for agent in found {
        eprint!("{verb} {} ({})? [Y/n] ", agent.label(), agent.config_path(home, project).display());
        std::io::stderr().flush()?;
        let answer = lines.next().transpose()?.unwrap_or_default();
        if yes(&answer) {
            chosen.push(agent);
        }
    }
    Ok(chosen)
}

fn yes(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "" | "y" | "yes")
}

/// Adds (or with `reset` removes) the entry in one config file.
pub fn apply(agent: Agent, path: &Path, endpoint: &Endpoint, reset: bool) -> Result<Change> {
    let text = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if reset && text.is_none() {
        return Ok(Change::Absent);
    }
    let text = text.unwrap_or_default();
    let (change, updated) = match agent {
        Agent::ClaudeCode | Agent::Cursor => edit_json(&text, agent.json_entry(endpoint), reset)?,
        Agent::Codex => edit_toml(&text, endpoint, reset)?,
    };
    if matches!(change, Change::Added | Change::Updated | Change::Removed) {
        write_atomically(path, &updated)?;
    }
    Ok(change)
}

fn edit_json(text: &str, entry: Value, reset: bool) -> Result<(Change, String)> {
    let mut root: Value =
        if text.trim().is_empty() { json!({}) } else { serde_json::from_str(text).context("not valid JSON")? };
    let Some(root_map) = root.as_object_mut() else { bail!("the file is not a JSON object") };
    let servers = root_map.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
    let Some(servers) = servers.as_object_mut() else { bail!("mcpServers is not an object") };
    let change = if reset {
        if servers.shift_remove(SERVER_NAME).is_some() { Change::Removed } else { Change::Absent }
    } else {
        match servers.insert(SERVER_NAME.into(), entry.clone()) {
            None => Change::Added,
            Some(old) if old == entry => Change::Unchanged,
            Some(_) => Change::Updated,
        }
    };
    Ok((change, format!("{}\n", serde_json::to_string_pretty(&root)?)))
}

fn edit_toml(text: &str, endpoint: &Endpoint, reset: bool) -> Result<(Change, String)> {
    use toml_edit::{DocumentMut, InlineTable, Item, Table, value};

    let url = endpoint.url.as_str();
    let authorization = endpoint.authorization();
    let mut doc: DocumentMut = text.parse().context("not valid TOML")?;
    if !doc.contains_key("mcp_servers") {
        if reset {
            return Ok((Change::Absent, text.to_owned()));
        }
        let mut servers = Table::new();
        // Written as `[mcp_servers.inkup]` alone, not an empty `[mcp_servers]` above it.
        servers.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(servers));
    }
    let Some(servers) = doc["mcp_servers"].as_table_like_mut() else { bail!("mcp_servers is not a table") };
    let existing = servers.get(SERVER_NAME).and_then(|s| s.as_table_like());
    let same = existing.is_some_and(|t| {
        let header = t
            .get("http_headers")
            .and_then(|h| h.as_table_like())
            .and_then(|h| h.get("Authorization"))
            .and_then(|a| a.as_str());
        t.len() == 1 + usize::from(authorization.is_some())
            && t.get("url").and_then(|u| u.as_str()) == Some(url)
            && header == authorization.as_deref()
    });
    let change = match (reset, existing.is_some()) {
        (true, true) => Change::Removed,
        (true, false) => Change::Absent,
        (false, _) if same => Change::Unchanged,
        (false, true) => Change::Updated,
        (false, false) => Change::Added,
    };
    match change {
        Change::Removed => {
            servers.remove(SERVER_NAME);
        }
        Change::Added | Change::Updated => {
            let mut entry = Table::new();
            entry.insert("url", value(url));
            if let Some(authorization) = &authorization {
                let mut headers = InlineTable::new();
                headers.insert("Authorization", authorization.as_str().into());
                entry.insert("http_headers", value(headers));
            }
            servers.insert(SERVER_NAME, Item::Table(entry));
        }
        Change::Unchanged | Change::Absent => {}
    }
    Ok((change, doc.to_string()))
}

/// Writes next to the file and renames over it, keeping its permissions (`~/.claude.json` is private).
fn write_atomically(path: &Path, contents: &str) -> Result<()> {
    let dir = path.parent().context("no parent directory")?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents.as_bytes())?;
    if let Ok(meta) = fs::metadata(path) {
        fs::set_permissions(tmp.path(), meta.permissions())?;
    }
    tmp.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_answer_is_yes() {
        for answer in ["", "y", "Yes\n"] {
            assert!(yes(answer), "{answer:?}");
        }
        for answer in ["n", "no", "nope"] {
            assert!(!yes(answer), "{answer:?}");
        }
    }

    fn local(url: &str) -> Endpoint {
        Endpoint { url: url.into(), token: None }
    }

    #[test]
    fn codex_keeps_comments_and_other_servers() {
        let text = "# mine\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"x\" # keep\n";
        let (change, added) = edit_toml(text, &local("http://127.0.0.1:1/mcp"), false).unwrap();
        assert_eq!(change, Change::Added);
        assert!(added.starts_with(text), "{added}");
        assert!(added.ends_with("[mcp_servers.inkup]\nurl = \"http://127.0.0.1:1/mcp\"\n"), "{added}");
        assert_eq!(edit_toml(&added, &local("http://127.0.0.1:1/mcp"), false).unwrap().0, Change::Unchanged);
        assert_eq!(edit_toml(&added, &local("http://127.0.0.1:2/mcp"), false).unwrap().0, Change::Updated);
        let (change, removed) = edit_toml(&added, &local(""), true).unwrap();
        assert_eq!(change, Change::Removed);
        assert_eq!(removed, text);
    }

    #[test]
    fn codex_gets_the_bearer_header_for_a_remote_hub() {
        let remote = Endpoint { url: "http://inkup.local:47823/mcp".into(), token: Some("ink1_x".into()) };
        let (change, added) = edit_toml("", &remote, false).unwrap();
        assert_eq!(change, Change::Added);
        assert_eq!(
            added,
            "[mcp_servers.inkup]\nurl = \"http://inkup.local:47823/mcp\"\nhttp_headers = { Authorization = \"Bearer ink1_x\" }\n"
        );
        assert_eq!(edit_toml(&added, &remote, false).unwrap().0, Change::Unchanged);
        let rotated = Endpoint { token: Some("ink1_y".into()), ..remote };
        assert_eq!(edit_toml(&added, &rotated, false).unwrap().0, Change::Updated);
    }
}
