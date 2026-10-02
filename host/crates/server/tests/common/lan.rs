//! The one gate for tests that listen beyond loopback: a bind on every interface (network mode, ADR 0006) or mDNS.
//! Shared by the server's tests through `common`, and by the CLI's and the desktop app's tests through `#[path]`.

/// Whether the tests that listen beyond loopback run: only with `INKUP_LAN_TESTS=1`, which CI sets. Each rebuild makes
/// the test binary a new unsigned program, and macOS asks "accept incoming network connections?" on its first such
/// listen, every time. Call it before anything binds: the prompt comes on the listen, so a skip after it is too late.
/// Under `CI` without the variable it fails rather than skips, so CI cannot lose these tests unnoticed.
pub fn lan_tests_enabled() -> bool {
    if std::env::var_os("INKUP_LAN_TESTS").is_some_and(|value| value == "1") {
        return true;
    }
    assert!(std::env::var_os("CI").is_none(), "CI runs the LAN tests: set INKUP_LAN_TESTS=1 on its cargo test step");
    eprintln!("skipped: listens beyond loopback; run with INKUP_LAN_TESTS=1 (CI does)");
    false
}
