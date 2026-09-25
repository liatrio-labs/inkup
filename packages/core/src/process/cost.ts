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

/**
 * What a provider's model list says about one model (the extension caches it: Anthropic's `models.list` and the
 * Vercel AI Gateway's `GET /v1/models`). Each field is null when the list does not give it.
 */
export interface CatalogModel {
  id: string;
  /** USD per 1M tokens (the Gateway's per-token prices × 1M). Anthropic's list has no prices. */
  price: Price | null;
  /** Largest input, in tokens. */
  context_window: number | null;
  /** Largest `max_tokens`. */
  max_tokens: number | null;
}

/** Models by id, and the day their list was fetched (YYYY-MM-DD, the estimate's "prices as of"). */
export interface ModelCatalog {
  models: Readonly<Record<string, CatalogModel>>;
  as_of: string;
}

/**
 * The Anthropic model id behind a Gateway id: `anthropic/claude-sonnet-5` → `claude-sonnet-5`. The Gateway writes
 * version dots (`anthropic/claude-haiku-4.5`) where Anthropic writes dashes. Any other id comes back unchanged.
 */
export function anthropicId(model: string): string {
  const id = model.trim();
  return id.startsWith('anthropic/') ? id.slice('anthropic/'.length).replace(/\./g, '-') : id;
}

/** The dated table first (Anthropic ids, bare or behind `anthropic/`), then the cached list, then DEFAULT_OUTPUT_CAP. */
export const outputCapFor = (model: string, catalog?: ModelCatalog | null): number =>
  OUTPUT_CAPS[anthropicId(model)] ?? catalog?.models[model.trim()]?.max_tokens ?? DEFAULT_OUTPUT_CAP;

export const priceFor = (model: string, catalog?: ModelCatalog | null): Price | null =>
  PRICES[anthropicId(model)] ?? catalog?.models[model.trim()]?.price ?? null;

/** The model's input limit in tokens from the cached list; null when no list gave it. */
export const contextWindowFor = (model: string, catalog?: ModelCatalog | null): number | null =>
  catalog?.models[model.trim()]?.context_window ?? catalog?.models[anthropicId(model)]?.context_window ?? null;

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
  /** Each call's own tokens, in order (the limits apply per call); absent: the totals are one call's. */
  chunk_tokens?: { input: number; output: number }[];
  /** null when neither PRICES nor the cached model list prices the model. */
  usd: number | null;
  /** PRICES_AS_OF, or the day the model list that priced it was fetched. */
  prices_as_of: string;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  catalog?: ModelCatalog | null,
): CostEstimate {
  const listed = PRICES[anthropicId(model)];
  const p = priceFor(model, catalog);
  const usd = p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
  const asOf = listed || !p || !catalog ? PRICES_AS_OF : catalog.as_of;
  return { model, input_tokens: inputTokens, output_tokens: outputTokens, usd, prices_as_of: asOf };
}

/** A call at or above this share of a model limit gets a warning before Process runs. */
export const LIMIT_SHARE = 0.8;

/** One call of the estimate near one of the model's limits: its largest call, when several are near. */
export interface LimitWarning {
  /** `context_window`: the call's input; `output_cap`: its estimated answer. */
  limit: 'context_window' | 'output_cap';
  /** 1-based, of `chunks`. */
  chunk: number;
  chunks: number;
  tokens: number;
  max: number;
}

/**
 * The estimate's calls that reach LIMIT_SHARE of the model's context window (skipped when no list gives it) or of
 * its output cap: at most one warning per limit, for the largest call.
 */
export function limitWarnings(estimate: CostEstimate, catalog?: ModelCatalog | null): LimitWarning[] {
  const calls =
    estimate.chunk_tokens ??
    ((estimate.chunks ?? 1) === 1 ? [{ input: estimate.input_tokens, output: estimate.output_tokens }] : []);
  const window = contextWindowFor(estimate.model, catalog);
  const limits: [LimitWarning['limit'], number | null, 'input' | 'output'][] = [
    ['context_window', window, 'input'],
    ['output_cap', outputCapFor(estimate.model, catalog), 'output'],
  ];
  const warnings: LimitWarning[] = [];
  for (const [limit, max, side] of limits) {
    if (!max) continue;
    let worst = -1;
    calls.forEach((c, i) => {
      if (c[side] >= LIMIT_SHARE * max && (worst < 0 || c[side] > calls[worst]![side])) worst = i;
    });
    if (worst >= 0) warnings.push({ limit, chunk: worst + 1, chunks: calls.length, tokens: calls[worst]![side], max });
  }
  return warnings;
}

/**
 * Whether Process may skip its confirm step: the reviewer set a threshold, the estimate is priced and under it, no
 * call is near a model limit, and nothing would be replaced (Process again discards the items and their edits).
 */
export function shouldAutoRun(input: {
  usd: number | null;
  threshold: number | undefined;
  done: boolean;
  warnings: readonly LimitWarning[];
}): boolean {
  const { usd, threshold, done, warnings } = input;
  return threshold !== undefined && usd !== null && usd < threshold && !done && warnings.length === 0;
}

/** "$0.0123" below a dollar, "$1.23" above. */
export const formatUsd = (usd: number): string => (usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
