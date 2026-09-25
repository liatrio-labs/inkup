# Decisions log

Calls made during implementation that the PRD, PLAN and ADRs leave open. Newest slice first.

## #39: the host updates itself (2026-09-24)

ADR 0008. `inkup update` (`--check`, `--homebrew brew|self|ask`) and a background check in the TUI and `serve`, in
`host/crates/inkup/src/update.rs`, on axoupdater 0.10. Calls made while building it:

- **Homebrew is found by path, not by running `brew`.** The canonical executable path runs through
  `<prefix>/Cellar/inkup/` (or `$HOMEBREW_CELLAR/inkup/`). No subprocess, no dependence on `brew` being on PATH, and
  the same rule covers `/opt/homebrew`, `/usr/local` and Linuxbrew.
- **"self" over Homebrew installs a second copy rather than overwriting Homebrew's.** Writing into the Cellar would
  leave Homebrew's records wrong and `brew upgrade` would put the old files back. The installer's own dir
  (`~/.cargo/bin`) gets the new copy and a receipt; `inkup update` reports which copy PATH runs and suggests
  `brew uninstall inkup`.
- **The choice lives in config.toml, the check's result in `update-check.json`.** The choice is a setting a user may
  edit; the check's time and result are a cache. The `[update]` table is written from the inkup crate with
  `toml_edit`, the same way the store writes `network`, so the store crate is unchanged.
- **The version check ignores the receipt.** Every copy asks GitHub for the newest `inkup-v*` release and compares it
  with its own version, so Homebrew and dev copies get the notice too. Only installing needs the receipt.
- **The notice goes in the key line.** The header has no room at 100 columns without cutting the tabs; the key line
  already carries status, and a command's outcome takes precedence over the notice.
- **reqwest gains rustls (aws-lc-rs)** through axoupdater's `axoasset`, for HTTPS to GitHub. The host's own reqwest
  use (loopback `/health`) is unchanged.

## #38: model providers, model lists and effort (2026-09-24)

Each model role (Process, Draft, Merge) picks its provider, its model and an effort in the options page. The
reviewer asked for model dropdowns instead of typed IDs and for the Test button beside the key.

- **The Vercel AI Gateway is a second provider, not a second adapter.** It serves the Anthropic Messages API at
  `https://ai-gateway.vercel.sh` (`/v1/messages` with streaming, structured output and images, and
  `/v1/messages/count_tokens`), so a Gateway role uses the same Anthropic adapter with the Gateway key and base URL.
  Its model IDs are `creator/model` (`anthropic/claude-sonnet-5`); any Gateway model can be picked. A model that does
  not take structured output or effort there fails the call like any API error.
- **Settings shape.** `processingSettings` is `{process, draft, merge}`, each `{provider: 'anthropic' | 'gateway',
  model, effort?}`. Settings saved before (`processModel`, `draftModel`, `mergeModel`, all Anthropic) are read
  through `normalizeProcessingSettings`, so nothing needs migrating; the next Save writes the new shape. The Gateway
  key is `gatewayKey` in storage.local, under the same rules as `anthropicKey`, with its own one-time notice.
- **"Has a key" is per role.** Live Draft Items need a key for the Draft role's provider, Process with a model a key
  for the Process role's, and Combine one for the Merge role's.
- **Effort is `output_config.effort`** (platform.claude.com/docs/en/build-with-claude/effort, read 2026-09-24;
  typed in `@anthropic-ai/sdk` 0.127): `low`, `medium`, `high`, `xhigh`, `max`. The select offers all five plus
  Default, which sends nothing, whatever the model: which levels a model accepts changes by model, and the API's 400
  says so plainly. It is also sent on the estimate's count_tokens call, since effort shapes the prompt.
- **Model lists are live and cached.** The options page asks each provider with a key for its list: Anthropic's
  `models.list` (every page) and the Gateway's `GET /v1/models`. Both land in `modelLists` (storage.local), which cost
  reads too. Without a key, or when the list call fails, the model field is the old text input. A saved ID the list
  lacks still shows as an option.
- **Cost.** `priceFor` and `outputCapFor` read `anthropic/<id>` as the Anthropic ID (the Gateway's version dots read as
  dashes), so the dated tables still price them. Other Gateway models use the cached list's per-token prices × 1M,
  dated by that list's fetch; unlisted, the estimate has no dollar amount as before. `contextWindowFor` reads the same
  cache (Anthropic's `max_input_tokens`, the Gateway's `context_window`).
- **Test per key.** Each key's Test button checks the models the roles on that provider use (the provider's default
  Process and Draft models when none does), with that key.

## #37: late Web Speech segments are aligned to the VAD before pairing (2026-09-24)

Process paired speech with the wrong Annotation. Strokes are stamped at the pointer event, but Web Speech, the
default transcription, stamps a segment's `t` when its first interim result arrives and `t_end` when its final
does: both late by the recognizer's latency, 0.3–2 s and variable. The Silero VAD's `speech_activity` spans are on
the PCM clock and were only read by the draft trigger.

- **Aligned at processing time, never logged.** `alignSegments` (`packages/core/src/process/align.ts`) moves each
  approximate segment onto the VAD speech that explains it; `processEvents` (the active, edited transcript, then
  aligned) is what Process, its windows and chunks, Process without a model and the Draft Item pass all read. The
  log keeps the arrival times, and an aligned segment carries them in memory as `vad`. No schema change: the
  timeline records what the recognizer reported, and a better aligner later re-reads the same log.
- **The rule.** The start is the latest VAD span that began by `t`, joined back across pauses of up to 1 s, and
  no earlier than 2.5 s before `t` (`SPEECH_LEAD_MS`): on the two real Sessions measured, the first interim came
  0.3–1.3 s after speech began, rarely 2 s. The end is the last span ending by `t_end` (a final arrives after its
  speech), or `t_end` when the final came mid-span. Segments are taken in log order and each starts where the
  previous one ended, so the recognizer splitting one VAD span into two finals gives two segments that share it
  in order. A segment nothing explains keeps its times, and the ones after it start after it.
- **Pairing window.** VAD-aligned segments pair within 2.5 s (word-level 2 s, stamped-on-arrival 4 s) and no longer
  make the Session approximate. The script header says `approximate, VAD-aligned`; when only some speech was
  aligned, the rest is marked `late`, and the system prompt keeps "prefer the Annotation just before" for late
  speech only.
- **"that" refers back.** A tighter window drops hints for pointing words that mean what the previous sentence
  named: in a real Session a "that" began 2.9 s after the scribble it meant. Rather than widen the window, "that"
  is marked like "it" in the demonstratives table (`refers_back`), and in the script a word like that with no mark
  near reads `near none (refers back: #n)`, naming what the latest speech near any Annotation pointed at.
- **Speech Boundary.** An approximate segment's boundary is the latest VAD speech start at or before its `t`, within
  2.5 s, so an Annotation begun while the sentence was said is not closed by it. The offscreen document judges
  comment-box routing and Mute by the same VAD-aligned span (`VoiceCommands.spoken`).
- **Audio start.** The mic recorder's start is taken when `start()` is called, as the tab video already did; the
  `start` event can fire seconds late on a loaded machine.
- **Evidence.** `node scripts/vad-alignment-report.ts` prints, per segment of the trimmed real Sessions in
  `fixtures/vad-alignment`, the stamped and aligned times and the Annotations each pairs with before and after
  (snapshot-tested). 41 of 48 segments align; starts move 0.1–2.4 s earlier (median about 0.8 s).

## #36: the host, Chrome and Firefox release on separate tags (2026-09-24)

ADR 0008. `inkup-v*` tags release the host through cargo-dist (`inkup-v-release.yml`, generated from
`dist-workspace.toml`); `inkup-chrome-v*` tags run `release.yml` (renamed "Chrome extension release"); and
`inkup-firefox-v*` tags run the new `firefox-release.yml`. Calls made while wiring it:

- **Lowercase `inkup-v`.** It is dist's `<package>-v<version>` form, and the package is the `inkup` crate; dist 0.33
  and axotag cannot parse `InkUp-v0.1.0`. The extension tags follow the same lowercase pattern.
- **`tag-namespace = "inkup-v"`, not `"inkup"`.** dist turns the namespace into the trigger `<namespace>**[0-9]+…`;
  with `inkup` that glob would also catch `inkup-chrome-v…` and `inkup-firefox-v…` and fail their runs at plan. The
  price is the generated file's name, `inkup-v-release.yml`.
- **dist-workspace.toml at the repo root**, with `members = ["cargo:host/"]`, because dist writes workflows under the
  repo's `.github/`. dist builds in `host/`, so `host/rust-toolchain.toml` pins the compiler in CI too. The `inkup`
  crate sets `[package.metadata.dist] dist = true`, since `publish = false` would otherwise hide it from dist.
- **All five targets build** on dist's native runners (macos-14, macos-15-intel, ubuntu-22.04, ubuntu-22.04-arm,
  windows-2022); none were dropped.
- **`install-updater = true`.** The shell installer writes the install receipt only when the updater is installed,
  and the planned in-binary updater needs the receipt.
- **No dist run on every PR.** `pr-run-mode = "skip"`; `host-dist-check.yml` runs `dist generate --check` and
  `dist plan` only when the release config changes, and is not part of `ci-ok`.
- **Firefox mirrors Chrome.** Same tag-on-main and tag-equals-version checks, `pnpm zip:firefox`, a GitHub Release
  with the add-on zip, and an AMO upload with the sources zip behind a `firefox-amo` environment that skips when
  `FIREFOX_JWT_ISSUER` or `FIREFOX_JWT_SECRET` is unset. The gecko id is public and set in the workflow. The channel
  defaults to `listed` (`FIREFOX_CHANNEL` overrides).
- **zizmor.** Findings from dist's template are ignored per rule for `inkup-v-release.yml` only
  (`.github/zizmor.yml`). The pre-commit hook passes `--config` because config discovery fails in a git worktree
  nested under another repo.

## #35: one contract between the extension and the host (2026-09-24)

The extension and the Host are about to release on their own tags, so an installed pair will be out of step. ADR 0007
moves what they share into `contract/` and makes CI route on it.

- **Moved.** `packages/protocol/protocol.schema.json`, `docs/schema/session.schema.json` and
  `packages/protocol/fixtures/` (valid and `invalid/`) now live in `contract/`. The generators write there, and every
  Host reader (`generated.rs`, the fixture tests, `contract.rs`, the store and server test helpers) reads only there.
  `docs/schema/` keeps a README pointing to the new place, for older links.
- **CI routing** is `scripts/ci-changes.ts`, unit-tested, instead of inline `grep`: `contract/` runs both sides,
  `host/` the Host, the workspace the extension, docs lint only, an unknown path both. The outputs are `extension`,
  `host` and `contract`. A wire change in `packages/core` is caught by the drift check, which fails until `contract/`
  is regenerated in the same change, and that then runs the Host.
- **The Chrome e2e runs for a host-only change too.** It builds the real Host and is the only test of both sides
  together. The Firefox job stays extension-only: it does not build the Host.
- **`contract-compat`** compares each schema with the base and fails a breaking change without a version bump. It is
  symmetric, because either side may be the older one: new enum values, loosened limits and required→optional are
  breaking as well as the usual removals. New enum values stay breaking because Zod's `z.enum` and serde's generated
  enums both refuse unknown values. It runs only when `contract/` changed and feeds `ci-ok`. No new dependency: node
  and git, with the already-pinned `setup-node`.
- **The extension sends `PROTOCOL_VERSION`**, not a literal `1`, so a protocol bump is one constant per side.

## #34: a painted frame before every screenshot, and Firefox CI on a desktop-like Linux (2026-09-24)

**The Text Comment screenshot sometimes showed the comment box** (about 1 run in 4 of the standalone e2e).

- **Cause.** Saving closes the box, puts the page's selection back and asks for the screenshot at once. The service
  worker hides the overlay's UI for the shot and captures the last painted frame, but the comment box skipped its
  frame wait when it was already hidden, and with no toolbar on the page nothing else waited: the shot could be the
  frame that still had the box.
- **Fix.** Hiding for a screenshot always waits for a painted frame (`content/paint.ts`, `nextPaint()`: two
  animation frames, or 150 ms in a tab that is not painting), whether or not any overlay UI is on the page, and
  `save()` waits for one after putting the selection back. The toolbar's copy of the wait uses the same helper.

**The Firefox e2e failed 10 of 26 on ubuntu CI** while passing on macOS. A Linux runner has no sound server and no
display, which a real Firefox user has.

- **No host.** The job never built `inkup`, so `network-host.spec.ts` could not spawn it. It now builds the host
  like the Chrome e2e job.
- **No sound server.** Without one, the media context's `AudioContext.resume()` does not settle until the context
  is closed, and `close()` then takes about ten seconds, so every Stop waited out the service worker's 15 s
  backstop (`__inkup` still present, the discard toast still up after Undo, no `audio.webm` in the export). The job
  now runs PulseAudio with a null sink. The product no longer waits on either call for more than 2 s
  (`AUDIO_DEVICE_TIMEOUT_MS` in `offscreen/pcm.ts`): a reviewer whose machine has no working audio output gets a
  Stop in about two seconds, and the recording still runs; only the PCM graph's frames are missing.
- **No display.** Headless, `getDisplayMedia` has no source and Sessions started from the Start frame recorded no
  video. The job runs Firefox headed under `xvfb-run`.
- **Hangs with no name.** `ExtPage.evaluate` could poll forever, so the frame host test ran into the 150 s test
  timeout. Evaluations now have a deadline that names the call, and the firefox project sets `actionTimeout`. Named,
  the hangs had two causes in the harness. The RDP client kept the last 200 packets for callers to claim, and an
  evaluation whose page opened or closed a tab could see its `evaluationResult` pushed out by the packets that
  followed; results are now kept by id until claimed (headed, `start-path.spec.ts` closing its review tabs hit this
  on every run).
  And a click on the frame host's Reset navigated the page away before the evaluation's answer was read:
  `ExtPage.click(id, { navigates: true })` clicks just after answering.
- The fixture also sets `media.autoplay.default` 0 and `media.autoplay.block-webaudio` false, so Web Audio starts
  without a gesture, as it does for the add-on in a real profile.

## #33: pre-commit, Biome and Conventional Commits (2026-09-24)

Before the repo opens to outside contributors, the checks CI runs now also run on the contributor's machine, from
one `.pre-commit-config.yaml`. The root `prepare` script (`scripts/install-hooks.mjs`) runs `pre-commit install`
on `pnpm install`, wiring all three stages; git runs nothing on clone, so install is the earliest point. It skips
in CI and warns, without failing, when pre-commit is missing.

- **On commit:** file hygiene (YAML, JSON and TOML parse, final newline, trailing space, LF, merge markers, files
  over 1 MB, private keys), gitleaks over the staged change, markdownlint, zizmor on the workflows, Biome on
  TS and JS, and `cargo fmt` and clippy `-D warnings` when `host/` changed. Byte-exact fixtures, TUI snapshots and
  the generated Safari project are excluded.
- **On push:** `pnpm typecheck`, `pnpm test`, and `cargo test` when `host/` changed. e2e stays in CI: it needs a
  browser build and takes minutes.
- **On the commit message:** commitlint with `@commitlint/config-conventional`.
- **In CI:** a `lint` job runs the same hooks (host.yml already runs the cargo ones) and gitleaks over the whole
  history.
- **Biome, not Prettier and ESLint.** One fast tool formats, lints and sorts imports, with no plugin tree. Its
  `recommended` rules apply, except `noNonNullAssertion`: the codebase uses `!` about 1,300 times, 1,050 of them
  in tests that have just asserted the value exists. Findings that are right for this code are silenced one at a
  time with a `biome-ignore` comment giving the reason. Biome does not format JSON (generated schemas and fixtures
  keep their bytes) or CSS.
- **Markdown wraps at 120 columns** (`.markdownlint.yaml`); tables and code blocks may run longer.
- **gitleaks allowlist.** `.gitleaks.toml` allows the exact fake tokens and keys the tests use, by value, never by
  path, so a real key pasted into a test still fails.
- **Workflows.** Every checkout drops its credentials, the release job reads build outputs through environment
  variables instead of templating them into shell, and the release build restores no dependency cache.

## #32: the product is InkUp (2026-09-24)

"Voice & Annotation Review" was a working title, and `voice-review` its host binary. The product, extension, host,
MCP server, Safari app and repo are now **InkUp** (`inkup` in identifiers). The name was chosen for having no US
trademark (classes 9 and 42) and no product in the web-feedback or annotation space; Napkin, Redline, Markup,
Red Pen, Punchlist, Nitpick and InkIt were taken.

- **Clean break, no migration.** v1 has not shipped, so every stored name changed with it: the IndexedDB database,
  the host data dir (`ProjectDirs` `dev.inkup.inkup`), `INKUP_DATA_DIR` and `INKUP_TOKEN`, the mDNS names
  (`inkup.local`, `_inkup._tcp`), `inkup://pair` links, the page API `window.__inkup`, the MCP server name
  (`[mcp_servers.inkup]`) and the token prefixes (`ink1_` for agent tokens, `inkc1_` for paired Clients).
  Sessions, tokens and MCP entries made under the old names are not read; re-run `inkup mcp install`. The Firefox
  add-on id is a GUID and did not change.
- **Open source.** Released under the MIT License, copyright Liatrio, Inc., as `liatrio-labs/inkup`, starting
  from a single commit; the earlier history stays in the private repo.
- **Kept:** the `var-` CSS class prefix and the `var:` Vite plugin names. They are internal, and renaming classes
  the overlay injects into pages buys nothing.
- **Icon.** `extensions/web/assets/icon.svg` (a reviewer's hand-drawn red circle around an up caret) is the master;
  `icon-small.svg` thickens the strokes for 16 and 32 px. `pnpm icons` renders `public/icon/*.png`, which WXT
  lists as the manifest and action icons. The Safari wrapper was regenerated as `safari-xcode/InkUp` and its app
  icons rendered from the SVG.

## #31: page-side scripts define no storage.session item (2026-09-24)

Firefox logged `"browser.storage.session" is undefined` six times on every page, from `content.js`.

- **Cause.** `@wxt-dev/storage`'s `defineItem` reads the item at once (`migrationsDone.then(getOrInitValue)`), not
  on first use. `src/settings.ts` defined six `session:` items (activeSession, toolbarTabs, tabViewports,
  frameHostLayouts, panelNotice, hostStatus), and the content script imports settings.ts for the toolbar's own
  `local:` items, so each definition threw an unhandled rejection. The toolbar's Start frame, an extension frame
  inside the page, loaded the same chunk through the worker's panel-port module and threw the same six.
- **It broke nothing.** No page-side code reads those items (they are the worker's state; the page hears it in
  messages, and the Start frame over its Port since F1), so the rejections were noise. Chrome gives content scripts
  no storage.session by default either, so it was not Firefox-only in principle.
- **Fix: a module boundary.** The six items and `hostCapabilities` moved to `src/session-state.ts`, imported only
  by the service worker and extension pages; their types stay in settings.ts. The Port's contract (`PANEL_PORT` and
  its message types) moved to `src/lib/panel-port.ts`, so the Start frame no longer loads the worker's side.
- **Proof**: `tests/e2e-firefox/page-storage.spec.ts` and `tests/e2e/page-storage.spec.ts` walk the built
  extension's page-side scripts from the manifest (content scripts and web-accessible pages, with every chunk they
  import) and find no `session:` key, while `background.js` still has them. On the build before the fix the Firefox
  check lists the six keys in `content.js` and six more in the Start frame's settings chunk.

## F5: Undo and Redo on the review page (2026-09-23)

The review page's Change Item edits had no way back: a wrong merge or delete stayed unless the reviewer rebuilt the
item by hand.

- **Undo and Redo are ops in the log** (Session schema v19: `item_edit` ops `undo` and `redo`). The log stays
  append-only and syncs to the Host as before; nothing is removed or rewritten. `effectiveItemEdits`
  (`packages/core/src/review-edits.ts`) folds them away before the edits are applied: a stack of steps done and a
  stack undone, `undo` moves the latest step across, `redo` moves it back, and any new step clears what can be redone.
  Everything that reads the edits (the page, session.json's `change_items`, the acceptance rate, the Host's items,
  Combine with AI again) goes through it, so an undone edit does not count against the acceptance rate.
- **A merge and its combine are one step.** The merge model's answer (E12) joins the step of the latest merge into
  the item, provided nothing changed the item in between (an edit of another item may). Undoing a merge therefore
  brings both originals back and drops the combined words; Redo puts the merge back with them, from the log, with no
  model call. A combine that comes after the reviewer's own edit of the merged item (Combine with AI again) is a step
  of its own. A combine answer logged for a merge already undone is void, and Redo still brings the merge back.
- **An Undo or Redo while the model is still answering drops its answer** (the page counts them, as it counts edits
  per card). The simple rule is conservative: an Undo of an unrelated step also drops it, and the merge then stays
  "Combined without AI" with its retry.
- **Shortcuts**: Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z anywhere on the page except a text field, a select or an editable
  element, where the field's own undo runs. The buttons show what the shortcut would do (disabled when there is
  nothing to undo or redo).
- The upgrade 18→19 is the identity: the ops are new.
- **Proof**: unit tests on replay (`packages/core/tests/review-edits.test.ts`): undo of a merge with its combine,
  redo, a combine after another change to the item, a void combine, undo and redo chains across edit, split, delete,
  reorder and merge, a new step clearing redo, the acceptance rate and mergeSources, and session.json after a reload.
  e2e in Chrome (`tests/e2e/combine.spec.ts`): merge → Undo → both originals → Redo → merged again, the same by the
  shortcuts, the text field's own undo, a reload; and an Undo before the answer drops it. Firefox
  (`tests/e2e-firefox/combine.spec.ts`): the buttons and the shortcuts.

## F4: closing Safari's recorder window is Stop (2026-09-23)

Safari has no offscreen document, so the microphone lives in a small extension window (`offscreen.html`, the
recorder). Closing it mid-Session ended the audio and nothing else: the Session kept "recording" with no microphone
(#9). Chrome's equivalent is closing the side panel, which is Stop (ADR 0001).

- **The adapter reports the close** (`src/platform/safari/windows.ts` `onClosed`, exposed as
  `Platform.mediaContext.onClosed`). It listens to `windows.onRemoved` for the window id it remembers in
  `storage.session`, so a restarted service worker still hears it. Its own `close()` at Stop forgets the id before it
  removes the window, so that close is not reported. Chrome and Firefox have no such hook: nobody can close an
  offscreen document or the background frame.
- **The background stops the Session** (`onMediaContextGone`, `background/session.ts`) as `panel_closed`. The
  timeline has no end reason of its own for it, and adding one would take a Session schema version: the recorder
  window is Safari's half of what the panel is in Chrome, and the reason reads the same to an agent. The page is
  flushed first as for any Stop, so the open Annotation closes with its screenshot.
- **The audio is joined in the service worker** (`background/audio.ts` `salvageAudio`). The page that finalizes the
  recording went with the window, so Stop does not ask it; it joins the `audio_chunk` rows written so far, writes the
  WebM duration where it can (`makeSeekable`, which runs in a worker, unlike fix-webm-duration's FileReader), and drops
  the chunks, as the recorder page would have. What the recorder had not written is lost, so a media context the user
  can close writes more often: `Platform.mediaContext.audioChunkMs`, 5 s on Safari, against 30 s elsewhere.
- **Proof**: unit tests on the adapter (`tests/unit/platform/safari-windows.test.ts`): the user closing the window is
  reported once, including to a restarted worker; our own close and another window closing are not; the recorder
  writes every 5 s; Chrome and Firefox have no hook. `pnpm build:safari` builds. Safari cannot be driven by
  Playwright, so the Stop and the joined audio are manual check S9.

## F3: a dropped pick takes its screenshot with it (2026-09-23)

An Object Select pick is screenshotted at the pick, with its outline on screen, before the comment box opens (E7). Esc
in the box dropped the pick but left that screenshot: its blob, its `screenshot` event, and on a paired Host both
again (#22).

- **Deleted at the drop.** `ObjectSelect` hands the dropped pick back (`discard`), whether Esc (or Clear all) comes
  after the pick's start was recorded or while it still is; the page sends `dropPick{screenshot_id}`. The service
  worker (`discardScreenshots`, `background/screenshots.ts`) deletes the blob, the `screenshot` event and their outbox
  rows not sent yet, in one transaction. It deletes only a screenshot taken for an Annotation that no Annotation or
  Text Comment uses, so a page cannot delete other evidence. A pick ended by a click while its start was in flight
  is now remembered on that pick, so a later pick dropped meanwhile cannot take it with it.
- **The Host is told.** No message could delete part of a Session, so the protocol has
  `screenshot_discard{session_id, screenshot_id}` (capability `screenshot_discard`). The Host deletes the blob row and
  file and the `screenshot` event naming it, found by reading each screenshot's `screenshot_id` through `Fields` (so
  F7's contract test checks that read against the schema); an unknown one is acked, another Client's is refused
  (`conflict`). While
  paired, a `screenshot_discard` outbox row is always queued, after the blob's own row: whether the upload already
  went out, is going out, or never will, the Host ends up without it. An older Host without the capability is not
  sent it.
- **Swept at Stop.** `finishStopped` (a Stop, or a Cancel that was undone) runs the same deletion for every
  screenshot taken for an Annotation that nothing uses (`unusedAnnotationShots`, `packages/core/src/annotation-shot.ts`):
  a pick whose drop never reached the service worker, the earlier shots of a drawn Annotation that a later one
  replaced, and the shot of a Stroke that Clear all closed without one. Screenshots of their own (a click, a
  navigation, Snap) are evidence and never swept. The event log is otherwise append-only; these events are removed
  because the image they describe no longer exists.
- **Proof**: `tests/e2e/dropped-pick.spec.ts` against the real host: a recorded pick keeps its screenshot; a pick
  whose screenshot has reached the host is dropped with Esc, and its screenshot is gone at once from IndexedDB, the
  outbox, the host's `/blobs`, `/api/sessions/:id/events` and the host's blob files. A Stroke cleared before its
  Annotation closed leaves its screenshot until Stop, which sweeps it. At the end the host's blob files are exactly
  the Session's local blobs. The spec fails without the extension change. Unit: `unusedAnnotationShots`, and
  Object Select's drop paths. Host: `a_discarded_screenshot_is_gone_from_the_read_api_and_the_blob_store`.

## F2: one overlay per page (2026-09-23)

A tab still loading when the extension installed or updated got two overlays and two toolbars (#18): Chrome ran the
manifest's content script there, and `injectIntoOpenTabs` (from onInstalled) injected another copy. Reproduced over raw
CDP: a page whose HTML streams in two parts 2.5 s apart, the extension loaded in between.

- **The first live copy claims the page** (`content/instance.ts`). Both copies of one extension instance run in the
  same isolated world, so the claim is a symbol on `window` holding a check of the claiming copy's runtime. A second
  copy that finds a live claim returns before it does anything.
- **After an update the old copy keeps running.** Observed in Chromium 153: the new version's copy runs in a new
  world, and the old copy's script is still alive there, with `chrome.runtime.id` gone. Its toolbar stays on the page
  and its top-layer keeper puts the host back if anything removes it. So a new copy's claim is also a DOM event
  (`inkup:overlay-claim`), which crosses worlds: a copy whose own runtime is dead leaves on it, step by step
  (the keeper first, then the host, then everything else, each step in its own try, since the extension's objects throw
  by now). The claiming copy also removes any overlay host still in the page: no live copy of the extension can own
  one. A page sending the event can at most clear an overlay whose extension is gone. The runtime is read once when
  a copy starts: a new copy may see a new `chrome` global in the same world.
- **`injectIntoOpenTabs` pings each tab first** (`contentPing`, 500 ms) and skips a tab whose content script answers.
  An orphaned copy cannot answer, so updated tabs still get the new version.
- **The leaving copy stops answering the page API** (`PageApiLink.disconnect`): two copies used to answer every
  `window.__inkup` call, one of them with "no Session is recording".
- **Proof**: `tests/e2e/single-overlay.spec.ts` installs the extension while the fixture page is loading, shows the
  toolbar and counts one overlay host and one toolbar (two before the fix). It then loads the same unpacked path
  again, which Chrome treats as an update: the orphaned toolbar leaves, the icon brings one new toolbar, and the new
  copy answers the service worker. Unit: `tests/unit/content/instance.test.ts`. `voice-optional.spec.ts` no longer
  opens an extension page first to avoid the double toolbar. Manual check C11 step 4.

## F1: the Start path (2026-09-23)

Two bugs: a first Start click that did nothing (#16), and seconds between the toolbar saying Recording and the page
receiving the Session, while its mode shortcuts were dead (#21). The path was traced (toolbar click, Alt+Shift+R and
the panel → `background/toolbar.ts` / `session.ts` → media context → page push) with timestamps at each step.

- **The lost click was a re-render.** The toolbar rebuilt its buttons on every state push (`replaceChildren`), and a
  state push lands often right after the toolbar appears (the saved position, the theme, the host status). A button
  replaced between press and release loses the click: Chrome drops it, Firefox fires it on the parent, where no
  `data-action` is found. Reproduced in both with a bare page, and in the e2e by holding the button down across a
  push. The toolbar now patches its children in place (`patchChildren` in `content/toolbar.ts`): nodes of the same
  kind (tag, action, test id) are kept and only their attributes and children change. A side effect: a clicked
  button keeps focus, so the mode buttons (Draw, Object Select, Select Text) blur themselves, as the keyboard belongs
  to the page in those modes.
- **The page gets the Session before anything slow.** `startSession` used to write the Session (the toolbar said
  Recording at once, from its storage watch) and only then open the media context, the microphone, the transcription
  engine and the recorders, and tell the page last. Now it writes the Session with `starting: true`, pushes it to the
  page, and waits for the page to answer, which it does once the overlay has applied it (`contentState` resolves after
  `apply`, at most 3 s). Only then does `starting` go false, and only then do the tab's capture id (moved out of
  `startFromToolbar`), the media context and the recorders start. Until the answer the toolbar says "Starting…"
  (`data-state="starting"`, every control off) and the panel's status says "Starting…".
- **Stop, Pause, Mute, Turn on voice and box dictation wait for the media.** Each talks to the media context, which
  may still be opening; they await the start's media half first, so a Mute pressed in that window is not lost with the
  microphone left on. A Stop marks the Session stopping at once and then waits the same way. An `offscreenStart`
  failure after the page has the Session clears it from the page too. `notifyContent` reads the Session at the send,
  so the start's last push, prepared before a mode the reviewer switched meanwhile, does not switch it back.
- **Modes answer in the page at once.** A mode change (Alt+Shift+O and T, Esc, the toolbar's buttons) is applied to
  the page's copy of the Session and the toolbar immediately, then sent; the service worker's pushes follow and have
  the last word, and if its answer differs from what the page shows the toolbar asks for its state again. In Firefox
  the media iframe shares the background page's thread, so while it starts (the VAD model, the recorder) a round
  trip took up to 540 ms.
- **Firefox's Start frame never said it was ready.** It watched `activeSession` in storage.session, which Firefox does
  not give an extension frame inside a web page: the watch threw, the frame never posted "ready", and after 4 s the
  toolbar replaced it with a plain Start button, without video. Tests clicked within that second. The frame now hears
  the Session over its Port (`{type: 'session'}`, `background/panel-port.ts`), matches messages by origin, and its
  button is disabled until its script listens (`data-ready` on the frame once it has said so). After the picker it
  gives the keyboard back to the page, where the shortcuts are heard.
- **The toolbar is placed only once it can be measured.** Placing it while the host was between leaving and
  re-entering the top layer measured 0 and put most of it off screen until the next render.
- **Proof**: `tests/e2e/start-path.spec.ts` (20 toolbar Starts, one click each, every other held down across a state
  push; 5 Alt+Shift+R Starts) and `tests/e2e-firefox/start-path.spec.ts` (20 Starts from the frame). Each measures in
  the page the time from the toolbar saying Recording to Object Select on after an Alt+Shift+O sent at that moment
  (bound 300 ms), and checks the service worker holds it. The retries in text-comment, object-select,
  voice-optional and cancel-mute specs are gone.
- **Checks after review.** (a) The Text Comment box opens a turn after the release and its input takes the focus
  and the page's selection; what is recorded is still the selected heading (`anchor.exact`, `selected_text`), and
  the heading is put back as the page's selection for the screenshot (`tests/unit/content/text-comment.test.ts`;
  the e2e in `text-comment.spec.ts` asserts the same anchor in Chrome). (b) The Firefox Start frame hears the Session
  over the Port: Pause pauses its recorder (no video chunks while paused), and a Session ended without asking the
  frame (Cancel, or the Session just gone) ends its recording. It now says it stopped recording only once the
  capture's tracks are stopped, and the toolbar shows that on the frame as `data-recording`
  (`tests/e2e-firefox/start-frame-follow.spec.ts`, which fails with the Port's `session` message ignored). (c) A
  toolbar Start the service worker never answers (seen stuck for over 17 s under load) gives the button back after
  `START_TIMEOUT_MS` (20 s) with an error toast; an answer after that is ignored, since the Session's own state then
  shows what came of it (unit tests with a fake clock). The Firefox frame's own Start button is not bounded: timing
  it out would drop the picked video of a Session that still starts.

## F7: the Host's reads of timeline fields, checked against the schema (2026-09-23)

- **One fixture set per event type, generated.** `pnpm -C packages/protocol fixtures:events`
  (`scripts/gen-event-fixtures.ts`) writes `fixtures/event.<type>.json` for all 28 timeline event types. It adds
  variants where the Host reads a type's shapes differently: `annotation.object_select`, `annotation.page_api`,
  dictation and rerun transcript segments, `voice_command` pin/resume, and each `item_edit` op. It also writes
  `items.json` with every Change Item field filled. Vitest checks three things: the files are current, every type is
  covered, and every schema field (through objects, arrays, records and each union option) holds a non-null value in
  some fixture.
- **Every Host read of an event or item field goes through `store::fields::Fields`.** While `record` runs, it logs
  each read: the path, the JSON type wanted and the type found. `crates/server/src/contract.rs` feeds every fixture
  through all the readers: the store (upsert, Signals, timeline, items), the server's timeline and item views, the
  WebSocket event check and the MCP item. The test fails on a read path in three cases: it is missing from
  `docs/schema/session.schema.json`, it has another type there, or no fixture fills it with the right type. A source
  scan also fails any raw `event["x"].as_…` read that would bypass `Fields`. Three renames were tried, and each one
  fails the test with the path it names: `command` to `name` (items.rs), `anchor.exact` to `anchor.quote` (state.rs)
  and `confidence` to `confidance` (mcp.rs).
- **Mismatches found and fixed**: `text_comment` was missing from the store's timeline types, so the TUI never showed
  Text Comments, though it could render them. `draft_item` Signals read a `url` field the schema does not have; they
  now take the Session's url.
- **Host tests use the fixtures.** Four places build their events from the generated fixtures and patch only the
  fields a test is about (`common::event`, `timeline_event`): `store/tests/items.rs`, `store/tests/store.rs`,
  `server/tests/mcp.rs` and the `state.rs` unit test.

## F6: what the outbox missed, and Forget (2026-09-23)

- **Earlier Sessions are found by asking the Host.** A Session is offered for upload when it is ended, not being
  cancelled, has no outbox rows, and the Host's `/api/sessions` lists fewer of its events than Dexie holds (none, for
  one it never saw). Asking, rather than marking Sessions locally, also covers a Session recorded while paired with a
  different Host. The options page's Host section shows "Upload N earlier Sessions" while there are any; the side
  panel's idle state and the Sessions page show it once per pairing (`hostBackfillNoticed`, set by Upload or Not now).
  The offer is asked again every 5 s and whenever the outbox empties.
- **A backfill is the live path replayed.** `queueSessionForHost` writes one transaction of outbox rows: every event
  in append order, the screenshots, crops, audio and video (the kinds a live Session queues; chunks never go), then
  an `items` row. The Host upserts events on their id and replaces a blob's bytes, so a second upload lands nothing
  twice. A Session restored from a file while paired goes the same way, straight after the restore.
- **Forget revokes on the Host: `forget`** (protocol, capability `forget`), answered with `ack`, after which the Host
  closes the connection. The Client's Sessions stay on the Host for its agents. A Host that cannot be reached keeps
  the token in `hostRevokePending`; the service worker asks it again at start and before each pairing, and drops the
  entry once revoked or once the Host says it never knew the token (`unknown_token`). A Host without the capability
  cannot be asked, and is not asked again. The options page says when the revoke is still owed.
- **Forget stops the outbox first.** `halted` stops `drain` from starting and the running drain before its next row;
  Forget waits up to 10 s for what is on the wire (a batch's acks, a blob upload), then revokes, then clears the
  pairing and the outbox. Blob uploads go over HTTP, so closing the WebSocket alone never stopped them: the e2e proof
  Forgets during the screenshot uploads and fails against a build without `halted` (1 run in 2: a race).
- **Proof**: `tests/e2e/host-sync.spec.ts` against the real host: a Session recorded before pairing is offered in the
  options page and the side panel, and Upload lands its events (no duplicates) and blobs (size and type); after
  Forget the old token gets 401 from `/api` and `/blobs` and an agent token still lists the Session; a zip restored
  while paired reaches the host; Forget during a 5,000-event, 1,200-screenshot backfill sends nothing after `forget`
  and uploads no screenshot twice; Forget with the host down revokes when it is back. Cargo:
  `crates/server/tests/host.rs` `forget_revokes_the_clients_token_and_keeps_its_sessions`.

## E14: the extension finds and pairs with a network hub (2026-09-23)

- **Discovery without mDNS browsing.** An extension cannot browse DNS-SD, but the browser resolves `.local` names
  through the OS. Find hubs probes `http://inkup.local:47823/health` and `-2` … `-5` at once, plus the
  addresses paired with before (`hostAddresses`, at most 10), with a 1.5 s timeout each. A probe that ignores its
  abort signal still loses the race to the timer. `adapters/host/discovery.ts`.
- **Address input takes three shapes**: a bare host (`192.168.1.20`, `inkup.local`; port 47823 added), a URL
  with an explicit port (kept, even a scheme's default), or a pair link, whose code goes straight into the hello.
  So Paste and Scan QR are one path.
- **The code prompt appears on the Host's answer**, not up front: the first Connect to another machine gets
  `pairing_code_required` and the options page shows a code field. A wrong code keeps the field with the Host's
  "tries left"; New code connects again for a fresh one. `hostPair` now takes `{url, code?}` and says `needsCode`.
- **Permissions.** `optional_host_permissions: ['http://*/*', 'ws://*/*']` (Chrome, Firefox). `<all_urls>` is
  required already (ADR 0003) and covers both, so the options page calls `permissions.contains` first and
  `permissions.request` only when it is false, from the Find hubs or Connect click. Asking unconditionally would
  throw in Firefox's e2e, whose DOM clicks carry no user activation. Safari's manifest leaves the key out.
- **Scan QR**: `BarcodeDetector` on a `getUserMedia` stream in the options page, polled every 250 ms until a code
  parses as a pair link. `capabilities().qrScan` is `'BarcodeDetector' in globalThis` plus `getUserMedia`; whether a
  camera exists is only known once asked, so a missing camera is an error message, not a hidden button.
- **"Unencrypted network hub"**: the paired Host's address is not loopback. Shown in the Host section, in the page
  toolbar's host dot title and aria-label (`ToolbarState.hostNetwork`), in the panel's host indicator title and on
  each Find hubs result.
- **The guard fails closed** (review of H5). A request with no `ConnectInfo` peer address used to count as
  loopback, so it needed no token. Only a router served without `into_make_service_with_connect_info` sends such a
  request, and `start` never does, but now an unknown peer counts as another machine: `/mcp`, `/api` and `/blobs`
  answer 401 without a token. A unit test in `crates/server/src/lib.rs` serves the router without `ConnectInfo`
  and expects exactly that; against the old fallback it gets 200.
- **Local Network Access**: Chromium 153 and Firefox 155 let the extension's own origin reach a LAN address with
  no preflight or prompt (docs/browsers.md, "Local network access"). Branded Chrome with enforcement on is manual
  check C22.
- **Proof**: `tests/e2e/network-host.spec.ts` and `tests/e2e-firefox/network-host.spec.ts` run the real host with
  `--network --print-pairing-codes` and reach it only on this machine's LAN IP: wrong code refused, right code
  pairs, a Session's events and blobs arrive (401 without the token), MCP 401 without a token and working with an
  agent token from `inkup token create`; Find hubs over [live hub, TEST-NET address] lists only the live
  one; a pasted pair link pairs.

## E8: adaptive contrast (2026-09-23)

- **The page's colour comes from computed styles first** (`packages/core/src/contrast.ts`, `content/theme.ts`). Under
  a rect the content script takes its centre and four inset corners, lists the elements there topmost first
  (`elementsFromPoint`, our host left out) and composites their background colours with alpha down to the canvas
  (the root's background, else the body's, else white). A background image or gradient, or an img, video, canvas,
  svg, iframe, object, embed or picture, makes a point indeterminate. `elementsFromPoint` skips elements with
  `pointer-events: none`, so a decorative overlay of that kind is not seen.
- **Where the styles cannot tell, a capture decides** (`sampleBackground`, `background/screenshots.ts`): the mean of
  a 12 px band around the toolbar (not the toolbar itself) in a fresh `captureVisibleTab`. Samples join the
  screenshot queue, are skipped within 1 s of any capture, a screenshot waits 500 ms after a sample (so both stay
  inside Chrome's two captures a second), and the toolbar asks at most once every 1.5 s, trying a skipped one up to
  three more times. Only the active tab is sampled.
- **The toolbar's theme** is light over dark pages and dark over light ones, switching only past luminance 0.35 and
  0.65 (no flicker at a section edge). It is looked at again at a drag end, a collapse, a scroll or resize settle
  (250 ms), history navigation and page mutations (500 ms debounce, our own host's left out). `data-theme` is on the
  bar, the pill and the toast; `data-theme-from` (style, sample or setting) on the bar. The theme button (◐ / ○ /
  ●) cycles Auto → Light → Dark, stored as `toolbarTheme` in storage.local for every page.
- **Comment boxes and the Object Select highlight** take their theme from the page under them the same way, without
  sampling: where the styles cannot tell, or when the setting fixes it, they follow the toolbar. The viewport
  control's menu follows the toolbar (it opens next to it). Light-theme colours also cover the later controls: Cancel
  (dark red text), Mute while muted, the toast's Undo link, the comment box's mic and live caption (E10, E11); Clear
  all (E9) is a plain toolbar button.
- **Ink** (schema v18, `Stroke.color`). At pointer-down the ink is the first of red, yellow, cyan, magenta, white,
  black with at least 3:1 contrast against the page at the pen tip (just the tip: a mean over a wider square blended a
  white card with the blue button next to it and picked black). Over an image the tip is indeterminate: hovering in
  draw mode samples a 48 px square now and then, and a Stroke starting within 80 px of a sample uses it; otherwise
  red. Every Stroke has a halo 4 px wider than the ink, black or white, whichever stands out from the ink, of those
  the one further from the page. The review page draws `color` over a halo picked without the page (the one further
  from the ink); a Stroke from before v18 keeps the old orange with no halo.
- **Proof.** `fixtures/site/contrast.html` (light, dark, red and a dark hero image, each a full viewport) with
  `tests/e2e/adaptive-contrast.spec.ts` and `tests/e2e-firefox/adaptive-contrast.spec.ts`: dark → light toolbar →
  dark again from styles, the hero from a sample, a Stroke on red that is not red and whose screenshot pixel stands out
  ≥ 3:1 from the red (and on dark, Chrome), the Light setting, and the review page's ink and halo. The specs drag the
  toolbar up first: headless Chromium's captures are shorter than Playwright's emulated viewport, so a sample in the
  bottom corner read nothing.

## E9: nothing drawn stays on the page, and Clear all (2026-09-23)

- **A hard cap per overlay element, apart from any message.** Ink, the Object Select outline and pending pick, and
  a comment box (Object Select's and Select Text's) are removed once idle for the overlay cap: 30 s
  (`DEFAULT_MAX_OVERLAY_MS`, `packages/core/src/overlay-lifetime.ts`; `devOverrides.maxOverlayMs` for tests). Idle
  counts from the last activity: pointer down, each move and pointer-up for a Stroke, pointer moves and keys for
  the outline, opening and each keystroke for a comment box. A Stroke still being drawn with no move that long (a
  lost pointer-up) ends at its last move and fades. A pick left open is recorded as typed; a comment box is saved
  if it has text, else closed.
- **One sweeper**, on every rendered frame and once a second (`SWEEP_EVERY_MS`), and also at Stop (after the
  flush), on `pagehide` and when the tab becomes visible again (timers are throttled in a hidden tab). Session
  teardown removes the overlay itself.
- **Every await that holds ink has a timeout.** The Annotation screenshot counts as none after 5 s
  (`SHOT_TIMEOUT_MS`), so the close goes on with `screenshot_id: null`; the close itself (Strokes and Annotation)
  is given up on after 10 s (`CLOSE_TIMEOUT_MS`) and its Strokes fade. The same bounds cover the overlay's
  message queue (one hung message delays the next 10 s at most), a pick's screenshot and its start, an Object
  Select record and a Text Comment's close and record, which keep the selection on the page until they finish.
- **A note being typed is not a hung message.** In a Session without voice (E11) a drawn Annotation's close waits
  for its note; that wait has no timeout (the note box has the cap: idle that long, it records what was typed), and
  the close timeout counts from the note. Its Strokes stay on screen meanwhile, up to their own cap. Dictation into
  a comment box counts as activity, as typing does. Clear all closes a note box with no note.
- **A faded Stroke whose Annotation is not sent yet is kept off screen.** Its data stays until `closeGroup` has
  posted it, so a cap or a Clear all before the close still records the Stroke.
- **Clear all** is a toolbar button (eraser icon, `aria-label` "Clear all", title naming Alt+Shift+C) in every
  toolbar state, and Alt+Shift+C on the page. It closes the open Annotation first with the new close reason
  `cleared`, with no screenshot (`closeShotPlan` → `none`), then removes every Stroke, the outline, a pick in
  progress (dropped, as Esc would, not recorded) and an open comment box (not saved), and the page's text
  selection. In a recording tab it logs `overlay_cleared` `{url, strokes, picks, comments}`; outside a Session it
  just clears the page. The Session leaving the page (Cancel, and Stop after its flush) goes through the same
  clearing before the overlay is torn down; only the button and the shortcut log `overlay_cleared`.
- **A `cleared` Annotation is kept.** Clear all is for stuck ink, not a discard (Cancel and "scratch that" are).
  Process sees it as "closed by Clear all (no screenshot)" and the review page says the same.
- **Schema v17**: close reason `cleared` and the `overlay_cleared` event; the upgrade step 16 → 17 adds nothing
  to old documents.
- **Proof.** `extensions/web/tests/unit/content/overlay-lifetime.test.ts` (fake clock: the cap with the screenshot
  and close hung, the cap counted from the last move, the hung close finishing with `screenshot_id: null`, Clear
  all's `cleared` close). `tests/e2e/overlay-cleanup.spec.ts` and `tests/e2e-firefox/overlay-cleanup.spec.ts`:
  with the screenshot stubbed to never answer (`devOverrides.hangAnnotationShots`) and a 2.5 s cap, the canvas
  has no ink pixels and keeps no Strokes, and the Annotation is recorded with `screenshot_id: null`; Clear all on
  an open Annotation closes it as `cleared`, and with ink, a pick and its comment box on screen one click empties
  the overlay and logs `overlay_cleared`. `overlap.spec.ts` (both browsers) now also draws over the max-z element,
  the popover and fullscreen: with the pointer down the page's topmost element under the Stroke is our host and the
  screen there has ink-red pixels, and so does the Annotation's screenshot (the fullscreen stage is no longer red).

## H5: network mode (2026-09-23)

- **ADR 0006** covers the trust model: opt-in network mode binds `0.0.0.0`, a `.local` name through mDNS, tokens
  from every other machine, pairing by code. The calls it leaves open are below.
- **Switching.** `serve --network` or `network = true` in the data dir's `config.toml`. The file is new (store
  `config.rs`); it also holds the `hub_id` for the TXT record and keeps the user's comments. The TUI's N key asks,
  writes the file and restarts the server in the same process with the terminal kept. WebSockets are closed through
  a cancellation token, since an upgraded connection outlives axum's graceful shutdown, and Clients reconnect. A
  `--network` flag counts for the first run only; after a switch the file decides.
- **Who counts as another machine**: the TCP peer address, not a header. A peer on this machine's own LAN address
  is another machine, which is how the tests reach a real `0.0.0.0` bind. `Config.every_peer_is_remote` (tests
  only) applies the rules for other machines to loopback peers.
- **Pairing by code is stateless on the wire.** A hello without a token from another machine gets
  `error{pairing_code_required}` and the connection closes. The code lives on the Host for 2 minutes, and the
  Client connects again with `hello{pairing_code}`. A pasted or scanned `inkup://pair` link does the same.
  No new message types, just an optional field and two error codes. The server never auto-approves a request from
  another machine, not even with `--auto-approve-pairing`.
- **Guess limits across codes**: a wrong code counts against every waiting code. At the fifth, a code is refused
  (`pairing_denied`), and after that the right code gets `pairing_timeout` ("no pairing code is waiting"). At most 4
  codes wait at once. A remote request in the TUI takes the keyboard like a local one, but y does nothing: approval
  is typing the code on the other machine. n or Esc refuses it and the code dies at once.
- **QR in the terminal**: `qrcode` half-block rows at EC level L (version 4 for the usual link), black on white, with a
  2-module margin instead of the standard 4 so it fits 32 rows. A test reads the rendered rows back with `rqrr`.
  On a shorter terminal only the code shows. Headless `serve` prints the code, the QR code (ANSI black on white)
  and the link to stderr.
- **Hub name**: `inkup on <first label of the hostname>`, in `/health.hub_name` and as the DNS-SD instance
  name.
- **mDNS**: `mdns-sd`, IPv4 only (the server binds IPv4). The daemon probes and renames itself on a conflict
  (`-2`, `-3`, …). The Host follows its `NameChange` and `Announce` events and stops advertising after `-5`.
  Failure to start mDNS is a warning, not an error. Tests claim `inkup-test-<pid>.local`, not the real name (hidden
  `serve --mdns-name`).
- **Agent tokens** (`ink1_` prefix, store migration 4) authenticate `/api` and `/blobs` too. A Client's pairing
  token authenticates `/mcp` from another machine, so a thick Client can be its own agent.
  `mcp install --remote … --token …` warns when the token goes into a project file, which could be committed.
- **Proof**: `crates/server/tests/network.rs`: MCP no token → 401, agent token → in, revoked → 401, loopback no
  token → in; wrong code, fifth wrong refused, right code pairs once, refused in TUI, expiry. A real `0.0.0.0` bind
  reached through the LAN address (skipped without one), a loopback-only Host unreachable on the LAN address, and a
  real mDNS browse finding the service, TXT and claimed name (skipped on CI). `crates/inkup/tests/cli.rs`:
  `--network --auto-approve-pairing` refused, `--print-pairing-codes` over the LAN address, `token
  create/list/revoke`. `tests/mcp_install.rs`: `--remote` headers for all three agents. TUI snapshots
  `network-header`, `pairing-remote` (with QR), `pairing-remote-short`, `tokens`, `token-new`, `token-shown`,
  `network-confirm`.

## E11: comment-box dictation and Sessions without voice (2026-09-23)

- **Dictated speech is a comment, not the transcript.** While a comment box dictates, the offscreen document routes
  every segment whose midpoint falls after the box opened to it: the segment is logged with a `target`
  (`{annotation_id}` or `{comment_id}`, schema v16) and its words are appended to the box, and it skips the Voice
  Command watcher and the mute check. `activeTranscript` (so Process, the script, review.md, cards and captions), the
  host's Signals and its timeline all leave targeted segments out. A re-run transcription has no targets, so it drops
  words whose midpoint lies in a span that was dictated live.
- **Interim words come from the engine's own non-final results** (`onInterim`): Web Speech and the scripted adapter
  give them; Whisper and the paid engines give finals only, so their boxes show no live caption.
- **The box's mic unmutes only the track, not the Session.** `applyMic` enables the track while unmuted or while a box
  dictates; `mic_muted`/`mic_unmuted` are not logged for it, and the Session is still muted when the box closes.
- **Without live captions a box has no mic button** (`box_dictation: null` in the page's state): there is nothing to
  dictate with (Firefox without Whisper).
- **The mic is optional.** Start no longer needs `micGranted`, and a microphone that fails to open no longer deletes
  the half-started Session (superseding "Mic grant gate" and "The half-started Session is deleted", Slice 1): the
  Session runs without voice (`session_start.voice: false`, a `transcription_fallback` and a panel notice when it was
  a failure). "Turn on voice" asks through onboarding (`?voice=1`) when there is no grant, then opens the mic in the
  running Session and logs `voice_on`.
- **A drawn Annotation in a voice-less Session asks for a note** only when it closes while the reviewer is there
  (a drawing pause, Draw off, a scroll). Stop, a pause, a pick or a Text Comment take what was typed so far rather than
  wait, and a press elsewhere on the page does too.
- **Process without a model is code, not a cheaper model.** `processInCode` makes one Change Item per live Annotation
  (its typed or page API comment, else the speech during it, else a flagged `question` at 0.3) plus the existing Text
  Comment merge, then the usual pinned-draft merge, grounding and viewport sizes. It runs when no key is set, whatever
  the Session holds; with a key the model runs unless `needsModel` says every Annotation and Text Comment already says
  what it wants and nothing else was said. The review page names it: "Process without a model", with a link to add a key.
- **The Chrome and Firefox e2e prove it with the scripted engine**, which emits interims too; Firefox's fake
  microphone is a tone, so the Whisper tier's dictation is the same routing with finals only (not run with a real
  model in automation).

## E10: Cancel and Mute (2026-09-23)

- **Cancel is Stop's pipeline with two steps held back.** The toolbar's red Cancel (and the panel's) turns the mic off
  at once (`offscreenMute`), then runs Stop (`stopSession(…, {discard: true})`): the open Annotation is closed and the
  page's ink cleared straight away, the audio and video are finalized, `session_end` is logged. What Stop does last,
  queueing the media for the Host and opening the review page, waits: Undo does it (`finishStopped`), so an undone
  Session is exactly a stopped one. The toolbar and the panel treat the Session as over the moment it is pending,
  while its Stop finishes behind the toast.
- **The deadline lives in `storage.local` (`discardPending`), not `storage.session`.** The plan said storage.session
  so a worker restart honours it; storage.local does that too and also survives the browser closing inside the
  window, which would otherwise keep a Session the reviewer threw away. Three things enforce it: a timer in the
  worker, a `chrome.alarms` alarm (new `alarms` permission; it shows no install warning) and a sweep on every
  worker start. `tests/e2e/cancel-mute.spec.ts` (c) stops the worker mid-window and fails without the sweep.
- **The outbox holds the Session during the window.** `drainOnce` skips rows of pending Sessions. What streamed live
  before Cancel is already on the Host, so the discard needs a message: `session_discard{session_id}` (protocol,
  capability `discard`), queued as an outbox row after the Session's own rows are deleted, so it goes whenever the
  Host is next reachable. The Host deletes the Session's events, Change Items, their Resolutions and its blobs
  (rows, then files); Signals derive from events and go with them. A Session another Client recorded is refused
  (`conflict`); an unknown one is acked, so a resend is harmless. The Undo window is 10 s (`devOverrides.discardUndoMs`
  shortens it for tests).
- **Mute is not Pause.** The mic track is disabled (`track.enabled = false`), so the recorder writes silence and the
  audio keeps Session time; the PCM graph, the VAD and the streaming engines hear zeros; the transcription adapter
  is paused (`syncAdapter`: muted, or paused with audio leaving the machine); Voice Commands are off entirely, even
  `resume`. A segment that reaches into a muted span is dropped whenever it arrives; one spoken just before the
  mute and delivered after it is kept. Video, ink, picks, screenshots and Draft Items go on. Mute and Pause are
  independent: a muted Session stays muted through a pause and its resume.
- **Schema v15: `mic_muted` and `mic_unmuted`** (`via`: button or shortcut). No balancing unmute at Stop: a Session
  that ends muted is muted to its end (`mutedSpans`). The Process script says `MIC MUTED: nothing the reviewer said
  until MIC ON was recorded` and `MIC ON`, and the system prompt says silence there means nothing. review.md lists
  the spans under the header ("Mic muted: 00:07–00:13."). E12 took v14.
- **Controls.** Toolbar: Mute (a mic icon, struck through while muted, `aria-pressed`) before Pause, and Cancel after
  Stop, in red text rather than a red fill so it does not read as the primary action. Alt+Shift+M is the page's own
  key, like Alt+Shift+O/T (the four Chrome command slots are taken), and works while paused. The panel has Mute and
  Cancel, a note while muted, and the same Undo as the Sessions page (`components/discard-undo.tsx`).

## The overlay stays on top of the page (2026-09-23)

- **The overlay host is in the browser's top layer** (`content/top-layer.ts`, both mount paths through
  `content/client.ts`). A maximum z-index was not enough: a modal dialog, a popover and an element in fullscreen
  paint above any z-index, and a page element at the same z-index later in the document won the tie. The host is a manual
  popover, shown, with its own `:host` style undoing the UA popover box. It is shown again (last shown is on top)
  on a page popover's `toggle`, a dialog's `open` and `fullscreenchange`, debounced, and at most 10 times in 2 s
  so a page that re-raises in answer cannot loop with it. No schema change.
- **Over a modal dialog or fullscreen the host moves inside it.** Both make everything outside inert, a popover
  above them included (Chrome 153 and Firefox 155 hit-test past it to the page), so painting on top is not
  enough to be clickable. The host moves into the newest open modal dialog or fullscreen element with
  `moveBefore` (Chrome keeps the canvas and frames as they are), and back under the root element when it closes.
  An element that cannot have children (a `<video>` in fullscreen) leaves the toolbar painted but unclickable until
  fullscreen ends.
- **Firefox: not while the Start frame records.** Firefox reloads an iframe in a shadow root on any move,
  `moveBefore` included, and the toolbar's Start frame records the Session's video. The frame tells the toolbar
  when it records (`FRAME_RECORDING`); meanwhile the host stays where it is, so over a modal dialog or
  fullscreen the toolbar is painted but inert until it closes. It still moves out of a dialog that closed with it
  inside (it would not show at all there), which ends that video as a navigation does.
- **Without popover** (Safari before 17) the host keeps the maximum z-index as the last child of the root element
  and goes back there when the page appends a maximum-z element after it. Not covered by a test: every browser the
  e2e drives has popover.
- **Proof.** `fixtures/site/overlap.html` and `tests/e2e/overlap.spec.ts` / `tests/e2e-firefox/overlap.spec.ts`:
  a fixed element at the maximum z-index added after the host, a modal dialog, a popover and element fullscreen;
  for each the page's `elementFromPoint` at the toolbar button's centre is our button and real clicks on Draw and
  Snap work, and over the modal a Stroke is drawn and recorded. With `keepOnTop` disabled the Chrome spec fails at
  the first case.

## E13: In work and Done from the MCP (2026-09-23)

- **`start_item(id, note?)`** records a Resolution with status `in_progress`, source `mcp` and the agent's name:
  `clientInfo.name` from the MCP `initialize` (rmcp's `peer_info`), stored as `agent` on the resolution. It is
  idempotent: an item already in progress returns its current record and nothing new is stored or pushed (whoever
  started it). An item whose latest status is `resolved` or `wont_fix` is refused with a tool error naming the
  status and note; `needs_info` can be started again (the agent picks it back up). `resolve_item` is unchanged
  apart from also storing the agent's name.
- **Status is the latest Resolution; history stays.** `in_progress` is one more Resolution row, so `get_item`
  lists the whole history and the latest wins everywhere. `read_items`/`watch_items` default `open` means no
  Resolution at all, so an item in work is not open; `status: in_progress` lists those. A session's `open_items`
  count follows the same rule.
- **Wire**: `ResolutionStatus` gains `in_progress`, the `resolution` message an optional `agent`. Fixture
  `resolution.in_progress.json`; Rust types regenerated. **Store migration 3** copies `resolutions` into a table
  whose CHECK allows `in_progress` and that has a nullable `agent` column (SQLite cannot alter a CHECK in place).
- **Instructions**: the server instructions and tool descriptions tell an agent to call `start_item` before it
  touches the code and `resolve_item` after, with what changed and where, and to leave items another agent has in
  work.
- **Cards and TUI**: the review card shows the latest word only: "In work" (sky) with the agent's name and a
  relative time, then "Done" / "Won't fix" / "Needs info" with the note. The name falls back to "An agent" or "The
  Host". Standalone (no Host) there are no resolutions and nothing shows. The TUI Items view labels statuses
  `in work` and `done` and puts "agent, 2 min ago" in the Resolution column for an item in work.
- **Proof**: store tests (idempotence, refusal, history, migration 2→3 keeping old rows); the real rmcp client in
  `crates/server/tests/mcp.rs` (start → open excludes, in_progress includes with the agent name → resolve →
  history of both → start refused); TUI snapshots `items` and `item-in-work`; `tests/e2e/host.spec.ts` against the
  real host binary (MCP start_item → card In work with the agent name; resolve_item → Done with the note).

## E12: Combine after a merge (2026-09-23)

- **The merge stays deterministic; the model only rewrites the words.** Merge logs `{op: 'merge'}` first, so the
  card shows the union at once (Locations, Evidence, crops, style changes, pinned, the lower confidence, all in
  `mergeItems`). Then the review page asks the worker (`combineItems`) to run the adapter's `combine` with both
  items as they were before the merge. Its answer (title, category, intent, agent_prompt, ambiguity) is logged as
  an ordinary `edit` op with `origin: 'combine'`. Replay folds the two ops in order and never calls a model, so
  session.json, the Host and the acceptance rate read it like any edit.
- **Schema v14.** The `edit` op's changes gain `agent_prompt` and `ambiguity` (null clears it, except on a
  low-confidence item, which keeps its own so the item still validates) and the op gains optional `origin`. All
  additive: the 13→14 upgrade is the identity. Other units are also taking versions; expect to renumber on merge.
- **Text only, aliases, grounding in code** (`packages/core/src/process/combine.ts`). The prompt shows each item's
  title, category, intent, transcript, ambiguity, Locations and screenshot ids, with ids as s1, s2 … as Process
  does. The E4 grounding lines (source in the codebase, element close-up) are taken off both prompts before the
  call and put back after it, deduplicated, with one close-up line for the union of crops, so crops stay cited
  whatever the model writes.
- **Validation**: Zod through structured output; then every screenshot either source prompt cited must be cited,
  no unknown alias, and an ambiguity when either item is unsure. One repair call (`combine_repair`), else the
  merge keeps the concatenation. After restoring ids, a last check that every screenshot and crop id cited by
  either source prompt is still in the result. The call records (`combine`, `combine_repair`) go on the run row.
- **Model**: `claude-haiku-4-5-20251001` by default, "Merge model" in Settings (`processingSettings.mergeModel`,
  optional so settings saved before it read the default). No confirm step: it is one small call.
- **The call path is shared.** `withRepair` in the Anthropic adapter took `{items: [...]}` roots only; `Call` is
  generic over the root now and `check` gets the whole output, so a one-object answer uses the same attempt,
  repair and error mapping. The second pass's "exactly one item" check moved into its `check`.
- **Races and failures.** The page counts the ops it logs per item; if the reviewer edited, split, deleted or merged
  the card again while the model answered, the late rewrite is dropped. A merged item with no edit after its
  latest merge (`applyItemEdits().uncombined`) shows "Combined without AI" (the error, if any, in its tooltip) and,
  with a key, "Combine with AI", which rebuilds the two source items from the log (`mergeSources`) and tries again.
  A reload during the call leaves that note, never a half-written card.
- **Ambiguity shows on any card that has one**, not only low-confidence ones: a combine reports contradictions
  there. There is no merge undo on the review page (before or after this unit); Delete and Split remain.
- **Proof**: core unit tests (prompt, validation, grounding, replay order, `mergeSources`); adapter tests against
  the stub (aliases, one repair, `invalid_output`, auth); `tests/e2e/combine.spec.ts` (Chrome: rewrite after the
  union, no-key note and retry, edit-before-answer race, Merge model setting) and `tests/e2e-firefox/combine.spec.ts`;
  a live merge case in `pnpm eval` (`tests/eval/combine.eval.ts`, skipped without a key).

## E7: Object Select and Select Text (2026-09-23)

- **Inspect becomes Object Select, and the page is never modified.** "Inspect" named a comparison with
  vibe-annotations; its live style panel is gone. A pick (hover, ↑/↓, click or ⏎) closes the open drawn
  Annotation (reason `object_select`), is screenshotted with its red outline at once (`captureAnnotation`), and
  opens a one-line comment box below the element. Enter records the Annotation, with what was typed or nothing:
  the reviewer may just speak. It spans the pick to Enter (`t`..`t_end`), so speech in that span attaches to it as
  it does to a drawn Annotation. Esc in the box drops the pick (the screenshot stays, tagged with an id no
  Annotation has). A click on the page, the mode going off, a pause or Stop record the pick as it is; the worker
  accepts it while paused or stopping for that reason.
- **Schema v13.** Close reason `inspect_pick` is renamed `object_select` (upgrade 12→13 maps it); an Annotation
  gets `comment` (null unless typed on a pick). A drawn Annotation a pick closes also has close reason
  `object_select`, so "is a pick" is `isObjectSelectPick` (the reason and no Strokes), not the reason alone.
- **`style_edit` stays, as the page API's data path only.** E5's `annotate({changes})` still records one; the
  wording that described it as Inspect edits ("Inspect pick #n", "made live", STYLE EDITS) is neutral now:
  STYLE CHANGES, "Apply these changes exactly", "(Annotation #n)".
- **Picks carry sources and crops.** `snapshotElementSourced` probes E4's MAIN-world bridge for the one picked
  element; the worker crops the pick's screenshot to it, as for a drawn Annotation.
- **The Process script** heads a pick `ANNOTATION #n OBJECT SELECT · start–end` and adds `COMMENT "…"` under it;
  the system prompt says speech in the span is about the element and the comment is the reviewer's own words.
  The host makes the comment the Signal's `intent` and adds it to the TUI line.
- **Modes live in the service worker.** Draw, Object Select and Select Text are one at a time: `select_mode`
  ('object' | 'text' | null) sits next to `draw_mode` on the Session, and `background/modes.ts` turns the others
  off when one goes on. The toolbar buttons, Alt+Shift+O / Alt+Shift+T (matched on `KeyboardEvent.code` in the
  page: the four Chrome command slots are taken), Draw's Alt+Shift+D command and Esc (all off, from the page or
  the toolbar, but not while typing in a comment box) all ask the worker, and every surface shows the pushed
  state (`aria-pressed`). A pause, Stop or a page with no overlay turns them off. The page hears the shortcuts
  once it has the Session, which the worker sends when the microphone has started.
- **Select Text replaces the always-on chip.** While it is on, a finished mouse selection (on release) or keyboard
  selection (Shift let go) opens the comment box directly; while it is off, selection does nothing special. The
  box is shared with Object Select (`content/comment-box.ts`), keeps E3's test ids and hides for every capture.
- **Toolbar order**: timer, Draw · Object Select · Select Text (an I-beam icon, built as SVG nodes because some
  pages' Trusted Types refuse `innerHTML`) · Snap · the viewport control, then Pause/Resume and Stop, then Panel.
  The side panel keeps only Draw.
- **Not fixed: the first toolbar Start sometimes leaves the toolbar idle under load.** No root cause found; the
  retry in `text-comment.spec.ts` stays.

## E5: the page API (2026-09-23)

- **`window.__inkup` only on the recording tab, only while it records.** The MAIN-world bridge (E4) defines
  the global when the overlay sends `inkup:page-api-state {enabled: true}` and deletes it on `false`. The
  overlay sends that from its Session state: on at Start (or on load of a recorded tab), off at Stop. Paused still
  counts as recording: `status` and `list` answer, `annotate` is refused. Other tabs never get the event, so their
  pages see `undefined`. The global is non-writable but configurable, so the bridge can take it back.
- **Nothing on the page is trusted.** A page can dispatch the enable event itself. That gets it a global whose
  calls all fail: the overlay answers only while its own Session state says the tab records, and the service
  worker checks `activeFor(tab)` again before it records anything. Arguments cross as JSON strings (as in E4) and
  are checked on the overlay side: a CSS selector (at most 500 chars, not the extension's own UI), a non-empty
  comment (clipped to 2000), at most 20 style properties.
- **A call is an Annotation with no Strokes.** It goes through the drawing path's parts: the element and its
  ancestors are snapshotted with sources, ranked by `rankCandidates` (the element's box is the bbox), screenshotted
  (trigger `page_api`, deferred like an Annotation's shot) and cropped. The event has `stroke_ids: []`,
  `close_reason: 'page_api'`, `source: 'page_api'`, and `page_api: {comment}`. `SessionDocument` allows empty
  `stroke_ids` only on such an Annotation or an Inspect pick. Keeping the comment on the Annotation, not in a
  separate event, makes Process, drafts, scratch that, the review page and the host read it with no new plumbing.
- **Style and text changes are `style_edit` events** in E2's Inspect shape, on the page_api Annotation's
  `annotation_id`: `changes` (kebab-case property → {from, to}, `from` read from the computed style unless the
  script gives it) and `text` ({from, to}, `from` read from the element's text). Process's style pass-through
  (`attachStyleChanges`), the script's STYLE EDITS line, review.md and the host Signal's `style_changes` then
  handle them with no parallel shape. The selector is the pick's generated one, as Inspect records it. The
  pass-through's wording still says "Inspect pick" and "made live" for these.
- **Schema.** E4 and E5 ship together as SCHEMA_VERSION 12, one identity upgrade 11→12, on E2's 9 and E3's 10. The
  chain must be contiguous (`upgradeSessionDocument` fails on a missing step), so 10→11 is an identity placeholder
  until E6 fills it (it has: E6's `viewport_change` step).
- **Order after Process** (anthropic.ts): Text Comments merged (`mergeTextComments`), pins enforced, the
  low-confidence second pass, Inspect and page API edits passed through (`attachStyleChanges`), E6's viewport
  sizes (`withViewportSizes`), then `groundItems` last, so the items the pass-through adds get sources, crops and
  the page_api tag too.
- **Change Items are tagged in code.** `groundItems` sets `source: 'page_api'` on an item when every Annotation it
  cites came from the page API, and drops any `source` the model wrote. A mixed item stays untagged. The script
  shows such an Annotation as `ANNOTATION #n PAGE API … made by a script on the page` with a `says: …` line (its
  edits follow as STYLE EDITS); the system prompt says to treat it like a reviewer's request unless the speech rejects it.
  The review page shows "from the page API" on the Annotation and a "page API" badge on the item; review.md adds
  "· from the page API" to the category line.
- **Host naming.** The Signal's E4 code-source field is renamed `element_source`, so `source` can mean who made
  it, as on the Annotation and the Change Item: `source: "page_api"` with the comment as `intent` and the note as
  `page_api`. MCP items carry `source` when set.

## E4: source mapping and element crops (2026-09-23)

- **A MAIN-world bridge, declared in the manifest.** `entrypoints/bridge.content.ts` runs with `world: 'MAIN'` at
  `document_start`. WXT writes that into `content_scripts` for every build. Chrome (111+) and Firefox (128+; our
  minimum is 140) honour it. Safari's support is unverified: if Safari runs it in the isolated world, the bridge
  sees no fibers and every source is absent (manual check S7). Tabs open at install get the bridge injected with
  `scripting.executeScript({world: 'MAIN'})` next to the content script. A window symbol keeps it to one per page.
- **Probe over DOM events, JSON-string details.** The overlay tags the elements with `data-inkup-probe`,
  dispatches `inkup:source-probe`, and reads `inkup:source-result`. A Firefox content script cannot
  read an object detail across worlds, so details are strings. Listeners run inside `dispatchEvent`, so the answer
  is there at once. The 1.5 s timeout only covers a page where the bridge never loaded. After one timeout, probes
  return nothing until the bridge announces itself (`inkup:bridge-ready`), so each Annotation doesn't wait
  1.5 s.
- **Only likely Candidates are probed.** The content script runs the same `rankCandidates` locally and asks only
  about the elements the ranking lists (about 10), not all 200 snapshots. Reading an owner stack formats an
  `Error.stack`, which is cheap but not free.
- **A navigation close does not wait for sources.** It must post before its first await. Sources are
  synchronous in practice, so they are already on the snapshot.
- **React 19 has no `_debugSource`.** The file and line come from the fiber's `_debugStack` owner stack: the first
  frame outside React, `node_modules`, `.vite/deps` and `/vendor/`. That is where the element was created, which
  for a dev server is the component's own file. With a bundler the line is the transformed module's line, which
  Vite and Next keep close to the source. React 16–18 `_debugSource` is read first when present. Components
  come from the `_debugOwner` chain, nearest first, and fall back to the fiber parents when there are no owners.
  `forwardRef` and `memo` are unwrapped. Names that are not `/^[A-Z][A-Za-z0-9_]{2,}$/` with a lowercase letter
  are dropped as minified.
- **Order: React, then Vue, then attributes.** The first one that knows wins. A missing file is filled from a
  later one (React components inside an element that carries `data-source-file`, say).
- **Path normalisation.** The path is cut at the last `src/` segment, else the last `app/`, so a checkout under a
  folder named `app/` keeps only the project path, and Next's `src/app/` keeps its `src/`. `node_modules`,
  `.vite/deps` and `vendor/` mean library code, and the source is dropped.
- **The page can spoof the probe.** Answers are sanitised (types, lengths, at most 8 components) and only ever
  shown to the agent as a hint. Nothing acts on them.
- **Grounding in code, not by the model.** The model's output schema (`ModelChangeItemSchema`) has no `source` or
  `crops`, so structured output gets no extra optional fields. After Process, `groundItems` copies the
  Candidate's source onto each Location (matched on Annotation number and selector), the item's Annotations'
  crops into `evidence.crops`, and one line each onto the agent_prompt. It replaces whatever the model invented,
  and grounding twice changes nothing. The Process script also shows `source:` on Candidates, so the model can
  name the file.
- **Crops.** In `closeAnnotation`, after ranking, the service worker crops the Annotation's own screenshot to the
  pick's box plus 16 CSS px (`OffscreenCanvas`). It stores the crop as blob `<screenshot_id>.crop` (kind
  `screenshot_crop`) and queues it for the Host. The Annotation event carries `crop {blob_id, path, rect}`. The
  scale is the image width over the viewport width: in the e2e harness Chromium captures 1280×633 for an emulated
  1280×720 viewport, the top part at 1:1 and not squeezed. An element off the visible image gets no crop. Two
  Annotations sharing a screenshot get separate crops. The id `<id>.crop` means `screenshots/<id>.crop.png` needs
  no new export code: `promptCitations` already reads it, and MCP `get_screenshot` fetches it by that id.
- **Schema v12** (with E5; v9 before E2, E3 and E6 took 9–11). All the new fields are optional, so the upgrade is
  the identity. Candidate `source` and
  Annotation `crop` are `.optional()` rather than `nullable().default(null)`, to keep this additive next to E2, E3
  and E6.
- **Host.** `read_items` passes each Location's `source` and the item's `crops` through. A live annotation Signal
  carries its pick's `source` and its `crop`. No schema change: the Host stores events and items verbatim.
- **Fixture.** `fixtures/site/react.html` uses React 19.3's development build, bundled from `node_modules` by
  `pnpm fixtures:react` into `fixtures/site/vendor/react-dev.js` (413 KiB, committed; no network at test time).
  `src/App.js` is plain `createElement` with no bundler, so the owner stack names `src/App.js:6`.

## E6: the viewport resizer (2026-09-23)

- **The frame host, in every browser; no `debugger` permission (the user's decision).** The toolbar's Viewport
  button reloads the tab into our `viewport.html`, which frames the page at the chosen size. Chrome's
  `chrome.debugger` (`Emulation.setDeviceMetricsOverride`) was built and spiked (`docs/spikes/viewport.md`): it
  resizes the real page in place, with no reload, even on sites that refuse framing. It was turned down and removed
  from the build. It adds "Access the page debugger backend" to the install prompt, and Chrome shows its "…
  started debugging this browser" bar, about 56 px of the tab, for as long as a size is set. The cost of the
  choice: the page reloads into the frame when a size is first set and again on Reset, and loses its in-page state
  both times (resizing within the frame does not reload). Sites that refuse framing cannot be resized, and their
  menu says why. The framed page is a third-party frame of an extension page, so a signed-in site may treat it
  differently (SameSite cookies, partitioned storage): manual check C20 step 6.
- **Behind `Platform.capabilities().viewport`.** Chrome and Firefox true. Safari false: the control is hidden until
  manual check S6 tries the frame host there (`devOverrides.viewport: true` offers it in any browser). Non-web pages
  never show it.
- **Frame host.** `viewport.html?u=<page>` frames the page in `<iframe name="var-viewport-frame">`. The frame is
  centred on a neutral backdrop (#3f3f46). A size larger than the room left by the host's bar is scaled down with
  a CSS transform, and the button and the readout say "1600×1000 at 80%". An all-frames probe content script
  (`viewport-frame.content.ts`) runs in every frame, and in the named one asks the worker to inject the overlay
  there. The toolbar, drawing, Snap and page context therefore work inside the frame. The host page mirrors the
  framed URL into its own with `history.replaceState`, so `tabs.onUpdated` still sees in-frame navigations.
  `effectiveUrl()` maps the host URL back to the page wherever the worker reads a tab's URL, so the Session never
  logs a navigation to our own page. Reset, on the toolbar or the host's bar, loads the page back into the tab, and
  so does leaving the host page.
- **Freeform drag** is on the host page: handles on the frame's right edge, bottom edge and corner. A live preview
  follows the pointer and the size is set on release, so each drag logs one `viewport_change`.
- **Framing refusals are read, not guessed.** Before offering sizes, the worker fetches the page (cached per URL)
  and reads `X-Frame-Options` and CSP `frame-ancestors`. A page that refuses keeps the Viewport button, and its
  menu names the header instead of offering sizes. When the fetch fails, the frame gets to try anyway.
- **Screenshots are the frame.** `captureVisibleTab` is cropped to the frame's rect as the host page reports it,
  with `dpr` times the frame's scale. Annotation and screenshot `viewport` and `dpr` come from the framed page
  itself, so Strokes are already in the resized page's coordinates.
- **The size is remembered per origin but not applied on its own.** `viewportSizes` (`storage.local`) keeps the
  last size set on each origin. The menu offers it as "Last used here" and pre-fills the typed W×H. Applying it on
  every visit would reload the page into a frame without the reviewer asking.
- **Schema v11: `viewport_change {width, height, scale, mechanism: 'frame_host' | 'none'}`.**
  - It is logged when a size is set, dragged to or reset (`'none'`, the tab's own size), and at Start when the tab
    is already resized.
  - The Process script prints `VIEWPORT resized to 375×812` in time order, and each Annotation head says the
    viewport it was drawn at.
  - A Change Item located at a resized viewport gets "The reviewer saw this with the page's viewport at 375 px wide
    (375×812); check it at that size." in its `agent_prompt` when the model did not already say it.
  - review.md lists the sizes in its header and names the width on each location.
  - The host stores events as opaque JSON, so it needs no change.

## E3: Text Comments (2026-09-23)

- **The chip lives with the drawing overlay.** `TextCommentUi` (`src/content/text-comment.ts`) mounts in the same shadow
  root as the canvas while a Session records on the tab, toolbar or not. It shows only for a finished selection (not
  mid-drag) outside our own UI, and only while drawing and Inspect are off and the Session is not paused. Draw mode,
  Inspect or a pause hides the chip and cancels an open box. While the canvas holds the pointer the page cannot be
  selected anyway, so drawing and selecting never mix. Esc and a press elsewhere on the page cancel; Enter saves, with
  or without Shift, since the box holds one line. Keys typed in the box stop at the box, so page shortcuts do not fire,
  and Shift typed there no longer turns on Shift-to-draw.
- **The anchor.** A W3C TextQuoteSelector: `exact`, and up to 32 characters of `prefix` and `suffix` with whitespace
  collapsed (`packages/core/src/text-quote.ts`). The context comes from the nearest ancestor holding at least 64
  characters more than the selection, so a whole-heading selection still gets the paragraph after it. `exact` is
  the source text (`textContent`), so CSS `text-transform` does not change it and an agent can grep for it.
  `selected_text` is what the page showed. The element is the smallest one holding the whole selection, described
  like a Candidate (selector, tag, role, name, text, test id, id, classes, bbox).
- **When things happen.** `t` is when the selection was made and `t_end` is when the comment was saved. Speech
  whose segment overlaps that span belongs to the comment. The span has no slack, so speech that arrives after the
  save is not attached. A save sends the grouping signal `text_comment` to close any open Annotation, then records
  the comment. The screenshot is taken at the save: the kept range is put back as the page's selection, so the
  image shows the selected text, and the chip and box are hidden. It is not taken at the chip's click, which would
  leave an orphan screenshot on Esc.
- **Hidden in every screenshot of the Session's tab.** `toolbarCapture` now goes to the Session's tab as well as to
  toolbar tabs, and the client hides the toolbar and the chip together. A tab that shows neither answers at once.
- **Process.** `detectReplacement` recognises comments that state the new text: `should say/read …`, `should be
  "…"` (quoted only: "should be bigger" is a style request), `change/rename (this) to …`, `replace with …`,
  a quoted text alone, `old -> new` and `-> new`. The before-text narrows to the part the comment names when the
  selection contains it. Such a comment becomes an item in code: category copy, confidence 0.95, subject Location
  on the selector with `annotation: null`, and the agent prompt quoting the old and new text and the anchor's
  context. The script shows it as HANDLED, and a model copy item on the same selector with no Annotation is
  dropped as a rewrite. Any other comment goes to the model on a TEXT COMMENT line (selector, selection with
  context, the comment, the speech). If no model item names its selector, it is converted in code (confidence
  0.8). A Session whose only content is explicit comments (no live Annotation, no other comment, no speech
  outside them) makes no call: the estimate is 0 tokens and the run records no calls (`windows: 1`, since the
  schema requires a positive count). The Draft Item pass is not triggered by a comment.
- **ChangeItem is unchanged.** The before and after texts travel in the title, intent and agent prompt, not in new
  fields, so the model's structured-output schema stays the same.
- **Schema v10** (on E2's v9). New `text_comment` event (with `index`, tN), close reason `text_comment` and
  screenshot trigger `text_comment`. Upgrading v9 needs no change. session.json checks that a comment's screenshot exists.
- **Host.** Text Comments are Signals (`kind: text_comment`, `number` tN, element, selector, screenshot, title
  `Comment on "…"`, category copy, intent = the comment, transcript = the speech while selected). `watch_items`
  wakes on them. The TUI timeline shows `t1 on '…': comment`. The wire protocol is unchanged: events are stored
  verbatim.

## E2: Inspect, with style diffs (2026-09-23)

- **A pick is an Annotation.** It has close reason `inspect_pick`, no Strokes, and the picked element as its one
  Candidate (`relation: pick`, coverage 1, no ranking). So pairing, Draft Items, Signals, the review page and Process
  handle it like any other Annotation. A pick first closes the open drawn Annotation (grouping signal
  `inspect_pick`), so the numbering follows what happened. `stroke_ids` may now be empty, and only for a pick: the
  session document check enforces that. The screenshot is taken with the pick's outline showing (like the ink of a
  Stroke) and before the panel opens. The panel is hidden for every capture.
- **`style_edit` carries the whole difference, not one change.** Every committed field (Enter, blur, a colour
  token) records `{annotation_id, selector, changes: {prop: {from, to}}, text?}`, measured from the computed values
  at the pick, and the latest one for a pick wins. Setting a value back to what it was drops it from the
  difference, and an edit that ends up empty counts as no edit. Recording on every commit means a navigation loses
  nothing, and it saves a separate flush step. Stop still commits whatever field is being typed in.
- **`from` is the computed value, `to` is what the reviewer typed.** So `var(--accent)` stays a token and never
  becomes an rgb value. The colour picker lists the page's colour custom properties (same-origin sheets and
  inline `:root`, resolved on the picked element, 24 at most), next to an `<input type=color>`.
- **The model never writes `style_changes`.** They are left out of the structured-output schema, which also
  avoids a record type in structured outputs. After the model answers (and after pins, windows and the second
  pass), `attachStyleChanges` copies the latest edits of the picks each item's Locations name. It appends an exact
  "Apply these edits exactly" block to the agent_prompt unless every `prop: from → to` is already in it. It adds
  the token rule: prefer the project's design tokens, and read `var(--x)` as that token. A pick with edits that no
  item covers gets an item of its own (style, or copy if only the text changed), so an edit never disappears.
  Scratched picks are left out. The script shows the latest edits under their pick (`STYLE EDITS … (made live,
  exact)`), not at the time they were made, so windowing can never split a pick from its edits.
- **The edits are live and inline, and Stop reverts them.** They are set as `!important` inline properties, and
  text is edited only for an element that holds nothing but text. The inspector lasts as long as the Session on
  that page, so turning Inspect off (Esc, Draw, a pause) keeps the edits in view while the reviewer talks. Stop
  puts back the original inline values and text.
- **Hit-testing and input.** The outline follows `composedPath()[0]` of pointer moves, so it reaches into open
  shadow roots (a closed root gives its host). ↑ climbs through shadow hosts, and ↓ walks back down the path ↑
  took. Presses, clicks and the keys Inspect uses are stopped in the window capture phase, before the page and the
  overlay's click capture. Events inside our overlay host (the toolbar and the panel) pass through. An Inspect
  toggle that arrives before the page has its Session state waits for it: the toolbar shows a new Session a moment
  before the page is told it is recording.
- **Selectors.** `data-test`, `data-cy` and `data-qa` rank with `data-testid`, in that order, and a test attribute
  that is not unique falls through to the next. An element inside an open shadow root is `host-selector >>>
  inner-selector` (Playwright's and Puppeteer's piercing form); `resolveSelector` reads one back. Candidate
  `testid` is the first test attribute found.
- **Host.** Picks reach the host as ordinary annotation events, so they became Signals with no change on the host.
  An annotation Signal now also carries its pick's latest `style_changes`, so an agent sees the exact edits before
  Process runs. The protocol schema is unchanged, because the host stores loose events.
- **Schema v9** (close reason, `style_edit`, Change Item `style_changes`): nothing older changes, and the upgrade
  step is the identity. The fixture site has colour tokens (`--brand`, `--accent`, `--ink`). The CTA uses
  `--brand`, which is the same colour as before.

## H4: `inkup mcp install` (2026-09-23)

- **It edits the config files; it does not shell out to `claude mcp add`.** The result is the same entry for
  Claude Code, and the behaviour does not depend on which agent CLIs are on the PATH. Only the `inkup`
  entry changes. JSON keeps its key order and other servers; TOML keeps comments and formatting (`toml_edit`). The
  file is replaced atomically with its permissions kept (`~/.claude.json` is private), and a file that does not
  parse is left alone with an error.
- **Where:** Claude Code `~/.claude.json` (user scope) or `<dir>/.mcp.json`; Cursor `~/.cursor/mcp.json` or
  `<dir>/.cursor/mcp.json`; Codex `$CODEX_HOME/config.toml` (default `~/.codex`) or `<dir>/.codex/config.toml`.
  Claude Code gets `{type: "http", url}`, Cursor `{url}`, Codex `[mcp_servers.inkup] url`.
- **Choosing agents:** `--agent` (repeatable) names them. Without it, the agents whose config dir exists are
  offered one by one on a terminal (`[Y/n]`); with `--yes` or no terminal, all of them. None found is an error
  that asks for `--agent`. `--project [DIR]` (default: the current directory) offers all three, since a project
  config does not depend on what this user installed.
- **`--reset` takes the entry out** (the inverse of install), leaving the rest of each file as it was. Installing
  again is a no-op; a different `--port` updates the URL.

## H2: the host TUI and commands to the browser (2026-09-23)

- **`inkup` with no subcommand is the TUI**; `serve` stays headless with the line prompt for pairing. In the
  TUI, pairing requests are answered in a popup (y/n) that takes the keyboard until answered, and logs go to
  `inkup.log` in the data dir, since the screen is the TUI's. Without a terminal it refuses and points at
  `serve`.
- **The TUI renders `HostState`, which `GET /api/state` also returns.** Clients (connected or only paired),
  Sessions (live, paused, processed, ended), the timeline of the selected Session (else the newest live one),
  items with their Resolutions, and the agents blocked in `watch_items`. It reads again every 500 ms and right
  after a command's answer. Tests assert on the endpoint, so what they check is what the TUI shows.
- **Commands are `command` / `command_result` on the WebSocket.** The host sends `start_session`, `pause`,
  `resume`, `stop` or `set_draw_mode {draw_mode}`; the Client runs it as the panel's button would and answers with
  `ok`, the `session_id` and a `message` saying why not. The host waits 20 s. `POST /api/clients/<id>/commands`
  (bearer token) is the same call: 404 when the Client is not connected, 504 when it did not answer. The keys `s`,
  `p`, `x` and `d` act on the focused Client: the one selected in Clients, the owner of the Session selected in
  Sessions, else the first connected one.
- **A Session started from the host is audio only.** Screen sharing needs a click in the browser, so it records
  audio, Strokes and screenshots with `video_off_reason: 'unavailable'`, the existing reason, rather than a new
  schema value. Pause and resume from the host are logged `via: 'button'`, likewise without a new value. Draw mode
  as last set from the TUI is tracked in the TUI, since `SessionOverview` does not carry it.
- **The Client refuses what it cannot do** with a reason the TUI shows: no Session recording, one already
  recording, microphone not granted, no web page to bind to, draw mode on a paused Session or a page with no
  overlay.

## E1: the floating toolbar (2026-09-23)

- **The toolbar icon toggles the toolbar, not the panel.** The panel is one click away on the toolbar ("Panel") and
  on the new Alt+Shift+P command. Chrome's `openPanelOnActionClick` is set back to false explicitly, because the
  setting persists in the profile. On pages no overlay can run on (chrome://, another extension's page) the icon
  still opens the panel, synchronously inside the click, as Chrome's `sidePanel.open` requires. A panel request from
  the toolbar that the browser refuses (Firefox's `sidebarAction.open` needs a user action, and a page's message is
  not one) opens `sidepanel.html` in a small popup window instead.
- **Which tabs show it.** `toolbarTabs` in `storage.session`: the icon toggles a tab in and out, a toolbar Start or
  Alt+Shift+R adds it, closing the tab drops it. A Session started from the panel does not add its tab, so the
  panel-only flow looks as before; the icon shows the toolbar on it at any time. `contentHello` now answers both
  questions (recording? toolbar?) in one message, so a page load wakes the worker once, as before.
- **The toolbar renders only pushed state.** The worker pushes a `ToolbarState` to every tab that shows it on any
  change of the Session, pairing, host status, mic grant or notice, coalesced over 30 ms, plus the toast strip on
  each `transcript_segment` or `draft_item` (an `onEventAppended` hook on the one event writer). The one state of
  its own is its position (`toolbarPosition`, `storage.local`, shared by every page), which the content script
  reads and writes directly: the only setting a content script touches.
- **Alt+Shift+R starts on its tab.** It used to open the panel. Now it starts a Session on the tab it was pressed in
  (or stops the live one), with the toolbar. A Start from the toolbar or the shortcut binds to the sender's tab
  (`targetTab`), not the focused window's active tab.
- **Lifecycle (ADR 0004).** The panel Port's "closing the panel is Stop" applies to the Session the panel started,
  as before. A toolbar Session has no owning page: closing a panel does not stop it, a navigation remounts the
  toolbar. While recording, the toolbar pings the worker every 20 s like the panel does. The Hide button is not
  offered while recording, so the controls cannot be lost mid-Session.
- **Video (docs/spikes/toolbar-start.md).** Chrome records the tab with `tabCapture` in the offscreen document,
  gated on the extension having been invoked on the tab; Firefox's Start is an extension frame that opens the
  picker and records; Safari starts without video from the toolbar. `LiveVideo.recorder` says where the recorder
  runs, so Stop flushes the right one (`offscreenVideoStop` before `offscreenStop`, or the panel Port). The frame
  holds the panel Port with `stops_session: false`: its page going away ends the video (`ended`), not the Session.
  The panel's recorder moved to `src/media/tab-video.ts` so all three share it.
- **Never in a screenshot.** Each capture asks the tab's toolbar to hide (visibility, then two animation frames,
  capped at 150 ms) and shows it again after, all inside the screenshot queue. The canvas is a sibling, so the ink
  stays. Click capture and Candidates already skip everything inside the overlay host; the click listener now
  checks the event path for the host too, so toolbar clicks are never logged as page clicks.
- **No new timeline or schema fields.** A toolbar Start without video logs `video_off_reason: 'unavailable'`; the
  toolbar says "No video". Snap on the toolbar logs the screenshot trigger `panel`, the schema's name for a Snap
  button. The session document schema and the host protocol are unchanged.
- **`tabCapture` permission (Chrome).** It adds no install warning. Firefox and Safari builds drop it. Only the
  Firefox build lists a web-accessible resource (`toolbar-start.html`): a web-accessible page lets any site detect
  the extension, so Chrome and Safari expose none.

## H3: Change Items, MCP and Resolutions (2026-09-23)

- **The extension pushes the whole current set, not a diff.** After a Process run and after each review edit, an
  `items` outbox row is queued; when it goes out, the worker sends the Session's latest done run with the review
  edits applied (the same fold as the review page). The host replaces the Session's set: an item left out
  (deleted, merged away, or from an earlier run) is withdrawn, never deleted, so a Resolution always keeps its item.
  Consecutive `items` rows for one Session send once.
- **Host ids are `item-<seq>`.** Items are keyed by run and item id (`item_0001` is only unique within a run); the
  host's never-reused `seq` is what agents see, and it survives review edits. The cursor `watch_items` waits past is
  `<item seq>.<event seq>`, returned by `read_items` and `watch_items`, so nothing arriving between two calls is
  missed.
- **Signals are derived on the host, not sent.** The host already has every event, so a Session with no Change
  Items yet exposes its live Annotations (with the words said around them) and Draft Items, minus what was
  scratched or discarded. The first `items` push for a Session supersedes them. `watch_items` wakes on a new
  Annotation, Draft Item, draft action or Voice Command as well as on items.
- **Resolutions go back over the WebSocket.** `resolution` is pushed to the Session's owning Client when an agent
  resolves an item, and every Resolution of its Sessions is replayed after each `welcome`, so a Client that was
  offline catches up. The extension keeps them by id in a `resolutions` table (Dexie v5); the review card shows the
  latest one.
- **`ack.event_id` became optional.** `items` is acked like an event, by the id of its message; `event_id` is present
  only when the acked message was an event. Nothing had shipped that relied on it.
- **The agent's instructions live in the tool descriptions and the server instructions.** They say what to do
  (read the backlog, implement the agent_prompt, resolve with a note, watch with the cursor), and that Signals are
  a heads-up rather than tasks. `read_items` warns when results span several origins and no `url` was given.
- **"Image paths" are screenshot ids.** Blob files are named by a hash, not a path an agent could open, so items
  list screenshot ids (the agent_prompt cites them as `screenshots/<id>.png`) and `get_screenshot` returns MCP image
  content, optionally cropped.
- **/mcp refuses web page origins** like /ws does, since it has no token. Agents send no Origin.

## H1: the extension streams a live Session to the host (2026-09-23)

- **The outbox holds references, not copies.** `outbox` rows name an `events` seq or a `blobs` id; the data stays
  where it is. A row is written in the same Dexie transaction as its event, and only while `hostPairing` is set,
  so a never-paired extension writes nothing extra (`tests/e2e/standalone.spec.ts`). A row whose event or blob was
  deleted meanwhile (a failed Start, a deleted Session, media deleted after export) is skipped.
- **Order and acks.** The service worker sends rows in `seq` order. Consecutive events go out together, each acked
  by the id of its message, and are deleted once all are acked; a blob is a `PUT /blobs/<id>` between them. A
  dropped socket keeps the rows, and the resend is harmless because the host upserts on the event id. A refusal
  (`bad_message`, `conflict`, a 400 or 413 for a blob) drops that row with a console warning instead of blocking
  the queue forever.
- **Media at Stop.** Screenshots are queued as they are taken; audio and video once, whole, when Stop has
  finalized them. Review-page edits and re-transcriptions go through the same outbox and wake the worker with
  `hostDrain`; a 5 s sweep catches anything a missed wake-up left.
- **Blob ids are the extension's own.** The host names blob files by the SHA-256 of the id, so
  `<session>:audio` needs no mapping on any OS.
- **Reconnect.** 0.5 s doubling to 10 s with ±20% jitter. A service worker that slept reconnects on its next wake;
  nothing is lost meanwhile, since capture never waits on the host. `unknown_token` stops retrying and asks the
  reviewer to pair again.
- **The wire event is the full timeline schema on the TypeScript side only.** `@inkup/protocol`'s `EventMessage`
  checks events with `TimelineEventSchema`; `protocol.schema.json` (and so the host) keeps the loose
  `WireTimelineEvent`, because the host must store events from newer timeline versions than it was built with.
- **The address is not on screen by default.** Settings shows the pairing hint and Pair for the default
  `127.0.0.1:47823`; "Other address" reveals the field. `tests/e2e/prod-ui.spec.ts` keeps loopback addresses off
  the unpaired pages.
- **Capabilities gate sending.** `hostCapabilities()` (from the host's `welcome`) is checked before events
  (`events`) and blobs (`blobs`) are sent; a host without one gets none of that kind, and the rows are dropped.

## Speech before the VAD loads (2026-09-23)

- **The problem.** vad-web's MicVAD opened its own microphone node only once Silero had loaded, which took 2.9 s
  after Start on the CI runners. Speech before that made no `speech_activity`. A Voice Command in that window
  was rejected ("no silence observed before the phrase"). Local Whisper transcribes VAD spans, so it never heard
  that speech. The audio file and the Web Speech, Deepgram and ElevenLabs tiers read the stream from Start and
  lost nothing. Speech Boundaries come from transcript segments, so only Whisper's were missing.
- **Buffer and replay (option a), not an early load alone (option b).** Loading earlier still depends on the
  machine, and the offscreen document only exists from Start. The 16 kHz PCM graph (`pcm.ts`) now starts with
  the capture. `src/core/vad-feed.ts` buffers its frames and, once the model is ready, feeds them in order as
  512-sample Silero frames. Each frame carries its own Session time, not the time it ran, so islands, command
  silences and Whisper spans land where the speech was. The same Silero model processes it all: MicVAD is never
  started and gets frames through `processFrame`. Its private frame processor is resumed by hand, and its model
  is released directly because `destroy()` assumes `start()` ran. Both depend on the pinned vad-web 0.0.31.
  `tests/unit/vad-web-pin.test.ts` fails if the installed version changes. At runtime, `voice.ts` checks
  `processFrame` and `frameProcessor.resume` after `MicVAD.new`. If either is missing it logs
  `[var] vad-web internals changed` and starts MicVAD on its own clone of the stream, as before: early speech
  is lost again, but Voice Commands still work.
- **Spans for a late listener.** Whisper subscribes after loading its own model, so spans are held until the
  first listener arrives, keeping at most 60 s of audio. If the VAD fails to load, the buffer is dropped.
- **"Recording" stays as it is.** The panel shows Recording at once: with the backlog replayed, nothing said
  before the detector is ready is lost.
- **Proof.** `tests/unit/core/vad-feed.test.ts` covers the backlog order, frame times, carry-over, stop and the
  span hold. With the model load delayed 3.5 s, `voice-commands.spec.ts` ignored "scratch that" on the old code
  and passes now. The spec checks for at least 4 islands from 0 s again.

## Field bug: Process lost its reply channel (2026-09-23)

A real review of a 4-minute Session failed with "A listener indicated an asynchronous response by returning true,
but the message channel closed before a response was received". The review page sent one message and waited for
the whole run. Chrome ends any single extension event that takes longer than 5 minutes, and stops a worker after
30 s without an event or extension API call (developer.chrome.com, "The extension service worker lifecycle"). The
page's 20 s keep-alive message only covered the second limit. A streamed run with long outputs can pass 5 minutes.

- **The request answers at once.** `startProcess` replies as soon as the run's row exists. The run carries on in
  the worker and the page follows the `processRuns` row, which it already watched. A late failure shows from the
  row, and closing the page no longer matters.
- **The worker keeps itself alive.** While any run is active it calls `chrome.runtime.getPlatformInfo()` every
  20 s, which resets the idle timer. The page's `keepAlive` message is gone.
- **Proof.** Playwright keeps a debugger on the worker, which lifts both limits, so the kill cannot be reproduced
  in e2e. `process-stream.spec` instead shows that the reply arrives within 5 s while a ~25 s answer streams, that
  the run reaches done with the review page closed, and that the heartbeat fired during the run.

## CI on Linux (2026-09-23)

Four e2e tests passed on macOS but failed on `ubuntu-latest` (2 vCPU). They were reproduced in
`mcr.microsoft.com/playwright:v1.63.0-noble` with `--cpus=2`.

- **Raw CDP launch (`inject.spec.ts`), test fix.** Ubuntu 23.10+ restricts unprivileged user namespaces, so
  Chromium's sandbox aborts with "No usable sandbox!" and CDP never comes up. Playwright passes `--no-sandbox` by
  default. `tests/e2e/raw-cdp.ts` now passes it too, and puts Chromium's stderr in the error.
- **Stale draw mode after a navigation (`navigation.spec.ts`), product fix.** `onTabUpdated` read the
  Session, took the navigation screenshot, then pushed that snapshot to the new page. If the reviewer turned
  drawing on during the screenshot, the stale push turned it off again, and the next circle selected page text.
  The CI trace shows the canvas going `pointer-events: auto`, then `none`. `ensureContentScript` now reads the
  Session on each try.
- **Video shorter than the Session (`export.spec.ts`), product fix.** Tab capture sends a frame only when the
  page repaints. On Linux a static page gets about one refresh frame a second. The WebM duration came from its
  last block, so a review that ended on a still page got a short recording: 56 ms after 3 s, or 1.6 s short
  after a quiet tail. The panel now reports when its recorder stopped (or the worker notes when the panel went
  away). `finalizeVideo` writes the header duration as the longer of the last block and that stop time, minus
  the start offset and pauses. The last frame holds until then.
- **Video start offset, product fix.** The offset came from MediaRecorder's start event, which a loaded
  machine fired up to 3 s after `start()`. The file's time 0 is the `start()` call, so every seek landed late.
  The panel now reports the `start()` time.
- **Stop stuck on "Finishing...", product fix.** Twice on CI, the service worker got a NotReadableError reading
  the chunks the panel had just written. It then stored a Blob built from them, and that write never finished.
  `finalizeVideo` now retries the read with fresh rows and stores bytes held in memory. `doStop` gives the
  video 30 s, like the audio's 15 s. The retry has not yet been seen in a CI log, so the cause is inferred
  from one warning.
- **Scripted speech in the navigation and scroll-close tests, test fix.** The cue's Speech Boundary closed the
  open Annotation before the draw toggle or scroll on a slow runner. Both tests now record without speech.
- **VAD islands in the voice-command test.** A test-only fix counted islands after 4 s. It is superseded by
  "Speech before the VAD loads" below, which restores the check from 0 s.
- **Voice-command test, test fix.** The fake audio runs on the Session clock, so "scratch that" lands at about
  4.8 s whatever the test is doing. On CI the command watcher took 2.6 s to load and the circle took 2.3 s, so
  the command landed mid-Stroke. The test now draws first and waits for the watcher after.
- **Timer test, test fix.** A late repaint can skip from 00:01 to 00:04, so the test waits for at least 2 s,
  not for exactly `00:02`.
- **Export test bounds, test fix.** The recorder stops after the Stop click and before `session_end`. That is
  logged once audio and video are finalized, which takes seconds on a slow runner. The duration is now checked
  between the two instead of within 1.5 s of `session_end`. The slack is 1 s below and 1.5 s above: the file
  starts with the latest frame captured before `start()` (up to one refresh frame early), plus pause latency.
  Measured 0.1–0.6 s in the container. The close-panel
  test waits for the first stored chunk, not a fixed 3 s: on a loaded runner the first chunk lands seconds after
  the start.

## Feedback batch 1, U5 (2026-09-23)

- **What a Session can do on a URL** (`src/core/target.ts`). Web pages and `file:` get the content script's
  overlay (`page`). Our own review, Sessions, options and onboarding pages get the same overlay, which they
  mount themselves (`own_page`). Other extensions' pages, `chrome://`, `about:` and the Web Store run nothing of
  ours (`no_overlay`). Our side panel, the offscreen document, devtools and view-source cannot be recorded.
- **No silent fallback.** Start binds to the active tab of the last focused window. It used to fall back to
  the most recently used web page whenever the active tab was not http(s) or file, so the reviewer recorded a
  tab they were not looking at. Now a tab that cannot be recorded gets a message naming it. The fallback remains
  only when the active tab is our own `sidepanel.html`, which happens only when the panel runs as a tab in tests.
  It prefers web pages, then any other target, most recently used first.
- **Our own pages** call `mountPageOverlay()` (`src/page-overlay/mount.ts`). It runs the overlay client that the
  content script now shares (`src/content/client.ts`), in a plain shadow host. Verified in the harness:
  `tabs.sendMessage` reaches an extension page open in a tab, so state pushes, flushes and close signals need no
  new channel. `scripting.executeScript` cannot run in extension pages ("Cannot access contents of url"). So the
  service worker reads such a page's context through a new `contentPageContext` message, answered by the
  overlay. `captureVisibleTab` works on our own pages with `<all_urls>`. The content-script injection
  (`ensureContentScript`) runs only for `page` mode.
- **No-overlay Sessions.** They record audio, the transcript, tab video and the URL. The draw toggle is disabled,
  and the panel explains why. On these pages Chrome refuses `captureVisibleTab` without a live `activeTab` grant
  ("The 'activeTab' permission is not in effect"), so the panel's Snap and navigation screenshots capture
  nothing. The new `snap` command, suggested key Alt+Shift+S, is the way to screenshot them: a keyboard shortcut
  grants `activeTab` for the active tab. The Session follows its tab, so a navigation recomputes the mode, and
  the Session gains or loses drawing with it.
- **Permissions.** `activeTab` is added. Chrome shows no install warning for it and grants nothing until the
  reviewer invokes the extension, so an update does not disable the extension or ask again. Commands carry no
  warning either. MV3 allows four suggested shortcuts; there are now three: Alt+Shift+R, Alt+Shift+D and
  Alt+Shift+S. A shortcut the browser or another extension already holds is left unassigned, and the reviewer
  sets it at `chrome://extensions/shortcuts`.
- **Schema v8.** `session_start.overlay` and `navigation.overlay` are `page` or `none`, defaulting to `page`. The
  screenshot trigger `shortcut` is new. `UPGRADES[7]` is the identity, since everything defaults. The session
  fixtures and `docs/schema` are regenerated.
- **Process** marks a start URL or a navigation with `overlay: none` as "(no drawing: URL and screenshots
  only)". The system prompt says Locations there are `selector: null`, element "page", the URL and the
  screenshot. `displayUrl` compared `URL.origin`, which is "null" for every `chrome://` and
  `chrome-extension://` URL, so it showed another extension's page as a bare path. It now compares scheme and
  host.
- **Test harness.** A tiny fixture extension (`fixtures/extension`) loads next to ours through the
  `extraExtensions` option. Its worker is named `fixture-sw.js` so the `serviceWorker` fixture still picks ours.
  Playwright key events never reach Chrome's extension-command accelerators, headless or headed. So the e2e
  dispatches the `snap` command event at our real listener (`chrome.commands.onCommand.dispatch`). A dispatched
  command carries no `activeTab` grant. On the fixture extension's page, the e2e therefore asserts that Chrome
  refuses the capture for want of `activeTab`. That a real Alt+Shift+S captures there is manual check C18. On
  our own Sessions page the dispatched command records a `shortcut` screenshot, with the page context the overlay
  reported.
- **Session list labels.** Our own origin reads "This extension" (`originLabel` in `src/core/session-list.ts`).
  Another extension is named only when `chrome.management` already exists, which needs the `management`
  permission. This extension does not request it, because naming a list group does not justify a new
  permission, so the list shows its raw `chrome-extension://<id>` origin.
- **Upgrade from v7.** A v7 export restores through `UPGRADES[7]`: `overlay` defaults to `page` on session_start
  and navigation (unit test in `tests/unit/core/session-file.test.ts`). Lane B's long-Session generator and seed
  build events through the schema, so they pick up the defaults; `pnpm schema` leaves `docs/schema` unchanged.
- **grantMic diagnostics.** When onboarding's "Microphone ready" never appears, the e2e helper attaches the
  page's console, its alert text and the stored `micGranted` flag to the failing test.

## Feedback batch 1, U3 (2026-09-23): screenshots inside Change Item cards

- **Where screenshots live.** Each Location in a Change Item card shows its screenshot directly under its row. The
  row keeps the role label and "Annotation #n", which serves as the reference indicator. The screenshot is the
  Location's own `screenshot`, else the cited Annotation's `screenshot_id`, else nothing. The right pane keeps only
  the player, plus one line with the selected item's time range, since selecting an item still seeks the recording.
  `EvidencePane` is gone.
- **Shared component.** `EvidenceShot` moved from `review/evidence.tsx` to `src/components/evidence-shot.tsx`,
  with `useShotIndex`, `locationShot` and `strokesOf`. The Stroke filter is U2's `strokeIdsForShot`
  (`src/core/evidence-strokes.ts`), with the Location's Annotation as the cited one: a card shows only the Strokes
  of the Annotation the Location cites, drawn on that screenshot. When the Location cites no Annotation, it shows
  every Annotation's Strokes on that screenshot, as U2 does for an item.
- **Enlarge** uses the shadcn `Dialog` (radix-ui was already a dependency), up to 95vw and 1400 px wide. Its title
  is the role and element, and its description is the URL and Annotation. Clicks inside the dialog do not select
  the card. The shadcn CLI added an unrelated `cn` npm package and imported `cn` from it, for both `dialog.tsx` and
  `skeleton.tsx`. The package was removed and both files import `@/lib/utils`.
- **Annotation list** screenshots get their own Strokes overlaid through the same component. The side panel's
  Annotation thumbnail uses `object-contain` on a muted background instead of `object-cover object-top`, so it
  shows the whole screenshot.
- **Tests.** Unit tests cover picking the Location screenshot and filtering Strokes. `process.spec` asserts that
  every subject Location's card holds its screenshot, that the destination without one shows none, that the right
  pane has none, and that the enlarge dialog opens with the same overlay path at a larger size.
  `export.spec` asserts that every Location with a screenshot shows it and its Strokes inside its card.
  `capture.spec` asserts one overlay path per Stroke in the Annotation list. `drafts.spec` asserts
  `object-fit: contain` on the panel thumbnail.

## Feedback batch 1, U4 (2026-09-23): streamed, budgeted Process

- **Reproduced first.** `tests/unit/adapters/truncation.test.ts` builds a dense 12-minute Session (one Annotation
  every 12 s, one Process window under the old rules) and has the stub count one token per character and cut the
  answer at the request's `max_tokens`, as the real API does. Before the fix it failed with `The model's answer
  failed validation twice: Failed to parse structured output as JSON: Expected double-quoted property name in JSON
  at position 16000`. That confirms the diagnosis: the fixed `MAX_TOKENS = 16_000` cut the JSON, the SDK's parse
  step failed before the `max_tokens` check, and the repair turn replayed the cut-off answer to the model.
- **Output caps** live next to `PRICES` in `src/core/process/cost.ts`: 128,000 for every current Fable, Opus and
  Sonnet model, 64,000 for Haiku 4.5, from the claude-api skill's model table (`shared/models.md`, cached
  2026-06-24). An unknown model gets 32,000. Process asks for the whole cap: thinking is on by default on the
  current models and counts against it. Looking the cap up with the Models API for unknown IDs is deferred.
- **Budgeted sections** (`src/core/process/sections.ts`, pure). Natural cuts are navigation, tab switch, pause,
  resume, the `next` Voice Command, an Annotation closing, and the middle of a silence of 8 s or more between
  speech. An Annotation and every segment within its pairing window (2 s word, 4 s approximate) form a cluster; a
  cut inside a cluster or a segment moves to its end, so speech never leaves its Annotation. Sections with no
  Annotation and no speech join their neighbour.
- **Packing.** A chunk's estimated answer (`estimateOutputTokens`, unchanged: 600 + 700 per item) may use half the
  output cap: 64,000 tokens, about 90 items, on the 128k models. A Session up to 12 minutes that fits is one chunk,
  as before. Longer ones get max(round(length / 10 min), ceil(estimate / budget)) chunks, each boundary the natural
  cut nearest an equal split, so a 40-minute Session is still 4 chunks of about 10 minutes, now cut at real pauses.
  A chunk over the budget is halved at the cut that best halves its estimate, and a single oversized section at its
  largest internal silence. The 10-minute target is kept on purpose: it gives the in-progress cards something to
  show and lets two chunks run at once. The 1-minute overlap, ownership, coverage retry, merge and pin handling in
  `windows.ts` are unchanged; `planWindows` is gone.
- **Streaming.** Every call (Process, second pass, live drafts) uses `client.messages.stream` with the same
  `zodOutputFormat`; `finalMessage().parsed_output` is the answer. `stop_reason` is read from the `message_delta`
  event because the SDK's parse step throws on cut-off JSON before `finalMessage` returns. While a chunk streams,
  the text snapshot goes through the SDK's vendored `partialParse` (`@anthropic-ai/sdk/_vendor/partial-json-parser/parser`)
  at most every 400 new characters; every item before the one still being written is checked with
  `ChangeItemSchema.safeParse` and reported, so an invalid item is never shown. Chunks run two at a time with
  `p-limit` (new dependency, 16 kB, the standard concurrency limiter).
- **Running out of tokens.** A chunk that stops at `max_tokens` is recorded as a `truncated` call, split in two at
  its best natural cut, and both halves run; at most 3 splits deep. A truncated answer is never repaired. When a
  chunk cannot be cut further the error reads "The answer did not fit in 128,000 output tokens, the most
  claude-sonnet-5 can write in one answer." A draft or second pass that hits its cap gets the same message.
- **Calibration data.** Each Process call record now carries `chunk` and `estimated_output` next to the real
  `output_tokens`, stored on the `processRuns` row. Not exported: session.json has no call records, so there is no
  schema bump.
- **In-progress cards.** New Dexie version 3 with a `processProgress` table keyed `[run_id+chunk]`: one row per
  chunk (status queued, streaming, done or split, and its items so far), written by the service worker as items
  arrive and deleted in the same transaction that stores the finished or failed run. The review page reads it with
  `useLiveQuery` and shows "Part k of n", read-only cards, and a shadcn `Skeleton` placeholder for the item being
  written. The estimate says "in n parts run two at a time". Deleting a Session deletes its progress rows.
- **Interrupted runs.** Process runs only in the service worker, so a run still marked running when a worker starts
  was cut off. The worker marks it failed (`error_code: interrupted`, "Process stopped because the extension
  restarted before it finished. Run it again.") and drops its progress rows. The e2e stops the worker through CDP
  `ServiceWorker.stopAllWorkers`; in practice any worker start after the rows were written sweeps them.
- **Stub.** `tests/support/anthropic-stub.ts` answers `stream: true` with SSE (message_start, text deltas,
  message_delta, message_stop), `deltaChars` per delta and `streamDelayMs` apart, truncates at `max_tokens` or its
  own `maxOutputTokens`, counts `charsPerToken`, and reports the peak number of open requests.
- **e2e seeding.** `tests/e2e/helpers/seed.ts` writes a session.json document straight into IndexedDB, so the
  e2e processes the synthetic 40-minute Session without recording it. Raw IndexedDB writes do not wake Dexie's
  live queries, so seeding happens before the review page opens.

## Feedback batch 1, U2 (2026-09-23)

- **Confirmed diagnosis.** `tests/e2e/highlight.spec.ts` circles `button.cta` (margin 1.3), waits 400 ms and
  scrolls. Before the fix, a 430 px scroll gave a `region` Annotation with no pick, a screenshot at scroll 430 and
  the Strokes at y −227 to −164 in it, all above the image. A 220 px scroll picked `div.hero-card`, with the
  Strokes clipped at the top of the image. Candidates, page context and the screenshot were all taken at close,
  and a scroll close happens after the page moved.
- **Context is read at each Stroke's pointer-up.** The overlay snapshots the open Annotation's Candidates,
  Connector ends and page context then, and asks for its screenshot 120 ms later (`captureAnnotation`), with the
  Strokes held on screen. Later Strokes in the same Annotation refresh both. The close only finalizes and passes
  the shot's id. 120 ms rather than the plan's ~300 ms: the ink is painted by then, and a shorter wait leaves
  less room for a scroll to land first. A page, or any inner container, that scrolled before the shot gets no
  new shot: the Annotation keeps an earlier one or has none (`src/core/annotation-shot.ts`).
- **Every capture re-reads the page after `captureVisibleTab`** and drops the image if the scroll or URL
  changed. Navigation and Snap read the page context right before the capture instead of before the queue.
  Chrome counts every capture call against its per-second quota, so a dropped or failed capture still spends
  the 500 ms window.
- **Annotation screenshots wait instead of reusing.** The `annotation` trigger was `reuse`, so an Annotation
  closing within 500 ms of another screenshot pointed at an image without its own Strokes. It is `defer` now.
  A navigation close still cannot wait: it takes its own shot if it landed, else the page's latest.
- **The review page draws only the cited Annotations' Strokes** on a Change Item's screenshot
  (`src/core/evidence-strokes.ts`). An item citing no Annotation shows all of them.
- **Candidate rule change (P0-4).** The pick is now the element the Strokes enclose: among elements at least 80%
  inside the Annotation bbox that fill at least a quarter of it, the one that fills most. A loose circle around
  the button picks the button, not the card. The old ">= 70% covering" rule stays as the fallback when nothing
  that size is enclosed, as for underlines and scribbles over text. A circle around the whole card still picks
  the card with its children as descendants, so fixture (d) is unchanged. This departs from the PRD's wording
  ("deepest element covering >= 70%"), as asked by the owner's feedback.
- **Known limit: inner scrolling containers.** Pick and screenshot come from pointer-up, so scrolling inside a
  container afterwards no longer moves them. But that scroll does not close the Annotation, since the 25% rule
  reads only the window, and the post-capture check reads only the window scroll.
- **`E2E_PORT_BASE`** (merged from U1) lets parallel checkouts run e2e side by side.

## Feedback batch 1, U1 (2026-09-23)

- **Paused timer.** The panel showed `now − t0`, so it kept counting while paused, and so did the soft caps.
  `activeElapsed` (`src/core/media-time.ts`) subtracts the paused time, from the timeline's pause gaps or from a
  running total. The active Session keeps `paused_ms`, the total of pauses already resumed, and the open pause is
  its existing `paused.t`, so the panel needs no event query. The regression e2e failed first: after 3.5 s paused
  the timer had moved from 2 s to 5 s.
- **Previous Sessions in the panel.** `SessionRow` moved to `src/components/session-row.tsx` with a compact
  variant for the panel: title, origin, date, length and Change Item count, without the size. The idle panel lists
  every Session newest first, not grouped by origin as on the Sessions page. Delete keeps its two steps and stays
  disabled for the Session that is recording.
- **Unzip library: unzipit 2.1.1** (2026-09-19, MIT, ~409k weekly downloads, 168 KB unpacked). The plan expected
  fflate 0.8.3 (2026-05-16, ~57M weekly). fflate's `unzipSync` needs the whole zip in memory and copies each stored
  entry out of it. Its streaming `Unzip` finds the end of an entry written with a data descriptor, which is how
  client-zip writes every entry, by scanning the data for the descriptor's signature. The bytes of a stored WebM or
  PNG can contain that signature. unzipit reads a `Blob` lazily through its central directory and returns a stored
  entry as a `Blob.slice` of the picked file. A long `recording.webm` is never copied into memory, which matches why
  export uses client-zip. `client-zip` itself cannot read zips.
- **Reading a file** (`src/core/session-file.ts`, pure). The first bytes decide: `PK` is a zip, anything else is
  parsed as JSON. In a zip, `session.json` sits at the root, or one folder down when someone re-zipped the
  unpacked export folder. The other files are keyed by their path in the export folder, the same paths
  session.json's `blobs` list.
- **Upgrade shim.** `UPGRADES[v]` turns a version-v document into version v+1, and a file runs every step from its
  version to `SCHEMA_VERSION`, then `SessionDocumentSchema` validates it. Most steps do nothing, because the fields
  they add default. v2→v3 gives a `voice_command` without `t_end` an end at its start. v4→v5 renames
  `draft_action.via` to `source`, and refuses a file with v4 `draft_item`s, which lack the Locations, intent and
  pass v5 needs. A newer version, a version below 1, or a failed validation is refused with a message naming the
  first problems. When a lane bumps the schema, it adds a step. A unit test fails while any version lacks one. The
  real schema v2 capture in `fixtures/sessions/captured` upgrades and validates.
- **Writing it back** (`src/db/session-import.ts`) is the reverse of `loadSessionDocument`, in one Dexie
  transaction over sessions, events, blobs and processRuns.
  - The Session row gets `status: 'ended'`. Events are added in file order.
  - A blob is written only when the file carries its bytes. Media metadata is kept only when its blob came
    along, so a bare session.json restores with no player.
  - `process_run` becomes a `done` run with the generated items. The review edits come back as the `item_edit`
    events they already are. Each other entry of `process_runs` becomes an item-less row, so the failure-rate
    metric survives a round trip. A run exported while `running` is restored as `failed`.
  - Only these four tables are written. Zod strips unknown fields, so a hand-edited file cannot carry a key in,
    and a restore never touches `chrome.storage`.
- **Id clash.** The transaction checks the id first and throws `SessionClashError`. The dialog (shadcn `Dialog`,
  added with the CLI) offers Open existing or Replace. Replace runs `deleteSession` and the import in the same
  transaction, so a failed Replace keeps the stored copy.
- **Known limit: a bare session.json restore cannot be exported or processed again.** session.json requires every
  screenshot it references to be in its blob list, and a JSON-only restore has no screenshot bytes. The review page
  shows its items, transcript and Annotations. Restore the zip for a working copy.
- **`E2E_PORT_BASE`.** The fixture servers used fixed ports (4401 upward), so e2e runs in two checkouts on one
  machine collided with `EADDRINUSE`. `tests/e2e/fixtures.ts` now reads a base port from the environment and
  defaults to 4401.

## Slice 7: hardening and release (2026-09-22)

- **No new dependencies.** Everything uses what was already installed: Dexie, sonner, Zod, the Anthropic SDK and
  Playwright. The privacy harness speaks CDP over Node's built-in WebSocket.
- **Process windows** (`src/core/process/windows.ts`, pure).
  - A Session up to 12 minutes is one window, as before. A longer one splits into `round(length / 10 min)` equal
    cores, at least two. Each window's script also shows the minute of overlap on each side, so an Annotation near
    a boundary keeps its speech.
  - Each Annotation belongs to the window whose core holds its start. Pinned Draft Items go only to that window's
    prompt, so a pin is never duplicated, and they pass through `mergePinnedDrafts` once, after the merge.
  - The merge dedupes only across windows. Two items are the same when they share a subject (the same subject
    Annotation, or the same selector on the same URL, or both page-level on one URL) and a similar intent (the
    same Category, and word overlap of at least 0.5 on title and intent or 0.6 on the transcript). The item from
    the window that owns its subject wins. It never loses an Annotation: if the loser covers Annotations the
    winner does not, the superset wins, and if neither covers the other both are kept. Items are renumbered in
    time order.
  - The screenshot second pass runs after the merge, with the script of the window that produced the item. The
    estimate is the sum over the windows.
- **No silent truncation.** The output gains an optional `dropped_annotations` list: an Annotation number and a
  one-sentence reason. Each window's prompt lists the Annotations it must account for. When windowed, an answer
  that neither uses nor drops one of them is a repair-retry reason. Whatever is still unaccounted after the retry
  is stored as `unaccounted_annotations`, and the review page shows it in amber. A single window keeps the old
  behaviour, with no coverage retry, so short Sessions cost the same.
- **Schema v7.** `session_start.clicked_at` is the Start click's epoch ms, for the Start→recording metric.
  `process_run` gains `windows`, `dropped_annotations` and `unaccounted_annotations`. A top-level `process_runs`
  lists every run with its status and error code, for the processing failure rate. All new fields default, so
  v6 files still read.
- **`pnpm metrics <dir>`** reads every session.json under a folder and prints the PRD §8 leading metrics with
  their targets. A Session counts as free tier when no audio went to a cloud engine and it made no Anthropic
  call: no Draft Items and no Process run. A Session with a saved key that it never used counts as free, because
  session.json cannot tell. The Voice Command false-trigger rate needs labels, so the script reports counts and a
  rate per 10 minutes instead.
- **Session list and warnings.** The list is its own extension page, linked from the panel footer and the
  options header. Size is the sum of a Session's blobs. The Change Item count is the latest successful run with
  review edits applied. Delete removes the Session, its events, blobs and Process runs in one transaction, after
  an inline confirmation, and is disabled while the Session records. Storage uses `navigator.storage.estimate`
  and warns at 80% on the page and in the panel. The soft cap is a sonner toast plus an inline note at 45 and
  60 minutes, and recording continues.
- **Privacy harness** (`tests/e2e/helpers/network-log.ts`). Playwright's request events miss the service worker
  and the offscreen document. The harness connects a second DevTools client through `--remote-debugging-port=0`
  and auto-attaches to every target, pausing each new one until its Network domain is on. A positive control
  fetches a probe URL from the service worker, the offscreen document, the panel, a web page and the review
  page, and the test fails unless all five are seen. A target can be attached twice, so requests are counted
  once per target and request id.
- **Two fallback events for Whisper without a model.** With Whisper picked and no model downloaded, a Session
  logs `whisper → webspeech` (`whisper_model_missing`) and then, in headless Chromium, `webspeech-on-device →
  none`. Both are true, so the privacy test accepts both.
- **One ONNX Runtime wasm.** vad-web imports `onnxruntime-web/wasm` from the root dependency (1.30), which
  shipped its own 14 MB wasm. A Vite `resolveId` plugin sends that import to the onnxruntime-web build that
  transformers.js pins (1.31.0-dev, WebGPU bundle), so the VAD loads `/ort/ort-wasm-simd-threaded.asyncify.wasm`
  like Whisper. vad-web only uses `InferenceSession`, `Tensor` and `env.wasm`, which did not change between
  these versions. `ort-assets.spec` now asserts the VAD fetched only that wasm. The unused legacy Silero model is
  no longer copied. The build went from 49.0 MB to 32.5 MB.
- **Production UI.** The dev overrides never had UI. `prod-ui.spec` loads every extension page of the built
  extension and fails on any text or control that mentions a scripted transcript, a base URL, a stub or
  localhost. It also checks the built manifest and that no dev-server client is bundled. `pnpm zip` packs the
  same build.
- **Fixture server.** A new Playwright worker could reuse its predecessor's ports before the kept-alive sockets
  closed, which failed with EADDRINUSE. Close now drops open connections, and listen retries a busy port for
  up to 10 s.
- **Optional Chromium logs in e2e.** `E2E_CHROME_LOG_DIR=<dir>` writes one Chromium log per test, with
  media-stream and offscreen detail. It is off by default.
- **The microphone flake** ("AbortError: Failed due to shutdown", seen since Slice 5).
  - *Where it happens.* Only the first getUserMedia in a newly created offscreen document is affected. Chromium
    logs (`E2E_CHROME_LOG_DIR`) show the browser opening the fake device and finalizing the request. Within 1 to 3 ms
    comes `MSM::CancelRequest({label})`, which is the renderer's `CloseDevice` for a stream whose page request had
    already failed with `FAILED_DUE_TO_SHUTDOWN`.
  - *What it is not.* The document is not torn down or re-created: a second request from the same frame and
    requester succeeds. Nothing in the extension closes the offscreen document at that moment, and onboarding's
    request never aborted. The likeliest cause is Chromium swapping the new document's media dispatcher host once
    after creation, but the release build compiles out the renderer's logging, so that part is inferred.
  - *Why the first retry looked insufficient.* It covered only the capture path. The ORT self-test's VAD
    (`ort-assets.spec`) and onboarding still called getUserMedia directly, so those failures never reached a retry.
  - *The fix.* All three paths now call `src/lib/get-user-media.ts`, which retries AbortError only, up to 3 times,
    250, 500 and 750 ms apart, and logs each retry. A real user can hit this on Start, and the retry keeps that
    Start from failing.
  - *Evidence.* Under a load average of 40 to 115 with `--workers=2`, ort-assets, shapes, free-tier, stt-tiers and
    drafts ran 8 times each, twice: 192 runs. There were 11 aborts, all on the offscreen document's first request,
    and every one recovered on the first retry. There were no microphone failures. The grantMic symptom, where
    `mic-status` never appears, did not reproduce, and onboarding never aborted. `grantMic` now waits 20 s for
    either the ready note or the page's error, and fails with that error text, so the next occurrence names its
    cause.
  - *Separate flake, not fixed here.* `shapes.spec` "shaft + V" failed twice across the stress runs. The two Strokes
    came out as one, a timing effect on pointer events, not the microphone.
- **Word times after the end of the Session** (found by the same stress runs). The PCM graph anchored frame
  times to the arrival of the first worklet message. A message delayed by a busy main thread made every word
  late, once 51 ms past `session_end`. The anchor now subtracts how far the AudioContext's clock had run past
  the frame when the message arrived.
- **Soft-cap e2e.** The test moves the Session's clock by writing storage from the service worker. A concurrent
  update of the active Session could undo that write, so the test re-applies it until the timer shows it.

## Slice 6: transcription tiers (2026-09-22)

- **Dependencies.**
  - `@deepgram/sdk` 5.12.0 and `@elevenlabs/client` 1.25.0, as the PLAN names them. Both are pinned
    exactly, because both change their wire details between minors.
  - `ws` and `@types/ws` as dev dependencies. The vendor stubs in `tests/support/stt-stubs.ts` need a
    WebSocket server, and the Deepgram SDK uses `ws` when the unit tests run it in Node.
  - ElevenLabs batch uses plain `fetch` with multipart. `@elevenlabs/client` is the browser realtime client
    and has no batch call. The Node SDK would add weight for one request.
- **Schema v6.**
  - A segment carries `run_id`: null for the live run, or the id of a re-transcription.
  - `transcription_run` records a re-run: engine, model, and segment count.
  - `transcript_select` records a switch between runs.
  - session.json checks that every `run_id` names a known run.
- **One shared 16 kHz PCM graph** in the offscreen document (`src/entrypoints/offscreen/pcm.ts`,
  `public/worklets/pcm16-worklet.js`).
  - The graph is `AudioContext({sampleRate: 16000})` with a worklet that emits 100 ms PCM16 frames. The
    browser does the resampling.
  - It starts only when a streaming tier asks for it. MediaRecorder and vad-web keep their own graphs on the
    same stream. The PLAN's "shared graph" means shared across tiers, not across those consumers.
  - Frames are stamped with the Session time of their first sample. The time comes from the worklet's
    frame index, anchored when the first frame arrives.
- **Word times go through the frames actually sent** (`src/core/audio-offsets.ts`).
  - Each connection keeps an offset map from "seconds of audio this socket received" to the Session time
    of those frames.
  - A pause stops sending, so the map jumps over the gap on its own. Frames replayed after a reconnect are
    stamped with their capture time. This is the same result `media-time.ts` gives for the recording.
  - Batch runs use `mediaToSession` with the recording's start offset and pause gaps.
- **Deepgram auth.**
  - Each connection mints a 60 s JWT with `POST /v1/auth/grant` and opens the socket with the `bearer`
    subprotocol. The stored key never goes on the socket.
  - A 403 means the key lacks the Member role. The adapter then uses the key itself on the `token`
    subprotocol, which is the SDK's browser path, and the options Test says so.
  - A 401 ends the tier at once, with no retries.
  - Batch re-transcription sends the key as `Authorization: Token`. It is a single REST call from an
    extension page.
- **ElevenLabs auth.** A single-use token comes from `POST /v1/single-use-token/realtime_scribe` for every
  connection, because each token is spent on use.
- **ElevenLabs word times.** The docs do not say whether committed word times count from the connection or
  from the commit. The adapter treats them as connection-relative. It switches to commit-relative when a
  commit's first word starts before the previous commit's end. The stub is connection-relative. Manual
  check C9 step 6 settles it with a real key.
- **Retry and fallback** (`src/adapters/transcription/streaming.ts`, a state machine tested with fake
  timers).
  - A dropped socket is retried 3 times, after 500 ms, 1 s and 2 s. The fourth failure falls back.
  - The failure count resets after 30 s of stable connection, so occasional drops over a long Session do
    not add up.
  - Frames are buffered while reconnecting, up to 30 s, and replayed.
  - The fallback is the free default: on-device Web Speech, or server speech only with the Slice 1 opt-in,
    or no captions.
  - One `transcription_fallback {from, to, reason}` is logged. The fallback adapter's own event is
    suppressed, so a paid tier falling to "no captions" logs one event, not two.
  - Pause closes the socket. Resume opens a new one.
  - A paid tier with no key saved starts on the free default and logs `reason: no_key`. It does not refuse
    to start.
- **Local Whisper.**
  - It transcribes each vad-web speech span, in order, so captions lag by about one span.
  - base and small run q8 on WASM. The turbo model runs q4 on WebGPU only, and options hides it without
    WebGPU.
  - transformers.js's WebGPU entry (onnxruntime-web 1.31) loads the same asyncify `.mjs` and `.wasm` pair
    as WASM, so WebGPU needs no extra ORT files.
  - Weights download only from the options page. Sessions and re-runs read the cache with
    `allowRemoteModels` off. transformers.js refuses any lookup with both local and remote models off. So
    "local" points at a path the extension does not have, and a cache miss ends in a 404 on
    `chrome-extension://`. `pnpm test:e2e:whisper` found this: every Whisper Session had been falling back.
  - A missing model, a VAD that failed to load, or a failed load falls back like a paid tier does. The
    reason names the missing files.
- **ORT wasm dedupe.** A pre-build Vite plugin in `wxt.config.ts` points onnxruntime-web's
  `new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url)` at `/ort/`. Without it the bundle
  carried a second 27 MB copy under `assets/`.

  | Build | Size |
  | --- | --- |
  | Before | 75.8 MB |
  | After | 49.0 MB |

- **Runs, and edits scoped to them** (`src/core/transcription-runs.ts`).
  - A re-transcription appends a new run and makes it active. Nothing is replaced.
  - The latest `transcription_run` or `transcript_select` names the active run. With neither, the live
    run is active.
  - The review page, Process, the second pass and review.md read only the active run.
  - Edits are keyed by segment id, and every run has its own ids, so an edit belongs to the run it was made
    on.
  - Voice Commands were matched on the live run. In a re-run, the words spoken inside each command's span,
    padded by 250 ms, are cut, so commands never reach Process as content.
  - Batch words are grouped into segments at sentence ends, at pauses of 800 ms or more, or at 15 s.
    Deepgram's own utterances are used when present.
- **Re-transcription runs in the review page**, not the service worker. It needs the audio blob, a
  transformers.js pipeline for Whisper and an `OfflineAudioContext` to decode to 16 kHz, and it is a
  foreground action the reviewer waits on. It is off when the media was deleted.
- **Test hooks.** `devOverrides` gains `deepgramBaseUrl`, `elevenlabsBaseUrl` and `sttRetryBaseMs`. These
  override both REST and WebSocket hosts. There is no UI for them.
- **Evals.**
  - `pnpm eval` now runs only the Process eval.
  - `pnpm eval:stt` runs every fixture WAV through both vendors, streaming and batch, and asserts
    word error rate (WER) ≤ 0.25 and word timing. It skips each vendor without its key.
  - `pnpm test:e2e:whisper` is opt-in and needs the network.
- **Known flake, not from this slice.** `free-tier.spec` sometimes fails to open the microphone with
  "AbortError: Failed due to shutdown". It failed 1 in 3 runs on the Slice 5 commit too.

## Slice 5: live Draft Items (2026-09-22)

- **No new dependencies.** The pass uses the SDK, Zod and Dexie already in place.
- **Schema v5.** The v4 `draft_item` had only `title`, `category`, `location_names` and `annotation_ids`. It
  now carries `pass_id`, `model`, `intent`, `transcript` and `locations`. Each Location has a role, an element
  name, the chosen `selector` and the Annotation number. `annotation_ids` lists the Annotations the draft
  covers. `draft_action` says `source` (click | voice) where v4 said `via`.
  - `intent`, `transcript` and `selector` go beyond the brief's "Location summary". They let Process turn a
    pinned draft into a Change Item in code when the model leaves it out.
  - session.json checks that drafts cover known Annotations and that actions name a known draft.
  - `LocationRole` moved to `timeline.ts`, and `change-item.ts` re-exports it.
- **Draft state is the `draft_action` log, and the latest action wins** (`src/core/drafts.ts`).
  - A pinned draft can still be discarded, by click or by "scratch that". A discarded one can be pinned
    again by click.
  - "pin that" takes the latest draft that is neither pinned nor discarded.
  - A voice action is logged twice: the `voice_command` with its target, then a `draft_action` with source
    `voice`. Only the `draft_action` decides state.
- **When a pass runs** (`src/core/draft-trigger.ts`, pure, tested with a fake clock).
  - *Annotation trigger.* An Annotation closed since the last pass, then 3 s of silence. The silence is
    counted from the latest of three moments: the Annotation's close, a VAD speech end, or a transcript
    segment's arrival. Each one restarts the wait, so a burst becomes one pass. While the VAD says someone is
    speaking, nothing fires. The offscreen document now also sends `speechStart` so the worker knows.
  - *Fallback.* Speech with no Annotation, 30 s after the last pass or the Start. It also waits until nobody is
    speaking.
  - *One pass at a time.* Signals that arrive during a pass set the flags again, so at most one more pass
    follows it.
  - *Pause.* A pause resets the speaking flag and holds passes until Resume. The flags are kept.
  - *Without VAD.* Only segment arrivals count, and "speaking" is never set.
- **The service worker loop** (`src/background/drafts.ts`).
  - It follows `activeSession` through `watch`, and a 500 ms tick polls the trigger. Drafts are enabled at Start
    when a key is saved. A key added mid-Session takes effect at the next Start. A key removed mid-Session makes
    passes skip without a note.
  - *Since the previous pass* means events with a Dexie `seq` above the cursor. The cursor advances only when a
    pass succeeds, so a failed pass's events go into the next one.
  - After a worker restart the cursor falls back to the `seq` of the last Draft Item written.
  - A pass with no new Annotation and no new speech makes no call. A Voice Command phrase alone does not count
    as speech, because the builder strips it.
  - Draft Items are stamped `t = max(now, covered Annotation t_end + 1)`, so they are always newer than what
    they cover. Ids are `d1`, `d2`, … across the Session. `pass_id` is a UUID.
  - A result that lands after Stop, or for another Session, is dropped. Stop does not run a final pass,
    because Process covers the end.
  - A failure sets `drafts.note` on the active Session, and the panel shows it as an amber note. Capture goes
    on. There is no retry timer; the next triggered pass retries.
- **The draft prompt** (`src/core/process/draft.ts`).
  - It shares `renderEvents` with Process, so its lines are the §7 format. It renders only the events since the
    previous pass, but walks the whole timeline, so scrolls, aliases and discards stay right.
  - Drafts, actions and Voice Commands are left out of NEW EVENTS. A RECENT DRAFT ITEMS section lists the last 2
    drafts with their state.
  - The prompt is text only. The system prompt is short and marked cacheable.
  - The output holds at most 5 items, each with at least one `subject`. The Session check rejects Annotation
    numbers that do not exist or were scratched, and one repair retry follows.
  - Output is capped at 2,000 tokens. Model: the Draft model setting (default `claude-haiku-4-5-20251001`).
  - A pass only adds drafts. It never revises an earlier one: that is Process's job.
- **The adapter** now has one call path, `attempt` and `withRepair` over any `{items: [...]}` schema. Process,
  the second pass and `draft()` all use it. The stub tells a draft request apart by its system prompt
  (`isDraftRequest`).
- **Pinned drafts in Process.**
  - *Prompt.* After the timeline, a PINNED DRAFT ITEMS section lists each pinned draft with its intent and
    Locations, as fixed items. A REJECTED DRAFT ITEMS section lists discarded ones as "the reviewer rejected:
    …". Each DRAFT line in the timeline also shows its Locations.
  - *Code* (`src/core/process/pins.ts`, run right after the main call). A draft's cover is its set of
    Annotation numbers.
  - A model item marked pinned with the same cover is kept, with the draft's title, category and intent. For a
    draft with no Annotation, the model item must have no Annotation and the same title. The kept item's
    confidence is raised to at least 0.6 and its ambiguity dropped, because the reviewer confirmed it.
  - Otherwise the draft is converted in code and inserted in time order. The converted item gets the
    Annotations' URLs, screenshots and time range, an agent prompt that cites every screenshot, and confidence
    1.
  - Every other item with exactly the same cover is dropped as a rewrite. An item that only overlaps the cover
    stays. A pin the model invents is removed.
  - Pinned items skip the screenshot second pass. The run records `pins_converted` and `pins_dropped`.
- **Pins and `item_edit`.** Pins live on the timeline and belong to the Session. Edits are keyed by `run_id` and
  belong to one run.
  - Every Process run applies the pins again. An edit of a pinned item on the review page applies to that run
    only. Process again restores the draft's title and category.
  - The reviewer can still edit, merge or delete a pinned item. The edit is logged and counts against the
    acceptance rate, like any other item.
  - Merging keeps `pinned` if either item was pinned. That rule already existed.
- **Panel.** Draft Item cards show the title, the Category and each Location as "Role: element (#n)", newest
  first.
  - Discard and Pin are disabled for the card's current state. Pinned cards get a border, and discarded ones
    are dimmed and struck through. The state line says "by voice" when voice set it.
  - Without a key, Annotation cards show the screenshot thumbnail, the geometric pick ("name" selector) and the
    speech paired by `pairSegment` in the Session's window, with command phrases stripped. Scratched cards are
    dimmed.
  - `useBlobUrl` moved to `src/lib/use-blob-url.ts`.
- **Review page.** A Draft Items list sits beside the Annotations. Each draft shows its state and whether a click
  or voice set it, and discarded ones are dimmed. Pinned Change Items carry `data-pinned` and a "pinned" badge.
- **P0-15 notice.** It now says that during every Session the transcript and element descriptions go to
  Anthropic every few seconds for Draft Items. Screenshots never go with Draft Items. Removing the key stops
  them.
- **Metric.** `pnpm validate:session` prints drafts, pinned and discarded counts, discards by click and by
  voice, the discard rate, and pinned Change Items.
- **Harness fixes.** The audio fixture guard misread gaps of 10 s or longer. `raw-cdp` now retries removing
  the profile, because `inject.spec` failed with `ENOTEMPTY` while Chromium was still exiting. In 30 repeat
  runs after the fix, one `inject.spec` run still timed out, with no message captured.
- **Not done.**
  - No live eval of the Draft model, because there is no key here. C8 in manual-checks covers it.
  - The panel shows no running cost for draft passes.
  - Passes are not windowed. Each one sends only new events, so its size stays bounded.

## Slice 4: video, evidence, editing, export (2026-09-22)

- **Dependencies.** The PLAN's `ts-ebml` 3.0.2, `client-zip` 2.5.1 and `@dnd-kit/react` 0.5.0. One addition beyond
  the PLAN: `buffer` 6.0.3. ts-ebml calls Node's global `Buffer` at run time, and extension contexts have none, so
  `src/media/buffer-global.ts` installs it before ts-ebml loads. shadcn's Textarea and Input were copied in by hand
  (`src/components/ui`), with no new package.
- **`ebml` is aliased to its UMD build** in `wxt.config.ts`. ts-ebml requires `ebml`, whose `browser` field points
  at an IIFE file that exports nothing once bundled. The UMD file of the same version exports the same API.
- **Video recorder.**
  - Start calls `getDisplayMedia` first: `displaySurface: 'browser'`, `width ≤ 1280`, `frameRate ≤ 15`,
    `selfBrowserSurface`, `surfaceSwitching` and `monitorTypeSurfaces` all `exclude`, no audio.
  - A cancelled picker rejects with `NotAllowedError`. The Session then starts with `video_off_reason:
    picker_cancelled` and the panel says "Video off". Other failures are `failed`; no `getDisplayMedia` is
    `unavailable`.
  - The recorder runs at 1.2 Mbit/s, about 270 MB for 30 minutes, and writes a `video_chunk` blob every 1 s. Closing
    the panel loses at most about a second.
  - The start offset is the recorder's `onstart` time minus t0. The panel reports it with `videoStatus`, and the
    service worker keeps it in the active Session.
  - The recorder pauses and resumes by watching the active Session, so button and voice pauses both reach it.
  - Chrome labels a captured tab `web-contents-media-stream://…`, so the panel says "Video: the tab you picked".
    ADR 0002 already says the tab cannot be identified.
  - "Stop sharing" in Chrome's bar ends the video only. The Session goes on and the panel says so.
- **Closing the panel is Stop, through a Port.** The panel opens `chrome.runtime.connect({name: 'panel'})` and,
  after Start, registers as the Session's owner. When the owner's Port disconnects, the service worker runs
  `stopSession('panel_closed')`. The panel reconnects and registers again if the worker restarts, and pings every
  20 s. On `pagehide` it calls `requestData()`, but the document may die before that chunk is written.
- **Stop asks the owning panel to flush.** The worker posts `flush_video` on the Port and waits up to 8 s for
  `video_flushed`. Then it joins the chunks, rewrites the header with ts-ebml (duration, SeekHead, Cues), stores one
  `video` blob and deletes the chunks. This runs in the service worker. If ts-ebml throws, the joined file is kept
  with `seekable: false`. With no chunks at all, `video` is null and `video_off_reason` is `failed`.
- **Media time and Session time.** Chromium's MediaRecorder leaves no gap for a pause, so `src/core/media-time.ts`
  maps Session time to media time. It subtracts the recorder's start offset and the paused time before that point.
  A time inside a pause maps to where the pause began. The review player, the transcript seek buttons and
  review.md's links all use it, for video and for audio.
- **Schema v4. Review edits are appended events.** The log stays append-only.
  - `transcript_edit` has `segment_id`, `text` and `edited_at`. The latest edit of a segment wins.
  - `item_edit` has `run_id`, `edited_at` and one `edit`: `edit`, `delete`, `merge`, `split` or `reorder`.
  - Both are stamped with `t` = the Session's duration, after `session_end`, in the order made. The review page
    writes them (`src/db/review.ts`), only for an ended Session. The service worker still writes every capture
    event.
  - `src/core/review-edits.ts` folds them in. Process reads edited segment text. An edited segment loses its word
    timings, so pairing treats it as one span.
  - session.json's `change_items` is now the latest run with its edits applied, in review order: unsure items
    first, then the reviewer's order. It was the model's order before. `process.spec` was updated to match.
  - `process_run` holds the generated items and the acceptance rate. Only an item exported with no edit counts as
    accepted: an edit, delete, merge or split counts against the item, and a reorder does not. A split copy
    counts against its original.
  - Edits belong to one run. Process again starts from the new run's items, and the confirmation says so.
    Transcript edits carry over.
  - Also new in v4: `SessionInfo.video_off_reason` and `media_deleted_at`, the `video_chunk` blob kind, and
    `media.video`.
- **Merge and split.** Merge keeps the first item's id, title and category. It unions Locations and Evidence
  screenshots and spans both video ranges. It joins the intents, the transcripts and both agent prompts, so every
  evidence screenshot stays cited. Confidence is the lower of the two. Split inserts a copy under the next free
  `item_NNNN` right after the original, to be edited. Editing a title, intent or category does not rewrite the
  agent prompt; the edit form says so.
- **Review page layout.** The item list is on the left. The right pane holds the recording (video, or the audio when
  video is off) and the selected item's screenshots with the Stroke overlay. Selecting an item seeks the recording
  to `evidence.video.start`. Drag uses @dnd-kit/react with its keyboard sensor. Two ticked items can be merged.
  `process.spec` now reads the overlay from the evidence pane.
- **Export.**
  - `src/core/export/bundle.ts` plans the folder: review.md, session.json, audio.webm, recording.webm (only with
    video) and every referenced screenshot. A screenshot counts as referenced when a screenshot event, an
    Annotation, or a Change Item's Locations, Evidence or agent prompt names it.
  - Export is refused with the reasons if a referenced screenshot has no image, or an agent prompt cites a path
    the folder lacks.
  - review.md links each item's time range as `recording.webm#t=<start>,<end>` in media time. It uses the audio
    without video, and plain Session time without media.
  - The review page builds the zip with client-zip and saves the Blob's object URL through `chrome.downloads`. The
    URL is revoked when the download completes or is interrupted. The zip is named
    `review-<date>-<start page>.zip`.
- **Deleting media after an export** removes the audio, video and any leftover chunks. It sets `audio` and `video` to
  null and records `media_deleted_at`. The transcript, Annotations, screenshots and Change Items stay.
- **Picker tests.** Through the panel's Start click, `--auto-select-tab-capture-source-by-title` picks the tab in
  headless Chromium. With no matching tab the picker waits forever. `--auto-reject-this-tab-capture` only covers
  `preferCurrentTab` requests. So the cancel test makes the panel's `getDisplayMedia` reject with
  `NotAllowedError`, as Chrome's Cancel does. `page.evaluate` calls to `getDisplayMedia` fail with
  `InvalidStateError` in this harness, while a real click works.
- **Not done.** The speech track on a scrubber (optional) and "re-transcribe with…" (Slice 6) are not built.

## Slice 3: understanding signals (2026-09-22)

- **Four new dependencies, all named by the PLAN.** They are `fuzzball` 2.2.6 for `token_set_ratio`,
  `double-metaphone` 2.0.1, `compromise` 14.17.0 and `sonner` 2.0.8. `@ricky0123/vad-web` was already
  bundled for the Slice 0 spike. Nothing else was added.
- **Silence comes from vad-web, not an AudioWorklet level detector.** PRD P0-8 names a level detector, but the
  PLAN and the Slice 3 brief name vad-web. Silero v5 runs in the offscreen document on a clone of the mic
  stream. Its per-frame probability goes through `onFrameProcessed` into our own hysteresis tracker
  (`src/core/speech-activity.ts`). vad-web's `onSpeechEnd` is not used: it pads speech and drops short
  misfires, and we need raw edges on the Session clock. The tracker starts speech at 0.5, ends it below 0.35,
  and uses a 90 ms minimum and a 160 ms hangover.
- **"About 1 s of silence" is 800 ms.** The command watcher joins speech spans separated by less than 800 ms
  into islands. A command needs its own island, with 800 ms of silence on both sides, and is confirmed 250 ms
  after that silence ends. VAD edge padding eats about 200 ms of a real 1 s pause, so 1000 ms missed commands
  spoken with a natural pause.
- **How a phrase is tied to its island depends on timestamp quality.**
  - *Word-level:* the island must match the phrase's words within 350 ms at each edge.
  - *Approximate (Web Speech):* a segment is stamped on arrival, so words cannot be placed. The command must be
    the whole final segment. The island must end at most 1.5 s before the segment's first result arrived. The
    island must also be no longer than `700 + 600 × words` ms, which rejects "the video should pause here" said
    as one breath. Unconfirmed segments are dropped after 8 s.
  - Matching normalizes with compromise, which drops fillers and spells numbers. It then takes the best
    `token_set_ratio` of at least 85 over a window the phrase's length, with a double-metaphone fallback per
    word. "resumes" scores 92 against "resume" and is accepted: it is short, isolated speech either way.
- **Command phrases are stripped from SPEECH by `segment_id`** in the Process script, and the ANNOTATION line
  shows `DISCARDED by the reviewer` for a scratched one. The timeline still keeps the raw segment, because the
  event log is append-only.
- **Scratch that and pin that resolve a target, recorded on the event.** `voice_command` gains `target`
  (`{kind: 'annotation' | 'draft_item', id}`, default null) and `t_end`. `resolveScratchTarget` in
  `src/core/voice-command-effects.ts` already considers Draft Items: the newer of the latest Draft Item and the
  latest Annotation wins. `resolvePinTarget` returns only Draft Items, so pin that is logged with no target
  until Slice 5.
- **Schema v3.** It adds Annotation `connector`, the close reason `pause`, `via` on `session_pause` and
  `session_resume` (default `button`), `voice_command.t_end` and `target`, and a new `speech_activity` event
  (`t`, `t_end`). `speech_activity` is beyond P0-9's event list. It records each VAD speech span so a session.json
  shows why a command was or was not accepted, and so Slice 4 can show speech on the scrubber. It is not logged
  while paused.
- **Strokes are sent when their Annotation closes.** Before, each Stroke was sent on pointer-up. Now the content
  script holds them until the group closes, so `detectConnector` can see the whole group and set each Stroke's
  `shape`. A two-Stroke arrow marks both Strokes `arrow`. The Stroke's own `t` is unchanged.
- **Shapes.** Only single-Stroke arrows and a straight shaft plus a V are detected. Three-Stroke arrows, one barb
  per Stroke, and curved shafts are `freeform`. The V's tip is the point farthest from both of its ends, not the
  sharpest turn: jitter at a narrow V's corner fell under the 105° turn threshold in the browser.
- **Grouping signals.**
  - *Scroll:* a Stroke drawn after the page scrolled more than 25% of the viewport, on either axis, from the
    group's first Stroke closes the old group. A scroll with no new Stroke closes it on the scroll event.
  - *Speech Boundary:* a final segment closes the open Annotation only if the Annotation began before the
    boundary. For word-level segments the boundary is the last demonstrative or sentence start, else the
    segment's `t`.
  - *Navigation:* `pagehide` closes the group synchronously, so the Annotation is sent before the page goes.
  - *Draw toggle:* only draw mode turning off closes. Releasing Shift after hold-Shift drawing does not.
  - *Pause:* closes the group with the new reason `pause`.
- **Screenshot throttle policy per trigger.** There is one shared 500 ms window. Annotation reuses the last
  shot, click drops, and navigation, voice command and panel wait for the window to end. Requests run in one
  queue. An Annotation closed by navigation cannot be shot, because its page is gone. It takes the latest
  screenshot of its URL taken since it began, which is usually the click on the link. It waits for that click's
  screenshot first.
- **Screenshots only while the Session tab is visible.** `captureVisibleTab` shoots whatever is showing. While
  the reviewer looks at another tab the Session keeps recording Strokes, clicks and speech from its own tab, but
  a screenshot request is skipped (`screenshot_id: null`). The panel says so in the "Go back" note.
- **Keystrokes are not captured.** Only clicks on interactive elements (links, buttons, form controls, ARIA
  roles) are logged, with no typed text.
- **The click screenshot is taken at the press.** A link click navigates on release, and on a fast site the next
  page commits within about 20 ms, before a click-time capture lands. The content script therefore asks for the
  `click` screenshot on `pointerdown` over an interactive element, and logs the `click` event on click. A click
  with no press in the previous 2 s, such as keyboard activation, is shot at click time. A click shot whose tab
  has already moved to another URL is dropped rather than saved under the wrong page. The navigation's own
  screenshot waits for pending click shots. A press that never becomes a click can leave a `click` screenshot
  with no `click` event. The e2e test presses for 120 ms, as a person does.
- **The Session follows its tab.** A completed load or an in-page URL change is a navigation: logged, then
  screenshotted. The manifest's content script usually arrives by itself. The service worker checks four
  times, 400 ms apart, before injecting one with `scripting`, so a page never gets two overlays. The first
  load of the start page is not a navigation.
- **Pause.**
  - It pauses the MediaRecorder, stops page capture and closes the open Annotation.
  - On-device recognition keeps running so the watcher can hear "resume". Its segments are not logged while
    paused.
  - Server speech is paused, because audio should not go to Google while paused. Voice resume is then
    unavailable and the panel's Resume button is the way back.
  - The voice-pause toast reads "Paused by voice" with an Undo action for 2 s. The brief's em-dash text is split
    into message and action.
  - Stop while paused logs a balancing `session_resume`.
  - *Note for Slice 4:* after a pause, media time no longer equals Session time. The paused gaps are the
    `session_pause`/`session_resume` pairs, and a player must subtract them.
- **Voice Commands need live captions.** With captions off (no on-device pack, no server opt-in) the panel
  says "Voice Commands are unavailable. Voice Commands need live captions." If vad-web fails to load it says
  silence detection could not load.

## Slice 2: Process to Change Items (2026-09-22)

- **One new dependency, the PLAN's `@anthropic-ai/sdk`.** Installed 0.127.0: 0.128.0 was published the same
  day and pnpm's release-age hold kept it back. `messages.parse`, `zodOutputFormat` from
  `@anthropic-ai/sdk/helpers/zod`, `countTokens` and the error classes were checked against 0.127.0's types
  and source. Nothing else was added.
- **Fourth Candidate relation, `descendant`.** These are elements under the pick that the grid or Stroke samples
  hit and that lie at least 80% inside the Annotation bbox. At most 8 are kept, largest coverage first. A loose
  circle around the hero card now lists `button.cta` as a Candidate.
- **Candidates also record `classes`.** These are at most 8 class names, with generated and utility classes
  removed by the selector blacklist. They are the "appearance" in P0-4. `#plan-basic` is a `.card`, and a link
  styled `.btn` counts as a button. Both changes shipped under `SCHEMA_VERSION` 2, and `classes` defaults to `[]`.
- **Noun matching is a hint, not a decision.** The English tables in `src/core/process/locale/en.ts` annotate
  the script. Each Candidate gets the nouns it can answer to, from its tag, role and own class or id names
  (never an ancestor's part of the selector). Each speech segment gets its demonstratives, the Annotations
  inside the pairing window, and the nouns spoken. The model makes the pick. The system prompt carries the
  same tables and the rules.
- **Screenshot aliases in the prompt.** Screenshots appear as `s1`, `s2`, … in capture order, so the model
  never copies a UUID. The adapter checks that every alias and Annotation number it gets back exists. It then
  restores the stored ids everywhere, including the `screenshots/<id>.png` citations in `agent_prompt`. Stored
  and exported items cite the real export path.
- **Change Items live in a new Dexie table, `processRuns` (db version 2), not in `events`.** They are derived,
  re-runnable output, not timeline facts, and P0-9 lists no such event type. Each run stores its status, model,
  estimate, items, call usage and error. The review page and session.json use the latest `done` run. A failed
  run is recorded and changes nothing else.
- **Process runs in the service worker, and the review page keeps it alive.** The page sends `keepAlive` every
  20 s while a run is pending, because a Sonnet call can outlast the worker's 30 s idle timeout.
- **`messages.parse` and one repair retry.** The `zodOutputFormat` object is wrapped so the raw answer is kept
  when the SDK's parse step throws. The repair turn replays that raw answer as the assistant message, followed
  by a user message that lists the issues. Three kinds of issue trigger it: invalid JSON, a Zod issue, or a
  Session check (unknown screenshot or Annotation). The SDK's schema transform turns enums, bounds and
  defaults into descriptions, so Zod is what enforces them. It also enforces the rules structured output
  cannot express: `ambiguity` below confidence 0.6, at least one `subject`, and `agent_prompt` citing every
  evidence screenshot. A second failure fails the run with `invalid_output`. `refusal` and `max_tokens` stop
  reasons fail at once.
- **Low-confidence second pass.** Each item under 0.6 is re-sent as its own request. The request holds the item's
  evidence screenshots as base64 image blocks from Dexie, then the script and the item. The answer replaces
  the item, keeping its `id` and `pinned`. When no screenshot bytes exist, the item is kept as is.
- **Cost estimate.** `countTokens` on the system prompt, the script and the output schema gives the input
  tokens. Output is estimated as 600 + 700 per expected item, where an item is one per Annotation or per two
  segments. The price table in `src/core/process/cost.ts` is dated 2026-06-24 and cites the claude-api skill's
  model table. Unknown model IDs show "price unknown". The estimate leaves out the second pass, and the
  confirmation says so.
- **The system prompt is marked `cache_control: ephemeral`.** It does not depend on the Session, so repair and
  second-pass calls can reuse it.
- **Options page.** The key is a password field saved to `storage.local`, shown back only masked. The Process
  model defaults to `claude-sonnet-5` and the Draft model to `claude-haiku-4-5-20251001`, and either can be any
  ID. Test runs a free `countTokens` on the Process model and a 1-token message on the Draft model. The P0-15
  Anthropic notice appears the first time a key is saved and never again.
- **`anthropicBaseUrl` is a dev override** in `devOverrides`, with no UI, like the scripted transcript. The e2e
  test points it at `tests/support/anthropic-stub.ts`. In Node the SDK also honors `ANTHROPIC_BASE_URL`.
- **Review page overlay.** Screenshots are taken with the ink still on screen, so the SVG overlay draws the
  Stroke outlines in orange on top to make them stand out. It uses the same perfect-freehand settings, in the
  screenshot's viewport coordinates (page point minus scroll, viewBox = viewport).
- **Session fixtures are generated.** `tests/e2e/fixture-capture.spec.ts` (gated by `CAPTURE_FIXTURES`) draws
  on the fixture site and saves real Annotations. `pnpm fixtures:sessions` re-times them and adds hand-written
  speech. Word mode has word timings. Approximate mode has whole segments stamped 800 ms late, with no words.
  `fixtures/sessions/expected.json` holds what `pnpm eval` asserts. Fixture (a) has no scroll between A and B,
  because both marks fit one viewport. Fixture (c), the arrow Connector, waits for shape recognition in Slice 3.
- **`pnpm eval` runs through Vitest** (`vitest.eval.config.ts`), so the `@/` imports resolve in Node. It loads
  `.env` with `process.loadEnvFile`. The fixtures carry no screenshot bytes, so the eval never makes the
  second pass.
- **Harness fix.** `RawChromium.extensionServiceWorker` skips workers whose `chrome` is not ready yet. The inject
  test was flaky on that.

## Slice 1: capture spine (2026-09-22)

- **No dependencies beyond the PLAN.** Slice 1 added the PLAN's @webext-core/messaging, @wxt-dev/storage,
  dexie, dexie-react-hooks, zod, perfect-freehand, css-selector-generator, dom-accessibility-api and
  fix-webm-duration, and nothing else.
- **`t` of span events is the span start.** Strokes, Annotations and transcript segments carry `t` (start)
  and `t_end`. The event log sorts by `t`, then append order. An Annotation's screenshot event is stamped
  when it was captured, so it sorts after the Annotation.
- **Strokes are held on screen until their Annotation's screenshot is taken.** The PRD asks for both a fade
  at 1–5 s after pointer-up and a screenshot "with the Strokes still visible", taken when the 1.5 s gap
  closes the Annotation. With a 1 s fade those conflict. Ink therefore fades at the later of pointer-up +
  fade and the moment the screenshot is confirmed.
- **Grouping runs in the content script and ranking runs in the service worker.** The content script owns
  the pointer and the DOM, so it groups Strokes and snapshots elements. The service worker ranks the
  snapshots with `src/core/candidates.ts` and records the `annotation` event. Grouping is a pure state
  machine with a `signal` input, so Slice 3's scroll, navigation, Speech Boundary, toggle and `next` signals
  plug in without changing it. Stop sends a `session_end` signal so an open Annotation is never lost.
- **Candidate rule as written in P0-4.** The pick must cover at least 70% of the Annotation bbox. A tight
  circle therefore picks the button. A loose one, where the button covers less than 70%, picks the
  enclosing card, and the button is then not a Candidate at all, because the button is a child, not an
  ancestor or a sibling. Slice 2's fixture (d) needs the button reachable from a loose circle too.
  Recommendation for Slice 2: add "enclosed descendants hit by the grid" as a fourth Candidate relation.
- **Region fallback** covers three cases: nothing overlaps, only `html` or `body` is under the Annotation,
  or the pick is a `canvas`, `iframe`, `frame`, `embed` or `object`. `html` and `body` are never Candidates.
- **Selectors.** A unique `data-testid` wins, then a unique human-looking id, then css-selector-generator.
  The generator tries class-only selectors first, so the result is `button.cta` rather than a bare
  `button` that happens to be unique today. Then it tries attribute, then combinations. Hashed CSS-in-JS
  and CSS-module classes, Tailwind utilities and noisy attributes are blacklisted. The library's
  `ignoreGeneratedClassNames` heuristic is off, because it rejects real short names such as `cta`. The last
  resort is a readable `html > body > … :nth-of-type()` path.
- **Mic grant gate.** Onboarding sets `micGranted` in `storage.local` after `getUserMedia` succeeds in its
  visible tab. The panel and the service worker both refuse Start without it. The panel also blocks Start
  when `navigator.permissions` reports `denied`. The flag is the source of truth because in automation
  the permission reads `prompt` even after a successful grant (Slice 0 a1).
- **Target tab.** Start binds to the active web page in the last focused window. If that is not a web page,
  as when `sidepanel.html` runs as a tab in tests, it binds to the most recently used web page.
- **Web Speech is on-device only unless the reviewer opts in** (revised after the first Slice 1 review).
  Recognition starts with `processLocally: true`, and only when `available()` reports `available`. Without
  that, by default no `SpeechRecognition` is constructed at all. The Session still records audio, Strokes
  and screenshots with no live captions. A `transcription_fallback` event is logged
  (`from: webspeech-on-device`, `to: none`, `reason: on_device_unavailable`), and the panel explains this and
  offers the language-pack `install()`. Onboarding offers the install too. The same applies when on-device
  start fails with `language-not-supported`. The opt-in setting "Allow Chrome server speech recognition when
  on-device is unavailable" (`allowServerSpeech`, default off, on the onboarding page) restores the server
  fallback. Its one-line notice says audio goes to Google. With it on, segments are marked `local: false`,
  the fallback event says `to: webspeech-server`, and the panel says so during the Session. Unit tests
  assert that with the default no recognizer is ever started. Reason: P0-15's zero-network free tier.
  Captions can be installed mid-Session but take effect at the next Start.
- **Audio chunks are merged on Stop.** 30 s chunks go to Dexie while recording. On Stop they are joined,
  fix-webm-duration writes the duration header, the result is stored as one `audio` blob, and the chunks are
  deleted. `media.audio.chunk_count` records how many there were. A crash mid-Session leaves the chunks in
  place (recovery UI: Slice 7).
- **Dev/test overrides** live in `storage.local` under `devOverrides`, with no UI. Tests set them through the
  service worker. `transcription: 'scripted'` selects the scripted adapter with a fixture from
  `fixtures/transcripts/`. `audioChunkMs` shortens the chunk interval so a short test exercises chunking.
- **The half-started Session is deleted** if the offscreen document cannot open the microphone, so no empty
  Sessions pile up.
- **Slice 0 spike code is removed.** The ORT/VAD guarantees (d1–d3) survive as an on-demand offscreen self-test
  (`ortSelfTest` message, `tests/e2e/ort-assets.spec.ts`). It is not reachable from any UI.
- **`scripting` permission, beyond P0-14's list.** It is needed to inject the content script into http(s) tabs
  already open at install or update, so drawing works without a reload. It adds no new site access, because
  `<all_urls>` is already granted. `tests/e2e/inject.spec.ts` covers it, and it fails when the injection is
  disabled.
