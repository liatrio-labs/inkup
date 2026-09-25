//! `cargo run --example render_icons -- DIR`: writes the icon in every state (no dot, paired, the pulse's two beats;
//! development and release) at 16, 32, 128 and 512 px to DIR, for review. The app draws the same at run time.
use inkup_desktop::icon::{Dot, compose};

fn main() -> anyhow::Result<()> {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "icons-rendered".into()));
    std::fs::create_dir_all(&dir)?;
    let base = image::open(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.png"))?.to_rgba8();
    let states = [("none", Dot::None), ("paired", Dot::Full), ("pulse-on", Dot::Full), ("pulse-off", Dot::Faint)];
    for (build, development) in [("dev", true), ("release", false)] {
        for (state, dot) in states {
            for size in [16, 32, 128, 512] {
                let path = dir.join(format!("{build}-{state}-{size}.png"));
                compose(&base, size, development, dot).save(&path)?;
                println!("{}", path.display());
            }
        }
    }
    Ok(())
}
