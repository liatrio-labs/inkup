// Firefox's media context: there is no offscreen document, but the background is an event page with a DOM
// (docs/browsers.md). The same offscreen.html runs in an iframe inside it, so the mic, recorder, transcription and
// voice detection code is unchanged and still talks to the background over runtime messages (a frame is its own
// extension context, so it receives what the background sends).
//
// Firefox suspends an event page after 30 s without an extension event, and the frame and its recording would go
// with it while the Session row still said "recording". So the frame sends the background a message every 10 s
// for as long as it exists: each one is an event, which restarts the idle timer.
const FRAME_ID = 'var-media-context';
const MEDIA_PATH = '/offscreen.html';
const KEEPALIVE = 'var:media-context-keepalive';
const KEEPALIVE_MS = 10_000;

let listening = false;

let creating: Promise<void> | null = null;

const frame = () => document.getElementById(FRAME_ID) as HTMLIFrameElement | null;

export async function ensureMediaFrame(): Promise<void> {
  if (frame()) return creating ?? undefined;
  const el = document.createElement('iframe');
  el.id = FRAME_ID;
  el.allow = 'microphone';
  el.src = chrome.runtime.getURL(MEDIA_PATH);
  if (!listening) {
    listening = true;
    // It only has to receive the message: the delivery is the event. It answers nothing.
    chrome.runtime.onMessage.addListener(() => undefined);
  }
  creating = new Promise<void>((resolve, reject) => {
    el.addEventListener(
      'load',
      () => {
        // The timer and the sender are the frame's own, so the message comes from another context and dies with it.
        const frameWindow = el.contentWindow as (Window & { chrome: typeof chrome }) | null;
        frameWindow?.setInterval(
          () => void frameWindow.chrome.runtime.sendMessage(KEEPALIVE).catch(() => {}),
          KEEPALIVE_MS,
        );
        resolve();
      },
      { once: true },
    );
    el.addEventListener('error', () => reject(new Error('the media context did not load')), { once: true });
  }).finally(() => (creating = null));
  document.body.append(el);
  await creating;
}

export async function closeMediaFrame(): Promise<void> {
  frame()?.remove();
}
