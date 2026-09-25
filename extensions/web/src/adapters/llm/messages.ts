// The Anthropic Messages API as a Transport: `messages.stream` with structured output (`output_config.format`),
// for Anthropic itself and for the Vercel AI Gateway's Anthropic-compatible endpoint. The answer is returned raw:
// the adapter parses and validates it (anthropic.ts), so the SDK's own parse step is turned into a pass-through.
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Part, Transport, TransportAnswer, Turn } from './transport';
import type { Effort, ProcessError } from './types';

/** The system prompt as one cached block: it is the same for every Session. */
export const systemBlocks = (system: string): Anthropic.TextBlockParam[] => [
  { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
];

/** `output_config` with the format, plus effort only when one is set. */
export const outputConfig = <F>(format: F, effort: Effort | undefined) => ({ format, ...(effort ? { effort } : {}) });

function block(p: Part): Anthropic.ContentBlockParam {
  if (p.type === 'text') return p;
  if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } };
  // The Messages API has no video or audio input; only the chat transport is given files.
  throw new Error(`The Messages API cannot take ${p.media_type} (${p.filename}).`);
}

export const anthropicMessages = (turns: readonly Turn[]): Anthropic.MessageParam[] =>
  turns.map((t) => ({ role: t.role, content: typeof t.content === 'string' ? t.content : t.content.map(block) }));

export function createMessagesTransport(client: Anthropic, toError: (e: unknown) => ProcessError): Transport {
  return {
    async send(req): Promise<TransportAnswer> {
      const base = zodOutputFormat(req.schema);
      // The adapter validates the answer itself, whatever the transport: the SDK only hands the text back.
      const format: typeof base = { ...base, parse: (content: string) => content as never };
      const usage = { input_tokens: 0, output_tokens: 0 };
      const stream = client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        system: systemBlocks(req.system),
        messages: anthropicMessages(req.messages),
        output_config: outputConfig(format, req.effort),
      });
      stream.on('streamEvent', (event) => {
        if (event.type === 'message_start') usage.input_tokens = event.message.usage.input_tokens;
        if (event.type === 'message_delta') usage.output_tokens = event.usage.output_tokens;
      });
      if (req.onText) stream.on('text', (_delta, snapshot) => req.onText!(snapshot));
      let message: Awaited<ReturnType<typeof stream.finalMessage>>;
      try {
        message = await stream.finalMessage();
      } catch (e) {
        throw toError(e);
      }
      usage.input_tokens = message.usage.input_tokens;
      usage.output_tokens = message.usage.output_tokens;
      const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const stop =
        message.stop_reason === 'max_tokens' ? 'max_tokens' : message.stop_reason === 'refusal' ? 'refusal' : 'end';
      return { raw, usage, stop };
    },
  };
}
