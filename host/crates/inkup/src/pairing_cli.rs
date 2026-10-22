//! `inkup pairing`: the only way a Remote Host issues a pairing code (ADR 0030).
//!
//! Each command finds the running Host through `host.json` and calls the control API on loopback with that
//! file's control token. Codes live in the Host's memory. This command stores nothing, and a restart burns
//! every outstanding code. Loopback and Network mode keep their own pairing.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::Subcommand;
use inkup_server::{OPERATOR_TTL_MAX, OPERATOR_TTL_MIN};
use inkup_store::instance::{HOST_FILE, holder};
use serde_json::{Value, json};

#[derive(Subcommand)]
pub enum PairingCommand {
    /// Print a one-time code, its Pair link and a QR code.
    ///
    /// The default lifetime is 15 minutes and the maximum is 24 hours.
    /// The code lives in memory only: restarting the Host burns it.
    Create {
        /// A label `pairing list` prints. Not the code.
        #[arg(long)]
        name: Option<String>,
        /// How long the code lasts, for example 15m or 24h. The default is 15m and the maximum is 24h.
        #[arg(long, value_name = "DURATION", value_parser = parse_ttl)]
        ttl: Option<Duration>,
        #[arg(long, env = "INKUP_DATA_DIR")]
        data_dir: Option<PathBuf>,
    },
    /// Outstanding codes: id, label, created, expires, guesses left. Never the code.
    ///
    /// Codes live in memory only. Restarting the Host burns them all.
    List {
        #[arg(long, env = "INKUP_DATA_DIR")]
        data_dir: Option<PathBuf>,
    },
    /// Burn one outstanding code.
    Revoke {
        /// Its id, from `pairing list` or from `pairing create`.
        id: String,
        #[arg(long, env = "INKUP_DATA_DIR")]
        data_dir: Option<PathBuf>,
    },
}

pub async fn run(command: PairingCommand) -> Result<()> {
    match command {
        PairingCommand::Create { name, ttl, data_dir } => create(data_dir, name, ttl).await,
        PairingCommand::List { data_dir } => list(data_dir).await,
        PairingCommand::Revoke { id, data_dir } => revoke(data_dir, &id).await,
    }
}

/// `15m`, `24h`, `90s` and the long unit names. Anything else is refused, including a bare number.
fn parse_ttl(raw: &str) -> Result<Duration, String> {
    let raw = raw.trim();
    let split = raw.find(|c: char| !c.is_ascii_digit()).ok_or_else(|| ttl_help(raw))?;
    let (num, unit) = raw.split_at(split);
    if num.is_empty() {
        return Err(ttl_help(raw));
    }
    let n: u64 = num.parse().map_err(|_| ttl_help(raw))?;
    let secs = match unit.trim() {
        "s" | "sec" | "secs" | "second" | "seconds" => n,
        "m" | "min" | "mins" | "minute" | "minutes" => {
            n.checked_mul(60).ok_or_else(|| "that ttl is too long".to_owned())?
        }
        "h" | "hr" | "hrs" | "hour" | "hours" => {
            n.checked_mul(3600).ok_or_else(|| "that ttl is too long".to_owned())?
        }
        _ => return Err(ttl_help(raw)),
    };
    let ttl = Duration::from_secs(secs);
    if ttl < OPERATOR_TTL_MIN {
        return Err("a pairing code's ttl must be at least 1 second".into());
    }
    if ttl > OPERATOR_TTL_MAX {
        return Err("a pairing code's ttl is at most 24h".into());
    }
    Ok(ttl)
}

fn ttl_help(raw: &str) -> String {
    format!("a ttl is a number and a unit, for example 15m or 24h (got {raw})")
}

struct Control {
    base: String,
    token: String,
}

/// The running Host's loopback control API. `control_port` is the separate listener a Remote Host binds;
/// without it, the public port is where loopback and Network mode serve the control API.
fn find(data_dir: Option<PathBuf>) -> Result<Control> {
    let dir = match data_dir {
        Some(dir) => dir,
        None => inkup_store::default_data_dir().context("no home directory; pass --data-dir")?,
    };
    let info = holder(&dir)?.context("no Host is running")?;
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.join(HOST_FILE)).context("read host.json")?).context("host.json")?;
    let port =
        raw.get("control_port").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()).unwrap_or(info.port);
    Ok(Control { base: format!("http://127.0.0.1:{port}"), token: info.control_token })
}

async fn call(control: &Control, method: &str, path: &str, body: Option<Value>) -> Result<reqwest::Response> {
    let mut request = reqwest::Client::new()
        .request(method.parse().context("method")?, format!("{}{path}", control.base))
        .bearer_auth(&control.token)
        .timeout(Duration::from_secs(5));
    if let Some(body) = body {
        request = request.json(&body);
    }
    match request.send().await {
        Ok(response) => Ok(response),
        Err(error) if error.is_connect() => bail!("no Host is running"),
        Err(error) => Err(error).context("call the control API"),
    }
}

async fn api_error(response: reqwest::Response) -> String {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_owned))
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| if text.trim().is_empty() { status.to_string() } else { text })
}

async fn create(data_dir: Option<PathBuf>, name: Option<String>, ttl: Option<Duration>) -> Result<()> {
    let control = find(data_dir)?;
    let mut body = json!({});
    if let Some(name) = name {
        body["label"] = json!(name);
    }
    if let Some(ttl) = ttl {
        body["ttl_secs"] = json!(ttl.as_secs());
    }
    let response = call(&control, "POST", "/api/host/pairing/codes", Some(body)).await?;
    if !response.status().is_success() {
        bail!("{}", api_error(response).await);
    }
    let made: Value = response.json().await.context("pairing create response")?;
    let code = made["code"].as_str().context("the Host did not return a code")?;
    let link = made["link"].as_str().context("the Host did not return a Pair link")?;
    let id = made["id"].as_str().unwrap_or("");
    let expires = made["expires_at"].as_i64().unwrap_or(0);
    println!("code: {code}");
    println!("id: {id}");
    println!("expires (UTC): {}", format_utc(expires));
    println!("{link}");
    for line in inkup_tui::qr_lines(link) {
        println!("{line}");
    }
    Ok(())
}

async fn list(data_dir: Option<PathBuf>) -> Result<()> {
    let control = find(data_dir)?;
    let response = call(&control, "GET", "/api/host/pairing/codes", None).await?;
    if !response.status().is_success() {
        bail!("{}", api_error(response).await);
    }
    let body: Value = response.json().await.context("pairing list response")?;
    let Some(codes) = body.get("codes").and_then(Value::as_array) else {
        bail!("the Host returned no code list");
    };
    for code in codes {
        let id = code.get("id").and_then(Value::as_str).unwrap_or("");
        let label = code.get("label").and_then(Value::as_str).filter(|label| !label.is_empty()).unwrap_or("-");
        let created = format_utc(code.get("created_at").and_then(Value::as_i64).unwrap_or(0));
        let expires = format_utc(code.get("expires_at").and_then(Value::as_i64).unwrap_or(0));
        let left = code.get("guesses_left").and_then(Value::as_u64).unwrap_or(0);
        println!("{id}  {label}  created {created} UTC  expires {expires} UTC  guesses left {left}");
    }
    Ok(())
}

async fn revoke(data_dir: Option<PathBuf>, id: &str) -> Result<()> {
    let control = find(data_dir)?;
    let response = call(&control, "DELETE", &format!("/api/host/pairing/codes/{id}"), None).await?;
    if response.status().as_u16() == 404 {
        bail!("no pairing code {id}");
    }
    if !response.status().is_success() {
        bail!("{}", api_error(response).await);
    }
    println!("revoked {id}");
    Ok(())
}

/// `YYYY-MM-DD HH:MM:SSZ` from epoch milliseconds. Howard Hinnant's civil-from-days, for a positive instant.
fn format_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    let (hour, minute, second) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ttl_is_a_number_and_a_unit_within_a_day() {
        assert_eq!(parse_ttl("15m").unwrap(), Duration::from_secs(15 * 60));
        assert_eq!(parse_ttl("24h").unwrap(), OPERATOR_TTL_MAX);
        assert_eq!(parse_ttl("90s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_ttl("1second").unwrap(), Duration::from_secs(1));
        assert!(parse_ttl("15").is_err());
        assert!(parse_ttl("25h").is_err());
        assert!(parse_ttl("0s").is_err());
        assert!(parse_ttl("1d").is_err());
    }

    #[test]
    fn epoch_zero_and_a_known_instant_format_as_utc() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00Z");
        assert_eq!(format_utc(1_700_000_000_000), "2023-11-14 22:13:20Z");
    }
}
