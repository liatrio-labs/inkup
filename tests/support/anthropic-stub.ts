// A local stand-in for the Anthropic API: POST /v1/messages and /v1/messages/count_tokens with response bodies
// shaped like the real ones. Tests script the /v1/messages answers and inspect every request. Used by the
// adapter unit tests and by tests/e2e/process.spec.ts and drafts.spec.ts (the extension points at it through the
// dev-only `anthropicBaseUrl` override). A live Draft Item pass is told apart from Process by its system prompt
// (isDraftRequest), whatever model it names, and a review-page Combine by its own (isCombineRequest).
//
// Streaming: a request with `stream: true` gets the same answer as server-sent events (message_start, text deltas,
// message_delta, message_stop), `deltaChars` characters per delta, `streamDelayMs` apart.
// Truncation: an answer longer than the request's `max_tokens` (or the stub's own `maxOutputTokens`, a stand-in for
// a model whose thinking ate the budget) is cut there and stops with `max_tokens`, as the real API does. Tokens are
// counted as `charsPerToken` characters (default 4).
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  path: string;
  headers: IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: whatever JSON the client sent; tests assert on it by deep path (body.output_config.format.schema…)
  body: any;
}

/** The fields of a Messages API response body the stub rewrites. */
interface MessageBody {
  type: string;
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage: { output_tokens: number };
}

export type StubReply = { status?: number; body: unknown };

export interface AnthropicStub {
  baseURL: string;
  requests: StubRequest[];
  /** Requests to /v1/messages only. */
  messages(): StubRequest[];
  /** Most /v1/messages responses open at once. */
  peakConcurrent(): number;
  close(): Promise<void>;
}

let seq = 0;

/** A Messages API response carrying one text block (what structured output returns). */
export function messageReply(
  model: string,
  text: string,
  usage = { input_tokens: 1800, output_tokens: 600 },
  stop_reason = 'end_turn',
): StubReply {
  return {
    body: {
      id: `msg_stub_${++seq}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason,
      stop_sequence: null,
      usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' },
    },
  };
}

export function errorReply(status: number, type: string, message: string): StubReply {
  return { status, body: { type: 'error', error: { type, message }, request_id: `req_stub_${++seq}` } };
}

export interface StubOptions {
  /** A promise holds the answer back until it settles (e.g. to race a review-page edit against a combine). */
  onMessage: (req: StubRequest, index: number) => StubReply | Promise<StubReply>;
  inputTokens?: (req: StubRequest) => number;
  port?: number;
  charsPerToken?: number;
  /** Cap every answer at this many output tokens, whatever max_tokens the request asked for. */
  maxOutputTokens?: number;
  deltaChars?: number;
  streamDelayMs?: number;
}

/** Cuts a message reply at the output limit: the text stops mid-way and stop_reason becomes max_tokens. */
export function truncateReply(reply: StubReply, limitTokens: number, charsPerToken = 4): StubReply {
  const body = reply.body as MessageBody | null;
  if (body?.type !== 'message') return reply;
  const text: string = body.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (Math.ceil(text.length / charsPerToken) <= limitTokens) return reply;
  const cut = text.slice(0, limitTokens * charsPerToken);
  return {
    ...reply,
    body: {
      ...body,
      content: [{ type: 'text', text: cut }],
      stop_reason: 'max_tokens',
      usage: { ...body.usage, output_tokens: limitTokens },
    },
  };
}

/** A message reply as the SSE events of a streamed response. */
export function sseEvents(message: MessageBody, deltaChars = 200): string[] {
  const text: string = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [
    ev('message_start', {
      message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } },
    }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '', citations: null } }),
  ];
  for (let i = 0; i < text.length; i += deltaChars)
    out.push(
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + deltaChars) } }),
    );
  out.push(
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    }),
    ev('message_stop', {}),
  );
  return out;
}

export async function startAnthropicStub(opts: StubOptions): Promise<AnthropicStub> {
  const requests: StubRequest[] = [];
  let messageCount = 0;
  let open = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        /* keep null */
      }
      const r: StubRequest = { path, headers: req.headers, body };
      requests.push(r);
      let reply: StubReply;
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        reply = { body: { input_tokens: opts.inputTokens?.(r) ?? 4321 } };
      } else if (req.method === 'POST' && path === '/v1/messages') {
        peak = Math.max(peak, ++open);
        res.on('close', () => open--);
        reply = await opts.onMessage(r, messageCount++);
        const limit = Math.min(Number(r.body?.max_tokens ?? Infinity), opts.maxOutputTokens ?? Infinity);
        if (Number.isFinite(limit)) reply = truncateReply(reply, limit, opts.charsPerToken);
      } else {
        reply = errorReply(404, 'not_found_error', `stub has no ${req.method} ${path}`);
      }
      if (
        r.body?.stream === true &&
        (reply.status ?? 200) === 200 &&
        (reply.body as MessageBody | null)?.type === 'message'
      ) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'request-id': `req_stub_${++seq}`,
          ...cors,
        });
        const events = sseEvents(reply.body as MessageBody, opts.deltaChars);
        const delay = opts.streamDelayMs ?? 0;
        let i = 0;
        const next = () => {
          if (res.destroyed) return;
          if (i >= events.length) return void res.end();
          res.write(events[i++]);
          if (delay > 0) setTimeout(next, delay);
          else setImmediate(next);
        };
        next();
        return;
      }
      res
        .writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          'request-id': `req_stub_${++seq}`,
          ...cors,
        })
        .end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    messages: () => requests.filter((r) => r.path === '/v1/messages'),
    peakConcurrent: () => peak,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The script text of a /v1/messages request (the first text block of the first user turn). */
export function scriptOf(req: StubRequest): string {
  const content = req.body?.messages?.[0]?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('\n');
}

/** A review-page Combine after a merge (packages/core/src/process/combine.ts). */
export function isCombineRequest(req: StubRequest): boolean {
  const system = req.body?.system;
  const text =
    typeof system === 'string' ? system : (system ?? []).map((b: { text?: string }) => b.text ?? '').join('\n');
  return text.startsWith('You combine two Change Items');
}

/** A live Draft Item pass (packages/core/src/process/draft.ts), as opposed to Process, a second pass or Test. */
export function isDraftRequest(req: StubRequest): boolean {
  const system = req.body?.system;
  const text =
    typeof system === 'string' ? system : (system ?? []).map((b: { text?: string }) => b.text ?? '').join('\n');
  return text.startsWith('You write Draft Items');
}
