---
status: accepted
date: 2026-09-22
---

# The extension requests `<all_urls>` host permission at install

A Session follows one tab through every URL it visits, including third-party checkouts. The drawing canvas must be
re-injected after each navigation and screenshots must keep working, both of which need host permission for the current
page. `activeTab`, granted by clicking the toolbar icon, is revoked on navigation, and it is not granted at all for side
panel interactions, which is where Start lives. Per-origin optional permissions would interrupt every cross-origin step
of a flow with a prompt. We accept the broad install-time permission because v1 is an unlisted, own-use release and the
extension makes no network calls the user has not configured.

## Consequences

- A public Chrome Web Store listing would face stricter review; revisit per-origin optional permissions before that.
- `captureVisibleTab` must be called from the service worker; the side panel lacks `activeTab` and would fail without
  host permissions.

## Sources

- <https://developer.chrome.com/docs/extensions/reference/api/tabs> (captureVisibleTab permissions)
- <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/uTtfM3Xbc3U> (activeTab not granted for side panel)
