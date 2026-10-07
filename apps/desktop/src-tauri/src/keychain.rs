//! Tracker tokens in the OS keychain (ADR 0028): the Keychain on macOS, the Credential Manager on Windows, the
//! Secret Service on Linux. The window's Trackers view saves a token here and reads it back at the moment it sends
//! or tests; it never keeps one in localStorage, and nothing here goes to the host.
//!
//! One keychain item per tracker field, under the service `dev.inkup.desktop` and the account
//! `tracker:<tracker>:<field>` (`tracker:github:token`). Only the trackers InkUp knows, and plain field names, are
//! accepted, so the window cannot read or write any other item of the app's.

use keyring::Entry;

/// The keychain service the app's items are under.
const SERVICE: &str = "dev.inkup.desktop";
/// The trackers a token can be for (`TrackerName` in the contract).
const TRACKERS: &[&str] = &["github", "linear", "jira"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeychainError {
    #[error("InkUp keeps tokens for GitHub, Linear and Jira only, not {0:?}")]
    UnknownTracker(String),
    #[error("{0:?} is not a tracker setting InkUp keeps in the keychain")]
    BadField(String),
    #[error("The keychain refused: {0}. Unlock it, or allow InkUp to use it, then try again.")]
    Refused(String),
}

/// Where secrets go: the OS keychain, or memory in tests.
pub trait Secrets {
    fn get(&self, account: &str) -> Result<Option<String>, KeychainError>;
    fn set(&self, account: &str, value: &str) -> Result<(), KeychainError>;
    fn delete(&self, account: &str) -> Result<(), KeychainError>;
}

/// The OS keychain.
pub struct OsKeychain;

fn refused(error: keyring::Error) -> KeychainError {
    KeychainError::Refused(error.to_string())
}

impl Secrets for OsKeychain {
    fn get(&self, account: &str) -> Result<Option<String>, KeychainError> {
        match Entry::new(SERVICE, account).map_err(refused)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(refused(error)),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), KeychainError> {
        Entry::new(SERVICE, account).map_err(refused)?.set_password(value).map_err(refused)
    }

    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        match Entry::new(SERVICE, account).map_err(refused)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(refused(error)),
        }
    }
}

/// `tracker:<tracker>:<field>`, for a tracker InkUp knows and a field named in lower case letters and `_`.
pub fn account(tracker: &str, field: &str) -> Result<String, KeychainError> {
    if !TRACKERS.contains(&tracker) {
        return Err(KeychainError::UnknownTracker(tracker.to_owned()));
    }
    let plain = !field.is_empty() && field.len() <= 32 && field.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    if !plain {
        return Err(KeychainError::BadField(field.to_owned()));
    }
    Ok(format!("tracker:{tracker}:{field}"))
}

/// A saved secret, or `None`.
pub fn read(secrets: &dyn Secrets, tracker: &str, field: &str) -> Result<Option<String>, KeychainError> {
    secrets.get(&account(tracker, field)?)
}

/// Saves `value`, trimmed; an empty one removes the secret.
pub fn save(secrets: &dyn Secrets, tracker: &str, field: &str, value: &str) -> Result<(), KeychainError> {
    let account = account(tracker, field)?;
    match value.trim() {
        "" => secrets.delete(&account),
        value => secrets.set(&account, value),
    }
}

/// Off the async runtime: a keychain call can wait on the OS asking the user.
async fn off_runtime<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, KeychainError> + Send + 'static,
) -> Result<T, String> {
    match tauri::async_runtime::spawn_blocking(call).await {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// A tracker setting kept in the keychain (a token), or `null` when none is saved.
#[tauri::command]
pub async fn tracker_secret(tracker: String, field: String) -> Result<Option<String>, String> {
    off_runtime(move || read(&OsKeychain, &tracker, &field)).await
}

/// Saves a tracker setting in the keychain; an empty value removes it.
#[tauri::command]
pub async fn set_tracker_secret(tracker: String, field: String, value: String) -> Result<(), String> {
    off_runtime(move || save(&OsKeychain, &tracker, &field, &value)).await
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::*;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);

    impl Secrets for Memory {
        fn get(&self, account: &str) -> Result<Option<String>, KeychainError> {
            Ok(self.0.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), KeychainError> {
            self.0.borrow_mut().insert(account.to_owned(), value.to_owned());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), KeychainError> {
            self.0.borrow_mut().remove(account);
            Ok(())
        }
    }

    #[test]
    fn a_token_is_saved_read_back_and_removed() {
        let memory = Memory::default();
        assert_eq!(read(&memory, "github", "token").unwrap(), None);
        save(&memory, "github", "token", "  github_pat_DESKTOPCANARY \n").unwrap();
        assert_eq!(read(&memory, "github", "token").unwrap().as_deref(), Some("github_pat_DESKTOPCANARY"));
        assert_eq!(memory.0.borrow().keys().collect::<Vec<_>>(), ["tracker:github:token"]);
        save(&memory, "github", "token", " ").unwrap();
        assert_eq!(read(&memory, "github", "token").unwrap(), None);
    }

    #[test]
    fn only_known_trackers_and_plain_fields_are_kept() {
        assert_eq!(account("jira", "api_token").unwrap(), "tracker:jira:api_token");
        assert!(matches!(account("trello", "token"), Err(KeychainError::UnknownTracker(_))));
        for field in ["", "Token", "token:x", "../token", &"a".repeat(33)] {
            assert!(matches!(account("github", field), Err(KeychainError::BadField(_))), "{field:?}");
        }
    }
}
