//! `config.toml` in the data dir: the Host's settings. The TUI writes it and a user may edit it; edits keep the
//! user's comments and anything this version does not know.

use std::path::Path;

use toml_edit::{DocumentMut, Item, Table, value};

use crate::{Result, StoreError, random_hex};

pub const CONFIG_FILE: &str = "config.toml";

/// The comment a new file starts with. Parsed alone it is the document's trailing decor, which toml_edit writes after
/// every key, so `write` moves it to the top.
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
        // A file an earlier version wrote has the header at the bottom: put it back on top.
        if header_at_bottom(&doc) {
            write(dir, &doc)?;
        }
        Ok(Self { network, hub_id })
    }

    /// Switches network mode in the file.
    pub fn save_network(dir: &Path, on: bool) -> Result<()> {
        let mut doc = read(dir)?;
        doc["network"] = value(on);
        write(dir, &doc)
    }
}

/// The desktop app's `[desktop]` table: where its icon shows. At least one is on, or the app could not be reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopConfig {
    /// An icon in the menu bar (macOS) or system tray.
    pub menubar: bool,
    /// An icon in the Dock (macOS) or taskbar.
    pub dock: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self { menubar: true, dock: true }
    }
}

impl DesktopConfig {
    /// The table's settings; a file with both off (edited by hand) gets the Dock back.
    pub fn load(dir: &Path) -> Result<Self> {
        let doc = read(dir)?;
        let on = |key: &str| doc.get("desktop").and_then(|t| t.get(key)).and_then(Item::as_bool).unwrap_or(true);
        let (menubar, dock) = (on("menubar"), on("dock"));
        Ok(Self { menubar, dock: dock || !menubar })
    }

    /// Writes the table, keeping the rest of the file. Both off is refused.
    pub fn save(self, dir: &Path) -> Result<()> {
        if !self.menubar && !self.dock {
            return Err(StoreError::Config("the menu bar icon and the Dock icon cannot both be off".into()));
        }
        let mut doc = read(dir)?;
        if !doc.get("desktop").is_some_and(Item::is_table) {
            doc["desktop"] = Item::Table(Table::new());
        }
        doc["desktop"]["menubar"] = value(self.menubar);
        doc["desktop"]["dock"] = value(self.dock);
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

fn header_at_bottom(doc: &DocumentMut) -> bool {
    doc.trailing().as_str().is_some_and(|trailing| trailing.contains(NEW_FILE))
}

/// The file's text, with the header first. Once written there it parses back as the first item's prefix, so it stays
/// on top and is not added twice; a header the user deleted is not added back.
fn render(doc: &DocumentMut) -> String {
    if !header_at_bottom(doc) {
        return doc.to_string();
    }
    let mut doc = doc.clone();
    let trailing = doc.trailing().as_str().unwrap_or_default().replacen(NEW_FILE, "", 1);
    doc.set_trailing(trailing);
    let body = doc.to_string();
    if body.is_empty() { NEW_FILE.to_owned() } else { format!("{NEW_FILE}\n{body}") }
}

fn write(dir: &Path, doc: &DocumentMut) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(CONFIG_FILE);
    let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
    std::fs::write(&tmp, render(doc))?;
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
        assert!(text.starts_with(NEW_FILE), "{text}");
    }

    fn text(dir: &Path) -> String {
        std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap()
    }

    #[test]
    fn a_new_file_starts_with_its_header() {
        let dir = tempfile::tempdir().unwrap();
        let config = HostConfig::load(dir.path()).unwrap();
        assert_eq!(text(dir.path()), format!("{NEW_FILE}\nhub_id = \"{}\"\n", config.hub_id));
    }

    #[test]
    fn edits_keep_the_header_on_top_once_and_the_users_comments() {
        let dir = tempfile::tempdir().unwrap();
        HostConfig::load(dir.path()).unwrap();
        let path = dir.path().join(CONFIG_FILE);
        std::fs::write(&path, text(dir.path()) + "\n# my note\n[mine]\nkept = true # inline\n").unwrap();
        for on in [true, false, true] {
            HostConfig::save_network(dir.path(), on).unwrap();
            HostConfig::load(dir.path()).unwrap();
        }
        let text = text(dir.path());
        assert!(text.starts_with(NEW_FILE), "{text}");
        assert_eq!(text.matches("# inkup host settings.").count(), 1, "{text}");
        assert!(text.contains("# my note\n[mine]\nkept = true # inline"), "{text}");
        assert!(text.contains("network = true"), "{text}");
    }

    #[test]
    fn a_header_an_earlier_version_left_at_the_bottom_moves_to_the_top() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        std::fs::write(&path, format!("hub_id = \"abc\"\n# mine\nnetwork = true\n{NEW_FILE}")).unwrap();
        assert_eq!(HostConfig::load(dir.path()).unwrap(), HostConfig { network: true, hub_id: "abc".into() });
        assert_eq!(text(dir.path()), format!("{NEW_FILE}\nhub_id = \"abc\"\n# mine\nnetwork = true\n"));
    }

    #[test]
    fn the_desktop_toggles_persist_and_cannot_both_be_off() {
        let dir = tempfile::tempdir().unwrap();
        let first = HostConfig::load(dir.path()).unwrap();
        assert_eq!(DesktopConfig::load(dir.path()).unwrap(), DesktopConfig::default());
        let tray_only = DesktopConfig { menubar: true, dock: false };
        tray_only.save(dir.path()).unwrap();
        HostConfig::save_network(dir.path(), true).unwrap();
        assert_eq!(DesktopConfig::load(dir.path()).unwrap(), tray_only);
        assert_eq!(HostConfig::load(dir.path()).unwrap(), HostConfig { network: true, ..first });
        let text = text(dir.path());
        assert!(text.starts_with(NEW_FILE), "{text}");
        assert!(text.contains("[desktop]\nmenubar = true\ndock = false\n"), "{text}");

        let off = DesktopConfig { menubar: false, dock: false };
        assert!(off.save(dir.path()).is_err());
        assert_eq!(DesktopConfig::load(dir.path()).unwrap(), tray_only, "a refused save changes nothing");
        // Both off by hand: the Dock comes back.
        std::fs::write(dir.path().join(CONFIG_FILE), "[desktop]\nmenubar = false\ndock = false\n").unwrap();
        assert_eq!(DesktopConfig::load(dir.path()).unwrap(), DesktopConfig { menubar: false, dock: true });
    }

    #[test]
    fn a_file_without_the_header_is_left_without_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        std::fs::write(&path, "# my own settings\nhub_id = \"abc\"\n").unwrap();
        HostConfig::save_network(dir.path(), true).unwrap();
        assert_eq!(text(dir.path()), "# my own settings\nhub_id = \"abc\"\nnetwork = true\n");
    }
}
