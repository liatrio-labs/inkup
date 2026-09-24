---
status: accepted
date: 2026-09-22
---

# Video is captured with `getDisplayMedia` and the browser picker, not `chrome.tabCapture`

Chrome's documented path for recording a tab from an MV3 extension is `chrome.tabCapture.getMediaStreamId` called
synchronously inside a toolbar-icon, command or context-menu handler, consumed in an offscreen document. It targets the
reviewed tab deterministically with no dialog. We chose the picker anyway because the product owner wants Start to be a
button inside the side panel, and Chromium will not start tab capture from side panel gestures (crbug 40926394, Won't
Fix). The cost is one picker per Session in which the reviewer must choose the tab themselves: `preferCurrentTab`
resolves to the calling document, so no extension context can preselect or verify the reviewed tab, and the extension
cannot map the stream back to a tab id.

## Consequences

- The Session records whatever the reviewer picked. Screenshots come from the active tab via `captureVisibleTab`, so a
  wrong pick makes video and screenshots disagree. The panel shows the picked surface's label to make this visible.
- The `tabCapture` path from the toolbar icon is kept as P1-5 and is the fallback if the picker path regresses.

## Sources

- <https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture>
- <https://developer.chrome.com/docs/extensions/reference/api/tabCapture>
- <https://issues.chromium.org/issues/40926394>
- <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/media/webrtc/display_media_access_handler.cc>
- <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/gu8jM0VnKc0>
