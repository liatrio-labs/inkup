//! src/generated.rs is typify's output for packages/protocol/protocol.schema.json, committed. This fails when it is
//! stale. Regenerate: `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`.
use std::path::Path;

use typify::{TypeSpace, TypeSpaceSettings};

const HEADER: &str = "// @generated from packages/protocol/protocol.schema.json by crates/protocol/tests/generated.rs.\n\
// Do not edit: change the Zod schemas, run `pnpm schema`, then\n\
// `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`.\n\n";

fn render() -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(root.join("../../../packages/protocol/protocol.schema.json"))
        .expect("read packages/protocol/protocol.schema.json");
    let schema: schemars::schema::RootSchema =
        serde_json::from_str(&text).expect("protocol.schema.json is JSON Schema");
    let mut types = TypeSpace::new(TypeSpaceSettings::default().with_struct_builder(false));
    types.add_ref_types(schema.definitions).expect("typify accepts the protocol schema");
    let file = syn::parse2::<syn::File>(types.to_stream()).expect("typify emits valid Rust");
    format!("{HEADER}{}", prettyplease::unparse(&file))
}

#[test]
fn generated_rs_matches_the_schema() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/generated.rs");
    let fresh = render();
    if std::env::var_os("UPDATE_PROTOCOL").is_some() {
        std::fs::write(&path, &fresh).expect("write src/generated.rs");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        committed == fresh,
        "src/generated.rs is stale: run `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`"
    );
}
