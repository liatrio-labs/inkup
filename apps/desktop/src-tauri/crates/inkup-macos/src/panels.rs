//! Panels: a window the app made, turned into a non-activating panel that covers one display, so InkUp can draw
//! over whatever app the reviewer is using without taking its menu bar or its focus.
//!
//! The app makes the window (a transparent Tauri webview) and hands its `NSWindow *` over as a [`NativeWindow`]; the
//! panel is that same window, so the webview keeps running inside it. Panels start click-through: the pointer reaches
//! the app underneath until [`Panels::set_click_through`] turns that off.
//!
//! # The NSPanel binding: objc2, not tauri-nspanel
//!
//! The panel is bound through `objc2` 0.6 and `objc2-app-kit` 0.3 directly, the crates the app already uses for its
//! Dock icon. `tauri-nspanel` 2.1.1 does support this repo's Tauri (it needs tauri >= 2.8.5; the app is on 2.12.1),
//! but it was not pinned, because:
//!
//! - it depends on `tauri` (with `macos-private-api`), and this crate stays free of Tauri: it takes the window as a
//!   plain `NSWindow *`, so it builds with std alone on Linux and Windows, and the trait boundary is AppKit's, not
//!   Tauri's;
//! - what it does for a panel is small and is all here: define an `NSPanel` subclass, set the Tauri window's class
//!   to it (`object_setClass`), and sync WindowServer's activation-prevention tag after the style mask changes
//!   (`_setPreventsActivation:`), which its own source notes `setStyleMask:` skips after a class change;
//! - it would pull `objc2-app-kit` with every feature on, where this crate names the eight it needs.
//!
//! # The window rules
//!
//! [`PANEL`] holds them as plain values, so a unit test checks them without AppKit (`cargo test` does not run on the
//! main thread): non-activating (`NSWindowStyleMaskNonactivatingPanel`, borderless), `NSStatusWindowLevel`, on every
//! Space and beside full-screen apps (`canJoinAllSpaces`, `fullScreenAuxiliary`, plus `stationary` and
//! `ignoresCycle`), `hidesOnDeactivate` off, key only if a view needs it and never main, clear and shadowless, and
//! click-through (`ignoresMouseEvents`) at creation.

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

/// AppKit's values for the rules, as plain numbers (the `objc2-app-kit` constants are macOS-only). A macOS test
/// checks each against AppKit's own.
pub mod appkit {
    /// `NSWindowStyleMaskNonactivatingPanel`.
    pub const NONACTIVATING_PANEL: usize = 1 << 7;
    /// `NSStatusWindowLevel` (`kCGStatusWindowLevel`).
    pub const STATUS_WINDOW_LEVEL: isize = 25;
    /// `NSWindowCollectionBehaviorCanJoinAllSpaces`.
    pub const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    /// `NSWindowCollectionBehaviorStationary`: Mission Control leaves it in place.
    pub const STATIONARY: usize = 1 << 4;
    /// `NSWindowCollectionBehaviorIgnoresCycle`: Cmd-` skips it.
    pub const IGNORES_CYCLE: usize = 1 << 6;
    /// `NSWindowCollectionBehaviorFullScreenAuxiliary`.
    pub const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
}

/// The window rules every panel follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanelSpec {
    /// The whole style mask: borderless (0) and non-activating.
    pub style_mask: usize,
    pub level: isize,
    pub collection_behavior: usize,
    pub hides_on_deactivate: bool,
    /// Clicks reach the webview without making the panel key, unless a view needs keys.
    pub becomes_key_only_if_needed: bool,
    /// The panel class's `canBecomeKeyWindow`. Key status in a non-activating panel never activates the app.
    pub can_become_key: bool,
    /// The panel class's `canBecomeMainWindow`.
    pub can_become_main: bool,
    pub opaque: bool,
    pub has_shadow: bool,
    /// `ignoresMouseEvents` when the panel is created: click-through.
    pub ignores_mouse_events: bool,
}

/// The rules (R1.2, R1.3).
pub const PANEL: PanelSpec = PanelSpec {
    style_mask: appkit::NONACTIVATING_PANEL,
    level: appkit::STATUS_WINDOW_LEVEL,
    collection_behavior: appkit::CAN_JOIN_ALL_SPACES
        | appkit::FULL_SCREEN_AUXILIARY
        | appkit::STATIONARY
        | appkit::IGNORES_CYCLE,
    hides_on_deactivate: false,
    becomes_key_only_if_needed: true,
    can_become_key: true,
    can_become_main: false,
    opaque: false,
    has_shadow: false,
    ignores_mouse_events: true,
};

/// What AppKit reports for an open panel, read back from the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Observed {
    /// `isKindOfClass(NSPanel)`.
    pub is_panel: bool,
    pub style_mask: usize,
    pub level: isize,
    pub collection_behavior: usize,
    pub hides_on_deactivate: bool,
    pub becomes_key_only_if_needed: bool,
    pub visible: bool,
    /// Whether it took key or main status: it never should.
    pub key: bool,
    pub main: bool,
}

impl Observed {
    /// What a panel made to `spec` reports, shown and not key: for test doubles.
    pub fn of(spec: &PanelSpec) -> Self {
        Self {
            is_panel: true,
            style_mask: spec.style_mask,
            level: spec.level,
            collection_behavior: spec.collection_behavior,
            hides_on_deactivate: spec.hides_on_deactivate,
            becomes_key_only_if_needed: spec.becomes_key_only_if_needed,
            visible: true,
            key: false,
            main: false,
        }
    }

    /// The rules of `spec` that the window breaks, in words; empty when it follows them all. Masks need `spec`'s
    /// bits, not only those.
    pub fn broken(&self, spec: &PanelSpec) -> Vec<&'static str> {
        let checks = [
            (self.is_panel, "not an NSPanel"),
            (self.style_mask & spec.style_mask == spec.style_mask, "style mask lacks a rule's bit"),
            (self.level == spec.level, "wrong window level"),
            (
                self.collection_behavior & spec.collection_behavior == spec.collection_behavior,
                "collection behaviour lacks a rule's bit",
            ),
            (self.hides_on_deactivate == spec.hides_on_deactivate, "hidesOnDeactivate differs"),
            (self.becomes_key_only_if_needed == spec.becomes_key_only_if_needed, "becomesKeyOnlyIfNeeded differs"),
            (!self.main, "took main window status"),
        ];
        checks.into_iter().filter(|(ok, _)| !ok).map(|(_, rule)| rule).collect()
    }
}

/// An open panel, as [`Panels::list`] reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelInfo {
    /// The label it was created with (the app's window label, `spike-<n>`).
    pub label: String,
    pub bounds: Bounds,
    /// Whether the pointer passes through it to the app underneath.
    pub click_through: bool,
    pub observed: Observed,
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
    /// The panels among the app's windows (`NSApplication.windows`).
    fn list(&self) -> Result<Vec<PanelInfo>, Error>;
}

/// Between top-left-origin bounds and AppKit's frames, whose origin is the bottom left of the primary display with
/// y growing up. The flip is its own inverse, so it maps AppKit frames back too.
pub fn flip(bounds: Bounds, primary_height: f64) -> Bounds {
    Bounds { y: primary_height - bounds.y - bounds.height, ..bounds }
}

/// The OS's panels: AppKit on macOS, a stub that answers [`Error::Unsupported`] elsewhere. Every call must come on
/// the main thread, or it answers [`Error::NotMainThread`].
#[derive(Debug, Default, Clone, Copy)]
pub struct OsPanels;

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol};
    use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
    use objc2_app_kit::{
        NSApplication, NSColor, NSPanel, NSResponder, NSScreen, NSUserInterfaceItemIdentification, NSWindow,
        NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    use super::{Bounds, NativeWindow, Observed, OsPanels, PANEL, PanelInfo, Panels, flip};
    use crate::Error;

    define_class!(
        // SAFETY: NSPanel has no subclassing requirements. The class adds no instance variables and no Drop, and
        // its two overrides have AppKit's signatures (`- (BOOL)canBecomeKeyWindow`, `- (BOOL)canBecomeMainWindow`).
        #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "InkUpOverlayPanel"]
        pub(super) struct OverlayPanel;

        impl OverlayPanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                PANEL.can_become_key
            }

            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main_window(&self) -> bool {
                PANEL.can_become_main
            }
        }
    );

    fn main_thread() -> Result<MainThreadMarker, Error> {
        MainThreadMarker::new().ok_or(Error::NotMainThread)
    }

    /// The height of the primary display (the one with the menu bar, first in `NSScreen.screens`), in points.
    fn primary_height(mtm: MainThreadMarker) -> f64 {
        NSScreen::screens(mtm).iter().next().map_or(0.0, |screen| screen.frame().size.height)
    }

    /// The panels among the app's windows.
    fn open_panels(mtm: MainThreadMarker) -> Vec<Retained<NSPanel>> {
        let class = OverlayPanel::class();
        NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .filter(|window| window.isKindOfClass(class))
            .filter_map(|window| window.downcast::<NSPanel>().ok())
            .collect()
    }

    fn info(panel: &NSPanel, primary_height: f64) -> PanelInfo {
        let frame = panel.frame();
        let frame = Bounds { x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height };
        PanelInfo {
            label: panel.identifier().map(|id| id.to_string()).unwrap_or_default(),
            bounds: flip(frame, primary_height),
            click_through: panel.ignoresMouseEvents(),
            observed: Observed {
                is_panel: panel.isKindOfClass(NSPanel::class()),
                style_mask: panel.styleMask().0,
                level: panel.level(),
                collection_behavior: panel.collectionBehavior().0,
                hides_on_deactivate: panel.hidesOnDeactivate(),
                becomes_key_only_if_needed: panel.becomesKeyOnlyIfNeeded(),
                visible: panel.isVisible(),
                key: panel.isKeyWindow(),
                main: panel.isMainWindow(),
            },
        }
    }

    /// Why `from` cannot become an `OverlayPanel` in place, if it cannot: the object's memory has to hold the panel
    /// class's instance variables, and NSPanel must add none to NSWindow, since the class change skips NSPanel's
    /// initialiser and anything it would set up.
    fn unconvertible(from: &AnyClass) -> Option<String> {
        let window = NSWindow::class().instance_size();
        let panel = NSPanel::class().instance_size();
        let ours = OverlayPanel::class().instance_size();
        if !from_is_window(from) {
            return Some(format!("{} is not an NSWindow", from.name().to_string_lossy()));
        }
        if panel != window || ours != panel {
            return Some(format!("NSPanel ({panel} bytes) or InkUp's panel ({ours}) differs from NSWindow ({window})"));
        }
        if from.instance_size() < ours {
            return Some(format!("{} is smaller than a panel", from.name().to_string_lossy()));
        }
        None
    }

    fn from_is_window(class: &AnyClass) -> bool {
        let window = NSWindow::class();
        let mut candidate = Some(class);
        while let Some(class) = candidate {
            if class == window {
                return true;
            }
            candidate = class.superclass();
        }
        false
    }

    impl Panels for OsPanels {
        fn create(&self, label: &str, bounds: Bounds, window: NativeWindow) -> Result<PanelInfo, Error> {
            let mtm = main_thread()?;
            // Only a window the app owns: the pointer is compared, never dereferenced.
            let window = NSApplication::sharedApplication(mtm)
                .windows()
                .iter()
                .find(|candidate| Retained::as_ptr(candidate).cast::<c_void>() == window.0.cast_const())
                .ok_or(Error::NoSuchWindow)?;
            if !window.isKindOfClass(OverlayPanel::class()) {
                let object: &AnyObject = &window;
                if let Some(reason) = unconvertible(object.class()) {
                    return Err(Error::Unconvertible(reason));
                }
                // SAFETY: `object` is a live NSWindow of this app (found in `NSApplication.windows`, retained by
                // `window`), on the main thread. `unconvertible` checked that its class descends from NSWindow,
                // that NSPanel and OverlayPanel add no instance variables to NSWindow, and that the object is at
                // least as large, so every ivar the new class reads is NSWindow's own and initialised. What the
                // old class (Tao's `TaoWindow`) adds is one ivar read only by its own `canBecomeKeyWindow` /
                // `canBecomeMainWindow`, which OverlayPanel overrides, and a `sendEvent:` that only moves windows
                // by their background, which a panel never needs. This is what tauri-nspanel does.
                unsafe {
                    objc2::ffi::object_setClass(Retained::as_ptr(&window).cast_mut().cast(), OverlayPanel::class())
                };
            }
            let panel = window
                .downcast::<NSPanel>()
                .map_err(|_| Error::Unconvertible("the window did not become an NSPanel".into()))?;

            panel.setStyleMask(NSWindowStyleMask(PANEL.style_mask));
            // The class change skipped NSPanel's initialiser, and `setStyleMask:` does not tell WindowServer that the
            // panel must not activate the app: that is this private call, where the OS has it.
            let prevents_activation = sel!(_setPreventsActivation:);
            if panel.respondsToSelector(prevents_activation) {
                // SAFETY: `_setPreventsActivation:` takes one BOOL and returns void; `respondsToSelector:` checked
                // the panel implements it. Main thread, on a live panel.
                let () = unsafe { msg_send![&*panel, _setPreventsActivation: true] };
            }
            panel.setLevel(PANEL.level);
            panel.setCollectionBehavior(NSWindowCollectionBehavior(PANEL.collection_behavior));
            panel.setHidesOnDeactivate(PANEL.hides_on_deactivate);
            panel.setBecomesKeyOnlyIfNeeded(PANEL.becomes_key_only_if_needed);
            panel.setOpaque(PANEL.opaque);
            panel.setBackgroundColor(Some(&NSColor::clearColor()));
            panel.setHasShadow(PANEL.has_shadow);
            panel.setIgnoresMouseEvents(PANEL.ignores_mouse_events);
            panel.setIdentifier(Some(&NSString::from_str(label)));
            let height = primary_height(mtm);
            let frame = flip(bounds, height);
            let frame = NSRect::new(NSPoint::new(frame.x, frame.y), NSSize::new(frame.width, frame.height));
            panel.setFrame_display(frame, true);
            // Shown without making it key or activating the app.
            panel.orderFrontRegardless();
            Ok(info(&panel, height))
        }

        fn set_click_through(&self, on: bool) -> Result<(), Error> {
            let mtm = main_thread()?;
            for panel in open_panels(mtm) {
                panel.setIgnoresMouseEvents(on);
            }
            Ok(())
        }

        fn close_all(&self) -> Result<(), Error> {
            let mtm = main_thread()?;
            for panel in open_panels(mtm) {
                panel.orderOut(None);
                panel.close();
            }
            Ok(())
        }

        fn list(&self) -> Result<Vec<PanelInfo>, Error> {
            let mtm = main_thread()?;
            let height = primary_height(mtm);
            Ok(open_panels(mtm).iter().map(|panel| info(panel, height)).collect())
        }
    }

    #[cfg(test)]
    mod tests {
        use objc2::ClassType;
        use objc2_app_kit::{NSPanel, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

        use super::OverlayPanel;
        use crate::panels::appkit;

        #[test]
        fn panels_rules_are_appkits_own_values() {
            assert_eq!(appkit::NONACTIVATING_PANEL, NSWindowStyleMask::NonactivatingPanel.0);
            assert_eq!(appkit::STATUS_WINDOW_LEVEL, NSStatusWindowLevel);
            assert_eq!(appkit::CAN_JOIN_ALL_SPACES, NSWindowCollectionBehavior::CanJoinAllSpaces.0);
            assert_eq!(appkit::FULL_SCREEN_AUXILIARY, NSWindowCollectionBehavior::FullScreenAuxiliary.0);
            assert_eq!(appkit::STATIONARY, NSWindowCollectionBehavior::Stationary.0);
            assert_eq!(appkit::IGNORES_CYCLE, NSWindowCollectionBehavior::IgnoresCycle.0);
            assert_eq!(NSWindowStyleMask::Borderless.0, 0);
        }

        /// The class change in `create` is sound only while NSPanel adds no instance variables to NSWindow.
        #[test]
        fn panels_class_change_holds_on_this_macos() {
            let window = NSWindow::class().instance_size();
            assert_eq!(NSPanel::class().instance_size(), window, "NSPanel adds instance variables to NSWindow");
            assert_eq!(OverlayPanel::class().instance_size(), window);
            assert_eq!(OverlayPanel::class().superclass(), Some(NSPanel::class()));
            assert!(super::unconvertible(NSWindow::class()).is_none());
            assert!(super::unconvertible(NSPanel::class()).is_none());
            assert!(super::unconvertible(objc2::runtime::NSObject::class()).is_some());
        }
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

    #[test]
    fn panels_do_not_activate_the_app() {
        assert_eq!(PANEL.style_mask & appkit::NONACTIVATING_PANEL, appkit::NONACTIVATING_PANEL);
        // Borderless: no other style bit.
        assert_eq!(PANEL.style_mask, appkit::NONACTIVATING_PANEL);
        // Never main; key only when a view needs keys (which never activates the app from a non-activating panel).
        let (main, key_only_if_needed) = (PANEL.can_become_main, PANEL.becomes_key_only_if_needed);
        assert_eq!((main, key_only_if_needed), (false, true));
    }

    #[test]
    fn panels_sit_at_the_status_level_on_every_space_and_beside_full_screen_apps() {
        assert_eq!(PANEL.level, 25);
        assert_eq!(PANEL.level, appkit::STATUS_WINDOW_LEVEL);
        assert_ne!(PANEL.collection_behavior & appkit::CAN_JOIN_ALL_SPACES, 0);
        assert_ne!(PANEL.collection_behavior & appkit::FULL_SCREEN_AUXILIARY, 0);
    }

    #[test]
    fn panels_stay_when_the_app_deactivates_and_start_click_through() {
        let PanelSpec { hides_on_deactivate, ignores_mouse_events, opaque, has_shadow, .. } = PANEL;
        assert!(!hides_on_deactivate, "hidesOnDeactivate stays off");
        assert!(ignores_mouse_events, "click-through at creation");
        assert_eq!((opaque, has_shadow), (false, false), "clear and shadowless");
    }

    #[test]
    fn panels_report_the_rules_they_break() {
        let good = Observed::of(&PANEL);
        assert!(good.broken(&PANEL).is_empty());
        // Extra bits AppKit adds are fine; a missing rule bit is not.
        let extra = Observed { collection_behavior: PANEL.collection_behavior | 1 << 9, ..good };
        assert!(extra.broken(&PANEL).is_empty());
        let bad = Observed {
            is_panel: false,
            level: 0,
            collection_behavior: appkit::CAN_JOIN_ALL_SPACES,
            hides_on_deactivate: true,
            main: true,
            ..good
        };
        assert_eq!(
            bad.broken(&PANEL),
            [
                "not an NSPanel",
                "wrong window level",
                "collection behaviour lacks a rule's bit",
                "hidesOnDeactivate differs",
                "took main window status"
            ]
        );
    }

    #[test]
    fn panels_frames_flip_between_top_left_and_appkit_origins() {
        // A 1512x982 primary display, and a 1920x1080 one to its right with its top 100 pt higher.
        let primary = Bounds { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
        let right = Bounds { x: 1512.0, y: -100.0, width: 1920.0, height: 1080.0 };
        assert_eq!(flip(primary, 982.0), primary);
        assert_eq!(flip(right, 982.0), Bounds { x: 1512.0, y: 2.0, width: 1920.0, height: 1080.0 });
        assert_eq!(flip(flip(right, 982.0), 982.0), right);
    }

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
