//! src/generated.rs and src/control/generated.rs are typify's output for contract/protocol.schema.json and
//! contract/host-control.schema.json, committed. This fails when either is stale. Regenerate:
//! `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`.
use std::path::Path;

use typify::{TypeSpace, TypeSpaceSettings};

fn render(schema_file: &str) -> String {
    let header = format!(
        "// @generated from contract/{schema_file} by crates/protocol/tests/generated.rs.\n\
         // Do not edit: change the Zod schemas, run `pnpm schema`, then\n\
         // `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`.\n\n"
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(root.join("../../../contract").join(schema_file))
        .unwrap_or_else(|e| panic!("read contract/{schema_file}: {e}"));
    let schema: schemars::schema::RootSchema =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{schema_file} is JSON Schema: {e}"));
    let mut types = TypeSpace::new(TypeSpaceSettings::default().with_struct_builder(false));
    types.add_ref_types(schema.definitions).unwrap_or_else(|e| panic!("typify accepts {schema_file}: {e}"));
    let file = syn::parse2::<syn::File>(types.to_stream()).expect("typify emits valid Rust");
    format!("{header}{}", prettyplease::unparse(&file))
}

fn check(schema_file: &str, generated: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(generated);
    let fresh = render(schema_file);
    if std::env::var_os("UPDATE_PROTOCOL").is_some() {
        std::fs::write(&path, &fresh).unwrap_or_else(|e| panic!("write {generated}: {e}"));
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        committed == fresh,
        "{generated} is stale: run `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`"
    );
}

#[test]
fn generated_rs_matches_the_schema() {
    check("protocol.schema.json", "src/generated.rs");
}

#[test]
fn control_generated_rs_matches_the_schema() {
    check("host-control.schema.json", "src/control/generated.rs");
}
