// The Vercel AI Gateway's OpenAI-style Chat Completions (POST {base}/v1/chat/completions) as a Transport: the only
// Gateway endpoint that takes video (its Anthropic Messages endpoint has no video part). Plain fetch, no SDK.
// vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions (read 2026-09-24):
// - files go as `{type: 'file', file: {filename, file_data: 'data:<type>;base64,…'}}`, images as `image_url`;
// - structured output is `response_format: {type: 'json_schema', json_schema: {name, schema}}`, sent non-strict so
//   the adapter's own validation and repair turn stay the judge;
// - streaming is SSE `data: {choices: [{delta: {content}, finish_reason}]}` … `data: [DONE]`, with `usage`
//   ({prompt_tokens, completion_tokens}) on a last chunk when `stream_options.include_usage` is set;
// - effort is `reasoning_effort`.
import { z } from 'zod';
import type { Part, Transport, TransportAnswer, TransportRequest, Turn } from './transport';
import { ProcessError } from './types';

export interface ChatTransportOptions {
  apiKey: string;
  /** The Gateway's base, e.g. https://ai-gateway.vercel.sh (or a local stub). */
  baseURL: string;
  /** Who answers, in error messages. */
  vendor?: string;
  fetch?: typeof fetch;
  /** Retries for 429, 5xx and network failures. Default 2. */
  maxRetries?: number;
  /** First retry delay in ms; doubles per retry. Default 500. */
  retryBaseMs?: number;
}

type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

const dataUrl = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;

function chatPart(p: Part): ChatPart {
  if (p.type === 'text') return p;
  if (p.type === 'image') return { type: 'image_url', image_url: { url: dataUrl(p.media_type, p.data) } };
  return { type: 'file', file: { filename: p.filename, file_data: dataUrl(p.media_type, p.data) } };
}

const chatTurn = (t: Turn) => ({
  role: t.role,
  content: typeof t.content === 'string' ? t.content : t.content.map(chatPart),
});

/** The request body (exported for tests). */
export function chatBody(req: TransportRequest) {
  return {
    model: req.model,
    messages: [{ role: 'system', content: req.system }, ...req.messages.map(chatTurn)],
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'output', schema: z.toJSONSchema(req.schema, { unrepresentable: 'any' }) },
    },
    ...(req.effort ? { reasoning_effort: req.effort } : {}),
  };
}

interface ChatChunk {
  choices?: {
    delta?: { content?: string | null };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

const stopOf = (finish: string | null): TransportAnswer['stop'] =>
  finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end';

/** Reads `data:` events off an SSE body, one parsed JSON object at a time, until `[DONE]` or the end. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = function* (final: boolean): Generator<string> {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = final ? '' : (parts.pop() ?? '');
    for (const event of parts) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      for (const data of events(done)) {
        if (data === '[DONE]') return;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data) as ChatChunk;
        } catch {
          continue;
        }
        yield chunk;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createChatTransport(opts: ChatTransportOptions): Transport {
  const vendor = opts.vendor ?? 'Vercel AI Gateway';
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseURL.replace(/\/$/, '')}/v1/chat/completions`;
  const maxRetries = opts.maxRetries ?? 2;
  const retryBase = opts.retryBaseMs ?? 500;

  async function httpError(res: Response): Promise<ProcessError> {
    let message = '';
    try {
      const text = await res.text();
      try {
        message = (JSON.parse(text) as ChatChunk).error?.message ?? text;
      } catch {
        message = text;
      }
    } catch {
      /* no body */
    }
    if (res.status === 401 || res.status === 403)
      return new ProcessError('auth', `The ${vendor} key was rejected (${res.status}).`);
    if (res.status === 429)
      return new ProcessError('rate_limit', `${vendor} rate limit reached. Try again in a minute.`);
    return new ProcessError('api', `${vendor} API error ${res.status}: ${message.trim() || res.statusText}`.trim());
  }

  const retryable = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

  async function post(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body,
        });
      } catch (e) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryBase * 2 ** attempt));
          continue;
        }
        throw new ProcessError('network', `Could not reach ${vendor}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.ok) return res;
      if (retryable(res.status) && attempt < maxRetries) {
        await res.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, retryBase * 2 ** attempt));
        continue;
      }
      throw await httpError(res);
    }
  }

  return {
    async send(req): Promise<TransportAnswer> {
      const res = await post(JSON.stringify(chatBody(req)));
      const usage = { input_tokens: 0, output_tokens: 0 };
      const takeUsage = (u: ChatChunk['usage']) => {
        if (!u) return;
        usage.input_tokens = u.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = u.completion_tokens ?? usage.output_tokens;
      };
      // A proxy or stub may answer the whole completion as JSON instead of a stream.
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
        const body = (await res.json()) as ChatChunk;
        if (body.error) throw new ProcessError('api', `${vendor} API error: ${body.error.message ?? 'unknown'}`);
        const choice = body.choices?.[0];
        const raw = choice?.message?.content ?? '';
        takeUsage(body.usage);
        req.onText?.(raw);
        return { raw, usage, stop: stopOf(choice?.finish_reason ?? null) };
      }
      let raw = '';
      let finish: string | null = null;
      try {
        for await (const chunk of sseData(res.body)) {
          if (chunk.error) throw new ProcessError('api', `${vendor} API error: ${chunk.error.message ?? 'unknown'}`);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            raw += delta;
            req.onText?.(raw);
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
          takeUsage(chunk.usage);
        }
      } catch (e) {
        if (e instanceof ProcessError) throw e;
        throw new ProcessError(
          'network',
          `The ${vendor} stream broke off: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return { raw, usage, stop: stopOf(finish) };
    },
  };
}
