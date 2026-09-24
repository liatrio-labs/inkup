// Best tier (PRD P0-7): ElevenLabs Scribe v2 Realtime through @elevenlabs/client's `Scribe`, in manual audio
// mode: we feed our own 16 kHz PCM16 frames (audio_format pcm_16000), so the SDK's microphone worklet (a blob:
// URL the extension CSP would block) is never loaded.
//
// Auth: each connection mints a single-use token with POST /v1/single-use-token/realtime_scribe
// (xi-api-key: <key>, response {token}); the key never goes on the socket. 401 ends the paid tier.
// Commits: commit_strategy vad, so the server cuts segments at pauses. With include_timestamps the server sends
// `committed_transcript_with_timestamps` {text, words[{text, start, end, type}]} after each commit; words of type
// `spacing` and `audio_event` are skipped.
//
// Timing: word start/end are seconds of audio received on the connection. ElevenLabs does not document the
// origin, so the adapter also accepts segment-relative times: when a committed segment's words start before the
// previous segment ended, they are offset by the audio sent up to the previous commit. The manual check with a
// real key (docs/manual-checks.md C9) confirms which one the service uses.
//
// Message shapes: @elevenlabs/types (asyncapi-types.ts: SessionStartedMessage, CommittedTranscriptWithTimestampsMessage,
// Word), https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime and
// https://elevenlabs.io/docs/api-reference/tokens/create.
import { AudioFormat, CommitStrategy, RealtimeEvents, Scribe } from '@elevenlabs/client';
import { createAudioOffsetMap, pcm16ToBase64 } from '@inkup/core/audio-offsets';
import { joinWords } from '@inkup/core/transcription-runs';
import { StreamAuthError, type StreamConnection, type StreamEngine, type StreamHandlers } from './streaming';
import type { TranscriptionInfo } from './types';

export const ELEVENLABS_ENGINE = 'elevenlabs';
export const SCRIBE_REALTIME_MODEL = 'scribe_v2_realtime';
export const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

export interface ElevenLabsOptions {
  key: string;
  /** REST base; the realtime socket uses the same host with ws[s]. */
  baseUrl?: string;
  lang: string;
  fetch?: typeof fetch;
}

const trimBase = (b = ELEVENLABS_BASE) => b.replace(/\/+$/, '');

/** A single-use realtime token (15 min, consumed on use). 401/403 throw StreamAuthError. */
export async function mintScribeToken(key: string, baseUrl?: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${trimBase(baseUrl)}/v1/single-use-token/realtime_scribe`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
  });
  if (res.status === 401 || res.status === 403)
    throw new StreamAuthError(`ElevenLabs rejected the key (${res.status})`);
  if (!res.ok)
    throw new Error(`ElevenLabs token request failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('ElevenLabs token response had no token');
  return body.token;
}

export const elevenlabsInfo: TranscriptionInfo = {
  engine: ELEVENLABS_ENGINE,
  local: false,
  timestamp_quality: 'word',
  captions: 'live',
};

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type: string;
}

export function createElevenLabsEngine(opts: ElevenLabsOptions): StreamEngine {
  return {
    id: ELEVENLABS_ENGINE,
    info: elevenlabsInfo,
    async connect(handlers: StreamHandlers): Promise<StreamConnection> {
      const token = await mintScribeToken(opts.key, opts.baseUrl, opts.fetch);
      const connection = Scribe.connect({
        token,
        modelId: SCRIBE_REALTIME_MODEL,
        audioFormat: AudioFormat.PCM_16000,
        sampleRate: 16000,
        commitStrategy: CommitStrategy.VAD,
        includeTimestamps: true,
        languageCode: opts.lang.split('-')[0],
        baseUri: trimBase(opts.baseUrl).replace(/^http/, 'ws'),
      });
      const map = createAudioOffsetMap(16000);
      let closing = false;
      let started = false;
      let lastEnd = 0;
      let sentAtLastCommit = 0;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => (resolveClosed = r));
      let onCommit: (() => void) | null = null;

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, (m) => {
        const raw = ((m.words ?? []) as ScribeWord[]).filter(
          (w) => w.type === 'word' && w.text.trim() && typeof w.start === 'number',
        );
        const first = raw[0]?.start ?? 0;
        // Segment-relative times: the words restart near 0 although audio has run on (see the header).
        const base = raw.length && first + 0.5 < lastEnd ? sentAtLastCommit : 0;
        sentAtLastCommit = map.sentSeconds;
        onCommit?.();
        if (!m.text.trim() || raw.length === 0) return;
        const words = raw.map((w) => ({
          text: w.text.trim(),
          t: map.toSession(base + w.start!),
          t_end: map.toSession(base + (w.end ?? w.start!)),
        }));
        lastEnd = base + (raw.at(-1)!.end ?? raw.at(-1)!.start!);
        handlers.onSegment({
          text: joinWords(words.map((w) => w.text)) || m.text.trim(),
          t: words[0]!.t,
          t_end: words.at(-1)!.t_end,
          engine: ELEVENLABS_ENGINE,
          local: false,
          timestamp_quality: 'word',
          words,
          confidence: null,
        });
      });
      connection.on(RealtimeEvents.CLOSE, (e) => {
        resolveClosed();
        if (started && !closing) handlers.onDrop(`socket_closed: ${e.code}${e.reason ? ` ${e.reason}` : ''}`);
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Scribe session did not start in 10 s')), 10_000);
        connection.on(RealtimeEvents.SESSION_STARTED, () => {
          clearTimeout(timer);
          resolve();
        });
        connection.on(RealtimeEvents.AUTH_ERROR, (m) => {
          clearTimeout(timer);
          reject(new StreamAuthError(`ElevenLabs auth error: ${m.error}`));
        });
        connection.on(RealtimeEvents.ERROR, (m) => {
          if (started) return console.warn('[var] Scribe error', m);
          clearTimeout(timer);
          reject(new Error(`Scribe error: ${'error' in m ? m.error : String(m)}`));
        });
        void closed.then(() => {
          clearTimeout(timer);
          reject(new Error('Scribe socket closed before the session started'));
        });
      });
      started = true;

      return {
        send(frame) {
          if (closing) return;
          try {
            connection.send({ audioBase64: pcm16ToBase64(frame.pcm) });
            map.sent(frame.t, frame.pcm.length);
          } catch {
            // The socket is closing; its CLOSE event reports the drop.
          }
        },
        async finish() {
          if (closing) return;
          closing = true;
          // A manual commit makes the server finalize what it holds; wait for that commit, then close.
          const committed = new Promise<void>((r) => (onCommit = r));
          try {
            connection.commit();
            await Promise.race([committed, closed, new Promise((r) => setTimeout(r, 3000))]);
          } catch {
            /* the socket already closed */
          }
          connection.close();
        },
        abort() {
          closing = true;
          connection.close();
        },
      };
    },
  };
}
