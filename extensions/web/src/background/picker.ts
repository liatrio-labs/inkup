// The picker window (docs/decisions-log.md #41): Chrome's fallback when a Session started from the page's toolbar or
// the shortcut cannot have tabCapture (the extension was not invoked on the tab, or it navigated since). The Session
// starts as it did without video; this small extension window offers "Choose what to record", whose click opens the
// same screen picker as the side panel. The window then records the video itself (media/video-owner.ts): a stream
// lives in the document that opened it, so the window stays open, out of the way behind the reviewed window, until
// the Session ends. It closes with its Session, picked or not.
import { extensionWindow } from '@/platform/safari/windows';
import { activeSession } from '@/session-state';
import type { ActiveSession } from '@/settings';

const pickerWindow = /* @__PURE__ */ extensionWindow('pickerWindow', 'picker.html', { width: 380, height: 280 });

/** Opens the picker window for `s` at the top right of the window it records. */
export async function openPicker(s: ActiveSession): Promise<void> {
  await pickerWindow.ensure({ focus: true, near: s.window_id });
}

/** Closes the picker window when its Session ends. Stop has taken the window's last video chunk by then. */
export function initPicker(): void {
  activeSession.watch((s) => {
    if (!s) void pickerWindow.close();
  });
}
