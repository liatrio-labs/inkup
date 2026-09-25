//! `inkup-desktop [--data-dir DIR] [--port N]`: the desktop app. Another data dir (with `--port 0`) is another
//! instance, for development and tests.

// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;

#[derive(Parser)]
#[command(name = "inkup-desktop", version, about = "The InkUp desktop app")]
struct Args {
    /// Where the database and blobs live. Defaults to the OS per-user data dir, the CLI's.
    #[arg(long, env = "INKUP_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// The loopback port when the app hosts. 0 picks a free one.
    #[arg(long, default_value_t = inkup_server::DEFAULT_PORT)]
    port: u16,
}

fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "warn,inkup_desktop=info,inkup_server=info".into());
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(filter).init();
    let args = Args::parse();
    let data_dir = match args.data_dir {
        Some(dir) => dir,
        None => inkup_store::default_data_dir().context("no home directory; pass --data-dir")?,
    };
    inkup_desktop::run(inkup_desktop::Launch { data_dir, port: args.port })
}
