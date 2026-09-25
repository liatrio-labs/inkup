# Manual checks (real Chrome)

Automated e2e runs in Playwright's bundled Chromium. That build has no on-device speech pack, so the e2e
tests use the `scripted` transcript adapter. It also cannot show a real side panel or a real permission
prompt. These checks cover what automation cannot. Run them in installed Chrome (153 or later) before a
release, in the order below. Later checks reuse Sessions and settings from earlier ones.

## The checklist

Tick each line when its section passes. Each line names what it needs beyond the setup.

1. [ ] **C11** Install from the release zip. Needs nothing.
2. [ ] **C2** The microphone gate on a fresh install. Needs nothing.
3. [ ] **C1** A two-minute capture run with real Web Speech. Needs the on-device language pack, which C1 installs.
4. [ ] **C1b** Captions without on-device speech, and the server-speech opt-in. Needs a profile without the pack.
5. [ ] **C4** Voice Commands with real speech. Needs the pack.
6. [ ] **C5** Navigation, tab switch, arrows, pause and Snap. Needs nothing.
7. [ ] **C6** Tab video, the real picker, and closing the panel. Needs nothing.
8. [ ] **C12** The Session list, delete and the storage warning. Needs the Sessions from the checks above.
9. [ ] **C13** Privacy of the free tier with `chrome://net-export`. Needs no key saved.
10. [ ] **C3** Process with a real Anthropic key. Needs an Anthropic key.
11. [ ] **C7** Editing and export. Needs the C3 key.
12. [ ] **C16** A circle followed by a scroll highlights the circled element. Needs the C3 key for its last step.
13. [ ] **C18** Extension pages as review targets: our Sessions page and another extension's page. Needs any other
    extension with an options page.
14. [ ] **C15** Paused timer, the panel's Session list, and restore from file. Needs the zip C7 exported, and a second
    Chrome profile.
15. [ ] **C8** Live Draft Items. Needs the C3 key and the pack.
16. [ ] **C17** A 20-minute real review Processes in streamed parts with in-progress cards. Needs the C3 key.
17. [ ] **C14** A long Session: the 45 and 60 minute warnings and windowed Process. Needs the C3 key and an hour.
18. [ ] **C9** Paid tiers. Needs a Deepgram and an ElevenLabs key.
19. [ ] **C10** Local Whisper, including large-v3 turbo on WebGPU. Needs WebGPU and a model download.
20. [ ] **C19** The floating toolbar: the icon, drag, Start with tab video, the shortcut, the panel button. Needs nothing.
21. [ ] **C20** Viewport sizes through the frame host: presets, drag, Reset, a signed-in site, a site that refuses
    framing. Needs a site you are signed in to.
22. [ ] **C21** Object Select and Select Text with real speech and the real shortcuts. Needs the pack.
23. [ ] **C22** A hub on another computer (network mode): find it as `inkup.local`, pair by code, record a Session that
    reaches its TUI and MCP. Needs a second computer on the same LAN with the host installed.

Safari has its own list, S1–S5, in "Safari" at the end of this file. No automation can load a Safari extension.

Keys belong in the options page only. Back up each new key with the secrets-backup skill before first use.

## Setup (once per build)

1. Run `pnpm install && pnpm zip`. It builds `extensions/web/.output/chrome-mv3` and writes the zip next to it.
2. In a second terminal, run `pnpm fixtures:serve`. It serves `http://localhost:4401` and `http://127.0.0.1:4402`.
3. Open `chrome://extensions` and turn on Developer mode. Click "Load unpacked" and pick `extensions/web/.output/chrome-mv3`,
   or the unzipped folder in C11. If an older build is loaded, click its reload icon instead.
4. Tabs that were already open get the content script injected at install, so they need no reload.

## C11: install from the release zip (Slice 7)

| # | Step | Expected |
| --- | --- | --- |
| 1 | Remove any loaded copy of the extension. Unzip `.output/inkup-<version>-chrome.zip` into a new folder and load that folder unpacked. | Chrome loads it with no errors or warnings on `chrome://extensions`. The details page lists the permissions in docs/PLAN.md "Manifest". |
| 2 | Look at the unzipped folder. | It has `ort/` with one `.wasm` file, and `vad/` with the worklet and `silero_vad_v5.onnx` only. There is no `.map`, `.env` or test fixture. |
| 3 | Open the options page, the side panel and the Sessions page. | Nothing mentions a scripted transcript, a base URL, a stub or localhost. |
| 4 | Remove it again. Open a heavy page (a news site) and, while it is still loading, load the folder unpacked. Once the page has loaded, click the extension's icon on it. (#18) | One toolbar. Then click the reload arrow on the extension's card in `chrome://extensions` (an update) and click the icon on the same tab again: the old toolbar has gone, and there is still exactly one. |

Continue with C2 on this install.

## C2: the microphone gate (P0-1)

Automation cannot click "Block" in Chrome's prompt, so this is manual.

1. Open `chrome://extensions`, click Remove on the extension, then load it unpacked again. That is a fresh
   install, with a new onboarding tab.
2. Open the side panel before finishing onboarding. Expect Start to be disabled, with "Microphone access is
   needed before the first Session. Finish setup".
3. In the onboarding tab click "Allow microphone", then choose **Block** in Chrome's prompt. Expect the
   onboarding page to say Chrome blocked the microphone. The panel now says the microphone is blocked, and
   Start stays disabled.
4. Allow the microphone for the extension: click the camera icon in the address bar of the onboarding tab,
   choose Allow, and click "Allow microphone" again. Expect Start to become enabled.

## C1: two-minute capture run with real Web Speech (Slice 1)

After C2, the extension is installed and the microphone is granted, so step 1 has already happened: start at step 2 if
the onboarding tab is gone.

| # | Step | Expected |
| --- | --- | --- |
| 1 | A fresh install opens the "Set up InkUp" tab by itself. | The page shows the "What a Session captures" notice. |
| 2 | Click "Allow microphone" and accept Chrome's prompt. | The page says "Microphone ready". |
| 3 | Read "On-device captions (en-US)". If it offers "Install on-device speech", click it and wait. | It ends at "Installed. Speech is recognized on this device." Write down how long the download took. |
| 4 | Open `http://localhost:4401/pricing.html`. Click the toolbar icon. | The side panel opens with Start enabled and the status "Ready". |
| 5 | Click Start. | Within 2 s the status reads "Recording" and the timer counts up in mm:ss. The panel shows "Recording: Pricing Fixture". No amber note appears. "Live captions are off" would mean the language pack is missing, and "server speech" would mean the opt-in is on. |
| 6 | Say "this button should go in the header". | Within a few seconds the words appear in the caption strip. |
| 7 | Press Alt+Shift+D, or click "Draw off". Circle the blue "Get started" button, keeping the circle close to it. | The Draw button reads "Draw on" and the cursor over the page is a crosshair. Red ink follows the pointer. |
| 8 | Stop drawing. | After about 1.5 s the Annotation count becomes 1. The ink fades about 2 s after you let go. |
| 9 | Press Alt+Shift+D again to turn drawing off. Hold Shift and circle the "Docs" nav link. Release Shift. | The page scrolls and clicks normally while Shift is up. Ink appears only while Shift is held. The count becomes 2. |
| 10 | Scroll down, circle the "Pro" card, and say "make this the same height as that one". | The count becomes 3. |
| 11 | Switch to another tab for about 20 s, then come back. | The panel stays open and the timer keeps running. It shows the "Go back" note while you are away (C5 covers it). |
| 12 | Click Stop. | The status goes through "Finishing…" to "Ready". A "Session review" tab opens listing 3 Annotations, each with a screenshot that shows your ink. The transcript lists what you said. |
| 13 | Click "Download session.json", then run `pnpm validate:session ~/Downloads/session-*.json`. | The output starts `VALID`. It shows `"local":true` in transcription and 3 annotations with `screenshot=yes`. Annotation #1's pick is `button.cta "Get started"`. Audio is about the Session length, in `ceil(length / 30 s)` chunks. |
| 14 | Repeat steps 5 and 6 with Wi-Fi off. | Captions still appear. This proves recognition runs on-device (Slice 0 M1, step 6). |

Record any `language-not-supported`, `network` or `service-not-allowed` error shown in the panel. Compare it
with crbug 444393111. If on-device speech never becomes available, the panel shows "Live captions are off".
session.json then has a `transcription_fallback` event with `to: none`. That is the privacy default working
as designed, not a pass for M1. Report it, because the PLAN then makes local Whisper the free default.

## C1b: captions without on-device speech (P0-15)

Do this on a profile without the language pack, or before step 3 of C1.

1. Leave "Allow Chrome server speech recognition when on-device is unavailable" unchecked on the onboarding
   page. Start a Session and speak. Expect "Live captions are off" in the panel, no captions, and an
   "Install on-device speech" button. After Stop, session.json validates. It has audio and screenshots, a
   `transcription_fallback` event with `reason: on_device_unavailable, to: none`, and no transcript segments.
   With `chrome://net-export` running, expect no requests to Google speech endpoints.
2. Tick the opt-in. Its notice says audio goes to Google. Start again and speak. Expect the "server speech"
   note and live captions. session.json has `"local": false` and `to: webspeech-server`.

## C4: Voice Commands with real speech (Slice 3)

Needs on-device captions (C1 step 3). Say each command on its own, with about a second of quiet on both sides.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `http://localhost:4401/pricing.html` and click Start. | Within a few seconds the panel's note under the buttons changes from "Voice Commands are starting…" to the list of commands. |
| 2 | Turn drawing on, circle the "Get started" button and say "this button". Wait a second, then say "scratch that". Wait again. | The Annotation count goes to 1, then back to 0 about a second after you stop speaking. "scratch that" does not stay in the captions as review speech. |
| 3 | Say "the video should pause here when it loads" in one breath. | Nothing happens: the status stays "Recording". |
| 4 | Wait a second, say "pause", then wait. | The status reads "Paused" and a "Paused by voice" toast with Undo shows for 2 s. The Draw and Snap buttons are disabled. |
| 5 | Click Undo in the toast before it goes. | The status returns to "Recording". |
| 6 | Say "pause" again, wait, then say "resume". | The status goes to "Paused", then back to "Recording". |
| 7 | Circle the Pro card, wait a second, and say "next". Draw a circle on the Basic card straight away. | The count rises by 2: "next" closed the first Annotation without the 1.5 s gap. |
| 8 | Say "snap". | A screenshot is taken: session.json later shows one with `trigger: voice_command`. |
| 9 | Click Stop, download session.json and run `pnpm validate:session`. | `VALID`. It lists `voice_command` lines for scratch that, pause, resume, next and snap, and none for step 3. The scratch that line points at an annotation. `speech_activity` is above 0, and a screenshot trigger is `voice_command`. |
| 10 | Look at the review page. | The first Annotation is dimmed and labelled "Discarded by “scratch that”". |

If a command is missed or fires falsely, save session.json and note the `speech_activity` spans around it.
They show the silence gate's view of the audio.

## C5: navigation, tab switch, arrows, pause and Snap (Slice 3)

| # | Step | Expected |
| --- | --- | --- |
| 1 | On `pricing.html`, click Start and turn drawing on. Draw an arrow from "Get started" to the "Docs" link in one Stroke. | After 1.5 s the count is 1. |
| 2 | Draw a line, lift the pen, then draw a V at its end. | The count rises by 1. On the review page both Annotations show a connector line: from `button.cta` to the header, and between your two points. |
| 3 | Turn drawing off. Click "Continue to partner checkout" at the bottom of the page. | The page loads from `127.0.0.1:4402`. The panel reads "Recording: Partner Checkout". |
| 4 | Turn drawing on and circle "Pay now". | The count rises by 1. Ink draws normally on the new origin. |
| 5 | Scroll down half a screen and circle something else within a second of the scroll. | The count rises by 2: the scroll closed the first one. |
| 6 | Open a new tab and look at it for a few seconds. | The panel shows "You are looking at another tab…" with "Go back". Circling on the new tab draws nothing. |
| 7 | Click "Go back". | The Session tab is active again and the note goes away. |
| 8 | Click Pause, wait five seconds, then click Resume. Click Snap. | "Paused", then "Recording". Snap adds a screenshot. |
| 9 | Stop, download session.json and run `pnpm validate:session`. | `VALID`. The arrow Annotations print a `connector` line from `button.cta`. One Annotation is `closed by scroll` and one `closed by navigation`. navigation, click, tab_switch, pause and resume are all above 0. Screenshot triggers include `click`, `navigation` and `panel`. |

Screenshots are taken only while the Session tab is visible. A screenshot requested while you look at another
tab is skipped, and the Annotation has no screenshot.

## C6: tab video, the real picker, and closing the panel (Slice 4)

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `http://localhost:4401/pricing.html`, open the side panel, click Start. | Chrome's picker opens at once, with tabs listed and no extension pages. Write down how long from the click to the picker. |
| 2 | Pick the "Pricing Fixture" tab and click Share. | Within 2 s the status reads "Recording". The panel shows "Video: the tab you picked". Chrome's sharing bar appears. |
| 3 | Switch to two other tabs for about 30 s without closing the panel, then come back. | The timer keeps running. This is M2: the panel is window-scoped, so its recorder keeps recording while you look elsewhere. |
| 4 | Circle the CTA, click Pause, wait 5 s, click Resume, circle the Docs link, then Stop. | The review page opens with a video player. |
| 5 | In the review page, Process (C3 key) and click each Change Item. | The video jumps to where each item was said. An item after the pause lands on the right frame, not 5 s late. |
| 6 | Run `pnpm validate:session` on a downloaded session.json. | `video … seekable`, with a duration about the Session length minus 5 s, `1280x…` or smaller. |
| 7 | Start again and click Cancel in the picker. | The Session starts. The panel says "Video off: the screen picker was cancelled". Audio, Strokes and captions still work. |
| 8 | Start again with video, draw once, then close the side panel with its X. | Chrome's sharing bar goes away. A review tab opens within a few seconds, with the video and audio. session.json ends with `session_end` reason `panel_closed`. |
| 9 | Start again, then click "Stop sharing" in Chrome's bar. | The panel says "Video stopped: sharing ended". Recording continues. After Stop, the video covers the time until you stopped sharing. |
| 10 | Quit Chrome, start it with `--enable-features=GetDisplayMediaRequiresUserActivation`, and repeat steps 1–2. | The picker still opens from Start. This is the rest of M2: Start calls the picker before anything slow, so the click's activation holds. |

## C19: the floating toolbar (E1)

Automation cannot click the extension's icon or press a real shortcut, so it stands in for them
(`tests/e2e/toolbar-session.spec.ts`, `docs/spikes/toolbar-start.md`). These steps use the real ones. Close the side
panel first.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `http://localhost:4401/pricing.html` and click the extension's icon. | A small dark toolbar appears at the bottom right of the page: a grip, Start, Panel, –, ×. No side panel opens. |
| 2 | Drag the toolbar by its grip (⋮⋮) to the top left, past the edge of the window. | It follows the pointer and stops 8 px inside the window. Reload the page: it comes back where you left it. |
| 3 | Click Start on the toolbar. | No picker. Within 2 s the toolbar shows a blinking red dot and a running timer, and no "No video" label. The page's tab shows Chrome's recording indicator. |
| 4 | Click Draw, circle "Get started" and say "this button should go in the header". | Red ink; the caption appears in a strip under the toolbar (with on-device speech, C1). |
| 5 | Click Snap, then Pause, wait 5 s, Resume, then click the "Docs" link in the page. | The timer freezes while paused. On the Docs page the toolbar is back, still recording. |
| 6 | Open the side panel with Panel on the toolbar, then close it with its X. | The panel shows the Session. Closing it does **not** stop the Session: the toolbar keeps running. |
| 7 | Click Stop on the toolbar. | The review tab opens. Its screenshots show your ink and never the toolbar. The video plays both pages, including after the navigation. |
| 8 | Collapse the toolbar with –, then click the pill. | A small pill with the timer, then the full toolbar again, in the same place. |
| 9 | On the Pricing tab, press Alt+Shift+R. | A Session starts on that tab with video, without clicking the icon first. Press Alt+Shift+R again: it stops and the review opens. |
| 10 | Reload the Pricing tab (no icon click since), then Start on the toolbar. | The Session starts and the toolbar says "No video": Chrome allows tab capture only after the icon or a shortcut on the page. Stop. |
| 11 | Press Alt+Shift+P. | The side panel opens. |
| 12 | Open `chrome://settings` and click the extension's icon. | The side panel opens there instead (no toolbar can run on Chrome's own pages). |
| 13 | Pair a host (Settings → Host), then show the toolbar. | A green dot sits next to Panel ("Host connected"). Quit the host: it turns grey ("Host offline, will sync"). Unpaired, there is no dot. |
| 14 | Stop, then click Start once and, the moment the timer appears, press Alt+Shift+O. (F1) | One click starts it: at most a brief "Starting…", then the timer. Object Select comes on at once; the page's elements outline on hover. |

## C21: Object Select and Select Text (E7)

Automation presses the shortcuts through the page and scripts the speech. These steps use a real keyboard and voice.

| # | Step | Expected |
| --- | --- | --- |
| 1 | On `http://localhost:4401/pricing.html`, show the toolbar and Start. | The toolbar reads: timer, Draw, Object Select, a caret icon (Select Text), Snap, then Pause and Stop. |
| 2 | Click Object Select, hover "Get started", press ↑ then ↓, then click it. | A blue outline follows the pointer; ↑ outlines the card, ↓ the button again. The click turns the outline red and opens a small box under the button. The button does not react. |
| 3 | Say "this should be bigger" and press Enter without typing. | The box closes. After Stop the review lists the Annotation as "picked with Object Select", and nothing on the page changed while you picked. |
| 4 | Press Alt+Shift+O, pick the heading, type "Make this roomier" and press Enter. | Object Select turns on from the keyboard. The review shows the comment under that Annotation. |
| 5 | Press Esc. | Object Select turns off (the button is no longer pressed). |
| 6 | Select some text with Select Text off. | Nothing happens. Press Alt+Shift+T and select it again: the comment box opens next to the selection at once. |
| 7 | Turn Draw on while Select Text is on. | Select Text turns off. Only one of the three is ever pressed. |

## C22: a hub on another computer (E14, ADR 0006)

The e2e reaches a network-mode host on this machine's own LAN address (the host counts that as another machine),
and sets Find hubs' probe list itself. These steps use two real computers on one LAN, so the `.local` name, the
router and each machine's firewall are real. Call the one running the host the hub, and the one with Chrome the
browser machine.

| # | Step | Expected |
| --- | --- | --- |
| 1 | On the hub, run `inkup --network`. | The TUI header warns "Network mode: unencrypted on this LAN — trusted networks only" and names `inkup.local` (or `-2` … `-5` when another hub holds it) with its LAN addresses. macOS may ask to allow incoming connections: allow them. |
| 2 | On the browser machine, open Settings → Host and click Find hubs. | Within about two seconds the list shows "inkup on <hub's name>", `http://inkup.local:47823` and the host's version, with "Unencrypted network hub". |
| 3 | Click Connect. | A prompt asks for the 6-digit code. On the hub, the TUI shows a popup naming this browser and its address, with the code, a QR code and a `inkup://pair` link. |
| 4 | Type a wrong code, then the right one. | The wrong one says "Wrong code" and how many tries are left. The right one pairs: "Connected (host …)", and the amber note "Unencrypted network hub". The TUI popup closes and the Clients view lists the browser. |
| 5 | Show the page toolbar on `http://localhost:4401/pricing.html` and hover the host dot. | It is green, titled "Host connected · Unencrypted network hub". |
| 6 | Record a short Session: draw one Annotation while talking, then Stop. | The hub's TUI shows the Session live and then finished, with its events. |
| 7 | On the hub, run `inkup token create --name laptop` and on the browser machine `inkup mcp install --remote http://inkup.local:47823 --token <token>` (or call /mcp with `Authorization: Bearer <token>`). Ask the agent to list sessions. | The Session from step 6 is listed. Without the token, `curl -i http://inkup.local:47823/mcp` answers 401. |
| 8 | Forget the host. Then Settings → Host → Other address, paste the `inkup://pair` link from a new TUI popup (click Pair once first for a fresh code), and click Pair. | It pairs without typing the code. |
| 9 | Forget the host again. In Chrome on a Mac with a camera, click Scan QR, allow the camera, and hold up the TUI's QR code (click Pair once first for a fresh one; a phone photo of the terminal works). | It pairs. In Firefox, which has no BarcodeDetector, there is no Scan QR button. |

## C20: viewport sizes (E6)

The e2e runs the frame host on fixture pages in Playwright's Chromium (`tests/e2e/viewport.spec.ts`). These steps
check it on real sites, with a real sign-in, in installed Chrome.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Install from the release zip (C11). | The permission prompt has no "Access the page debugger backend" line. |
| 2 | Open `http://localhost:4401/responsive.html`, show the toolbar and click Viewport. | A menu: Phone 375×812, 390×844, 768×1024, 1280×800, 1440×900, Fit to tab, a W×H field, and a note that the page reloads into a frame. |
| 3 | Pick Phone 375×812. | The tab shows a bar with "375×812", the page's address and Reset, and under it the page in a 375 px frame, centred on grey. The nav is collapsed into "☰ Menu", and the toolbar is inside the frame. No debugging bar. |
| 4 | Start, circle the Menu button, Snap, then drag the frame's right handle to about 900 px. | A live size follows the drag; on release the frame is about 900 px wide and the nav is back. |
| 5 | Click Viewport on the toolbar, then "The tab's own size". | The page fills the tab again, still recording. Stop: the review's screenshot is 375 px wide (no grey, no bar), and review.md's header lists 375×812, 900×… and the tab's own size. |
| 6 | On a site you are signed in to (e.g. GitHub), set 375×812. | Write down whether you stay signed in inside the frame. If not, note it in the decisions log's E6 entry (third-party cookies or storage in the frame). |
| 7 | On `https://www.google.com`, click Viewport. | No sizes: the menu says the site does not allow being shown in a frame (X-Frame-Options). |
| 8 | Set 2400×1400 on a smaller window. | The frame is scaled down to fit, and the button and the bar say "2400×1400 at N%". |
| 9 | Reload the page and open Viewport. | "Last used here" offers the last size; nothing was applied by itself. |

## C12: the Session list, delete and the storage warning (Slice 7)

| # | Step | Expected |
| --- | --- | --- |
| 1 | Click "Sessions" at the foot of the side panel. The options page has a "Stored Sessions" link too. | A Sessions tab opens. Sessions are grouped under the origin each one started on, `http://localhost:4401` and `http://127.0.0.1:4402`, with the most recent group first. |
| 2 | Read a row. | It shows the start page's title, date and time, length in mm:ss, the Change Item count or "not processed", and the size of its recordings and screenshots. The header shows the total and the extension's share of the quota. |
| 3 | Start a Session, then look at its row on the Sessions page. | Its length reads "recording" and its Delete button is disabled. Stop it. |
| 4 | Click "Open review" on a row. | Its review page opens in a new tab. |
| 5 | Click Delete on a Session you no longer need, then Cancel. Click Delete again, then confirm. | Cancel keeps it. Confirm removes the row, and the totals drop by its size. Its review page now says there is no Session with that id. |
| 6 | Fill the disk until the quota ratio passes 80%, or skip this step: `tests/e2e/sessions.spec.ts` covers it with a stubbed estimate. | The Sessions page and the panel both show "Storage is N% full" with a link to delete old Sessions. |

## C13: privacy of the free tier (Slice 7, P0-15)

`tests/e2e/privacy.spec.ts` proves this in Playwright's Chromium for every extension context. This run checks
real Chrome, where the browser itself also talks to Google, so only the extension's requests matter.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Remove every key in options and pick the Free tier with Web Speech. Open `chrome://net-export` and start logging with "Include raw bytes" off. | Logging runs. |
| 2 | Run a full Session on `http://localhost:4401/pricing.html`: Start, draw two Annotations while talking, go to the partner checkout, Stop. On the review page click Export. | The zip downloads. The Process area asks you to add an Anthropic key in settings. |
| 3 | Stop logging and open the file in the NetLog viewer. Filter by the extension's id and by `anthropic`, `deepgram`, `elevenlabs`, `huggingface` and `speech`. | The extension's requests go only to `localhost:4401`, `127.0.0.1:4402` and `chrome-extension://`. Nothing goes to any vendor. |
| 4 | Save fake keys for all three vendors, run another Session with the Better tier and Process, and Export. Unzip and search the folder for each key. | No file holds a key. `grep -r` prints nothing. |

## C3: Process with a real Anthropic key (Slice 2)

Needs a key. Back it up with the secrets-backup skill before first use.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open the extension's options page (right-click the toolbar icon, Options). Paste the key, click Save. | A notice says what goes to Anthropic. Save again: the notice does not come back. The key field shows only a masked hint. The Process, Draft and Merge model fields turn into lists of your account's models, with the saved models selected. |
| 2 | Click the Test button beside the key. | "OK: Key works with claude-sonnet-5 and claude-haiku-4-5-20251001." under the key. |
| 2b | Optional, with a Vercel AI Gateway key: paste it under "Vercel AI Gateway key", Save, set the Process provider to Vercel AI Gateway, pick `anthropic/claude-sonnet-5` and High effort, Save, and click the Test button beside that key. | A notice says what goes to Vercel. The Process model list shows the Gateway's models grouped by maker. "OK: Key works with anthropic/claude-sonnet-5." Step 5 then runs through the Gateway: its dashboard shows the requests. |
| 3 | Run C1 steps 4–12 (circle the CTA saying "this button should go in the header", then circle the Pro card saying "make this the same height as that one" and circle the Basic card). | The review page opens with Process enabled. |
| 4 | Click Process. | An estimate with input tokens, output tokens and a dollar amount appears. Nothing has been sent yet. |
| 5 | Click Run Process. | After up to a minute, Change Items appear. One is a layout item with Subject `button.cta`. Another is a layout item with Subject and Reference on the two plan cards. Unsure items come first with a "check me" badge and a sentence, never a number. Each Location that has a screenshot shows it inside the card, right under its row (role and "Annotation #n" above it), with orange outlines only on that Annotation's Strokes. The right pane shows only the recording. |
| 5b | Click a Location's screenshot. Press Escape. | A dialog shows the same screenshot and Strokes, large enough to read the page text, titled with the role and element. Escape closes it and the card keeps its place. In the Annotation list below, each screenshot also has its Strokes outlined. In the side panel (C8), Annotation thumbnails show the whole screenshot letterboxed, not a crop of its top. |
| 6 | Click "Copy agent prompt" and paste into a text editor. | It cites `screenshots/<id>.png` and names `button.cta`. |
| 7 | Turn Wi-Fi off and click Process, then Run Process. | An error appears with Retry. The transcript, Annotations and the earlier items are unchanged. |
| 8 | Download session.json and run `pnpm validate:session`. | `VALID`, and the file has `change_items` and no `sk-ant-`. |

## C7: editing and export (Slice 4)

| # | Step | Expected |
| --- | --- | --- |
| 1 | After C6 step 5, edit a transcript segment and click outside it. | "Edited. Heard: …" appears under it. Process again uses the new words (check the Process request, or that the items follow the edit). |
| 2 | Edit a Change Item's title, split another, delete the copy, tick two items and click "Merge selected", and drag one item to the top. | Each change shows at once and survives a reload of the review page. The merged card says "Combining…" for a moment, then reads as one request: one title and intent, one agent prompt that still cites both items' screenshots (E12). |
| 3 | Click "Copy all prompts" and paste into a text editor. | One prompt, numbered 1…n in the list's order, each item citing `screenshots/<id>.png`. |
| 4 | Click Export. | A `review-<date>-pricing-fixture.zip` lands in Downloads. The page offers to delete the video and audio. |
| 5 | Unzip it. Open `review.md` in a Markdown viewer. | Items are numbered in the list's order, with Locations, the screenshots shown inline, and a "video at mm:ss" link. The transcript is at the end with your edit. |
| 6 | Open the video link in Chrome, or `recording.webm` and drag the scrubber. | It plays and seeks at once. |
| 7 | Run `pnpm validate:session session.json` in the folder. | `VALID`, an acceptance line, and no `sk-ant-` anywhere in the folder (`grep -r sk-ant- .` prints nothing). |
| 8 | Paste "Copy all prompts" into a Claude Code session opened in the unzipped folder. | It opens the cited screenshots without asking where they are. |
| 9 | Back on the review page, click "Delete video and audio". | The player says the media was deleted. Items, transcript and screenshots remain. A new export has no `.webm` files. |

## C15: paused timer, the panel's Session list, restore from file (feedback batch 1, U1)

`tests/e2e/sessions.spec.ts` and `tests/e2e/restore.spec.ts` cover these in Playwright's Chromium, with the
panel opened as a tab. This run checks the docked side panel, real file pickers and a fresh profile.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Start a Session. At about 00:10 click Pause and wait 20 seconds. | The timer holds its value the whole time, and the status reads Paused. |
| 2 | Click Resume. With the pack installed, also say "pause", wait, and say "resume". | The timer continues from where it stopped, with no jump by the paused time, both for the button and for voice. Stop. |
| 3 | Look at the idle side panel. | "Previous Sessions" lists your Sessions, newest first, each with its title, origin, date and time, length and Change Item count. |
| 4 | Click "Open review" on a row, then Delete on another row, then confirm. | The review opens in a new tab. Delete asks first, then the row disappears here and on the Sessions page. |
| 5 | In a second Chrome profile with the extension loaded and no Sessions, click "Restore from file" in the side panel and pick the zip C7 exported. | "Restored …" appears, with an Open review link. The review page shows the same Change Items, Annotation screenshots, transcript edits and the video, and the video seeks. |
| 6 | Restore the same zip again. | A dialog says the Session is already stored. Open existing opens its review. Doing it again and choosing Replace restores the file's copy and drops edits made since. |
| 7 | Unzip the export and restore its `session.json` alone from the Sessions page. | "Restored … without screenshots or media". The review shows the items and transcript, and no screenshots or player. |
| 8 | Restore a text file renamed to `.zip`, and a `session.json` whose `schema_version` you set to 99. | Each shows a red message that says why, and no Session is added. The options page still holds your keys. |

## C18: extension pages as review targets (feedback batch 1, U5)

`tests/e2e/extension-pages.spec.ts` covers drawing on our Sessions page and a no-overlay Session on a fixture
extension's page. It cannot press a real extension shortcut, so the Alt+Shift+S capture is checked only here.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `chrome://extensions/shortcuts`. | "InkUp" lists Alt+Shift+R, Alt+Shift+D and "Take a screenshot" on Alt+Shift+S. If one is blank, another extension holds it: assign a free one. |
| 2 | Open the Sessions page from the panel footer, click Start, turn drawing on and circle the "Sessions" heading. | After 1.5 s the count is 1. Buttons on the page still work while drawing is off. |
| 3 | Stop. | On the review page, Annotation 1 picks the `h1` "Sessions" and its screenshot shows the circle. |
| 4 | Open another extension's options page (any installed extension), click Start and share that tab in the picker. | The panel says drawing is off on this page, the Draw button is disabled, and the video is recording. |
| 5 | Click Snap, then press Alt+Shift+S. | Snap adds no screenshot. Alt+Shift+S adds one: the panel's latest screenshot shows that options page. |
| 6 | Open `chrome://extensions` in the same tab, press Alt+Shift+S, and Stop. | The review page lists the two screenshots. session.json has `overlay: "none"` on session_start and on the navigation, and two `shortcut` screenshots. |
| 7 | With `chrome://newtab` active, click Start. | The Session starts in the no-drawing mode on that tab. It never records a different tab. |
| 8 | Open `chrome://extensions`, find this extension and check the permission details. | No new warning. The site access reads "On all sites", as before. |

## C16: a circle followed by a scroll (feedback batch 1, U2)

`tests/e2e/highlight.spec.ts` covers this with a mouse in Playwright's Chromium. This run checks a real pen or
trackpad and real scroll momentum.

| # | Step | Expected |
| --- | --- | --- |
| 1 | On `pricing.html`, Start and turn drawing on. Circle "Get started" loosely, lift, and within a second scroll down about half a screen. | The count rises by 1. |
| 2 | Circle a plan card, then scroll back up with the trackpad while the ink is still showing. | The count rises by 1. |
| 3 | Stop, and on the review page look at the Annotation list. | Annotation 1 is `button.cta` and its screenshot shows the button with the circle around it, not the page below. Annotation 2 is the card you circled. |
| 4 | Process with the C3 key. | In the Change Item card for Annotation 1, the Location's screenshot shows only that Annotation's ink. |

## C8: live Draft Items with a real key (Slice 5)

Needs the C3 key and on-device captions (C1 step 3). Say each Voice Command on its own, with about a second of
quiet on both sides.

| # | Step | Expected |
| --- | --- | --- |
| 1 | With the key saved, open `http://localhost:4401/pricing.html` and click Start. | Below the captions, the panel shows "Draft Items" and says cards appear a few seconds after you finish pointing and talking. |
| 2 | Turn drawing on. Circle the "Get started" button and say "this button should go in the header". Then stay quiet. | About 3 to 5 s after you stop, "Drafting…" shows briefly. A card appears with a title like "Move 'Get started' into the header", the Category `layout`, and "Subject: button 'Get started' (#1)". Write down the delay from the end of speech to the card. |
| 3 | Say "pin that". | The card gets a border, its Pin button reads "Pinned", and the state line says "Pinned by voice". |
| 4 | Circle the Pro plan card and say "make this card taller". Stay quiet. | A second card appears at the top. |
| 5 | Click Discard on it. | The card dims, its title is struck through, and the state line says "Discarded". |
| 6 | Circle the Basic card, say "make this one blue", wait for its card, then say "scratch that". | That card is discarded by voice. The Annotation count does not drop, because "scratch that" took the newer Draft Item, not the Annotation. |
| 7 | Talk for 40 s without drawing, for example about the page's tone. | Within about 30 s a card appears from the speech alone, with a page Location or none. |
| 8 | Turn Wi-Fi off, circle something, and speak. | An amber note says the last pass failed and capture goes on. The timer, captions and Annotation count keep working. Turn Wi-Fi on and circle something else: when its card appears, the note is gone, and the card also covers what you said while offline. |
| 9 | Click Stop. | The review page lists the Draft Items beside the Annotations. The pinned one says "Pinned by voice". The discarded ones are dimmed. |
| 10 | Click Process, then Run Process. | The pinned draft is a Change Item with the "pinned" badge and the same title and Category as its card. No item repeats a discarded reading. |
| 11 | Process again. | The pinned item is still there with the same title, even if you edited its title after step 10. |
| 12 | Download session.json and run `pnpm validate:session`. | `VALID`. The draft line lists the drafts, pinned 1, discarded 2 (click 1, voice 1) and a discard rate. `pinned change items 1`. |
| 13 | Remove the key in options, start a new Session, circle the CTA and speak. | The panel shows Annotation cards instead: a screenshot thumbnail, `“Get started” button.cta`, and your words. "scratch that" dims the card. With `chrome://net-export` running, nothing goes to `api.anthropic.com`. |

## C14: a long Session (Slice 7)

Needs the C3 key and about an hour. `pnpm fixtures:long` and `tests/unit/adapters/long-session.test.ts` prove
the windowing on a synthetic 40-minute Session. This checks the real thing.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Start a Session on the fixture site and keep reviewing, with an Annotation every minute or two. Leave it running. | At 45:00 a toast and an amber note say the Session has run for 45 minutes and recording continues. |
| 2 | Keep going to 60:00. | A second toast and the note say 60 minutes. The timer keeps counting and captions keep coming. Stop at about 62 minutes. |
| 3 | On the review page click Process. | The estimate covers the whole Session and says it runs in about 6 parts, two at a time. The input tokens are the sum over the parts. |
| 4 | Run Process. | In-progress cards fill in part by part (C17), then the final list replaces them. Items cover the start, middle and end of the Session. Above the items, a line says how many parts the Session was processed in, and how many duplicates from the overlaps were merged. Any Annotation with no item is listed with its reason. No amber line says an Annotation has no item and no reason. |
| 5 | Download session.json and run `pnpm validate:session` and `pnpm metrics` on its folder. | `VALID`, with `process_run.windows` equal to the parts shown in step 4 and an empty `unaccounted_annotations`. The metrics line shows one Session of about 62 minutes. |

## C17: a 20-minute review Processes in streamed parts (feedback batch 1, U4)

Needs the C3 key. This is the Session that used to fail with "The answer did not fit in 16000 output tokens".
`tests/unit/adapters/truncation.test.ts` and `tests/e2e/process-stream.spec.ts` prove it against the stub.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Record a real 20-minute review of the fixture site (or a real site): move between at least three pages, pause once, say "next" a few times, and draw 20 or more Annotations with speech. | The Session records as usual. |
| 2 | On the review page click Process. | The estimate says the Session runs in 2 parts (or more), two at a time. |
| 3 | Run Process and watch the Change Items section. | Within a few seconds "Part 1 of 2 · writing" and "Part 2 of 2 · writing" appear with a grey placeholder card each. Finished items appear one by one as read-only cards marked "in progress" before the run ends. |
| 4 | Wait for the run to finish. | The in-progress cards disappear and the final list appears, numbered from item_0001. No "did not fit" or other token error. The coverage line names the number of parts. |
| 5 | Open DevTools on the review page, Application, IndexedDB, `inkup`, `processRuns`, and expand the newest row's `calls`. | Each `main` call has a `chunk` and an `estimated_output`; note the ratio of `output_tokens` to `estimated_output` in the decisions log for calibrating the estimate. |
| 6 | Click Process again and, while parts are writing, go to `chrome://extensions` and click the extension's reload button. Reopen the review page. | The review page says "Process failed: Process stopped because the extension restarted before it finished. Run it again." No in-progress cards remain. Retry works. |

## C9: paid tiers with real keys (Slice 6)

Needs a Deepgram key (Member role, so it can mint tokens) and an ElevenLabs key. Keys go in the options page
only. `pnpm eval:stt` with `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY` in `.env` runs the automated half first:
every fixture through both vendors, streaming and batch, with WER and timestamp checks.

| # | Step | Expected |
| --- | --- | --- |
| 1 | In options, pick Better. | A notice says your audio goes to Deepgram. Pick Free, then Better again: the notice does not come back. |
| 2 | Paste the Deepgram key, Save, then Test. | The field shows `Saved (xxxx…yyyy)`, never the whole key. Test says "OK: Deepgram issued a short-lived token." A key without the Member role says the key works but cannot mint tokens. |
| 3 | Open `http://localhost:4401/pricing.html`, Start, and talk for a minute with pauses, pointing and circling. | The panel says "Transcription: Deepgram Nova-3 (Better)". Captions appear within about a second of each phrase. |
| 4 | Pause for 10 s, Resume, talk, then Stop. | On the review page, click a segment's timestamp after the pause: the recording plays the words you said there, not 10 s off. |
| 5 | Download session.json. | Segments say `engine: deepgram`, `local: false`, `timestamp_quality: word`, with words on each. `grep` for the key prints nothing. |
| 6 | Repeat steps 1 to 5 with Best and the ElevenLabs key. | "Transcription: ElevenLabs Scribe v2 (Best)". Speak three phrases with long pauses between them. In session.json each phrase's words start near where you said it. If the second and third phrases' words sit at the start of the Session instead, Scribe's word times are relative to each commit, and the heuristic in `src/adapters/transcription/elevenlabs.ts` guessed wrong. Record which it is. |
| 7 | During a Better Session, turn Wi-Fi off for 20 s, then on. | Captions stop. After about 4 s of retries, the panel's transcription line switches to the free default: on-device Web Speech, or off without the speech pack. The Session keeps recording. The review page shows the Session ended normally, with one `transcription_fallback` from `deepgram`. |
| 8 | On the review page of step 3's Session, pick "ElevenLabs Scribe (Best)" under "Re-transcribe with" and click Re-transcribe. | Within a minute a new transcript replaces the old one. "Showing" lists the live run and the new one. Switch between them. Process uses the one shown. |
| 9 | Edit a segment in the new run, switch back to the live run, and switch again. | The edit shows only in the run it was made on. |
| 10 | With `chrome://net-export` running during a Free-tier Session, check the log. | Nothing goes to `api.deepgram.com` or `api.elevenlabs.io`. |

## C10: local Whisper, including large-v3 turbo on WebGPU (Slice 6)

`pnpm test:e2e:whisper` covers whisper-base on WASM, the download and a re-transcription. This check covers
the bigger models and a real voice.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `chrome://gpu` and check that WebGPU is "Hardware accelerated". In options pick Free, then Local Whisper. | Three models are listed, including "Whisper large-v3 turbo, WebGPU". Without WebGPU, turbo is hidden and a line says why. |
| 2 | Click Download on turbo. | A progress bar with a percent and a total size. Afterwards the row says Downloaded, and a reload keeps it. |
| 3 | Select turbo and run a two-minute Session with pauses. | "Transcription: local Whisper on this device (Free)". Captions appear a moment after each pause. Write down the delay from the end of a phrase to its caption. |
| 4 | Turn Wi-Fi off and repeat step 3. | It works the same. Nothing is downloaded during a Session. |
| 5 | Stop, then re-transcribe with "Whisper large-v3 turbo". | A new run with word times. The words line up with the recording when you click a segment's timestamp. |
| 6 | Select Whisper small without downloading it and Start. | The Session records with the free default. A `transcription_fallback` in session.json says `whisper_model_missing`. |

## Slice 0 checks folded in

**M1 (on-device Web Speech in the offscreen document)** is now covered by C1. Steps 3, 5, 13 and 14 cover
the language pack install, the grant reaching the offscreen document, on-device recognition, and the Wi-Fi-off
proof. The spike page it used was removed in Slice 1.

**M2 (a real side panel keeps recording while hidden; Start has activation)** has two halves:

- *Panel survives tab switches.* C1 step 11 covers this for Slice 1. Audio lives in the offscreen document, so
  it does not depend on the panel.
- *Panel `MediaRecorder` video while you look at other tabs, and activation for `getDisplayMedia`.* C6 steps 3
  and 10 cover these now that the panel records video. The panel's own recorder replaced the spike page. Automation
  only checks the hidden-page recorder with raw CDP and a tab standing in for the panel (Slice 0 b). A real docked
  panel needs this manual run.

## Safari (S1 unit)

Why this is manual:

- Playwright's WebKit cannot load extensions.
- Safari runs an unsigned extension only after a person authenticates in its Developer settings.
- Agents built and compiled everything but never ran it in Safari.

`docs/spikes/safari.md` says why each step expects what it does. The steps assume Safari 27 on macOS 26. Keep the
fixture server from Setup running (`pnpm fixtures:serve`).

1. [ ] **S1** Build, load and open the panel.
2. [ ] **S2** Microphone, recorder window and a capture run.
3. [ ] **S3** Video from the panel window.
4. [ ] **S4** Process, export and the free tiers.
5. [ ] **S5** The floating toolbar.
6. [ ] **S6** Viewport sizes through the frame host (spike: decides whether Safari lists it).
7. [ ] **S7** Source mapping and element crops.
8. [ ] **S8** The page API.
9. [ ] **S9** Closing the recorder window stops the Session.

<!-- markdownlint-disable-next-line MD024 -->
### Setup (once per build)

1. Run `pnpm install && pnpm build:safari`. It writes `extensions/web/.output/safari-mv3`.
2. In Safari, open Settings, then Advanced, and tick "Show features for web developers". In the Developer tab,
   tick "Allow unsigned extensions" and authenticate. Safari clears this when it quits.
3. Load the extension in one of two ways:
   - **Quick**: in the Developer tab, click "Add Temporary Extension…" and pick `extensions/web/.output/safari-mv3`.
     Safari removes it after 24 hours or when it quits.
   - **Wrapper app**: `cd "extensions/web/safari-xcode/InkUp" && xcodebuild -project "InkUp.xcodeproj"
     -scheme "InkUp" -configuration Debug build CODE_SIGNING_ALLOWED=NO`, then open the built
     `InkUp.app`. Its path is in the build log, under DerivedData. The app offers "Quit and Open Safari
     Settings…".
     - If the build gained or lost a top-level file since `safari-xcode/` was generated, first run
       `pnpm safari:xcode`.
     - To sign instead, set a team in Xcode's Signing & Capabilities and replace the placeholder bundle id
       `com.example.InkUp`.
4. In Settings, then Extensions, turn on "InkUp". Tick "Always Allow on Every Website" or
   allow `localhost` and `127.0.0.1` when Safari asks.
5. To debug, the Develop menu has "Web Extension Background Content" for the service worker. Each extension
   window has its own Web Inspector.

### S1: build, load and open the panel

| # | Step | Expected |
| --- | --- | --- |
| 1 | Load the extension (Setup step 3). | Safari lists it with no errors. The onboarding tab opens by itself. |
| 2 | Look at the permissions Safari shows for it. | Storage, tabs, scripting and website access only. There is no side panel, offscreen or downloads entry. |
| 3 | Open `http://localhost:4401/pricing.html`. If the toolbar icon has a badge, click it and allow the site. | The page reloads with the extension allowed. |
| 4 | Click the toolbar icon. | The floating toolbar appears on the page (E1). Click its Panel button: a narrow "InkUp" window opens at the right edge of the Safari window, showing the panel. Clicking Panel again focuses the same window and does not open a second one. |
| 5 | On a site you have not allowed yet, click the toolbar icon. | Write down what happens: Safari's permission prompt, the panel window, or both. The spike could not tell which (docs/spikes/safari.md "Everything else"). |
| 6 | Press Alt+Shift+P on the fixture page. | The panel window opens or comes to the front. (Alt+Shift+R starts a Session: S5.) |

### S2: microphone, recorder window and a capture run

| # | Step | Expected |
| --- | --- | --- |
| 1 | In the onboarding tab, click "Allow microphone" and accept Safari's prompt. | "Microphone ready". The captions line says "On-device speech is not available for this language in this browser." |
| 2 | In the panel window, with the fixture tab active in the main window, click Start. Cancel the screen picker (S3 covers video). | A small window opens in front, saying the extension "is recording your microphone". Within about 2 s the panel reads "Recording: Pricing Fixture". Write down whether Safari asked for the microphone again. If it asks at every Start, report it. |
| 3 | The panel shows "Live captions are off" (Web Speech has no on-device check in Safari). Turn drawing on (Alt+Shift+D or the panel's Draw button) and circle "Get started". | Red ink, and the Annotation count reaches 1 after about 1.5 s. |
| 4 | Click back into the fixture page, so the recorder window is behind the main window. Talk for 20 s, circle something else, then Stop from the panel. | The recorder window closes by itself. The review tab opens with 2 Annotations and screenshots that show your ink. The audio player plays **all** of what you said, including the 20 s while the recorder window was behind. If the audio stops when the window went behind, the recorder has to stay in front: report it. |
| 5 | Start again, then close the recorder window with its close button. | The Session stops: S9 checks it in full. |
| 6 | Start again, then close the **panel** window. | The Session stops (`panel_closed`), the recorder window closes, and a review tab opens. |

### S3: video from the panel window

| # | Step | Expected |
| --- | --- | --- |
| 1 | Click Start in the panel window. | Safari's picker opens straight away. It offers windows and screens, not tabs. |
| 2 | Pick the Safari window showing the fixture page. | The panel shows "Video: …" with the window's name. Draw once, then Stop. The review page plays a video of that window, and seeking works. |
| 3 | Start again and dismiss the picker. | "Video off: the screen picker was cancelled". Audio and Strokes still record. |
| 4 | If Start instead says "Video off: this browser cannot record the screen here" or "screen capture failed", report it. | Then `tabVideo` in `src/platform/safari/index.ts` should become `false` (docs/spikes/safari.md "Results"). |

### S4: Process, export and the free tiers

| # | Step | Expected |
| --- | --- | --- |
| 1 | On the S2 or S3 review page, click "Download session.json". | Safari saves `session-<id>.json` to Downloads. It may first ask whether to allow downloads from the extension. `pnpm validate:session ~/Downloads/session-*.json` prints `VALID`. |
| 2 | With an Anthropic key in the options page, click Process. | Change Items appear as in C3. |
| 3 | Click Export. | "Saved inkup-….zip (N files) to your downloads", and the zip is in Downloads. Unzip it: it matches C7's layout. |
| 4 | In the options page, choose local Whisper, download a model, and run a short Session. | Captions come from Whisper. Write down whether it used WebGPU or wasm. |
| 5 | Tick the server-speech opt-in in the options page, then run a short Session with Siri or Dictation turned on in System Settings. | Live captions appear. Write down any `service-not-allowed` or `not-allowed` error. |

### S5: the floating toolbar

| # | Step | Expected |
| --- | --- | --- |
| 1 | On the fixture page, click the toolbar icon, drag the toolbar by its grip, reload. | The toolbar appears, moves, stays on screen, and comes back where you left it. |
| 2 | Click Start on the page's toolbar. Close the panel window if it is open. | The recorder window opens as in S2. The toolbar shows the timer and "No video" (Safari's toolbar Start has no video: `docs/spikes/toolbar-start.md`). |
| 3 | Draw, then Stop from the toolbar. | The review tab opens; the screenshots show the ink and not the toolbar. |
| 4 | Press Alt+Shift+R, then Alt+Shift+R again. | A Session starts on the tab with the toolbar, then stops. |
| 5 | Spike for video (optional): add `"web_accessible_resources": [{"resources": ["toolbar-start.html"], "matches": ["<all_urls>"]}]` to `.output/safari-mv3/manifest.json` and reload the extension. In Web Inspector on the fixture page, run `const f = document.createElement('iframe'); f.allow = 'display-capture'; f.src = '<extension base URL>/toolbar-start.html'; document.body.append(f)` (the base URL is on the extension's Web Inspector) and click its Start. | Write down whether the page may frame it and whether Safari's picker opens. If both, Safari can use `toolbarVideo: 'frame_picker'` (and list the page as web-accessible, as Firefox does). |

### S6: viewport sizes through the frame host

Safari's `viewport` capability is false (`platform/safari`), so the toolbar hides Viewport. This checks whether the frame
host that Firefox uses works in Safari.

| # | Step | Expected |
| --- | --- | --- |
| 1 | In the extension's service-worker Web Inspector, run `chrome.storage.local.set({ devOverrides: { viewport: true } })`, then show the toolbar on `http://localhost:4401/responsive.html`. | The toolbar has a Viewport button. |
| 2 | Pick 375×812. | The tab loads the extension's viewport page with the page in a 375 px frame on a grey backdrop; the nav is collapsed. Write down whether the toolbar appears inside the frame. |
| 3 | Start, Draw a circle in the frame, Snap, Stop. | Write down whether the review's screenshot is the 375 px frame. If steps 2 and 3 work, set the Safari adapter's `viewport` capability to true. Clear the override afterwards. |

### S7: source mapping and element crops (E4)

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `http://localhost:4401/react.html`. In Web Inspector's console (the page, not the extension), run `document.dispatchEvent(new CustomEvent('inkup:source-probe', {detail: '{"id":"x"}'}))` after `document.addEventListener('inkup:source-result', e => console.log(e.detail))`. | One line is logged: the MAIN-world bridge runs. If nothing is logged, Safari ran it in the isolated world or not at all: write that down. Sources are then absent in Safari and nothing else changes. |
| 2 | Start a Session, circle "Get started", Stop, and export. | In `session.json` the Annotation's pick `#cta` has `source` `{"file": "src/App.js", "line": 6, "components": ["CtaButton", "PricingCard", "App"]}` (if step 1 logged), and the zip has `screenshots/<id>.crop.png` showing only the button with a margin. |

### S8: the page API (E5)

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `http://localhost:4401/react.html`. In Web Inspector's console (the page), run `typeof __inkup`. | `"undefined"`: no Session records the tab. |
| 2 | Start a Session on the tab and run `await __inkup.annotate('#cta', {comment: 'Make it purple'})`. | `{annotation: 1, selector: "#cta"}`, and the panel counts one Annotation. If the S7 bridge did not run, `__inkup` stays undefined: write that down. |
| 3 | Stop, then run `typeof __inkup` again. | `"undefined"`. The review page lists Annotation #1 as "from the page API" with the comment. |

### S9: closing the recorder window stops the Session (#9)

| # | Step | Expected |
| --- | --- | --- |
| 1 | Start a Session from the panel window on the fixture tab (cancel the screen picker). Circle "Get started", then talk for about 15 s. | "Recording", and the Annotation count reaches 1. |
| 2 | Close the small recorder window with its close button. | Within a few seconds the Session stops by itself, as closing the panel does: the panel reads "Ready" and a review tab opens. Nothing asks to reopen the recorder. |
| 3 | On the review tab, look at the Annotation and play the audio. | The Annotation and its screenshot are there. The audio plays what you said up to about 5 s before the close: the recorder writes every 5 s in Safari, and what it had not written yet goes with the window. The Sessions page lists the Session as ended, and its end reason in an export is `panel_closed`. |
| 4 | Start again from the toolbar (click the extension's icon on the fixture tab, then Start), and close the recorder window. | The same: the Session stops and the review tab opens. |
| 5 | Start again and Stop normally. | The recorder window closes by itself, and the Session is **not** stopped twice (one review tab, one `session_end`). |
