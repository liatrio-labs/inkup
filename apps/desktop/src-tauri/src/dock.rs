//! The Dock icon on macOS, while the app runs. Tauri 2 cannot change it, and `NSApplication`'s
//! `setApplicationIconImage` is unsafe in objc2-app-kit, so the image goes in the Dock tile's content view instead:
//! the same picture, through safe calls only. The bundled .icns (Finder, the Dock before launch) never changes.

use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage, NSImageView, NSView};
use objc2_foundation::NSData;

/// Shows `png` as the Dock icon, or the bundled icon for `None`. Does nothing off the main thread.
pub fn show(png: Option<&[u8]>) {
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!("the Dock icon can only change on the main thread");
        return;
    };
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    let view = png.and_then(|png| {
        let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))?;
        Some(NSImageView::imageViewWithImage(&image, mtm))
    });
    let view: Option<&NSView> = view.as_deref().map(|v| v as &NSView);
    tile.setContentView(view);
    tile.display();
}
