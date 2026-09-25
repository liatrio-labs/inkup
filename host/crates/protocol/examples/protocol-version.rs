//! Writes `PROTOCOL_VERSION` to the file named by the first argument (stdout without one). The host release ships
//! it as `protocol-version.txt` (dist's `extra-artifacts`), so `inkup update` can warn before a host that raises it
//! locks out an installed extension (ADR 0008).

fn main() -> std::io::Result<()> {
    let line = format!("{}\n", inkup_protocol::PROTOCOL_VERSION);
    match std::env::args_os().nth(1) {
        Some(path) => std::fs::write(path, line),
        None => {
            print!("{line}");
            Ok(())
        }
    }
}
