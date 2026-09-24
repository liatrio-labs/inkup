// Process cost estimate (PRD P0-11): input tokens from the API's count_tokens endpoint × the model's published
// price, plus a rough output estimate. Hardcoded, dated price table (docs/PLAN.md: the only maintained price
// library is 2.1 MB for a handful of models).
//
// Source: Anthropic's model table as bundled in the claude-api skill ("Current Models", cached 2026-06-24),
// read 2026-09-22. USD per million tokens, first-party API, standard (non-batch, uncached) rates.
// `claude-haiku-4-5-20251001` is the dated ID of Claude Haiku 4.5, used as the Draft model default.

export const PRICES_AS_OF = '2026-06-24';

export interface Price {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

/**
 * Largest `max_tokens` each model accepts (its output cap). Same source as PRICES: the claude-api skill's model
 * table (shared/models.md, "Max Output", cached 2026-06-24), read 2026-09-23. Process streams, so it can ask for the
 * whole cap; a model not listed gets DEFAULT_OUTPUT_CAP, which every current model supports.
 */
export const OUTPUT_CAPS: Readonly<Record<string, number>> = {
  'claude-fable-5-1': 128_000,
  'claude-fable-5': 128_000,
  'claude-opus-5-5': 128_000,
  'claude-opus-5': 128_000,
  'claude-opus-4-8': 128_000,
  'claude-opus-4-7': 128_000,
  'claude-opus-4-6': 128_000,
  'claude-sonnet-5': 128_000,
  'claude-sonnet-4-6': 128_000,
  'claude-haiku-4-5': 64_000,
  'claude-haiku-4-5-20251001': 64_000,
};
export const DEFAULT_OUTPUT_CAP = 32_000;

export const outputCapFor = (model: string): number => OUTPUT_CAPS[model.trim()] ?? DEFAULT_OUTPUT_CAP;

export const priceFor = (model: string): Price | null => PRICES[model.trim()] ?? null;

/**
 * Rough output size: each Change Item is ~350 tokens of JSON (the agent_prompt dominates), about one per
 * Annotation or per two speech segments, plus room for the model's thinking.
 */
export function estimateOutputTokens(annotations: number, segments: number): number {
  const items = Math.max(1, annotations, Math.ceil(segments / 2));
  return 600 + items * 700;
}

export interface CostEstimate {
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** Process calls the Session is split into (packages/core/src/process/sections.ts); absent: 1. */
  chunks?: number;
  /** null when the model is not in PRICES. */
  usd: number | null;
  prices_as_of: string;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): CostEstimate {
  const p = priceFor(model);
  const usd = p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
  return { model, input_tokens: inputTokens, output_tokens: outputTokens, usd, prices_as_of: PRICES_AS_OF };
}

/** "$0.0123" below a dollar, "$1.23" above. */
export const formatUsd = (usd: number): string => (usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
