// The toolbar's Start where it must be an extension frame (Firefox; docs/spikes/toolbar-start.md). A click in this
// frame is a user activation in an extension document, so it can open the screen picker, which a click on the page's
// own toolbar cannot. The frame then starts the Session for the tab it sits in and records the video itself, like
// the side panel does, holding the panel Port as a video owner that does not stop the Session: if its page navigates
// away the video ends there and the Session goes on.

import { FRAME_ERROR, FRAME_READY, FRAME_RECORDING } from '@/content/toolbar';
import { pickTabVideo, TabVideoRecorder } from '@/media/tab-video';
import { holdVideo } from '@/media/video-owner';
import { sendMessage } from '@/messaging';

const button = document.getElementById('start') as HTMLButtonElement;
let recorder: TabVideoRecorder | null = null;

const tell = (msg: { type: string; error?: string; on?: boolean }) => window.parent.postMessage(msg, '*');

button.addEventListener('click', async () => {
  const clickedAt = Date.now();
  button.disabled = true;
  // Said at once, not once recording: the Session (and a page's dialog) can reach the toolbar before this frame gets
  // the start's answer, and moving the overlay host meanwhile would reload this frame (content/top-layer.ts).
  tell({ type: FRAME_RECORDING, on: true });
  // First, while the click's activation is fresh: the screen picker.
  const picked = await pickTabVideo();
  // The keyboard goes back to the page, where the mode shortcuts and Esc are heard: left here, they would reach
  // this frame instead for the whole Session (F1).
  button.blur();
  window.parent.focus();
  try {
    const r = await sendMessage('startSession', { video: picked.info, clicked_at: clickedAt, from_toolbar: true });
    if (!r.ok) {
      picked.stream?.getTracks().forEach((t) => {
        t.stop();
      });
      tell({ type: FRAME_ERROR, error: r.error });
      return;
    }
    if (picked.stream) {
      const rec = new TabVideoRecorder(picked.stream, r.session.id, r.session.t0);
      recorder = rec;
      rec.start();
      // Said once the capture is stopped (flush stops its tracks), so the page knows the picker's surface is free.
      holdVideo(rec, () => {
        if (recorder !== rec) return;
        recorder = null;
        tell({ type: FRAME_RECORDING, on: false });
      });
    }
  } catch (e) {
    picked.stream?.getTracks().forEach((t) => {
      t.stop();
    });
    tell({ type: FRAME_ERROR, error: String(e) });
  } finally {
    button.disabled = false;
    if (!recorder) tell({ type: FRAME_RECORDING, on: false });
  }
});

// The page is going away: ask the recorder for what it has; the Port's disconnect then ends the video
// (media/video-owner.ts).
addEventListener('pagehide', () => recorder?.requestData());

button.disabled = false;
tell({ type: FRAME_READY });
