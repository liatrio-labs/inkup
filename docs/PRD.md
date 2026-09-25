# PRD: InkUp

**Status:** Draft v0.3 · **Author:** Daniel Hagen · **Date:** 2026-09-22
**Form factor:** Browser extension (Chrome first, Manifest V3) with a side panel UI and an in-extension processing pipeline
**Vocabulary:** canonical terms are defined in [`CONTEXT.md`](../CONTEXT.md). This document uses them exactly.

---

## 1. Problem Statement

Reviewing a live website today means context-switching between the site, a screenshot tool, a notes doc, and a ticket
tracker. Spoken observations ("this should go here", "make this feel lighter") are fast to produce but slow to turn into
actionable, located, written change requests, so most of them are lost or arrive as vague tickets that need a follow-up
conversation. Existing tools cover pieces of this (Loom records, Slack's overlay draws, BugHerd pins comments) but none
capture *where on the page* the reviewer meant, *what they said about it*, and *when*, then turn that into a structured
change list and agent-ready prompts.

The cost is that review feedback from the person with the most product context (the site owner or PM) is the most
expensive kind to write down, so it happens less often and lands with less precision than it should.

## 2. Goals

1. **Zero-friction capture.** A reviewer can start a review on any page in one click and speak and draw without ever
   stopping to type. Target: time from "decide to review" to "recording" under 5 seconds, plus one screen-picker
   confirmation for video.
2. **Located, deictic-aware notes.** Spoken references like "this" and "here" resolve to concrete page elements in the
   output. Target: 90% of Change Items name the correct DOM element or region, verified against a labeled sample set.
3. **Actionable output, not a transcript.** Every Session produces a numbered Change Item list where each item has a
   title, Locations, intent, evidence (screenshot, video timestamp), and an optional agent prompt. Target: a reviewer
   accepts 80%+ of generated items without editing.
4. **See it as you say it.** Draft Items appear in the side panel during the Session so the reviewer can discard or pin
   them by voice without breaking flow.
5. **Works for free, better for a key.** Transcription has a free, fully offline default and two paid tiers the user
   unlocks with their own keys. Draft and final processing use the user's own Anthropic key. The extension makes no
   calls to any vendor the user did not configure.
6. **Off-the-shelf everything.** Use established libraries for UI, drawing, recording, storage, and extension
   scaffolding. The novel code is the timeline correlation and the prompt design, nothing else.

## 3. Non-Goals

- **Implementing the fixes.** The product produces Change Items and prompts for an agent. It does not run an agent, edit
  code, or open PRs. (Separate initiative; keeps the trust boundary clear.)
- **Multi-user or collaborative review.** One reviewer, one Session. Sharing is "export a folder." (Adds auth, sync, and
  hosting; premature.)
- **Hosted service or accounts.** No backend, no sign-in. Everything runs in the browser and hits only user-configured APIs.
- **A Site entity.** Sessions record the origin they started on and the session list groups by it. There is nothing to
  create or name. (Site-level context for the model is a P2 idea.)
- **Firefox and Safari in v1.** Architecture stays cross-browser where possible (WebExtension APIs, sidebar-shaped UI),
  but only Chrome ships. Firefox has a sidebar but no offscreen document; see Decision Log.
- **Companion native app in v1.** The macOS on-device speech engine is fast and free but needs a native messaging host
  installed outside the browser. Deferred to P2.
- **Persistent annotations on the page.** Strokes are ephemeral, Slack-style. They exist as Annotations on the timeline,
  not as a comment layer on the site.
- **Masking on-screen data.** Video and screenshots capture whatever the page shows. The reviewer owns the site;
  first-run notices say what leaves the machine. No blurring, no field masking.
- **Reviewing native apps, PDFs, or non-web content.** Web pages only.

## 4. Users

**Primary: the site owner / product person reviewing their own site.** Has context on what should change, is not
necessarily the one who will implement it, and increasingly hands work to an AI coding agent. Wants to talk, point, and
move on.

**Secondary: the implementer (human or agent) consuming the output.** Needs each Change Item to be unambiguous about
*what* and *where*, with evidence to check against.

## 5. User Stories

Ordered by priority.

### Capture

- As a site owner, I want to open the side panel and press Start on any page so that I can begin talking immediately
  without setup.
- As a site owner, I want to draw on the page while I talk, with the Strokes fading after a couple of seconds, so that I
  can point at things without cluttering the page or stopping to erase.
- As a site owner, I want my voice transcribed live as I talk, with captions in the side panel, so that I can catch
  mis-hearings in the moment and never type a note.
- As a site owner, I want the tab recorded as video so that motion, hover states, and scrolling I comment on are preserved.
- As a site owner, I want a screenshot captured automatically whenever I draw, click, or navigate so that each
  Annotation has a still image of exactly what I was looking at.
- As a site owner, I want a running timer and a recording indicator in the panel so that I know the Session is live and
  how long I have been going.
- As a site owner, I want to pause and resume, by button or by voice, so that I can take a phone call without producing
  a garbage segment.
- As a site owner, I want the Session to follow the tab through any navigation, including a third-party checkout, so
  that I can review a whole flow in one Session.

### Live feedback

- As a site owner, I want Draft Items to appear in the panel shortly after I finish pointing and talking so that I can
  see whether I was understood.
- As a site owner, I want to say "scratch that" to discard the last Draft Item or Annotation, and "pin that" to keep
  one, so that I can correct the record without touching the keyboard.
- As a site owner, I want to correct a mis-hearing by simply saying it again so that I never have to stop and edit mid-review.

### Deictic references (the core case)

- As a site owner, I want to circle a component, say "this", scroll somewhere else, circle a spot, and say "should go
  here", and get one Change Item that moves the component from the first Location to the second, so that I do not have
  to describe positions in words.
- As a site owner, I want "this button" to resolve to the button and "this card" to resolve to the card even when my
  circle covers both, so that the implementer does not have to guess.
- As a site owner, I want "make this the same height as that" to produce one Change Item with a subject and a reference
  so that comparisons are structured, not prose.
- As a site owner, I want to draw an arrow from one spot to another and have that count as a move so that I can skip the
  words entirely.

### Output

- As a site owner, I want a review page listing every Change Item with its screenshot and video timestamp so that I can
  verify and edit before exporting.
- As a site owner, I want items the model was unsure about flagged and sorted first so that I resolve ambiguity before
  it reaches an implementer.
- As a site owner, I want to edit the transcript and re-run Process so that a mis-hearing never becomes a wrong item.
- As a site owner, I want to edit, merge, split, delete, and reorder items so that the final list reflects what I meant.
- As a site owner, I want each item to carry an agent prompt that cites its screenshots by path so that an agent working
  in the exported folder can see the evidence.
- As a site owner, I want to export the Session as a folder (Markdown, JSON, screenshots, video) so that it lives with
  the project and is diffable.

### Configuration

- As a site owner, I want transcription to work out of the box with no key so that I can try the product in one sitting.
- As a site owner, I want to pick a transcription tier (Free / Better / Best) and paste a key for the paid ones so that
  I can trade cost for accuracy.
- As a site owner, I want to paste my Anthropic API key once, stored locally, and choose a model so that processing runs
  on my account.
- As a site owner, I want to see an estimated cost before Process runs so that I am never surprised by API spend.

### Edge cases

- As a site owner, on first run I want a one-time page that asks for microphone access and explains what leaves my
  machine, so that later Sessions start without prompts.
- As a site owner, if I cancel the screen-share picker, I want the Session to continue with screenshots only and tell me
  video is off.
- As a site owner, if I close the side panel mid-Session, I want the Session to stop cleanly and open the review page,
  not lose the recording.
- As a site owner, if the streaming transcription connection drops, I want the extension to reconnect and, failing that,
  fall back to the free offline engine without losing the Session.
- As a site owner, if Process fails, I want the raw recording, transcript, and Annotations preserved so that I can retry
  without re-reviewing.
- As a site owner, if I speak for 40 minutes, I want processing to complete without hitting a context limit or silently
  truncating.
- As a site owner, if a page uses an iframe, canvas, or shadow DOM, I want drawing to still work even if Candidates
  degrade to "region at coordinates."
- As a site owner, if storage is nearly full, I want a warning and an easy way to drop old video without losing the items.

## 6. Requirements

### 6.1 Must-Have (P0)

**P0-1 Session control.** The Session is bound to one tab from Start to Stop, whatever URLs it visits. Control lives in
a window-scoped Chrome side panel.

- [ ] The toolbar icon and the `Alt+Shift+R` shortcut open the side panel. The panel has Start; once live, it has Pause,
  Resume, Stop, and a Draw toggle.
- [ ] Start requests the tab video stream via the screen picker (see P0-5), then begins recording within 2 seconds of
  the picker closing. If the picker is cancelled, the Session starts without video and the panel shows "video off".
- [ ] The panel shows elapsed time (mm:ss), recording state, the recording tab's title, the live caption strip, the
  Annotation count, and the Draft Item list.
- [ ] If the reviewer switches to another tab, the panel stays open, shows "recording: \<tab title>" with a "go back"
  link, and a `tab_switch` event is logged. Capture is unaffected.
- [ ] Pause halts audio, video, transcription, and event capture; Resume continues into the same Session with a gap marker.
- [ ] Stop finalizes all media and opens the review page. Closing the side panel is treated as Stop.
- [ ] Soft cap: the panel warns at 45 and 60 minutes; recording continues.
- [ ] First run: an onboarding tab requests microphone permission and shows the privacy notices (see P0-12). Sessions
  cannot start until the mic grant exists.

**P0-2 Ephemeral drawing overlay.** A full-viewport transparent canvas injected as a content script, inside a Shadow DOM
root. Nothing else is injected into the page.

- [ ] Draw mode toggles from the panel button or `Alt+Shift+D`. While on, pointer events go to the canvas and the cursor
  changes. Holding `Shift` while draw mode is off draws temporarily.
- [ ] Strokes render immediately, persist while the pointer is down, then fade out 2 seconds after pointer-up
  (configurable 1–5s).
- [ ] Each Stroke is recorded with: session-relative timestamp, path points, viewport scroll offset, viewport size and
  device pixel ratio, page URL, and bounding box in page coordinates.
- [ ] Works on pages with fixed headers, sticky elements, and inside scrollable containers.
- [ ] Re-injects after every navigation so drawing works on every page the tab visits (requires the host permission in P0-11).

**P0-3 Annotation grouping and shape recognition.** Strokes are grouped into Annotations at capture time.

- [ ] A Stroke joins the open Annotation if it starts within 1.5s of the previous Stroke ending and the page has not
  scrolled more than 25% of the viewport or navigated. Otherwise a new Annotation opens.
- [ ] The open Annotation also closes on: a Speech Boundary (a new demonstrative or sentence start in the live
  transcript), the draw-mode toggle turning off, or the `next` Voice Command.
- [ ] Shape recognition classifies each Stroke as `circle`, `underline`, `arrow`, `scribble`, or `freeform`. A Stroke
  classified as `arrow` is a Connector: the marks at its tail and head become that Annotation's `subject` and
  `destination`.
- [ ] Each Annotation stores its Strokes, its screenshot, its Candidates, and the transcript segments that overlap its
  time span plus 2s either side.

**P0-4 Candidate resolution.** For each Annotation, capture the elements it might refer to. The final pick happens at
processing time using speech.

- [ ] Geometric pick: the element the Strokes enclose. Among elements lying at least 80% inside the Annotation's
  bounding box and filling at least a quarter of it, pick the one filling most of it, so a loose circle around a button
  picks the button, not the card around it. When the mark encloses nothing that size (an underline, a scribble over
  text), pick the deepest element whose box covers at least 70% of the bounding box; fall back to the largest overlap.
  (Changed 2026-09-23 after review feedback; see ADR 0012.)
- [ ] Candidates = the geometric pick, up to 5 of its ancestors, and any siblings the Strokes cover. For each store: a
  stable CSS selector, tag, role, accessible name / visible text (truncated to 200 chars), `data-testid` and `id` if
  present, and bounding box.
- [ ] Degrade gracefully: if nothing resolves (canvas, cross-origin iframe), store the region only and flag
  `resolution: "region"`.
- [ ] Processing (P0-8) picks the winner: a noun in the paired speech ("button", "card", "header", "section", "image",
  "link", "nav") is matched against Candidate roles, tags, and appearance (a link styled as a button counts as a
  button). No noun or no match falls back to the geometric pick with lowered confidence.

**P0-5 Tab video capture.** `getDisplayMedia` with the browser's screen picker, called from the side panel's Start click.

- [ ] The picker opens with tabs listed and the extension's own surfaces excluded. The reviewer chooses the reviewed
  tab; the extension cannot preselect or verify it (see Decision Log D1).
- [ ] The video `MediaRecorder` runs in the side panel document. Because the panel is window-scoped it survives tab
  switches; closing it stops the Session (P0-1).
- [ ] Video is aligned to the Session clock; recorder start offset is stored.
- [ ] Default cap 1280px wide, 15 fps, to keep a 30-minute Session under ~300 MB.
- [ ] Capture continues across all navigations, same-origin and cross-origin, until Stop or tab close.

**P0-6 Action-triggered screenshots.** `chrome.tabs.captureVisibleTab` from the service worker on defined triggers.

- [ ] Triggers: Annotation close (captured with the Strokes still visible), click on an interactive element, navigation
  complete, the `snap` Voice Command, and a panel Snap button.
- [ ] Debounce to at most one screenshot per 500ms.
- [ ] Each screenshot stores timestamp, URL, scroll offset, viewport size, DPR, and the Annotation it depicts.
  Screenshots are clean by construction: the panel is browser chrome, not page content, and the canvas holds only
  Strokes.

**P0-7 Audio capture and streaming transcription.** Microphone via `getUserMedia` in the offscreen document. Audio is
both recorded (`MediaRecorder`, WebM/Opus) and transcribed live. Three configurable tiers, all streaming.

| Tier | Engine | Key | Timestamps | Cost (Sept 2026) |
| --- | --- | --- | --- | --- |
| **Free (default)** | Chrome on-device Web Speech API (`processLocally: true`) | none | Approximate: results stamped against the Session clock on arrival | $0 |
| **Free (alternate)** | Local Whisper in-browser via Transformers.js + WebGPU; model picker base / small / turbo | none | Word-level | $0, one-time model download 75 MB–800 MB |
| **Better** | Deepgram Nova-3 streaming (WebSocket) | Deepgram | Word-level | ~$0.46/hr, $200 free credit |
| **Best** | ElevenLabs Scribe v2 Realtime (WebSocket) | ElevenLabs | Word-level | ~$0.39/hr |

- [ ] Mic, speech recognition, and the audio recorder live in the MV3 offscreen document (reason `USER_MEDIA`), which
  has unbounded lifetime and survives service-worker termination. They start only after the onboarding mic grant.
- [ ] Audio is chunked every 30s to IndexedDB so a crash loses at most 30s.
- [ ] Transcript segments arrive as `transcript_segment` events while the Session is live; the panel shows the last ~2
  lines as captions.
- [ ] Language follows `navigator.language`. English is the tested locale; the demonstrative and noun lists are
  English-only in v1 and live in a per-locale table.
- [ ] Web Speech results carry `timestamp_quality: "approximate"`; word-level engines carry `"word"`. If
  `SpeechRecognition.available()` returns `downloadable`, the onboarding page offers to install the language pack.
- [ ] Local Whisper runs on 30s chunks as they land; captions lag by up to one chunk.
- [ ] Paid tiers stream PCM over WebSocket; on disconnect, retry 3× with backoff, then fall back to the free default and
  log `transcription_fallback`.
- [ ] Every engine is an adapter behind one interface (`start(stream) → AsyncIterable<Segment>`).
- [ ] Post-Session re-transcription from the review page through any tier's batch endpoint.

**P0-8 Voice Commands.** Matched on the live transcript; never treated as review content.

- [ ] Vocabulary: `scratch that` (discard the latest Draft Item, or the latest Annotation if no Draft Item is newer),
  `next` / `new note` (close the open Annotation), `pin that` (pin the latest Draft Item), `snap` (screenshot), `pause`,
  `resume`.
- [ ] No wake prefix. A phrase counts as a command only when the microphone level shows ~1s of silence on both sides of
  it. Silence is measured from the mic stream (an AudioWorklet level detector), not from transcript timestamps, so it
  works on the approximate-timestamp free tier.
- [ ] A recognized command is logged as a `voice_command` event and removed from the transcript that goes to processing.
- [ ] Known trade-off (owner's decision): ordinary speech such as "…should pause here" followed by a natural pause can
  trigger `pause`. The panel shows a 2s "Paused by voice, undo?" toast.

**P0-9 Unified event timeline.** One ordered log per Session, the single source of truth for processing.

- [ ] Event types: `session_start`, `session_pause`, `session_resume`, `stroke`, `annotation`, `click`, `navigation`,
  `tab_switch`, `scroll_settle`, `screenshot`, `transcript_segment`, `transcription_fallback`, `voice_command`,
  `draft_item`, `draft_action`, `session_end`.
- [ ] All events share the Session clock (`t0` recorded in the service worker at Start; every context stamps
  `Date.now() - t0`; recorder start offsets stored).
- [ ] The JSON schema is versioned and documented in `contract/` (was `docs/schema/`; ADR 0007).

**P0-10 Draft Items during the Session.** A cheap model pass runs live so the reviewer sees what was understood.

- [ ] Trigger: an Annotation closes and ~3s of silence follows, debounced; plus a 30s fallback timer for speech with no
  drawing. Each pass sends only events since the previous pass, plus the last 2 Draft Items for continuity.
- [ ] Model: a small fast model (default `claude-haiku-4-5-20251001`), separate from the Process model. Sends text only,
  never screenshots.
- [ ] Draft Items render in the panel as cards: title, Category, resolved Location names. Two actions, by click or
  voice: **discard** and **pin**. No inline editing.
- [ ] Discards and pins are logged as `draft_action` events. Process (P0-11) receives discards as negative examples and
  pins as fixed items it may not rewrite.
- [ ] No Anthropic key configured: the panel shows Annotation cards (screenshot thumbnail, geometric pick, paired
  speech) instead of Draft Items, and `scratch that` discards Annotations.

**P0-11 Process: final Change Item generation.** Explicit, never automatic.

- [ ] Stop opens the review page showing the transcript, Annotations, and Draft Items. A **Process** button shows an
  estimated token count and cost (computed from transcript length, Annotation count, and the chosen model's published
  prices) before any call.
- [ ] The transcript is editable before Process; Process runs on the edited text.
- [ ] Input is a compact, time-ordered interleaving of transcript segments, Annotations (with Candidates, shape class,
  Connector endpoints), Voice Commands, and draft actions. No raw pixels by default.
- [ ] Output is a JSON array of Change Items validated with Zod: `id`, `title`, `category` (layout | style | copy |
  content | behavior | bug | question), `intent`, `locations[]` (each with `role` subject | reference | destination,
  `selector`, `element`, `url`, `screenshot`, `annotation`), `evidence` (video range, screenshot IDs), `transcript`
  excerpt, `confidence`, `ambiguity` (string, present when confidence is low), `agent_prompt`, `pinned` (bool).
- [ ] Stroke-to-speech pairing window: 2s with word-level timestamps, 4s with approximate ones; the prompt is told which
  applies.
- [ ] Fixtures, each run in both timestamp modes: (a) "this" at Annotation A then "should go here" at B yields one
  `layout` item with subject A and destination B; (b) "make this the same height as that" yields one `layout` item with
  subject and reference; (c) an arrow Connector from A to B with no speech yields a `layout` item with subject and
  destination; (d) a circle covering a button inside a card with "this button" resolves to the button, and with "this
  card" resolves to the card.
- [ ] Long Sessions are processed in ~10-minute windows with overlap, then merged; the merge deduplicates items with the
  same subject and intent. Pinned Draft Items pass through unchanged.
- [ ] Every item is checked against the recording, or its screenshots and crops, after Process (vetting, ADR
  0009; it replaced the second pass for items under confidence 0.6).
- [ ] Uses the Anthropic SDK with structured output / tool-use. Default model `claude-sonnet-5`; the user can enter any
  model ID.

**P0-12 Review page.** An extension page showing the processed Session.

- [ ] Left: Change Item list. Items with confidence under 0.6 show a "check me" badge with the model's stated ambiguity
  and sort to the top. No raw scores are displayed.
- [ ] Inline editing of title, intent, category; drag reorder; merge; split; delete. Edits are logged so acceptance rate
  can be measured locally.
- [ ] Right: evidence for the selected item, screenshot with Strokes overlaid, and a video player that seeks to the
  item's timestamp.
- [ ] Transcript view: editable, segments clickable to seek video, "re-transcribe with…" control.
- [ ] "Copy agent prompt" per item and "Copy all prompts" (one numbered prompt for the whole list).

**P0-13 Export.** The exported folder is the handoff to humans and agents.

- [ ] `review.md`: numbered items, each with Locations, intent, embedded screenshot, and video timestamp link; full
  transcript as an appendix.
- [ ] `session.json`: the full event timeline, transcript, Annotations, Draft Items and actions, Change Items.
- [ ] `screenshots/` and `recording.webm` (omitted if video was off).
- [ ] Each `agent_prompt` is self-contained text that cites its screenshots by relative path (`screenshots/s7.png`) so
  an agent run inside the folder can open them.
- [ ] Delivered as one `.zip` via `chrome.downloads`.
- [ ] After a successful export, offer to delete the Session's video and audio while keeping transcript, items, and screenshots.

**P0-14 Settings, permissions, and key storage.**

- [ ] Manifest requests `<all_urls>` host permission at install, plus `sidePanel`, `offscreen`, `storage`, `downloads`,
  `tabs`. Rationale in Decision Log D3.
- [ ] Transcription: tier selector with engine, key field, and Test button per tier; Free tier shows Web Speech vs local
  Whisper and the Whisper model picker with download status.
- [ ] Processing: an Anthropic key and a Vercel AI Gateway key, each with its Test button; per model role (Process,
  Draft, Merge) a provider, a model from that provider's list (a model ID field when there is no list) and an effort.
- [ ] Capture: fade duration, video quality preset, keyboard shortcuts.
- [ ] Keys stored with `chrome.storage.local` (never `sync`), never logged, never exported.
- [ ] Session list: grouped by starting origin, showing date, length, item count, size; per-Session delete; total
  storage with a warning at 80% of quota.

**P0-15 Privacy guarantees.**

- [ ] First-run notices, each shown once at the moment a capability is enabled: microphone and video capture
  (onboarding), choosing a paid transcription tier (audio streams to that vendor while live), adding an Anthropic key
  (transcript and element descriptions are sent during Sessions for Draft Items and on Process; screenshots only for
  low-confidence items).
- [ ] Keystrokes are never captured. Screen content is captured as-is.
- [ ] With the Free tier and no Anthropic key, the extension makes zero network calls other than the one-time model or
  language-pack download the user triggers.
- [ ] Sessions live in IndexedDB until the user deletes them.
- [ ] Chrome's own tab-sharing indicator plus the panel's timer are the recording indicators; nothing is drawn into the
  page except Strokes.

### 6.2 Nice-to-Have (P1)

- **P1-1 Element highlight on hover** in draw mode, showing the geometric pick before committing.
- **P1-2 Additional transcription adapters**: OpenAI `whisper-1` (batch, word timestamps; `gpt-4o-transcribe` returns no
  timestamps and is unusable here), AssemblyAI Universal-3.5 Realtime, Speechmatics.
- **P1-3 Additional LLM adapters**: OpenAI-compatible endpoint (covers OpenAI, OpenRouter, Ollama, LM Studio).
- **P1-4 Push exports**: post items to GitHub Issues or Linear via the user's token.
- **P1-5 `chrome.tabCapture` path** started from the toolbar icon: deterministic tab targeting with no picker, and the
  fallback if Chrome enforces user activation for `getDisplayMedia` (see D1).
- **P1-6 Per-locale demonstrative and noun tables** beyond English.
- **P1-7 Firefox build**: sidebar UI, background page instead of offscreen document.

### 6.3 Future Considerations (P2)

Design so these are possible; do not build them now.

- **OS speech engine via native messaging host.** macOS 26 SpeechAnalyzer runs 40–60× realtime on-device with word
  timestamps, free. Keep the transcription adapter interface able to accept a native-messaging source.
- **Site context for the model.** An optional per-origin note ("Next.js marketing site, Tailwind") passed into Process.
  Keep the prompt builder able to accept a preamble.
- **Persistent, shareable reviews** (hosted). Keep the Session format self-contained and URL-addressable.
- **Multi-reviewer Sessions and comment threads.** Keep item IDs stable and include an `author` field from day one.
- **Diff-aware re-review**: run the same Session against a new deploy. Keep selectors, screenshots, and element text.
- **Design-tool import**: reference Figma frames in Locations. Keep `locations[]` extensible beyond DOM selectors.
- **Agent execution**: a "fix with agent" button. Explicit non-goal now; `agent_prompt` is the seam.

## 7. Technical Approach

| Concern | Default choice | Why |
| --- | --- | --- |
| Extension scaffolding | WXT (Vite-based, MV3, cross-browser) | Manifest, HMR, content script bundling, Firefox/Chrome builds |
| Language / UI | TypeScript, React, Tailwind, shadcn/ui | Standard, accessible components |
| Session UI | `chrome.sidePanel`, window-scoped | Outside the captured tab; survives tab switches |
| In-page overlay isolation | Shadow DOM root for the canvas | No CSS collisions with the reviewed site |
| Drawing | `perfect-freehand` on `<canvas>` | Pressure-aware, tiny, maintained |
| Shape recognition | Custom rules-based classifier (circle / underline / arrow / scribble) | Every $1/$P npm package is unmaintained; see `docs/PLAN.md` |
| Element selectors | `css-selector-generator` + `dom-accessibility-api` | Maintained, hashed-class blacklists; accessible name and role for Candidates |
| Media capture | `MediaRecorder`, `getDisplayMedia`, `getUserMedia`, `chrome.tabs.captureVisibleTab` | Platform APIs |
| Silence detection | `@ricky0123/vad-web` (Silero, ORT wasm bundled locally) | Voice Command silence gaps on every tier; segments local Whisper |
| Free transcription (default) | Web Speech API with `processLocally: true` | Built into Chrome, offline, live |
| Free transcription (alternate) | `@huggingface/transformers` running Whisper on WebGPU, WASM fallback | Word timestamps offline |
| Paid transcription | `@deepgram/sdk` v5 (Nova-3 streaming), `@elevenlabs/client` Scribe (v2 Realtime) | WebSocket streaming, word timestamps, browser token auth |
| Local storage | IndexedDB via Dexie | Large blobs, indexed queries |
| State | `@wxt-dev/storage` for settings, `dexie-react-hooks` for live data | Cross-context updates without a sync library |
| Messaging | `@webext-core/messaging` | Typed messages between worker, offscreen, panel, content, pages |
| Schema validation | Zod | Validates LLM output and `session.json` |
| LLM | `@anthropic-ai/sdk` structured outputs (`messages.parse` + `zodOutputFormat`), `countTokens` | Validated JSON, cost estimate, image support for the low-confidence pass |
| Video playback | Native `<video>`; `fix-webm-duration` / `ts-ebml` make chunked WebM seekable | No player library |
| Export | `client-zip` in the review page + `chrome.downloads` | Streams large video without holding it in memory |
| Testing | Vitest (unit), Playwright with extension loading (e2e; fake media devices for capture) | Playwright loads unpacked MV3 extensions |

Library versions, maintenance status and rejected alternatives were checked on 2026-09-22 and are recorded in `docs/PLAN.md`.

### Architecture sketch

```text
┌─ Side panel (window-scoped, UI + video) ──────────────────────────────────┐
│ Start · Pause/Resume · Stop · Draw · timer · captions · Draft Item cards   │
│ getDisplayMedia + video MediaRecorder  (close panel = Stop)                │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ chrome.runtime messages
┌──────────────▼────────────────────────────────────────────────────────────┐
│ Background service worker                                                  │
│  session clock t0 · event log · captureVisibleTab · IndexedDB (Dexie)      │
│  Draft Item passes (Haiku) · Process pipeline (Sonnet → Zod)               │
├────────────────────────────────────────────────────────────────────────────┤
│ Offscreen document (USER_MEDIA, unbounded lifetime)                        │
│  mic getUserMedia · audio MediaRecorder · silence detector                 │
│  transcription adapter (Web Speech | local Whisper | Deepgram | 11Labs)    │
└──────────────▲────────────────────────────────────────────────────────────┘
               │ messages (strokes, annotations, clicks, navigations)
┌──────────────┴────────────────────────────────────────────────────────────┐
│ Content script (Shadow DOM, re-injected per navigation)                    │
│  drawing canvas · shape recognizer · Annotation grouper · Candidate finder │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Extension pages ──────────────────────────────────────────────────────────┐
│ Onboarding (mic grant + notices) · Options · Review page · Session list    │
└────────────────────────────────────────────────────────────────────────────┘
```

**Session clock.** The service worker records `t0 = Date.now()` at Start. Every event in every context carries
`t = Date.now() - t0`. Audio and video recorders store their start offsets from `t0`, so transcript timestamps and video
seek positions map to one axis. Streaming transcripts are stamped on arrival and, for word-level engines, corrected by
the engine's own audio offsets. This is the one piece of correctness the whole product rests on.

**Prompt shape for Process.** The model receives a time-ordered script like:

```text
TIMESTAMP QUALITY: word-level
[00:12.4] ANNOTATION #3 circle · candidates: button.cta "Get started" (pick) › div.card › section.hero · at /pricing · screenshot s7
[00:12.9] SPEECH "this button"
[00:14.1] SCROLL to y=0
[00:16.0] ANNOTATION #4 circle · candidates: nav > a "Docs" (pick) › header nav › header · at /pricing · screenshot s8
[00:16.5] SPEECH "should go here, and make it smaller"
[00:19.2] DRAFT d2 "Move Get started into header nav" → PINNED by user
```

and is instructed to pair each demonstrative with the Annotation inside the pairing window, use nouns to pick among
Candidates, honor pins and discards, and emit Change Items.

## 8. Success Metrics

### Leading (first 30 days of personal use, then a handful of friendly testers)

- Sessions started per week per user: ≥ 3 (success), ≥ 6 (stretch).
- Median time from Start click to recording, including the picker: < 5s.
- Item acceptance rate (items exported without edit ÷ items generated): ≥ 80%.
- Draft Item discard rate: < 25% of drafts discarded by voice or click. Higher means the live pass is noise.
- Candidate resolution accuracy on the fixture set: ≥ 90% correct element with word-level timestamps, ≥ 80% with the
  free Web Speech tier, on a 20-Session labeled set.
- Voice Command false-trigger rate: < 1 per 10 minutes of speech on the labeled set.
- Processing failure rate: < 5%.
- Free-tier share: % of Sessions run with no paid key (diagnostic, not a target).

### Lagging (quarter)

- Share of Change Items acted on (closed in tracker or shipped) within 14 days: ≥ 60%.
- Reviewer-reported time saved per review vs. the previous workflow: ≥ 50%.
- Sessions per user retained at week 8: ≥ 50% of week-1 users still recording.

Measurement: all leading metrics are computable from local `session.json` files with a small script; no telemetry is
sent anywhere. Evaluate at 2 weeks, 30 days, and end of quarter.

## 9. Decision Log

Decisions D1–D4 made 2026-09-22 with the product owner and revised the same day after a grilling session (Q1–Q31,
recorded below) and a research pass against Chromium sources. Decisions marked **ADR** have a longer record in
`docs/adr/`.

| # | Decision | Chosen | Alternatives rejected | Rationale |
| --- | --- | --- | --- | --- |
| D1 **ADR-0002** | Video capture | `getDisplayMedia` with the browser picker, called from the side panel Start click | `chrome.tabCapture` from the toolbar icon (no picker, deterministic tab); screenshots-only | Owner wants Start inside the panel. Research: the picker cannot preselect or verify the reviewed tab from any extension context, and Chrome plans to require user activation, which the panel click provides. `tabCapture` cannot be started from panel clicks (Chromium Won't Fix) and becomes P1-5. |
| D2 | Transcription model | Three configurable tiers, all streaming | Single provider; batch after Stop | "Free, better, best." Streaming gives live captions and Draft Items. |
| D2a | Free default | Chrome on-device Web Speech API | Local Whisper only | Zero download, live, offline. No per-word timestamps (spec PR WebAudio/web-speech-api #192 still open July 2026). Local Whisper stays as the offline word-level alternate. |
| D2b | Better | Deepgram Nova-3 streaming | AssemblyAI; OpenAI `whisper-1` | Lowest latency, word timestamps, free credit. `gpt-4o-transcribe` rejects timestamp granularities; `whisper-1` is batch-only. |
| D2c | Best | ElevenLabs Scribe v2 Realtime | AssemblyAI | Lowest WER on independent benchmarks, word timestamps. Tiers are about accuracy and latency, not price. |
| D2d | OS speech engine | P2, design the seam only | P1 build | Needs a native messaging host outside the browser. |
| D3 **ADR-0003** | Host permissions | `<all_urls>` at install | Per-origin optional permission at Start; activeTab only | Session follows the tab anywhere (Q1). activeTab is revoked on navigation; per-origin prompts would interrupt every cross-origin step. Unlisted, own-use release. |
| D4 | LLM provider | Anthropic only behind an adapter | OpenAI-compatible first; both | Structured output and images in one SDK. Draft model Haiku, Process model Sonnet. |
| D5 **ADR-0001** | Media ownership | Mic, speech, audio recorder in the offscreen document; video recorder in the side panel; panel close = Stop | Everything in the panel; everything in offscreen | Offscreen has unbounded lifetime and survives worker termination but never has user activation. The panel has activation for the picker. Closing the panel is a deliberate act, so treating it as Stop loses nothing. |
| D6 | Session UI | Chrome side panel, window-scoped | In-page floating toolbar; popup | Owner: UI must not be in the tab. Panel is outside captured media by construction. Window-scoped survives tab switches. |
| D7 | Voice Commands | No wake prefix; ~1s silence gap on both sides, measured from mic level | Prefix for session control only; prefix for all | Owner's call. False triggers on "pause" are mitigated by an undo toast. |

**Grilling record (Q1–Q31, 2026-09-22).** Session = one tab, any URL (Q1). Stroke → Annotation → Change Item, "note"
banned (Q2). Categories layout | style | copy | content | behavior | bug | question (Q3). Location roles subject |
reference | destination (Q4). Grouping by 1.5s gap + no scroll/navigation + signals (Q5, Q9: speech boundaries,
Connectors, draw toggle, voice command). Candidate pick: smallest enclosing ≥70% + spoken noun (Q6), candidates = pick +
ancestors + covered siblings (Q10). Side panel UI (Q7), canvas-only in page (Q11). Explicit Process with cost estimate
(Q8). Live Draft Items (Q12), triggered on Annotation close + silence (Q13), Haiku for drafts (Q14), discard and pin
only (Q15). Corrections by speaking again and editing the transcript before Process (Q16). Export folder is the agent
handoff (Q17). Keep until deleted, warn at quota, offer to drop media (Q18). Low-confidence badge sorted first (Q19).
First-run notices, no masking (Q20). Six voice commands (Q21), no prefix, silence gap (Q25). Browser locale,
English-tested (Q22). Soft cap 60 min (Q23). No Site entity (Q24). Picker over tabCapture, Start in panel (Q26/27/30).
`<all_urls>` (Q28). Window-scoped panel (Q29). Panel owns video, close = Stop (Q31).

Research sources (Chromium source, Chrome developer docs, chromium-extensions group, MDN) are listed in `docs/adr/0001`
and `docs/adr/0002`. Transcription sources: [Deepgram STT comparison
2026](https://deepgram.com/learn/best-speech-to-text-apis-2026), [Future AGI
benchmarks](https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/),
[Coval
benchmarks](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/),
[OpenAI transcription
reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create),
[ElevenLabs pricing](https://elevenlabs.io/pricing/api), [MDN
processLocally](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally), [Web Speech timing
PR #192](https://github.com/WebAudio/web-speech-api/pull/192),
[simonw/speech-analyzer-cli](https://github.com/simonw/speech-analyzer-cli/blob/main/README.md).

## 10. Open Questions

### Blocking (answer before build)

- **[Engineering]** Does `SpeechRecognition` with `processLocally: true` actually run in an offscreen document?
  Chromium's permission gate allows offscreen documents and no bug says otherwise, but no primary source confirms
  on-device mode was tested there. Also check crbug 444393111 (macOS on-device availability regression in Chrome 140).
  Spike on day one; fallback is local Whisper as the free default.
- **[Engineering]** Does a hidden, cached side panel document (reviewer switched tabs) keep its `MediaRecorder` running?
  Chromium caches the view rather than destroying it, but nothing documents recorder behavior while hidden. Spike
  alongside the above.

### Non-blocking (resolve during build)

- **[Engineering]** Track Chrome's "getDisplayMedia requires user activation" deprecation (chromestatus
  5090735022407680). The panel click satisfies it; confirm activation survives the async gap between click and the call.
- **[Engineering]** Streaming PCM format and sample rate per vendor (Deepgram linear16 at 16 kHz vs ElevenLabs); one
  AudioWorklet resampler should serve both and the silence detector.
- **[Engineering]** Cross-origin iframes: `all_frames` injection is possible; coordinating Strokes across frames is
  messy. Region-only Candidates in v1; confirm.
- **[Engineering]** Cost estimate accuracy: token counts from the Anthropic count-tokens endpoint vs a local heuristic.
- **[Product]** Is 25% of Annotations discarded by voice a sign the Draft Item pass is too eager, or that grouping is
  wrong? Decide what the metric triggers.
- **[Design]** Panel layout: captions vs Draft Item cards competing for the same narrow column.

## 11. Timeline Considerations

No hard external deadline. Phased so each phase is demoable end-to-end:

1. **Phase 1, capture spine (weeks 1–2):** onboarding mic grant, side panel with Start/Stop/timer, offscreen document
   with mic recording and Web Speech captions, Session clock, canvas with fade and toggle/modifier, Annotation grouping
   (time gap only), Candidate capture, screenshot on Annotation close, `session.json` export. Proof: record a 2-minute
   Session on a sample page, export, and see Annotations interleaved with caption segments in the JSON.
2. **Phase 2, understanding (weeks 3–4):** shape recognition and Connectors, speech-boundary and voice-command grouping
   signals, silence detector, Anthropic adapter with Zod output, all four fixtures passing in both timestamp modes,
   review page read-only with badges. Proof: fixtures pass.
3. **Phase 3, live loop and video (weeks 5–6):** Draft Items with discard and pin, `getDisplayMedia` video in the panel
   with close-equals-Stop, video seek from items, Deepgram and ElevenLabs adapters with fallback, local Whisper
   alternate, editable transcript and items, cost estimate, Markdown + zip export, options page. Proof: full Session on
   the Best tier from Start to a pasted agent prompt, with one draft discarded by voice.
4. **Phase 4, polish (weeks 7–8):** re-transcribe from the review page, quota warnings and media cleanup, hover
   highlight, `whisper-1` adapter, `tabCapture` alternate path. Chrome Web Store unlisted release.

Dependencies: none external beyond provider API access. Risk to timeline: the two blocking spikes above. If on-device
Web Speech fails in the offscreen document, local Whisper becomes the free default and Phase 1 grows by ~3 days.

## 12. Appendix: Sample Change Item

```json
{
  "id": "item_0007",
  "title": "Move 'Get started' CTA into the header nav, right of Docs",
  "category": "layout",
  "intent": "The primary CTA is buried below the fold on /pricing; reviewer wants it in the header, smaller.",
  "locations": [
    { "role": "subject", "url": "/pricing", "selector": "main section.hero button.cta",
      "element": "button 'Get started'", "screenshot": "s7", "annotation": 3 },
    { "role": "destination", "url": "/pricing", "selector": "header nav",
      "element": "nav region right of link 'Docs'", "screenshot": "s8", "annotation": 4 }
  ],
  "evidence": { "video": { "start": 12.4, "end": 18.0 }, "screenshots": ["s7", "s8"] },
  "transcript": "this button ... should go here, and make it smaller",
  "transcription": { "tier": "best", "engine": "elevenlabs-scribe-v2-realtime", "timestamp_quality": "word" },
  "confidence": 0.91,
  "pinned": true,
  "agent_prompt": "On the /pricing page, move the 'Get started' call-to-action button (currently main section.hero button.cta) into the header navigation, positioned immediately right of the 'Docs' link. Reduce its size to match the nav's existing link scale. Keep its destination link unchanged. See screenshots/s7.png (current) and screenshots/s8.png (target area)."
}
```
