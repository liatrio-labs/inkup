//! `inkup`: the host (ADR 0004).
//!
//! - no subcommand: the server with the TUI, where pairing requests are answered. Logs go to `inkup.log` in
//!   the data dir, since the screen is the TUI's.
//! - `serve`: the headless server. Pairing requests are asked on the terminal.
//! - `status`: whether a host is running, which one holds the data dir, and what its store holds.
//! - `mcp install`: point Claude Code, Cursor or Codex at the host's `/mcp` (mcp_install.rs).
//! - `token create|list|revoke`: agent tokens, for agents on other machines in network mode (ADR 0006).
//! - `update`: install a newer inkup release, or say how (update.rs, ADR 0008). The TUI and `serve` check for one
//!   in the background at most once a day.
//!
//! One host per data dir (`inkup_store::instance`): the TUI and `serve` take the data dir's lock before they start.
//! If another host holds it they say which and exit 1, first asking a desktop app holder to come forward.
//!
//! Network mode (`--network`, or `network = true` in the data dir's config.toml, which the TUI's N key writes)
//! binds every interface; the default is 127.0.0.1 only.

mod mcp_install;
mod update;

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use inkup_protocol::Health;
use inkup_server::{Config, Control, DEFAULT_PORT, NETWORK_WARNING, NetworkConfig, Server, VERSION, lan_addresses};
use inkup_store::instance::{HostInfo, HostKind, HostLock, LockError};
use inkup_store::{DB_FILE, HostConfig, Store};
use tokio::sync::watch;

const DEFAULT_LOG: &str = "warn,inkup=info,inkup_server=info,inkup_store=info,inkup_tui=info";

#[derive(Parser)]
#[command(name = "inkup", version, about = "The InkUp host", args_conflicts_with_subcommands = true)]
struct Cli {
    /// With no subcommand: the host with its TUI.
    #[command(flatten)]
    common: Common,
    /// Listen on every interface so other machines on this LAN can pair (unencrypted: trusted networks only).
    #[arg(long)]
    network: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the host server without the TUI.
    Serve {
        #[command(flatten)]
        common: Common,
        /// Approve every pairing request without asking. Testing only: any local process could pair.
        #[arg(long)]
        auto_approve_pairing: bool,
        /// Listen on every interface so other machines on this LAN can pair (unencrypted: trusted networks only).
        #[arg(long)]
        network: bool,
        /// Testing only: print each code for pairing from another machine as a `pairing code:` line on stdout.
        #[arg(long, hide = true)]
        print_pairing_codes: bool,
        /// The `.local` name to claim in network mode, without `.local`. Tests use their own.
        #[arg(long, hide = true, default_value = inkup_server::DEFAULT_MDNS_NAME)]
        mdns_name: String,
    },
    /// Agent tokens: what an agent on another machine sends to /mcp in network mode.
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },
    /// Say whether a host is running on the port, and what the data dir holds.
    Status {
        #[command(flatten)]
        common: Common,
    },
    /// Agents' MCP config.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
    /// Update inkup to the newest release (--check only says whether there is one).
    Update(update::UpdateArgs),
}

#[derive(Subcommand)]
enum McpCommand {
    /// Add the host to Claude Code, Cursor or Codex (or take it out with --reset).
    Install(mcp_install::InstallArgs),
}

#[derive(Subcommand)]
enum TokenCommand {
    /// Make a token and print it once.
    Create {
        /// Who it is for: `claude-code on laptop`.
        #[arg(long)]
        name: String,
        #[arg(long, env = "INKUP_DATA_DIR")]
        data_dir: Option<PathBuf>,
    },
    /// The tokens that work.
    List {
        #[arg(long, env = "INKUP_DATA_DIR")]
        data_dir: Option<PathBuf>,
    },
    /// Stop a token working.
    Revoke {
        /// Its id, from `token list`.
        id: String,
        #[arg(long, env = "INKUP_DATA_DIR")]
        data_dir: Option<PathBuf>,
    },
}

#[derive(Args)]
struct Common {
    /// Where the database and blobs live. Defaults to the OS per-user data dir.
    #[arg(long, env = "INKUP_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// The loopback port. 0 picks a free one (printed on start).
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
}

impl Common {
    fn data_dir(&self) -> Result<PathBuf> {
        match &self.data_dir {
            Some(dir) => Ok(dir.clone()),
            None => inkup_store::default_data_dir().context("no home directory; pass --data-dir"),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let filter = || tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| DEFAULT_LOG.into());
    match cli.command {
        Some(command) => {
            tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(filter()).init();
            match command {
                Command::Serve { common, auto_approve_pairing, network, print_pairing_codes, mdns_name } => {
                    serve(common, Serve { auto_approve_pairing, network, print_pairing_codes, mdns_name }).await
                }
                Command::Status { common } => status(common).await,
                Command::Token { command } => token(command),
                Command::Mcp { command: McpCommand::Install(args) } => mcp_install::install(args),
                Command::Update(args) => update::run(args).await,
            }
        }
        None => {
            let dir = cli.common.data_dir()?;
            std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
            // Before the terminal check: whoever runs `inkup` where a host already runs is told so.
            let lock = lock(&dir, HostKind::Tui).await?;
            if !std::io::stdout().is_terminal() {
                bail!("the TUI needs a terminal; run `inkup serve` for the headless host");
            }
            let log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(LOG_FILE))?;
            tracing_subscriber::fmt().with_writer(Arc::new(log)).with_ansi(false).with_env_filter(filter()).init();
            tui(cli.common, cli.network, dir, lock).await
        }
    }
}

const LOG_FILE: &str = "inkup.log";

/// The name other machines see: `inkup on studio-mac`.
fn hub_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    // `studio-mac.local`, `studio-mac.localdomain`: the first label is the machine's name.
    let host = host.split('.').next().unwrap_or_default();
    if host.is_empty() { "inkup".into() } else { format!("inkup on {host}") }
}

/// Takes the data dir's host lock. If another host holds it: says which (asking a desktop app to come forward
/// first) and exits 1.
async fn lock(dir: &Path, kind: HostKind) -> Result<HostLock> {
    let found = match HostLock::acquire(dir, kind) {
        Ok(lock) => return Ok(lock),
        Err(LockError::Store(error)) => return Err(error).context("lock the data dir"),
        Err(LockError::Held(found)) => found,
    };
    let found = match found {
        Some(found) => Some(found),
        None => published(dir).await,
    };
    if let Some(holder) = found.as_ref().filter(|holder| holder.kind == HostKind::Desktop) {
        activate(holder).await;
    }
    let who = found.as_ref().map_or_else(|| "starting up".to_owned(), HostInfo::describe);
    eprintln!("InkUp is already running ({who}). Use --data-dir for a separate instance.");
    std::process::exit(1);
}

/// A holder that has just taken the lock writes `host.json` once its server binds: wait a moment for it.
async fn published(dir: &Path) -> Option<HostInfo> {
    for _ in 0..30 {
        if let Ok(Some(found)) = inkup_store::instance::holder(dir) {
            return Some(found);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

/// Asks the host to come forward (`POST /api/host/activate`); best effort.
async fn activate(holder: &HostInfo) {
    let url = format!("http://127.0.0.1:{}/api/host/activate", holder.port);
    let sent = reqwest::Client::new()
        .post(url)
        .bearer_auth(&holder.control_token)
        .timeout(Duration::from_secs(2))
        .send()
        .await;
    if let Err(error) = sent {
        tracing::warn!(%error, "could not ask the running host to come forward");
    }
}

/// The control API's settings for this process's lock.
fn control(lock: &HostLock, update: &watch::Receiver<Option<String>>) -> Control {
    Control {
        token: lock.control_token().to_owned(),
        kind: lock.kind(),
        on_activate: None,
        on_network: None,
        update: Some(update.clone()),
    }
}

/// The server's config: network mode from the flag or the data dir's config.toml.
fn config(common: &Common, dir: &Path, network_flag: bool, control: Control) -> Result<Config> {
    let settings = HostConfig::load(dir).with_context(|| format!("read the config in {}", dir.display()))?;
    let network = (network_flag || settings.network)
        .then(|| NetworkConfig { hub_id: settings.hub_id, ..NetworkConfig::default() });
    Ok(Config { port: common.port, network, hub_name: Some(hub_name()), control: Some(control), ..Config::default() })
}

/// Starts the server and writes `host.json` for it.
async fn start(store: Arc<Store>, config: Config, lock: &HostLock) -> Result<Server> {
    let (port, network) = (config.port, config.network.is_some());
    let bind = if network { "0.0.0.0" } else { "127.0.0.1" };
    let server = inkup_server::start(store, config)
        .await
        .with_context(|| format!("listen on {bind}:{port} (is another host running?)"))?;
    lock.publish(server.addr.port(), VERSION).context("write host.json")?;
    Ok(server)
}

async fn tui(common: Common, network_flag: bool, dir: PathBuf, lock: HostLock) -> Result<()> {
    let store = Arc::new(Store::open(&dir).with_context(|| format!("open the store in {}", dir.display()))?);
    let update = update::spawn_check(&dir);
    let mut terminal = inkup_tui::init();
    let run = async |running| inkup_tui::run(&mut terminal, running).await.context("the TUI failed");
    let result = host_tui(&common, network_flag, &dir, &lock, store, &update, run).await;
    inkup_tui::restore();
    result
}

/// Serves and runs the TUI (`run`) until it quits, restarting the server when it switches network mode. A restart
/// binds the port the first start bound, with `--port 0` too, so host.json, Clients and agents keep the address.
async fn host_tui(
    common: &Common,
    mut network_flag: bool,
    dir: &Path,
    lock: &HostLock,
    store: Arc<Store>,
    update: &watch::Receiver<Option<String>>,
    mut run: impl AsyncFnMut(inkup_tui::Running) -> Result<inkup_tui::Exit>,
) -> Result<()> {
    let mut port = common.port;
    loop {
        let config = Config { port, ..config(common, dir, network_flag, control(lock, update))? };
        let mut server = start(Arc::clone(&store), config, lock).await?;
        port = server.addr.port();
        let running = inkup_tui::Running {
            address: format!("127.0.0.1:{port}"),
            store: Arc::clone(&store),
            hub: Arc::clone(server.hub()),
            requests: server.take_pairing_requests().context("pairing requests already taken")?,
            network: server.network().cloned(),
            update: update.clone(),
        };
        let exit = run(running).await;
        server.shutdown().await?;
        match exit? {
            inkup_tui::Exit::Quit => return Ok(()),
            inkup_tui::Exit::SwitchNetwork(on) => {
                HostConfig::save_network(dir, on)?;
                // The flag was for the first run; from here the saved setting decides.
                network_flag = false;
                tracing::info!(on, "network mode switched from the TUI");
            }
        }
    }
}

struct Serve {
    auto_approve_pairing: bool,
    network: bool,
    print_pairing_codes: bool,
    mdns_name: String,
}

async fn serve(common: Common, flags: Serve) -> Result<()> {
    let Serve { auto_approve_pairing, network, print_pairing_codes, mdns_name } = flags;
    let dir = common.data_dir()?;
    let lock = lock(&dir, HostKind::Serve).await?;
    let store = Store::open(&dir).with_context(|| format!("open the store in {}", dir.display()))?;
    let mut update = update::spawn_check(&dir);
    let mut config = Config { auto_approve_pairing, ..config(&common, &dir, network, control(&lock, &update))? };
    if let Some(network) = &mut config.network {
        network.mdns_name = mdns_name;
    }
    if config.network.is_some() && auto_approve_pairing && !print_pairing_codes {
        bail!(
            "--auto-approve-pairing is refused in network mode: other machines on the LAN could pair. \
             (Tests pair by code with --print-pairing-codes.)"
        );
    }
    let mut server = start(Arc::new(store), config, &lock).await?;
    if auto_approve_pairing {
        tracing::warn!("--auto-approve-pairing: every pairing request from this machine is approved without asking");
    }
    let port = server.addr.port();
    // The first stdout line is the address, for scripts and test harnesses that start the host on port 0.
    println!("inkup listening on http://127.0.0.1:{port}");
    std::io::stdout().flush()?;
    eprintln!("data dir: {}", dir.display());
    eprintln!("MCP for agents: http://127.0.0.1:{port}/mcp");
    if let Some(network) = server.network() {
        eprintln!("\n{NETWORK_WARNING}");
        for ip in lan_addresses() {
            eprintln!("other machines: http://{ip}:{port}");
        }
        eprintln!("agents on other machines need a token: inkup token create --name <agent>");
        let network = Arc::clone(network);
        tokio::spawn(async move {
            for _ in 0..50 {
                if let Some(name) = network.claimed_name() {
                    eprintln!("on mDNS as http://{name}:{port}");
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            eprintln!("no .local name claimed (no multicast?): give other machines an address above");
        });
    }

    tokio::spawn(async move {
        if update.wait_for(Option::is_some).await.is_ok()
            && let Some(notice) = update.borrow().as_deref()
        {
            eprintln!("{notice}");
        }
    });

    let requests = server.take_pairing_requests().context("pairing requests already taken")?;
    let prompt = tokio::spawn(inkup_tui::prompt_pairing(requests, print_pairing_codes));
    stop_requested().await?;
    prompt.abort();
    server.shutdown().await?;
    Ok(())
}

/// Ctrl-C, or on Unix SIGTERM (`kill`, a service manager's stop): either way serve shuts down and gives up the data
/// dir, host.json included.
async fn stop_requested() -> Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            stopped = tokio::signal::ctrl_c() => stopped?,
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

fn token(command: TokenCommand) -> Result<()> {
    let open = |dir: Option<PathBuf>| -> Result<Store> {
        let dir = match dir {
            Some(dir) => dir,
            None => inkup_store::default_data_dir().context("no home directory; pass --data-dir")?,
        };
        Store::open(&dir).with_context(|| format!("open the store in {}", dir.display()))
    };
    match command {
        TokenCommand::Create { name, data_dir } => {
            let made = open(data_dir)?.create_agent_token(&name)?;
            // The token alone on stdout, for scripts; the rest to stderr.
            println!("{}", made.token);
            eprintln!("agent token {} for {name}: shown once, keep it secret.", made.agent.id);
            eprintln!(
                "on the agent's machine: inkup mcp install --remote http://<this hub>:{DEFAULT_PORT} --token <token>"
            );
        }
        TokenCommand::List { data_dir } => {
            for token in open(data_dir)?.agent_tokens()? {
                let used = if token.last_used_at.is_some() { "used" } else { "never used" };
                println!("{}  {}  ({used})", token.id, token.name);
            }
        }
        TokenCommand::Revoke { id, data_dir } => {
            if !open(data_dir)?.revoke_agent_token(&id)? {
                bail!("no working token {id}");
            }
            println!("revoked {id}");
        }
    }
    Ok(())
}

async fn status(common: Common) -> Result<()> {
    let dir = common.data_dir()?;
    // The data dir's host, if one wrote host.json: its port is where to look.
    let holder = inkup_store::instance::holder(&dir)?;
    let port = holder.as_ref().map_or(common.port, |holder| holder.port);
    let url = format!("http://127.0.0.1:{port}/health");
    let health = match reqwest::get(&url).await {
        Ok(response) if response.status().is_success() => Some(response.json::<Health>().await?),
        _ => None,
    };
    match &health {
        Some(health) => {
            let capabilities: Vec<&str> = health.capabilities.iter().map(|c| c.as_str()).collect();
            println!(
                "running: inkup {} on 127.0.0.1:{port} (protocol {}; {})",
                health.version.as_str(),
                health.protocol_version,
                capabilities.join(", ")
            );
        }
        None => println!("not running on 127.0.0.1:{port}"),
    }
    if let Some(holder) = holder.as_ref().filter(|_| health.is_some()) {
        println!("host: {}", holder.describe());
    }

    if dir.join(DB_FILE).exists() {
        let store = Store::open(&dir)?;
        println!(
            "data dir: {} ({} Sessions, {} paired Clients)",
            dir.display(),
            store.sessions()?.len(),
            store.clients()?.len()
        );
    } else {
        println!("data dir: {} (empty)", dir.display());
    }
    if health.is_none() {
        bail!("no host is running");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With `--port 0` the first start takes a free port; switching network mode restarts on that port rather than
    /// on a new free one, and host.json keeps it.
    #[tokio::test]
    async fn a_network_switch_keeps_the_port_that_port_0_bound() {
        let dir = tempfile::tempdir().unwrap();
        let lock = HostLock::acquire(dir.path(), HostKind::Tui).unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let common = Common { data_dir: Some(dir.path().into()), port: 0 };
        let (_notice, update) = watch::channel(None);
        let mut ports = Vec::new();
        let run = async |running: inkup_tui::Running| {
            let port = running.address.rsplit(':').next().unwrap().parse::<u16>().unwrap();
            assert_eq!(inkup_store::instance::holder(dir.path()).unwrap().unwrap().port, port, "host.json");
            ports.push(port);
            // Off to off: a restart like any switch, without binding every interface.
            Ok(if ports.len() < 3 { inkup_tui::Exit::SwitchNetwork(false) } else { inkup_tui::Exit::Quit })
        };
        host_tui(&common, false, dir.path(), &lock, store, &update, run).await.unwrap();
        assert_eq!(ports.len(), 3);
        assert_ne!(ports[0], 0);
        assert!(ports.iter().all(|port| *port == ports[0]), "{ports:?}");
    }
}
