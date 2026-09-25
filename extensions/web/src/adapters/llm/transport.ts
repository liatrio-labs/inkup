// One structured-output call on the wire, behind the adapter's shared logic (repair, chunking and splitting, pins,
// grounding, vetting). Two transports: the Anthropic Messages API (Anthropic, and the Vercel AI Gateway's
// Anthropic-compatible endpoint) and the Gateway's OpenAI-style Chat Completions (./chat.ts), the only one of the
// two that takes video. A transport sends, streams the text, and reports usage and why the answer stopped; it never
// parses or validates the answer, so both are held to exactly the same checks.
import type { z } from 'zod';
import type { Effort, ScreenshotImage } from './types';

/** A piece of a user turn. `file` (video, audio) only goes through the chat transport. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: ScreenshotImage['media_type']; data: string }
  | { type: 'file'; media_type: string; filename: string /** base64, no data: prefix. */; data: string };

export interface Turn {
  role: 'user' | 'assistant';
  content: string | Part[];
}

export interface TransportRequest {
  model: string;
  /** Sent only when set. */
  effort?: Effort;
  system: string;
  messages: Turn[];
  /** The answer's schema: sent as the structured-output format. The caller validates the answer against it. */
  schema: z.ZodType;
  maxTokens: number;
  /** Called with the whole answer so far, as it streams. */
  onText?: (snapshot: string) => void;
}

export interface TransportAnswer {
  /** The answer's text (the JSON), '' when there was none. */
  raw: string;
  usage: { input_tokens: number; output_tokens: number };
  /** `max_tokens`: cut off at the output limit; `refusal`: the model or a content filter declined. */
  stop: 'end' | 'max_tokens' | 'refusal';
}

export interface Transport {
  /** Throws a ProcessError for API and network failures. */
  send(request: TransportRequest): Promise<TransportAnswer>;
}
