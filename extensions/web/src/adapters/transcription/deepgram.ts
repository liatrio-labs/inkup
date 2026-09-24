// Better tier (PRD P0-7): Deepgram Nova-3 over the listen WebSocket, through @deepgram/sdk v5.
//
// Auth: the stored key never goes on the socket when it can be helped. Each connection first mints a
// short-lived JWT with POST /v1/auth/grant {ttl_seconds} (Authorization: Token <key>) and opens the socket with
// the `bearer` subprotocol. A key without the Member role cannot mint tokens: Deepgram answers 403, and the
// adapter then falls back to the raw key on the `token` subprotocol (the SDK's browser path, see
// CustomClient getWebSocketOptions). 401 means the key itself is wrong and ends the paid tier.
// REST from the offscreen document and extension pages is not subject to CORS, because the manifest holds
// host permissions, so the SDK needs no proxy here.
//
// Timing: Results carry word `start`/`end` in seconds of audio received on this connection. The connection's
// AudioOffsetMap turns them into Session time (packages/core/src/audio-offsets.ts), which handles pauses, reconnects and
// replayed frames.
//
// Message shapes: ListenV1Results / ListenV1Metadata in @deepgram/sdk dist/esm/api/resources/listen/resources/v1/
// types, and https://developers.deepgram.com/reference/speech-to-text/listen-streaming.
import { DeepgramClient, DeepgramError } from '@deepgram/sdk';
import { createAudioOffsetMap } from '@inkup/core/audio-offsets';
import { joinWords } from '@inkup/core/transcription-runs';
import { StreamAuthError, type StreamConnection, type StreamEngine, type StreamHandlers } from './streaming';
import type { Segment, TranscriptionInfo } from './types';

export const DEEPGRAM_ENGINE = 'deepgram';
export const DEEPGRAM_MODEL = 'nova-3';
export const DEEPGRAM_BASE = 'https://api.deepgram.com';
/** Token lifetime: the socket must open within it; an open socket outlives it. */
export const DEEPGRAM_TOKEN_TTL_S = 60;

export interface DeepgramOptions {
  key: string;
  /** REST base, e.g. https://api.deepgram.com or a test stub; the socket uses the same host with ws[s]. */
  baseUrl?: string;
  lang: string;
}

/** The SDK's environment for a base URL: REST on http(s), the listen socket on ws(s). */
export function deepgramEnvironment(baseUrl = DEEPGRAM_BASE) {
  const base = baseUrl.replace(/\/+$/, '');
  const ws = base.replace(/^http/, 'ws');
  return { base, production: ws, agent: ws, agentRest: base };
}

export type DeepgramCredential = { kind: 'bearer'; token: string } | { kind: 'key'; token: string };

const statusOf = (e: unknown) => (e instanceof DeepgramError ? e.statusCode : undefined);

/** Mints a short-lived token; a 403 (key cannot mint) falls back to the key itself. 401 throws StreamAuthError. */
export async function mintDeepgramToken(
  key: string,
  baseUrl?: string,
  ttlSeconds = DEEPGRAM_TOKEN_TTL_S,
): Promise<DeepgramCredential> {
  const client = new DeepgramClient({
    apiKey: key,
    environment: deepgramEnvironment(baseUrl),
    maxRetries: 0,
    timeoutInSeconds: 15,
  });
  try {
    const grant = await client.auth.v1.tokens.grant({ ttl_seconds: ttlSeconds });
    return { kind: 'bearer', token: grant.access_token };
  } catch (e) {
    const status = statusOf(e);
    if (status === 403) return { kind: 'key', token: key };
    if (status === 401) throw new StreamAuthError(`Deepgram rejected the key (401)`);
    throw e;
  }
}

export const deepgramInfo: TranscriptionInfo = {
  engine: DEEPGRAM_ENGINE,
  local: false,
  timestamp_quality: 'word',
  captions: 'live',
};

interface ResultsMessage {
  type: 'Results';
  is_final?: boolean;
  start: number;
  duration: number;
  channel: {
    alternatives: {
      transcript: string;
      confidence: number;
      words: { word: string; punctuated_word?: string; start: number; end: number }[];
    }[];
  };
}

export function createDeepgramEngine(opts: DeepgramOptions): StreamEngine {
  return {
    id: DEEPGRAM_ENGINE,
    info: deepgramInfo,
    async connect(handlers: StreamHandlers): Promise<StreamConnection> {
      const cred = await mintDeepgramToken(opts.key, opts.baseUrl);
      const environment = deepgramEnvironment(opts.baseUrl);
      const client = new DeepgramClient(
        cred.kind === 'bearer'
          ? { accessToken: cred.token, environment, reconnect: false }
          : { apiKey: cred.token, environment, reconnect: false },
      );
      const socket = await client.listen.v1.connect({
        model: DEEPGRAM_MODEL,
        language: opts.lang,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        interim_results: 'true',
        punctuate: 'true',
        smart_format: 'true',
        reconnectAttempts: 0,
        connectionTimeoutInSeconds: 10,
      });
      const map = createAudioOffsetMap(16000);
      let closing = false;
      let opened = false;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => (resolveClosed = r));

      socket.on('message', (m) => {
        if (m.type !== 'Results') return;
        const r = m as unknown as ResultsMessage;
        // Interim results are superseded by the final one for the same audio; only finals become segments.
        if (!r.is_final) return;
        const alt = r.channel.alternatives[0];
        if (!alt?.transcript.trim()) return;
        const words = alt.words.map((w) => ({
          text: w.punctuated_word ?? w.word,
          t: map.toSession(w.start),
          t_end: map.toSession(w.end),
        }));
        const seg: Segment = {
          text: words.length ? joinWords(words.map((w) => w.text)) : alt.transcript.trim(),
          t: words[0]?.t ?? map.toSession(r.start),
          t_end: words.at(-1)?.t_end ?? map.toSession(r.start + r.duration),
          engine: DEEPGRAM_ENGINE,
          local: false,
          timestamp_quality: 'word',
          words,
          confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
        };
        handlers.onSegment(seg);
      });
      socket.on('close', (e) => {
        resolveClosed();
        if (opened && !closing) handlers.onDrop(`socket_closed: ${e.code}${e.reason ? ` ${e.reason}` : ''}`);
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Deepgram socket did not open in 10 s')), 10_000);
        socket.on('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.on('error', (e) => {
          if (opened) return;
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
        void closed.then(() => {
          clearTimeout(timer);
          reject(new Error('Deepgram socket closed before it opened'));
        });
        socket.connect();
      });
      opened = true;

      return {
        send(frame) {
          if (closing) return;
          try {
            socket.sendMedia(frame.pcm);
            map.sent(frame.t, frame.pcm.length);
          } catch {
            // The socket is closing; its close event reports the drop.
          }
        },
        async finish() {
          if (closing) return;
          closing = true;
          // CloseStream: Deepgram sends the last final Results and Metadata, then closes the socket.
          try {
            socket.sendCloseStream({ type: 'CloseStream' });
          } catch {
            /* already closed */
          }
          await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
          socket.close();
        },
        abort() {
          closing = true;
          socket.close();
        },
      };
    },
  };
}
