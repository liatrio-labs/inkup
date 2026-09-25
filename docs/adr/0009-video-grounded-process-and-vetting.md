---
status: accepted
date: 2026-09-24
---

# Video-grounded Process and a vetting pass: a model that takes video watches the recording, and every Change Item is checked before it is shown

## Context

Process wrote Change Items from a text script of the Session: the transcript, the Annotations with their times and
targets, and the page events. The items came out wrong in ways the script cannot show: the wrong element, or speech
paired with the wrong mark. The tab video was recorded and never sent to a model. The only image input was a second
pass that sent screenshots for items under confidence 0.6, and nothing checked the rest against what was on screen.

The Vercel AI Gateway reaches models that take video, Gemini among them, but only through its OpenAI-style Chat
Completions endpoint (vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions, read 2026-09-24). Its
Anthropic-compatible Messages endpoint, which Process used, has no video part.

## Decision

**Two transports, one adapter.** We previously streamed each call through the Anthropic SDK's `messages.stream`, which
parsed the answer. Now each call goes through a `Transport` (`adapters/llm/transport.ts`): send, stream the text, and
report usage and why the call stopped. `messages.ts` is the Messages API, for Anthropic and for the Gateway's
Anthropic-compatible endpoint. `chat.ts` is the Gateway's Chat Completions over plain `fetch`, with no OpenAI SDK: one
endpoint did not need one. The adapter parses and validates every answer itself, with the same `zodOutputFormat` parse
the SDK ran. Repair, chunking and splitting, pins and grounding are therefore the same on both transports. The chat
transport:

- sends a non-strict `json_schema` response format from `z.toJSONSchema`;
- streams the SSE deltas into the partial-item cards;
- maps `prompt_tokens` and `completion_tokens` into the CallRecord;
- maps `finish_reason: 'length'` to truncated and `content_filter` to a refusal;
- maps HTTP errors to the existing ProcessError codes;
- retries 408, 409, 429, 5xx and network failures.

**Which models take video.** The Gateway's `GET /v1/models` has no modality field. The per-model
`GET /v1/models/{creator}/{model}/endpoints` returns `data.architecture.input_modalities`, but its docs do not say
whether that list ever includes `"video"`: the Gemini example is `["text", "image", "file"]`
(vercel.com/docs/ai-gateway/sdks-and-apis/rest-api, read 2026-09-24). So a model takes video when any of these holds:

1. its cached tags include `video`;
2. the endpoints call lists `video`;
3. as a fallback, it is a `google/` model that takes `file`.

The answer is cached per model id (`modelCapabilities`) and cleared when the Gateway list is fetched again. A failed
lookup is not cached. Only a Gateway Process role can use video, and only then does Process use the chat transport.

**What goes with each call.** We previously sent only the text script. Now, with a model that takes video and a
Session that has a video blob, each window's main call carries three more things:

- the whole video webm and the whole audio webm, as `file` parts (data URLs);
- a MEDIA block (`core/process/video.ts`): each file's start on the Session clock, the pauses, the pieces that map
  file time to Session time, and the rule for that mapping;
- a Recording section in the system prompt: trust what is seen and heard over the script's times, the ink is visible
  while it is drawn, and set `evidence.video` from the footage.

A Session in several windows sends the same files with every window. That is simple and costs a few MB per ten
minutes. Cutting the files per window can come later.

**The cap.** `VIDEO_INLINE_MAX_BYTES` is 20 MB of decoded video plus audio per request. Over the cap, Process falls
back to the script and screenshots on the Messages API, and the run carries a note that the review page shows under
the Process result. Real Sessions are 2–4 MB of VP9 and 1–2 MB of Opus per 2–3 minutes, so the cap is about ten
minutes of busy review.

**Vetting replaces the second pass.** We previously re-asked about items under confidence 0.6, with their
screenshots. Now every item is checked. The check runs after the pins are enforced and the windows renumbered, and
before style changes and grounding. It makes one call per window with all of that window's items (CallRecord kind
`vet`):

- With a model that takes video, the call carries the video and audio.
- Otherwise it carries each item's screenshots and element close-ups as image blocks, at most 20 per call, in item
  order.

The answer is `{results: [{id, verdict: 'confirmed' | 'corrected' | 'unverified', reason, item?}]}`, and each outcome is
handled this way:

- A `corrected` item replaces the original only if it passes the item rules and `checkAgainstSession`. Otherwise the
  original stays, marked `unverified` with the reason.
- A pinned item is flagged but never rewritten.
- A failed vetting call leaves its items `unverified`. It never fails the run.
- Corrections then get style changes and grounding like any other item.

`processingSettings.vet`, on by default, turns vetting off: the options checkbox "Check items against the recording"
is saved only when it is off. The review page shows a badge on each card: Checked, Corrected: reason, or Unverified:
reason.

**Contract.** Items gain an optional `vetting: {verdict, reason}`. It is a new optional property with a new enum
inside it, which ADR 0007 counts as additive, so there is no version bump. The Host stores items verbatim. The MCP
`read_items` view now includes `vetting`, and `get_item` returns the whole item as before.

**Cost.** The estimate adds the vetting calls roughly: the same input again and an answer the size of the items. It
also adds the recording, per call, at 263 tokens a second of video and 32 of audio.

## Considered options

- **The OpenAI SDK for the chat endpoint.** Its streaming and retries would be free, but it is a dependency for one
  endpoint that plain `fetch` and an SSE reader cover.
- **Upload the recording once and refer to it.** The Gateway's Chat Completions docs show only inline data for
  files, so the files go inline and the cap bounds the request.
- **Vet only unsure items, as the second pass did.** Confidence is the model's own guess. The failures that prompted
  this change were items it was sure of.
- **Let a failed correction fail the run.** A check that cannot be applied still says something: keeping the original
  with an `unverified` reason shows the doubt without losing the item.
- **Always use the chat transport on the Gateway.** Anthropic models on the Gateway keep the Messages endpoint, whose
  structured output and prompt caching are known to work. Only a model that takes video needs the chat endpoint.

## Consequences

- Process makes about twice as many calls when vetting is on, and a video call's input is tens of thousands of tokens
  for a few minutes. The estimate shows both before the run.
- The file part's shape is from the Gateway docs, which show two forms (`file_data`, and `{data, media_type,
  filename}`). No test has run against the real Gateway. Manual check C23 covers a real Gemini run, and a rejection
  would be fixed in `chatPart` (`adapters/llm/chat.ts`).
- The capability rule's third branch is a guess about google models. If the endpoints call starts listing `video`,
  the first two branches decide, and the third can go.
- Older Hosts and agents see `vetting` as an unknown property and ignore it.
