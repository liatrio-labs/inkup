//! `inkup`: the host (ADR 0004).
//!
//! - no subcommand: the server with the TUI, where pairing requests are answered. Logs go to `inkup.log` in
//!   the data dir, since the screen is the TUI's.
//! - `serve`: the headless server. Pairing requests are asked on the terminal.
//! - `status`: whether a host is running, and what its store holds.
//! - `mcp install`: point Claude Code, Cursor or Codex at the host's `/mcp` (mcp_install.rs).
//! - `token create|list|revoke`: agent tokens, for agents on other machines in network mode (ADR 0006).
//! - `update`: install a newer inkup release, or say how (update.rs, ADR 0008). The TUI and `serve` check for one
//!   in the background at most once a day.
//!
//! Network mode (`--network`, or `network = true` in the data dir's config.toml, which the TUI's N key writes)
//! binds every interface; the default is 127.0.0.1 only.

mod mcp_install;
mod update;

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use inkup_protocol::Health;
use inkup_server::{Config, DEFAULT_PORT, NETWORK_WARNING, NetworkConfig, Server, lan_addresses};
use inkup_store::{DB_FILE, HostConfig, Store};

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
            if !std::io::stdout().is_terminal() {
                bail!("the TUI needs a terminal; run `inkup serve` for the headless host");
            }
            let dir = cli.common.data_dir()?;
            std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
            let log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(LOG_FILE))?;
            tracing_subscriber::fmt().with_writer(Arc::new(log)).with_ansi(false).with_env_filter(filter()).init();
            tui(cli.common, cli.network, dir).await
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

/// The server's config: network mode from the flag or the data dir's config.toml.
fn config(common: &Common, dir: &std::path::Path, network_flag: bool) -> Result<Config> {
    let settings = HostConfig::load(dir).with_context(|| format!("read the config in {}", dir.display()))?;
    let network = (network_flag || settings.network)
        .then(|| NetworkConfig { hub_id: settings.hub_id, ..NetworkConfig::default() });
    Ok(Config { port: common.port, network, hub_name: Some(hub_name()), ..Config::default() })
}

async fn start(store: Arc<Store>, config: Config) -> Result<Server> {
    let (port, network) = (config.port, config.network.is_some());
    let bind = if network { "0.0.0.0" } else { "127.0.0.1" };
    inkup_server::start(store, config)
        .await
        .with_context(|| format!("listen on {bind}:{port} (is another host running?)"))
}

async fn tui(common: Common, mut network_flag: bool, dir: PathBuf) -> Result<()> {
    let store = Arc::new(Store::open(&dir).with_context(|| format!("open the store in {}", dir.display()))?);
    let update = update::spawn_check(&dir);
    let mut terminal = inkup_tui::init();
    let result = async {
        loop {
            let config = config(&common, &dir, network_flag)?;
            let mut server = start(Arc::clone(&store), config).await?;
            let running = inkup_tui::Running {
                address: format!("127.0.0.1:{}", server.addr.port()),
                store: Arc::clone(&store),
                hub: Arc::clone(server.hub()),
                requests: server.take_pairing_requests().context("pairing requests already taken")?,
                network: server.network().cloned(),
                update: update.clone(),
            };
            let exit = inkup_tui::run(&mut terminal, running).await;
            server.shutdown().await?;
            match exit.context("the TUI failed")? {
                inkup_tui::Exit::Quit => return Ok(()),
                inkup_tui::Exit::SwitchNetwork(on) => {
                    HostConfig::save_network(&dir, on)?;
                    // The flag was for the first run; from here the saved setting decides.
                    network_flag = false;
                    tracing::info!(on, "network mode switched from the TUI");
                }
            }
        }
    }
    .await;
    inkup_tui::restore();
    result
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
    let store = Store::open(&dir).with_context(|| format!("open the store in {}", dir.display()))?;
    let mut config = Config { auto_approve_pairing, ..config(&common, &dir, network)? };
    if let Some(network) = &mut config.network {
        network.mdns_name = mdns_name;
    }
    if config.network.is_some() && auto_approve_pairing && !print_pairing_codes {
        bail!(
            "--auto-approve-pairing is refused in network mode: other machines on the LAN could pair. \
             (Tests pair by code with --print-pairing-codes.)"
        );
    }
    let mut server = start(Arc::new(store), config).await?;
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

    let mut update = update::spawn_check(&dir);
    tokio::spawn(async move {
        if update.wait_for(Option::is_some).await.is_ok()
            && let Some(notice) = update.borrow().as_deref()
        {
            eprintln!("{notice}");
        }
    });

    let requests = server.take_pairing_requests().context("pairing requests already taken")?;
    let prompt = tokio::spawn(inkup_tui::prompt_pairing(requests, print_pairing_codes));
    tokio::signal::ctrl_c().await?;
    prompt.abort();
    server.shutdown().await?;
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
    let url = format!("http://127.0.0.1:{}/health", common.port);
    let health = match reqwest::get(&url).await {
        Ok(response) if response.status().is_success() => Some(response.json::<Health>().await?),
        _ => None,
    };
    match &health {
        Some(health) => {
            let capabilities: Vec<&str> = health.capabilities.iter().map(|c| c.as_str()).collect();
            println!(
                "running: inkup {} on 127.0.0.1:{} (protocol {}; {})",
                health.version.as_str(),
                common.port,
                health.protocol_version,
                capabilities.join(", ")
            );
        }
        None => println!("not running on 127.0.0.1:{}", common.port),
    }

    let dir = common.data_dir()?;
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
