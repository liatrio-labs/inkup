//! `config.toml` in the data dir: the Host's settings. The TUI writes it and a user may edit it; edits keep the
//! user's comments and anything this version does not know.

use std::path::Path;

use toml_edit::{DocumentMut, value};

use crate::{Result, StoreError, random_hex};

pub const CONFIG_FILE: &str = "config.toml";

const NEW_FILE: &str = "\
# inkup host settings.
#
# network = true binds every interface so other machines on this LAN can pair and send Sessions (ADR 0006).
# The traffic is unencrypted: use it on trusted networks only. `inkup serve --network` turns it on for one
# run; the TUI's N key switches it and writes it here.
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    /// Network mode: listen on every interface and advertise on mDNS.
    pub network: bool,
    /// This Host's id in mDNS TXT records, so a Client can tell two Hosts with the same name apart.
    pub hub_id: String,
}

impl HostConfig {
    /// Reads the file, creating it (and a hub id) on first use.
    pub fn load(dir: &Path) -> Result<Self> {
        let mut doc = read(dir)?;
        let network = doc.get("network").and_then(|v| v.as_bool()).unwrap_or(false);
        let hub_id = match doc.get("hub_id").and_then(|v| v.as_str()) {
            Some(id) if !id.is_empty() => id.to_owned(),
            _ => {
                let id = random_hex(8)?;
                doc["hub_id"] = value(id.as_str());
                write(dir, &doc)?;
                id
            }
        };
        Ok(Self { network, hub_id })
    }

    /// Switches network mode in the file.
    pub fn save_network(dir: &Path, on: bool) -> Result<()> {
        let mut doc = read(dir)?;
        doc["network"] = value(on);
        write(dir, &doc)
    }
}

fn read(dir: &Path) -> Result<DocumentMut> {
    let text = match std::fs::read_to_string(dir.join(CONFIG_FILE)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => NEW_FILE.to_owned(),
        Err(e) => return Err(e.into()),
    };
    text.parse().map_err(|e: toml_edit::TomlError| StoreError::Config(e.to_string()))
}

fn write(dir: &Path, doc: &DocumentMut) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(CONFIG_FILE);
    let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
    std::fs::write(&tmp, doc.to_string())?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_mode_persists_and_the_users_comments_stay() {
        let dir = tempfile::tempdir().unwrap();
        let first = HostConfig::load(dir.path()).unwrap();
        assert!(!first.network);
        assert_eq!(HostConfig::load(dir.path()).unwrap().hub_id, first.hub_id, "the hub id is kept");
        let path = dir.path().join(CONFIG_FILE);
        let edited = std::fs::read_to_string(&path).unwrap() + "# mine\nextra = 1\n";
        std::fs::write(&path, edited).unwrap();
        HostConfig::save_network(dir.path(), true).unwrap();
        assert_eq!(HostConfig::load(dir.path()).unwrap(), HostConfig { network: true, ..first });
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# mine\nextra = 1") && text.contains("trusted networks only"), "{text}");
    }
}
