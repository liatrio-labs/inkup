---
status: accepted
date: 2026-09-23
---

# A MAIN-world bridge maps elements to source files and serves `window.__inkup`; nothing the page says is trusted, and it is only ever a hint

An agent fixes a Change Item faster when it knows which component rendered the element, and some apps want to add
review notes from their own code. Both need InkUp to talk to the page's own JavaScript world, which the page controls.

**One bridge, declared in the manifest.** `entrypoints/bridge.content.ts` runs with `world: 'MAIN'` at
`document_start` (Chrome 111+, Firefox 128+; Safari is manual check S7). Tabs open at install get it through
`scripting.executeScript({world: 'MAIN'})`. The overlay talks to it over DOM events with JSON-string details, since a
Firefox content script cannot read an object detail across worlds. A probe the bridge never answers times out once
(1.5 s), and later probes return nothing until the bridge announces itself.

**Source mapping.** Only the Candidates the ranking lists are probed. React is read first (the fiber's `_debugStack`
owner stack in React 19, `_debugSource` in 16–18; components from the `_debugOwner` chain, minified names dropped),
then Vue, then `data-source-file`-style attributes; the first that knows wins. Paths are cut at the last `src/` (else
`app/`) segment, and `node_modules`, `.vite/deps` and `vendor/` mean library code and are dropped. Answers are
sanitised (types, lengths, at most 8 components). The source reaches Change Items only through `groundItems`, in code
(ADR 0015), and is shown to agents as a hint.

**Crops.** The service worker crops each Annotation's own screenshot to the pick's box plus 16 CSS px, stored as blob
`<screenshot_id>.crop`, so export and MCP `get_screenshot` read it with no new code (ADR 0013).

**`window.__inkup`, only on the recording tab, only while it records.** The bridge defines the global when the overlay
enables it from its own Session state and deletes it at Stop; other tabs see `undefined`. A page can dispatch the enable
event itself and get a global whose calls all fail: the overlay answers only while its Session state says the tab
records, and the service worker checks `activeFor(tab)` again before recording. Arguments are checked on the overlay
side (a selector of at most 500 characters that is not our own UI, a comment clipped to 2,000, at most 20 style
properties). Paused, `status` and `list` answer and `annotate` is refused.

**A page API call is an Annotation with no Strokes** (`close_reason: 'page_api'`, `source: 'page_api'`,
`page_api: {comment}`), built through the drawing path's parts: snapshot with sources, `rankCandidates`, screenshot,
crop. Style and text changes are `style_edit` events on it. Keeping the comment on the Annotation means Process, drafts,
"scratch that", the review page and the Host read it with no new plumbing. An item whose Annotations all came from the
page API is tagged `source: 'page_api'`, and the review page and the script say "from the page API"; the model is told
to treat it like the reviewer's request unless the speech rejects it.

## Considered options

- Injecting the bridge per page with `executeScript` only: misses `document_start` on every navigation.
- Probing every snapshot: reading owner stacks formats an `Error.stack` per element; about 10 is enough.
- A separate event type for page API notes: every consumer would need new plumbing.
- Letting the model write sources: it would invent paths (ADR 0015).

## Consequences

- With a bundler the line is the transformed module's, which Vite and Next keep close to the source.
- A page can spoof a source or make its own notes on its own tab while it records; both are labelled and neither is
  acted on without the reviewer's Session.

## History

- 2026-09-23 (E4, E5): shipped together as schema v12. The Host's Signal field for the code source was renamed
  `element_source`, so `source` means who made an item, as on Annotations and Change Items.
- 2026-09-23 (E7): Inspect's live style edits were removed; `style_edit` remains as the page API's data path.
