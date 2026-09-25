---
status: accepted; superseded in part by 0009 (the low-confidence second pass is now vetting of every item)
date: 2026-09-22
---

# Process: the model proposes, code grounds and enforces; runs stream in budgeted chunks in the service worker and never truncate silently

Process turns a Session's timeline into Change Items. A model is good at reading what a reviewer meant and bad at
copying ids, respecting limits it cannot see, and staying inside a token budget. So the model's part is kept small and
checked, and everything that can be decided in code is.

**The script.** `packages/core/src/process/script.ts` renders the timeline as text: Annotations with their Candidates
(and `source:` where known), speech paired to them, Text Comments, Object Select comments, style changes, viewport
changes, muted spans and pinned or rejected Draft Items. Screenshots appear as aliases `s1`, `s2`, … so the model never
copies a UUID; the adapter checks every alias and Annotation number it gets back and restores the real ids everywhere,
including `screenshots/<id>.png` in `agent_prompt`. The English noun and demonstrative tables
(`packages/core/src/process/locale/en.ts`) annotate the script as hints; the model makes the pick.

**Structured output, validated, one repair.** Every call uses `zodOutputFormat` and streams (`client.messages.stream`).
Zod enforces what structured output cannot express: `ambiguity` below confidence 0.6, at least one `subject`, and an
`agent_prompt` citing every evidence screenshot; Session checks refuse unknown screenshots and Annotations. One repair
turn replays the raw answer with the issues; a second failure fails the run with `invalid_output`. `refusal` fails at
once. The shared call path is `withRepair` in the Anthropic adapter, generic over the output's root. The system prompt
is Session-independent and marked `cache_control: ephemeral`.

**Chunks within a budget.** `packages/core/src/process/sections.ts` cuts the Session at natural points (navigation,
tab switch, pause, resume, `next`, an Annotation closing, the middle of an 8 s silence) and never inside an
Annotation's pairing cluster. A Session up to 12 minutes that fits is one chunk; longer ones get about one chunk per 10
minutes, and a chunk whose estimated answer would pass half the model's output cap (`outputCapFor`) is split further.
Chunks keep a 1-minute overlap and ownership by Annotation start, and the merge across chunks (`windows.ts`) dedupes
only across chunks and never loses an Annotation. Two chunks run at once (`p-limit`). A chunk that stops at
`max_tokens` is recorded as `truncated`, split at its best cut and run again, at most 3 deep; a truncated answer is
never repaired.

**No silent loss.** When windowed, each chunk's prompt lists the Annotations it must account for, and the output may
list `dropped_annotations` with a reason; an Annotation neither used nor dropped triggers the repair, and what is still
missing is stored as `unaccounted_annotations` and shown in amber.

**After the model, in this order** (`anthropic.ts`): Text Comments merged (`mergeTextComments`), pins enforced
(`pins.ts`, ADR 0017), vetting (every item checked against the recording, or its screenshots and crops, ADR 0009),
style and page API changes passed through (`attachStyleChanges`), viewport sizes (`withViewportSizes`), then
`groundItems` last.

**Code does what code can.**

- Grounding (`grounding.ts`): the model's schema (`ModelChangeItemSchema`) has no `source` or `crops`. `groundItems`
  copies each Candidate's source onto its Location and the Annotations' crops into `evidence.crops`, tags
  `source: 'page_api'` when every cited Annotation came from the page API, and replaces whatever the model invented.
  Grounding twice changes nothing.
- Style changes (`style-changes.ts`): the model never writes `style_changes`; they are copied from the recorded edits,
  with an "Apply these changes exactly" block, and an edit no item covers gets an item of its own.
- Text Comments (`text-comments.ts`): a comment that states the new text (`detectReplacement`) becomes a copy item in
  code; others go to the model, and are converted in code if no model item names their selector. A Session of explicit
  comments only makes no call.
- Viewport: an item located at a resized viewport says so in its `agent_prompt`.

**Process without a model is code, not a cheaper model.** With no key, `processInCode` (`in-code.ts`) makes one item
per live Annotation (its typed or page API comment, else its speech, else a flagged `question`) plus the Text Comment
merge, pins, grounding and viewport sizes. With a key the model runs unless `needsModel` says every Annotation already
says what it wants and nothing else was said.

**Combine after a merge.** The review page's merge is deterministic (`mergeItems`) and shows at once. Then one call
(`combine.ts`, the Merge role's model) rewrites only the words: title, category, intent, `agent_prompt`, ambiguity. Its
answer is an ordinary `edit` op with `origin: 'combine'`, so replay never calls a model. Grounding lines are taken off
before the call and put back after, so crops stay cited. The page drops a late answer if the card changed meanwhile.

**Runs live in the service worker and answer at once.** `startProcess` replies as soon as the run's row exists; the page
follows the `processRuns` row, and the worker keeps itself alive with `chrome.runtime.getPlatformInfo()` every 20 s
while a run is active. Items stream into `processProgress` rows ("Part k of n", read-only cards). A run still marked
running when a worker starts was cut off and is marked failed (`interrupted`).

## Considered options

- Letting the model write sources, crops, style changes or pins: it invents ids and paths, and structured output grows
  optional fields it may fill badly.
- A cheaper model for "no key": still a key, and still a network call.
- A fixed `max_tokens`: 16,000 cut a 12-minute Session's JSON mid-string, and the repair turn replayed the cut answer.
- A model call for every merge: the merge must show at once and replay without a model.

## Consequences

- Every new field an agent sees must say whether the model or code writes it; code-written fields stay out of the
  model's schema.
- Each call record carries `chunk`, `estimated_output` and the real `output_tokens`, for calibrating the estimate
  (manual check C17 step 5).
- Chrome's 5-minute limit on a single extension event no longer applies to Process, since no request waits for a run.

## History

- 2026-09-22 (Slice 2): one `messages.parse` call with a fixed 16,000-token cap; the review page sent `keepAlive`
  every 20 s. 2026-09-23 (U4): streaming, per-model output caps, budgeted chunks and truncation splitting.
  2026-09-23: a real 4-minute Session lost its reply channel; the request now answers at once and the worker keeps
  itself alive.
- 2026-09-22 (Slice 7): Sessions over 12 minutes split into `round(length / 10 min)` equal windows. 2026-09-23 (U4): the
  same target, but cut at natural points and bounded by the output budget.
- 2026-09-23 (E11): Process without a model. 2026-09-23 (E12): Combine after a merge, originally with its own
  `mergeModel` setting (now the Merge role, ADR 0016).
- 2026-09-24 (#37): Process reads VAD-aligned speech (ADR 0014).
- 2026-09-24 (PR D): we previously re-sent each item under confidence 0.6 alone with its screenshots (the second pass),
  and only the text script fed the main call. Now every item is vetted per window, and a model that takes video gets
  the recording with each call (ADR 0009).
