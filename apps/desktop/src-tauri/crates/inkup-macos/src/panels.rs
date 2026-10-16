//! Panels: a window the app made, turned into a non-activating panel that covers one display, so InkUp can draw
//! over whatever app the reviewer is using without taking its menu bar or its focus.
//!
//! The app makes the window (a transparent Tauri webview) and hands its `NSWindow *` over as a [`NativeWindow`]; the
//! panel is that same window, so the webview keeps running inside it. Panels start click-through: the pointer reaches
//! the app underneath until [`Panels::set_click_through`] turns that off.

use std::ffi::c_void;

use crate::Error;

/// A display's bounds in points, in global screen coordinates with the origin at the top left of the primary
/// display and y growing down: CoreGraphics' convention, which Tauri's monitor list uses once divided by the
/// monitor's scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The window a panel hosts: the `NSWindow *` of a window the app made (Tauri's `WebviewWindow::ns_window()`).
/// Only an address: the crate looks it up among the app's own windows before it touches it, so a stale or wrong
/// pointer is an error, never a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeWindow(pub *mut c_void);

/// An open panel, as [`Panels::list`] reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelInfo {
    /// The label it was created with (the app's window label, `spike-<n>`).
    pub label: String,
    pub bounds: Bounds,
    /// Whether the pointer passes through it to the app underneath.
    pub click_through: bool,
}

/// Panels over the displays: the macOS implementation, or a stub, or a test double.
pub trait Panels {
    /// Turns `window` into a panel labelled `label` covering `bounds`, click-through, and shows it without
    /// activating the app.
    fn create(&self, label: &str, bounds: Bounds, window: NativeWindow) -> Result<PanelInfo, Error>;
    /// Click-through on (the pointer reaches the app underneath) or off (the panels catch it), on every open panel.
    fn set_click_through(&self, on: bool) -> Result<(), Error>;
    /// Closes every open panel, so none is left among the app's windows.
    fn close_all(&self) -> Result<(), Error>;
    /// The open panels.
    fn list(&self) -> Result<Vec<PanelInfo>, Error>;
}

/// The OS's panels: AppKit on macOS, a stub that answers [`Error::Unsupported`] elsewhere.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsPanels;

#[cfg(target_os = "macos")]
impl Panels for OsPanels {
    fn create(&self, _label: &str, _bounds: Bounds, _window: NativeWindow) -> Result<PanelInfo, Error> {
        Err(Error::Unsupported)
    }

    fn set_click_through(&self, _on: bool) -> Result<(), Error> {
        Err(Error::Unsupported)
    }

    fn close_all(&self) -> Result<(), Error> {
        Err(Error::Unsupported)
    }

    fn list(&self) -> Result<Vec<PanelInfo>, Error> {
        Err(Error::Unsupported)
    }
}

/// Linux and Windows: no panels, so the app says the platform is unsupported.
#[cfg(not(target_os = "macos"))]
impl Panels for OsPanels {
    fn create(&self, _label: &str, _bounds: Bounds, _window: NativeWindow) -> Result<PanelInfo, Error> {
        Err(Error::Unsupported)
    }

    fn set_click_through(&self, _on: bool) -> Result<(), Error> {
        Err(Error::Unsupported)
    }

    fn close_all(&self) -> Result<(), Error> {
        Err(Error::Unsupported)
    }

    fn list(&self) -> Result<Vec<PanelInfo>, Error> {
        Err(Error::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn panels_are_unsupported_off_macos() {
        let bounds = Bounds { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        let window = NativeWindow(std::ptr::null_mut());
        assert_eq!(OsPanels.create("spike-0", bounds, window), Err(Error::Unsupported));
        assert_eq!(OsPanels.set_click_through(false), Err(Error::Unsupported));
        assert_eq!(OsPanels.close_all(), Err(Error::Unsupported));
        assert_eq!(OsPanels.list(), Err(Error::Unsupported));
    }

    #[test]
    fn unsupported_reads_as_a_sentence() {
        assert_eq!(Error::Unsupported.to_string(), "Drawing over other apps works on macOS only.");
    }
}
