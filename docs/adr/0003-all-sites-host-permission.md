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

## History

Permissions added since, each without a new install warning unless noted:

- 2026-09-22 (Slice 1): `scripting`, to inject the content script into tabs already open at install or update, so
  drawing works without a reload. It adds no site access beyond `<all_urls>`.
- 2026-09-23 (U5): `activeTab`, so the `snap` shortcut can screenshot pages `<all_urls>` does not cover (other
  extensions' pages, `chrome://`). `management` was not requested just to name another extension in the Session list.
- 2026-09-23 (E1): `tabCapture` (Chrome only), for toolbar Sessions (ADR 0010). Only the Firefox build lists a
  web-accessible resource (`toolbar-start.html`), since a web-accessible page lets any site detect the extension.
- 2026-09-23 (E10): `alarms`, so a Cancel's Undo deadline survives a worker restart.
- 2026-09-23 (E14): `optional_host_permissions` for `http://*/*` and `ws://*/*` (Chrome, Firefox), to reach a Host on
  the LAN (ADR 0006). `<all_urls>` already covers both, so the options page checks `permissions.contains` first and
  requests only when it is false. Safari's manifest leaves the key out.
- 2026-09-23 (E6): `debugger` was built for viewport sizes and turned down for its install warning (ADR 0023).

## Sources

- <https://developer.chrome.com/docs/extensions/reference/api/tabs> (captureVisibleTab permissions)
- <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/uTtfM3Xbc3U> (activeTab not granted for side panel)
