// Local stand-ins for the paid transcription vendors (Slice 6). No vendor keys exist in this repo, so the e2e
// and adapter tests run the real SDKs (@deepgram/sdk 5.12, @elevenlabs/client 1.25) against these servers,
// reached through the dev-only base URL overrides. They cannot recognize speech: each one "hears" a scripted
// word list, laid out on the audio it actually received, so word times are real offsets into that audio.
//
// Deepgram (https://developers.deepgram.com/reference):
// - POST /v1/auth/grant {ttl_seconds} with `Authorization: Token <key>` → {access_token, expires_in}
//   (GrantV1Response in the SDK types). `grantStatus: 403` answers like a key without the Member role.
// - GET  /v1/listen upgrade (Sec-WebSocket-Protocol `bearer, <jwt>` or `token, <key>`, the SDK's browser auth).
//   Binary frames are linear16 audio. Every `resultEveryS` of audio it sends an interim then a final
//   `Results` message (ListenV1Results: channel.alternatives[0].{transcript, confidence, words[{word,
//   punctuated_word, start, end, confidence}]}, start, duration, is_final, speech_final). `{"type":"CloseStream"}`
//   flushes, sends `Metadata` and closes with 1000.
// - POST /v1/listen (pre-recorded) → ListenV1Response {metadata, results: {channels[0].alternatives[0], utterances}}.
// ElevenLabs (https://elevenlabs.io/docs/api-reference):
// - POST /v1/single-use-token/realtime_scribe with `xi-api-key` → {token}; each token opens one socket.
// - GET  /v1/speech-to-text/realtime?model_id&token&audio_format&commit_strategy&include_timestamps upgrade.
//   Sends `session_started` {session_id, config}, then per `resultEveryS` of `input_audio_chunk` audio
//   (base64 PCM16) a `partial_transcript`, a `committed_transcript` and a `committed_transcript_with_timestamps`
//   {text, words[{text, start, end, type: word|spacing, logprob}]} (@elevenlabs/types asyncapi-types.ts).
//   A chunk with `commit: true` flushes.
// - POST /v1/speech-to-text (multipart: model_id, file, timestamps_granularity) → {language_code, text, words}.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface StubWord {
  text: string;
  start: number;
  end: number;
}

export interface StubSocketLog {
  path: string;
  query: Record<string, string>;
  protocols: string[];
  /** Bytes of PCM16 audio received. */
  audioBytes: number;
  openedAt: number;
  closedAt: number | null;
  closeCode: number | null;
  /** Words sent in final results, in connection audio seconds. */
  words: StubWord[];
}

export interface StubRestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface SttStub {
  baseURL: string;
  sockets: StubSocketLog[];
  rest: StubRestLog[];
  close(): Promise<void>;
}

export interface SttStubOptions {
  /** The key the stub accepts. */
  key: string;
  /** The words it "hears", repeated as audio keeps coming. */
  script: string;
  /** Seconds of audio between results. */
  resultEveryS?: number;
  /** Close each of the first `dropConnections` sockets with 1011 this long after it opened. */
  dropAfterMs?: number;
  dropConnections?: number;
  /** Deepgram only: the /v1/auth/grant status (403: the key cannot mint tokens). */
  grantStatus?: number;
  /** Pre-recorded / batch answer: how many seconds of words to lay out. */
  batchSeconds?: number;
  port?: number;
}

const WORD_S = 0.3;
const GAP_S = 0.1;

/** Lays the script out on [from, to) seconds of audio, continuing from word index `next`. */
function layout(script: string[], from: number, to: number, cursor: { next: number; at: number }): StubWord[] {
  const out: StubWord[] = [];
  if (cursor.at < from) cursor.at = from;
  while (cursor.at + WORD_S <= to) {
    out.push({ text: script[cursor.next % script.length]!, start: round(cursor.at), end: round(cursor.at + WORD_S) });
    cursor.next++;
    cursor.at += WORD_S + GAP_S;
    // A pause after each sentence of 6 words, so batch engines have something to split on.
    if (cursor.next % 6 === 0) cursor.at += 0.9;
  }
  return out;
}
const round = (n: number) => Math.round(n * 1000) / 1000;
const words = (s: string) => s.split(/\s+/).filter(Boolean);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res
    .writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    .end(JSON.stringify(body));

async function listen(server: ReturnType<typeof createServer>, port = 0): Promise<string> {
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url, 'http://x').searchParams);
}

function trackDrops(opts: SttStubOptions, ws: WebSocket, index: number) {
  if (opts.dropAfterMs !== undefined && index < (opts.dropConnections ?? Infinity)) {
    setTimeout(() => ws.readyState === ws.OPEN && ws.close(1011, 'stub drop'), opts.dropAfterMs);
  }
}

// ---------------------------------------------------------------------------------------------------------------

export async function startDeepgramStub(opts: SttStubOptions): Promise<SttStub> {
  const sockets: StubSocketLog[] = [];
  const rest: StubRestLog[] = [];
  const tokens = new Set<string>();
  const script = words(opts.script);
  const every = opts.resultEveryS ?? 1;
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => [...p][0] ?? false });

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS')
      return res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end();
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    rest.push({
      method: req.method ?? '',
      path: url.pathname,
      query: queryOf(req.url ?? '/'),
      headers: req.headers,
      body,
    });
    const auth = String(req.headers.authorization ?? '');
    if (req.method === 'POST' && url.pathname === '/v1/auth/grant') {
      if (auth !== `Token ${opts.key}`)
        return json(res, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' });
      if (opts.grantStatus && opts.grantStatus !== 200)
        return json(res, opts.grantStatus, { err_code: 'FORBIDDEN', err_msg: 'Insufficient permissions.' });
      const ttl = JSON.parse(body.toString('utf8') || '{}').ttl_seconds ?? 30;
      const token = `dg-jwt-${tokens.size + 1}`;
      tokens.add(token);
      return json(res, 200, { access_token: token, expires_in: ttl });
    }
    if (req.method === 'POST' && url.pathname === '/v1/listen') {
      if (auth !== `Token ${opts.key}` && !tokens.has(auth.replace(/^Bearer /, '')))
        return json(res, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' });
      const ws = layout(script, 0.5, opts.batchSeconds ?? 4, { next: 0, at: 0 });
      const toWord = (w: StubWord) => ({
        word: w.text.toLowerCase(),
        punctuated_word: w.text,
        start: w.start,
        end: w.end,
        confidence: 0.99,
      });
      // Utterances split where the layout paused.
      const utterances: StubWord[][] = [];
      for (const w of ws) {
        const cur = utterances.at(-1);
        if (cur && w.start - cur.at(-1)!.end < 0.5) cur.push(w);
        else utterances.push([w]);
      }
      return json(res, 200, {
        metadata: {
          request_id: 'stub',
          created: new Date().toISOString(),
          duration: opts.batchSeconds ?? 4,
          channels: 1,
          models: ['nova-3'],
        },
        results: {
          channels: [
            {
              alternatives: [{ transcript: ws.map((w) => w.text).join(' '), confidence: 0.99, words: ws.map(toWord) }],
            },
          ],
          utterances: utterances.map((u, i) => ({
            id: `u${i}`,
            start: u[0]!.start,
            end: u.at(-1)!.end,
            confidence: 0.99,
            channel: 0,
            transcript: u.map((w) => w.text).join(' '),
            words: u.map(toWord),
          })),
        },
      });
    }
    json(res, 404, { err_msg: `stub has no ${req.method} ${url.pathname}` });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Browsers cannot set headers on a WebSocket, so the SDK sends the credential as subprotocols there; in Node
    // (the eval and the adapter tests) it sends the Authorization header.
    const header = String(req.headers.authorization ?? '');
    const [scheme, cred] = protocols.length
      ? [protocols[0], protocols[1] ?? '']
      : [header.split(' ')[0]?.toLowerCase(), header.split(' ')[1] ?? ''];
    const ok =
      url.pathname === '/v1/listen' &&
      ((scheme === 'bearer' && tokens.has(cred)) || (scheme === 'token' && cred === opts.key));
    if (!ok) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const log: StubSocketLog = {
        path: url.pathname,
        query: queryOf(req.url ?? '/'),
        protocols: protocols.length ? protocols : [String(scheme), cred],
        audioBytes: 0,
        openedAt: Date.now(),
        closedAt: null,
        closeCode: null,
        words: [],
      };
      const index = sockets.push(log) - 1;
      const cursor = { next: 0, at: 0.2 };
      let reported = 0;
      const flush = (upTo: number, final: boolean) => {
        const out = layout(script, cursor.at, upTo, cursor);
        const msg = (is_final: boolean) => ({
          type: 'Results',
          channel_index: [0, 1],
          duration: round(upTo - reported),
          start: round(reported),
          is_final,
          speech_final: is_final,
          from_finalize: false,
          channel: {
            alternatives: [
              {
                transcript: out.map((w) => w.text).join(' '),
                confidence: 0.98,
                words: out.map((w) => ({
                  word: w.text.toLowerCase(),
                  punctuated_word: w.text,
                  start: w.start,
                  end: w.end,
                  confidence: 0.98,
                })),
              },
            ],
          },
          metadata: {
            request_id: 'stub',
            model_info: { name: 'nova-3', version: 'stub', arch: 'stub' },
            model_uuid: 'stub',
          },
        });
        if (out.length) {
          ws.send(
            JSON.stringify({
              ...msg(false),
              channel: {
                alternatives: [
                  {
                    transcript: out
                      .slice(0, 1)
                      .map((w) => w.text)
                      .join(' '),
                    confidence: 0.5,
                    words: [],
                  },
                ],
              },
            }),
          );
          ws.send(JSON.stringify(msg(true)));
          log.words.push(...out);
        } else if (final) ws.send(JSON.stringify(msg(true)));
        reported = upTo;
      };
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          log.audioBytes += (data as Buffer).length;
          const secs = log.audioBytes / 32000;
          if (secs - reported >= every) flush(secs, false);
          return;
        }
        const m = JSON.parse(data.toString());
        if (m.type === 'CloseStream') {
          flush(log.audioBytes / 32000, true);
          ws.send(
            JSON.stringify({
              type: 'Metadata',
              transaction_key: 'deprecated',
              request_id: 'stub',
              sha256: 'stub',
              created: new Date().toISOString(),
              duration: log.audioBytes / 32000,
              channels: 1,
            }),
          );
          ws.close(1000);
        }
      });
      ws.on('close', (code) => {
        log.closedAt = Date.now();
        log.closeCode = code;
      });
      trackDrops(opts, ws, index);
    });
  });

  const baseURL = await listen(server, opts.port);
  return {
    baseURL,
    sockets,
    rest,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------

export async function startElevenLabsStub(opts: SttStubOptions): Promise<SttStub> {
  const sockets: StubSocketLog[] = [];
  const rest: StubRestLog[] = [];
  const tokens = new Set<string>();
  const script = words(opts.script);
  const every = opts.resultEveryS ?? 1.5;
  const wss = new WebSocketServer({ noServer: true });
  let issued = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS')
      return res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end();
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    rest.push({
      method: req.method ?? '',
      path: url.pathname,
      query: queryOf(req.url ?? '/'),
      headers: req.headers,
      body,
    });
    if (req.headers['xi-api-key'] !== opts.key)
      return json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    if (req.method === 'POST' && url.pathname === '/v1/single-use-token/realtime_scribe') {
      const token = `sutkn_stub${++issued}`;
      tokens.add(token);
      return json(res, 200, { token });
    }
    if (req.method === 'POST' && url.pathname === '/v1/speech-to-text') {
      const ws = layout(script, 0.5, opts.batchSeconds ?? 4, { next: 0, at: 0 });
      const out: { text: string; start: number; end: number; type: string; logprob: number }[] = [];
      ws.forEach((w, i) => {
        if (i > 0) out.push({ text: ' ', start: ws[i - 1]!.end, end: w.start, type: 'spacing', logprob: 0 });
        out.push({ text: w.text, start: w.start, end: w.end, type: 'word', logprob: -0.05 });
      });
      return json(res, 200, {
        language_code: 'en',
        language_probability: 0.99,
        text: ws.map((w) => w.text).join(' '),
        words: out,
      });
    }
    json(res, 404, { detail: `stub has no ${req.method} ${url.pathname}` });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const token = url.searchParams.get('token') ?? '';
    if (url.pathname !== '/v1/speech-to-text/realtime' || !tokens.delete(token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const log: StubSocketLog = {
        path: url.pathname,
        query: queryOf(req.url ?? '/'),
        protocols: [],
        audioBytes: 0,
        openedAt: Date.now(),
        closedAt: null,
        closeCode: null,
        words: [],
      };
      const index = sockets.push(log) - 1;
      const cursor = { next: 0, at: 0.2 };
      let reported = 0;
      ws.send(
        JSON.stringify({
          message_type: 'session_started',
          session_id: `stub-session-${index + 1}`,
          config: {
            sample_rate: 16000,
            audio_format: log.query.audio_format,
            model_id: log.query.model_id,
            commit_strategy: log.query.commit_strategy,
            include_timestamps: log.query.include_timestamps === 'true',
          },
        }),
      );
      const commit = (upTo: number) => {
        const out = layout(script, cursor.at, upTo, cursor);
        reported = upTo;
        const text = out.map((w) => w.text).join(' ');
        if (out.length)
          ws.send(
            JSON.stringify({
              message_type: 'partial_transcript',
              text: out
                .slice(0, 2)
                .map((w) => w.text)
                .join(' '),
            }),
          );
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text }));
        const wordsOut: object[] = [];
        out.forEach((w, i) => {
          if (i > 0) wordsOut.push({ text: ' ', start: out[i - 1]!.end, end: w.start, type: 'spacing', logprob: 0 });
          wordsOut.push({ text: w.text, start: w.start, end: w.end, type: 'word', logprob: -0.05 });
        });
        if (log.query.include_timestamps === 'true')
          ws.send(
            JSON.stringify({
              message_type: 'committed_transcript_with_timestamps',
              text,
              language_code: 'en',
              words: wordsOut,
            }),
          );
        log.words.push(...out);
      };
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.message_type !== 'input_audio_chunk') return;
        log.audioBytes += Buffer.from(m.audio_base_64 ?? '', 'base64').length;
        const secs = log.audioBytes / 32000;
        if (m.commit) commit(secs);
        else if (secs - reported >= every) commit(secs);
      });
      ws.on('close', (code) => {
        log.closedAt = Date.now();
        log.closeCode = code;
      });
      trackDrops(opts, ws, index);
    });
  });

  const baseURL = await listen(server, opts.port);
  return {
    baseURL,
    sockets,
    rest,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
