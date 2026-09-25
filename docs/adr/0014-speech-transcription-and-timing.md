---
status: accepted
date: 2026-09-22
---

# Speech is free and on-device by default, paid tiers fall back rather than fail, and every segment is placed on the Session clock by the VAD before it is paired

What the reviewer says is half the review, and when they said it decides which Annotation it belongs to. The free tier
must send nothing off the machine (PRD P0-15). The engines disagree about time: word-level engines give word times,
Web Speech stamps a segment when its results arrive, and the Silero VAD sees speech on the PCM clock.

**Tiers.** The transcription adapters (`extensions/web/src/adapters/transcription/`) are:

- Web Speech, on-device only by default (`processLocally: true`, started only when `available()` says so). Server
  recognition is an opt-in (`allowServerSpeech`) whose notice says audio goes to Google; its segments are marked
  `local: false`. Without either, the Session records with no live captions and logs a `transcription_fallback`.
- Local Whisper, which transcribes each VAD speech span. Weights download only from the options page; Sessions read the
  cache with remote models off.
- Deepgram and ElevenLabs, streaming over a shared 16 kHz PCM graph (`offscreen/pcm.ts`). Deepgram gets a 60 s JWT per
  connection (the stored key never goes on the socket; a key without the Member role falls back to the SDK's browser
  path); ElevenLabs a single-use token per connection.

A paid tier retries a dropped socket three times (500 ms, 1 s, 2 s), buffers up to 30 s of frames meanwhile, and then
falls back to the free default with one `transcription_fallback {from, to, reason}`. A paid tier with no key starts on
the free default (`reason: no_key`); it does not refuse to start. Word times go through the frames actually sent, so
pauses and reconnects map back to Session time (`packages/core/src/audio-offsets.ts`).

**Runs.** A re-transcription (in the review page, which has the audio and a foreground user) appends a run and makes it
active; nothing is replaced (`packages/core/src/transcription-runs.ts`). Segments carry `run_id`, edits are keyed by
segment id, and everything downstream reads only the active run. Voice Command spans are cut from re-runs.

**The VAD.** Silero v5 through vad-web, its per-frame probability fed to our own hysteresis tracker
(`packages/core/src/speech-activity.ts`: on at 0.5, off below 0.35, 90 ms minimum, 160 ms hangover), logged as
`speech_activity` spans. vad-web's own `onSpeechEnd` is not used: it pads and drops short speech. PCM frames are
buffered from Start and replayed into the model once it loads (`packages/core/src/vad-feed.ts`), each stamped with its
own Session time, so nothing said before the model is ready is lost. That relies on vad-web internals, so the
version is pinned and `extensions/web/tests/unit/vad-web-pin.test.ts` fails when it changes; at runtime a missing
internal falls back to vad-web's own start and logs `[var] vad-web internals changed`.

**Voice Commands.** A command needs its own island of speech with 800 ms of silence on both sides, confirmed 250 ms
after. Matching normalizes with compromise and takes the best `token_set_ratio` of at least 85, with a double-metaphone
fallback. With approximate timestamps the command must be the whole final segment and its island short enough for the
phrase. "scratch that" and "pin that" resolve a target (the newer of the latest Draft Item and Annotation) recorded on
the event. Command phrases are stripped from speech by `segment_id`; the log keeps them. Voice Commands need live
captions.

**Alignment before pairing.** At processing time, never in the log, `alignSegments`
(`packages/core/src/process/align.ts`) moves each approximate segment onto the VAD speech that explains it: its start
is the latest VAD span that began by `t`, joined across pauses up to 1 s, no earlier than `SPEECH_LEAD_MS` (2.5 s)
before `t`; its end the last span ending by `t_end`. `processEvents` (the active, edited, aligned transcript) is what
Process, its chunks, Process without a model and the Draft Item pass read. The log keeps arrival times, so a better
aligner can re-read old Sessions.

**Pairing windows** (`PAIRING_WINDOW_MS` in `packages/core/src/process/pairing.ts`): word-level 2 s, VAD-aligned
2.5 s, stamped-on-arrival 4 s. Rather than widen a window for pointing words that mean what was just named, "that" is
marked `refers_back` like "it", and the script names what the latest speech near any Annotation pointed at.

**Speech Boundary.** For word-level segments, the last demonstrative or sentence start; for an approximate one, the
latest VAD speech start at or before its `t`, within 2.5 s.

**Mute is not Pause.** Mute disables the mic track, so the recorder writes silence and keeps Session time, the VAD and
engines hear zeros, Voice Commands are off (even "resume"), and a segment reaching into a muted span is dropped.
`mic_muted`/`mic_unmuted` are logged and the Process script marks the spans. Pause stops the recorders and page
capture; on-device recognition keeps running so "resume" is heard, but server speech is paused, since audio must not
leave the machine while paused.

**Dictation into a comment box is a comment, not transcript.** While a box dictates, segments whose midpoint falls
after it opened are logged with a `target` and appended to the box; the transcript, Signals and Process leave them
out. The box's mic enables the track only, not the Session.

**No wait on the audio device longer than 2 s** (`AUDIO_DEVICE_TIMEOUT_MS` in `offscreen/pcm.ts`): without a sound
server `AudioContext.resume()` and `close()` can hang, and Stop must not.

## Considered options

- vad-web's `onSpeechEnd` edges, or a level detector as PRD P0-8 named: padded, or not speech-specific.
- Loading the VAD earlier instead of buffering: still machine-dependent, and the offscreen document exists only from
  Start.
- Rewriting segment times in the log: the log records what the recognizer reported; alignment is a reading of it.
- Widening the pairing window for "that": pairs unrelated speech everywhere else.
- Treating a Voice Command island as 1 s of silence: VAD padding eats about 200 ms of a real 1 s pause.

## Consequences

- Whisper and the paid tiers give finals only, so comment boxes show no live caption with them.
- Every consumer of speech must read `processEvents`, not raw `transcript_segment` events.
- A vad-web upgrade is a deliberate change that re-checks the internals it touches.

## History

- 2026-09-22 (Slice 1): Web Speech became on-device only unless the reviewer opts in, after the first review.
- 2026-09-22 (Slice 7): PCM frame times were anchored to the first worklet message's arrival, making words late on a
  busy thread; the anchor now subtracts how far the AudioContext's clock had run.
- 2026-09-23: MicVAD opened its own node only once Silero loaded (2.9 s on CI), losing early speech for Voice Commands
  and Whisper. The buffer-and-replay feed replaced it.
- 2026-09-23 (E10, E11): Mute and comment-box dictation arrived; a Session may have no voice at all (ADR 0010).
- 2026-09-24 (#37): approximate segments paired within 4 s of their arrival stamp, which is 0.3–2 s late, and paired
  speech with the wrong Annotation. Now aligned to the VAD first, paired within 2.5 s, and "that" refers back. 41 of
  48 segments in the real fixtures align (`node scripts/vad-alignment-report.ts`).
- 2026-09-24 (#34): the 2 s audio device bound, after Firefox on Linux CI waited out a 15 s backstop on every Stop.
