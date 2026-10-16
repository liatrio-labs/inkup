//! The InkUp desktop app's macOS helper. Every Apple framework call the app makes, and every `unsafe` block, lives
//! here behind a trait, so `inkup-desktop` keeps `unsafe_code = "forbid"` and its tests can run against a double.
//!
//! - [`Panels`]: non-activating panels over a display, hosting a window the app made (panels.rs).
//!
//! Off macOS every trait has a stub implementation whose methods answer [`Error::Unsupported`], so the crate builds
//! on the Linux and Windows CI legs with std alone.

pub mod panels;

pub use panels::{Bounds, NativeWindow, OsPanels, PanelInfo, Panels};

/// What a call into the crate can fail with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The platform has no implementation: anything but macOS.
    #[error("Drawing over other apps works on macOS only.")]
    Unsupported,
}
