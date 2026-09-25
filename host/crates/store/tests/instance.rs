//! One host per data dir: the lock, and `host.json` for whoever finds it held.
use inkup_store::instance::{CONTROL_API, HOST_FILE, HostKind, HostLock, LockError, holder};

#[test]
fn a_second_acquire_on_the_same_dir_is_told_who_holds_it() {
    let dir = tempfile::tempdir().unwrap();
    let lock = HostLock::acquire(dir.path(), HostKind::Desktop).unwrap();
    // Held but not yet published: nobody to call.
    assert!(matches!(HostLock::acquire(dir.path(), HostKind::Serve), Err(LockError::Held(None))));

    let info = lock.publish(47999, "9.9.9").unwrap();
    assert_eq!(info.kind, HostKind::Desktop);
    assert_eq!(info.pid, std::process::id());
    assert_eq!(info.control_api, CONTROL_API);
    assert_eq!(info.control_token.len(), 64, "32 random bytes, hex");
    assert_eq!(info.control_token, lock.control_token());
    match HostLock::acquire(dir.path(), HostKind::Tui) {
        Err(LockError::Held(Some(found))) => assert_eq!(found, info),
        other => panic!("expected Held(Some), got {other:?}"),
    }
    assert_eq!(info.describe(), format!("desktop app, pid {}, port 47999", std::process::id()));
}

#[test]
fn other_dirs_are_other_instances() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let _a = HostLock::acquire(a.path(), HostKind::Serve).unwrap();
    let _b = HostLock::acquire(b.path(), HostKind::Serve).unwrap();
}

#[test]
fn dropping_the_lock_frees_the_dir_and_removes_host_json() {
    let dir = tempfile::tempdir().unwrap();
    let lock = HostLock::acquire(dir.path(), HostKind::Serve).unwrap();
    lock.publish(1, "0").unwrap();
    drop(lock);
    assert_eq!(holder(dir.path()).unwrap(), None);
    HostLock::acquire(dir.path(), HostKind::Serve).unwrap();
}

#[test]
fn a_host_json_left_by_a_dead_holder_is_cleared_on_acquire() {
    let dir = tempfile::tempdir().unwrap();
    // What a killed holder leaves: its file, but no lock (the OS dropped it with the process).
    let stale = r#"{"pid":1,"kind":"tui","port":1,"control_token":"x","control_api":1,"version":"0","started_at":0}"#;
    std::fs::write(dir.path().join(HOST_FILE), stale).unwrap();
    assert!(holder(dir.path()).unwrap().is_some());
    let _lock = HostLock::acquire(dir.path(), HostKind::Serve).unwrap();
    assert_eq!(holder(dir.path()).unwrap(), None);
}

#[cfg(unix)]
#[test]
fn host_json_is_only_readable_by_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let lock = HostLock::acquire(dir.path(), HostKind::Serve).unwrap();
    lock.publish(1, "0").unwrap();
    let mode = std::fs::metadata(dir.path().join(HOST_FILE)).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}
