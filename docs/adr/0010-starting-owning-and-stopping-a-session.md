---
status: accepted
date: 2026-09-22
---

# A Session binds to the tab it was started on, the service worker owns it, and whatever holds its media decides what closing means

A Session can start from the side panel, from the floating toolbar on the page, from Alt+Shift+R, or from the Host's
TUI. Wherever it starts, the service worker owns the live Session (ADR 0004): the panel, the toolbar and the page only
render the state it pushes and send it requests. What differs between browsers is where the microphone and the video
live, and so what the user can close by accident. This ADR collects the rules for binding, starting, stopping and
cancelling a Session, and where its media is recorded.

**Binding.** Start binds to the tab it was asked from: the sender's tab for the toolbar and the shortcut (`targetTab`),
the active tab of the last focused window for the panel. `packages/core/src/target.ts` says what a Session can do on a
URL: `page` (web pages and `file:`, the content script's overlay), `own_page` (our review, Sessions, options and
onboarding pages, which mount the same overlay themselves with `mountPageOverlay()`), `no_overlay` (other extensions'
pages, `chrome://`, `about:`, the Web Store: audio, transcript, video and URL only, screenshots through the `snap`
shortcut), or not recordable at all (our side panel, the offscreen document, devtools, view-source). A tab that cannot
be recorded gets a message naming it; there is no silent fallback to another tab. The Session follows its tab: a
completed load or an in-page URL change is a navigation, and the mode is recomputed on it.

**Start shows the Session before anything slow.** `startSession` writes the Session with `starting: true`, pushes it to
the page and waits (at most 3 s) for the overlay to say it has applied it. Only then do the capture id, the media
context, the microphone, transcription and the recorders start, and until then the toolbar says "Starting…" with every
control off. Stop, Pause, Mute, Turn on voice and box dictation await the start's media half before they talk to the
media context, so nothing pressed during Start is lost. A toolbar Start the worker never answers gives the button back
after `START_TIMEOUT_MS` (20 s).

**The microphone is optional.** A Session starts without a microphone grant, and a microphone that fails to open leaves
the Session running without voice (`session_start.voice: false`, a `transcription_fallback`, a panel notice). "Turn on
voice" asks through onboarding (`?voice=1`) and opens the mic in the running Session. Every `getUserMedia` goes through
`src/lib/get-user-media.ts`, which retries `AbortError` up to three times: Chromium aborts the first request in a
newly created offscreen document now and then, and a real Start must not fail on it.

**Where media lives, per browser.** The microphone, speech recognition, the audio recorder and the VAD live in the
long-lived media context (`Platform.mediaContext`): Chrome's offscreen document (ADR 0001), the same page in an
iframe inside Firefox's background event page, and Safari's small recorder window (`offscreen.html`). Tab video
depends on how the Session started:

- From the side panel: the panel's `getDisplayMedia` picker (ADR 0002). The panel holds a Port as the Session's owner.
- From the toolbar or Alt+Shift+R in Chrome: `tabCapture`, recorded in the offscreen document. Chrome grants it only on
  a tab the extension was invoked on since it last navigated. When it refuses, the Session starts without video and the
  service worker opens `picker.html`, a small window at the top right of the reviewed window
  (`background/picker.ts`), offering "Choose what to record" and "Record without video". A click in an extension window
  may open `getDisplayMedia`; a click on the page's toolbar may not. The window records the video itself, since a
  `MediaStream` cannot be handed to another document, and `attachVideo` turns the Session's `off` video into a
  `surface` recording from the moment of the pick.
- From the toolbar in Firefox: the toolbar's Start is an extension frame (`toolbar-start.html`) that opens the picker
  and records.
- Safari: no video from the toolbar (`toolbarVideo: 'none'`) until manual check S5 shows `getDisplayMedia` works from an
  extension window there.

Every recorder that is not in the media context (the panel, the picker window, Firefox's Start frame) shares
`media/video-owner.ts`: it holds the panel Port and the `TabVideoRecorder`, and says whether its going away stops the
Session (`stops_session`).

**What closing means.** Closing the side panel stops the Session the panel started (`panel_closed`), as ADR 0001 said,
so the only way to lose the panel's video is a deliberate act that also finalizes everything. A toolbar Session has no
owning page: closing a panel does not stop it. Closing a picker window or Firefox's Start frame ends the video only, as
"Stop sharing" does. Closing Safari's recorder window stops the Session (`onMediaContextGone`, also `panel_closed`),
because it is Safari's half of what the panel is in Chrome; the service worker then joins the audio chunks written so
far itself (`salvageAudio`), and that window writes a chunk every 5 s (`audioChunkMs`) instead of 30 s, so little is
lost. A Session started from the Host records audio only (`video_off_reason: 'unavailable'`), since screen sharing
needs a click in the browser.

**Stop finalizes; Cancel is Stop with the last two steps held back.** Stop flushes the page (the open Annotation closes
with its screenshot), asks the owning recorder for its last chunk, joins and finalizes the audio and video, logs
`session_end`, queues the media for the Host and opens the review page. Cancel turns the mic off at once and runs the
same Stop with `discard: true`: everything is finalized, but queueing for the Host and opening the review page wait for
Undo (`finishStopped`), so an undone Cancel is exactly a Stop. The Undo deadline lives in `storage.local`
(`discardPending`), enforced by a timer, a `chrome.alarms` alarm and a sweep at every worker start, so a worker restart
or a browser closing inside the window still discards. What the Host already has is removed with `session_discard`
(ADR 0020).

**Media files.** Audio is written as 30 s chunks while recording and joined once at Stop, with the WebM duration
written in. Video is written in 1 s chunks, joined at Stop, and its header rewritten with ts-ebml so it seeks; a file
ts-ebml cannot fix is kept with `seekable: false`. A recorder's start offset is taken when `start()` is called, not from
its `start` event, and the video's duration is the longer of its last block and the moment its recorder stopped (tab
capture sends frames only on repaint). Media time and Session time differ by that offset and by pauses, and
`packages/core/src/media-time.ts` maps between them for every player and link.

**Long Sessions.** A soft cap at 45 and 60 minutes shows a note and keeps recording. Storage is read with
`navigator.storage.estimate` and warns at 80%.

## Considered options

- Fall back to the most recently used web page when the active tab cannot be recorded: the reviewer recorded a tab they
  were not looking at. Refused since 2026-09-23.
- Minimize the picker window after the pick: it is easy to close by mistake or forget, and closing it ends the video.
  It stays visible behind the reviewed window, saying "Recording video — keep this window open".
- A Safari close reason of its own: a Session schema version for a reason that reads the same to an agent.
- Time out the Firefox frame's own Start: it would drop the picked video of a Session that still starts.

## Consequences

- Session state is pushed from the worker to every surface; a surface never decides a mode on its own for longer than
  one round trip (ADR 0011 for the toolbar).
- A Session without voice is a normal Session: Process must work from typed notes alone (ADR 0015).
- Firefox has no hook for closing its media context (nobody can close the background page), and Chrome none for the
  offscreen document; only Safari's adapter reports `onClosed`.

## History

- 2026-09-22: Onboarding's `micGranted` flag gated Start, and a Session whose microphone failed to open was deleted
  so no empty Sessions piled up. 2026-09-23: the mic is optional (E11); both rules are gone, because a Session without
  voice is still useful and typed notes cover it.
- 2026-09-22: Start fell back to the most recently used web page when the active tab was not one. 2026-09-23: no
  silent fallback (U5); only our own `sidepanel.html` running as a tab in tests still falls back.
- 2026-09-22: the video start offset came from MediaRecorder's `onstart`. 2026-09-23: a loaded machine fired it up to
  3 s late while the file's time 0 is the `start()` call, so the offset is now taken at `start()`; #37 did the same
  for the microphone recorder.
- 2026-09-23 (E1): the toolbar icon toggles the floating toolbar, not the panel; Chrome records a toolbar Session with
  `tabCapture`, and Safari starts it without video. 2026-09-24 (#41): when Chrome refuses `tabCapture`, the picker
  window adds the video instead of leaving the Session without one.
- 2026-09-23 (F1): Start used to write the Session (so the toolbar said Recording) and tell the page last, and the
  page's mode shortcuts were dead for seconds. Now the page gets the Session before anything slow starts. Firefox's
  Start frame used to watch `storage.session`, which Firefox does not give an extension frame in a page; it now hears
  the Session over its Port.
- 2026-09-23 (F4): closing Safari's recorder window used to end only the audio while the Session kept "recording". It
  is Stop now.
