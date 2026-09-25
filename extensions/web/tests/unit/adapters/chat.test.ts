// @vitest-environment node
// The Gateway's Chat Completions transport against a stubbed fetch: request body, SSE parsing, usage, stop reasons
// and HTTP errors.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createChatTransport } from '@/adapters/llm/chat';
import type { TransportRequest } from '@/adapters/llm/transport';

const schema = z.object({ items: z.array(z.object({ id: z.string() })) });
const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  model: 'google/gemini-3.1-pro-preview',
  system: 'You write Change Items.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'file', media_type: 'video/webm', filename: 'video.webm', data: 'dmlkZW8=' },
        { type: 'image', media_type: 'image/png', data: 'cG5n' },
        { type: 'text', text: 'The script.' },
      ],
    },
  ],
  schema,
  maxTokens: 64_000,
  ...over,
});

/** SSE body cut into arbitrary pieces, so events straddle reads. */
function sse(events: unknown[], pieceChars = 17): Response {
  const text = `${events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')}`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += pieceChars) c.enqueue(bytes.slice(i, i + pieceChars));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const delta = (content: string, finish: string | null = null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});

function stubFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no more stubbed responses');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const transport = (fetch: typeof globalThis.fetch, maxRetries = 0) =>
  createChatTransport({ apiKey: 'vck-test', baseURL: 'http://gw.test/', fetch, maxRetries, retryBaseMs: 1 });

describe('chat transport', () => {
  it('posts the chat request with file, image and text parts, schema and effort; streams the text and usage', async () => {
    const answer = JSON.stringify({ items: [{ id: 'item_0001' }, { id: 'item_0002' }] });
    const { fetch, calls } = stubFetch(
      sse([
        delta(answer.slice(0, 20)),
        delta(answer.slice(20), 'stop'),
        { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 5120, completion_tokens: 88 } },
        '[DONE]',
      ]),
    );
    const snapshots: string[] = [];
    const r = await transport(fetch).send(request({ effort: 'high', onText: (s) => snapshots.push(s) }));
    expect(r).toEqual({ raw: answer, usage: { input_tokens: 5120, output_tokens: 88 }, stop: 'end' });
    expect(snapshots.at(-1)).toBe(answer);
    expect(snapshots.length).toBeGreaterThan(1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://gw.test/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer vck-test');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      model: 'google/gemini-3.1-pro-preview',
      max_tokens: 64_000,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { name: 'output' } },
    });
    expect(body.response_format.json_schema.schema.properties.items.type).toBe('array');
    expect(body.response_format.json_schema).not.toHaveProperty('strict');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You write Change Items.' });
    expect(body.messages[1].content).toEqual([
      { type: 'file', file: { filename: 'video.webm', file_data: 'data:video/webm;base64,dmlkZW8=' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } },
      { type: 'text', text: 'The script.' },
    ]);
  });

  it('sends no effort when none is set', async () => {
    const { fetch, calls } = stubFetch(sse([delta('{}', 'stop'), '[DONE]']));
    await transport(fetch).send(request());
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('reasoning_effort');
  });

  it('finish_reason length is a max_tokens stop, content_filter a refusal', async () => {
    const cut = stubFetch(sse([delta('{"items": [{"id"', 'length'), '[DONE]']));
    expect((await transport(cut.fetch).send(request())).stop).toBe('max_tokens');
    const filtered = stubFetch(sse([delta('', 'content_filter'), '[DONE]']));
    expect((await transport(filtered.fetch).send(request())).stop).toBe('refusal');
  });

  it('takes a whole JSON completion too', async () => {
    const { fetch } = stubFetch(
      Response.json({
        choices: [{ index: 0, message: { role: 'assistant', content: '{"items": []}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    );
    expect(await transport(fetch).send(request())).toEqual({
      raw: '{"items": []}',
      usage: { input_tokens: 10, output_tokens: 4 },
      stop: 'end',
    });
  });

  it('maps HTTP errors to ProcessError codes', async () => {
    const err = (status: number, message = 'nope') =>
      new Response(JSON.stringify({ error: { message, type: 'x' } }), { status });
    await expect(transport(stubFetch(err(401)).fetch).send(request())).rejects.toMatchObject({
      code: 'auth',
      message: 'The Vercel AI Gateway key was rejected (401).',
    });
    await expect(transport(stubFetch(err(403)).fetch).send(request())).rejects.toMatchObject({ code: 'auth' });
    await expect(transport(stubFetch(err(429)).fetch).send(request())).rejects.toMatchObject({ code: 'rate_limit' });
    await expect(
      transport(stubFetch(err(400, 'model does not support video')).fetch).send(request()),
    ).rejects.toMatchObject({
      code: 'api',
      message: 'Vercel AI Gateway API error 400: model does not support video',
    });
    await expect(transport(stubFetch(new TypeError('fetch failed')).fetch).send(request())).rejects.toMatchObject({
      code: 'network',
      message: 'Could not reach Vercel AI Gateway: fetch failed',
    });
  });

  it('an error event mid-stream is an API error', async () => {
    const { fetch } = stubFetch(sse([delta('{"it'), { error: { message: 'upstream timed out' } }]));
    await expect(transport(fetch).send(request())).rejects.toMatchObject({
      code: 'api',
      message: 'Vercel AI Gateway API error: upstream timed out',
    });
  });

  it('retries 5xx and network failures, then answers', async () => {
    const { fetch, calls } = stubFetch(
      new Response('bad gateway', { status: 502 }),
      new TypeError('fetch failed'),
      sse([delta('{"items": []}', 'stop'), '[DONE]']),
    );
    expect((await transport(fetch, 2).send(request())).raw).toBe('{"items": []}');
    expect(calls).toHaveLength(3);
  });
});
