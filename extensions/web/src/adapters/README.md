# src/adapters

Engines behind stable interfaces (docs/PLAN.md).

- `transcription/`: `start(stream) → AsyncIterable<Segment>`. Slice 1 ships `webspeech` (free default) and
  `scripted` (replays a timed transcript fixture; dev/test only). Whisper, Deepgram and ElevenLabs arrive in Slice 6.
- `llm/`: `LlmAdapter` (`estimate`, `process`, `test`). Slice 2 ships `anthropic`: `messages.parse` +
  `zodOutputFormat`, one repair retry, vetting of every item against the recording or its screenshots, and
  `countTokens` for the estimate. Each call goes through a `Transport`: the Messages API (`messages.ts`), or the
  Vercel AI Gateway's Chat Completions (`chat.ts`) when Process sends the recording to a model that takes video.
  The service worker runs it for the extension; `pnpm eval` runs it in Node.
- `host/`: the Host client (ADR 0004): `connectHost` (hello, pairing, welcome, events and Change Items acked by message
  id, pushed Resolutions), `putBlob`, `backoffMs`. The service worker's `src/background/host-client.ts` owns the
  connection and drains the Dexie outbox (`src/db/outbox.ts`).
