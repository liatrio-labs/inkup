# src/adapters

Engines behind stable interfaces (docs/PLAN.md).

- `transcription/`: `start(stream) → AsyncIterable<Segment>`. Slice 1 ships `webspeech` (free default) and
  `scripted` (replays a timed transcript fixture; dev/test only). Whisper, Deepgram and ElevenLabs arrive in Slice 6.
- `llm/`: `LlmAdapter` (`estimate`, `process`, `test`). Slice 2 ships `anthropic`: `messages.parse` +
  `zodOutputFormat`, one repair retry, a screenshot second pass for items under confidence 0.6, and
  `countTokens` for the estimate. The service worker runs it for the extension; `pnpm eval` runs it in Node.
- `host/`: the Host client (ADR 0004): `connectHost` (hello, pairing, welcome, events and Change Items acked by message
  id, pushed Resolutions), `putBlob`, `backoffMs`. The service worker's `src/background/host-client.ts` owns the
  connection and drains the Dexie outbox (`src/db/outbox.ts`).
