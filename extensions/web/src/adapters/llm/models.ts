// The providers' model lists, for the options page's model selects and for cost (the extension caches them in
// `modelLists`, src/settings.ts). Anthropic: `models.list` through the SDK, every page. The Vercel AI Gateway:
// `GET {base}/v1/models`, an OpenAI-style list with per-token prices, context window, output cap and capability
// tags (vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#list-models, read 2026-09-24).
import Anthropic from '@anthropic-ai/sdk';
import type { CatalogModel, ModelCatalog } from '@inkup/core/process/cost';

/** The fields InkUp keeps of one listed model. */
export interface ListedModel {
  id: string;
  /** Human-readable name, when the list gives one. */
  name: string | null;
  /** USD per 1M tokens; null when the list has no prices (Anthropic's has none). */
  price: { input: number; output: number } | null;
  /** Largest input, in tokens. */
  context_window: number | null;
  /** Largest `max_tokens`. */
  max_tokens: number | null;
  /**
   * Capability tags. Gateway: its `tags` as given (`vision`, `file-input`, `tool-use`, `reasoning`…). Anthropic:
   * from `capabilities`: `vision` (image input), `file-input` (PDF input), `effort` (accepts `output_config.effort`).
   */
  tags: string[];
}

export interface ModelList {
  /** Epoch ms. */
  fetched_at: number;
  models: ListedModel[];
}

export interface ListOptions {
  apiKey: string;
  /** Absent: the provider's own (api.anthropic.com, or GATEWAY_BASE_URL). */
  baseURL?: string | null;
  fetch?: typeof fetch;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** A Gateway per-token price string ("0.000002") as USD per 1M tokens (2), without float noise. */
export function perMillion(v: unknown): number | null {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toPrecision(12)) : null;
}

/** One entry of the Gateway's `/v1/models` `data`, or null for anything but a language model. */
export function gatewayModel(raw: unknown): ListedModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || (m.type !== undefined && m.type !== 'language')) return null;
  const pricing = (m.pricing ?? {}) as Record<string, unknown>;
  const input = perMillion(pricing.input);
  const output = perMillion(pricing.output);
  return {
    id: m.id,
    name: typeof m.name === 'string' ? m.name : null,
    price: input !== null && output !== null ? { input, output } : null,
    context_window: num(m.context_window),
    max_tokens: num(m.max_tokens),
    tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

export function anthropicModel(m: Anthropic.ModelInfo): ListedModel {
  const c = m.capabilities;
  return {
    id: m.id,
    name: m.display_name || null,
    price: null,
    context_window: num(m.max_input_tokens),
    max_tokens: num(m.max_tokens),
    tags: [
      ...(c?.image_input?.supported ? ['vision'] : []),
      ...(c?.pdf_input?.supported ? ['file-input'] : []),
      ...(c?.effort?.supported ? ['effort'] : []),
    ],
  };
}

export async function listAnthropicModels(opts: ListOptions): Promise<ListedModel[]> {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    maxRetries: 1,
    dangerouslyAllowBrowser: true,
  });
  const out: ListedModel[] = [];
  for await (const m of client.models.list({ limit: 100 })) out.push(anthropicModel(m));
  return out;
}

export async function listGatewayModels(opts: ListOptions & { baseURL: string }): Promise<ListedModel[]> {
  const res = await (opts.fetch ?? fetch)(`${opts.baseURL.replace(/\/$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) throw new Error(`Vercel AI Gateway answered ${res.status} for its model list.`);
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error('The Vercel AI Gateway model list had no data.');
  return body.data.flatMap((m) => gatewayModel(m) ?? []);
}

/** The cached lists as one catalog for cost and caps (Gateway ids carry their `creator/` prefix, so none collide). */
export function catalogOf(lists: Partial<Record<string, ModelList>>): ModelCatalog | null {
  const all = Object.values(lists).filter((l): l is ModelList => !!l);
  if (!all.length) return null;
  const models: Record<string, CatalogModel> = {};
  for (const l of all)
    for (const m of l.models)
      models[m.id] = { id: m.id, price: m.price, context_window: m.context_window, max_tokens: m.max_tokens };
  // Only the Gateway's list has prices, so its fetch dates them.
  const priced = lists.gateway?.fetched_at ?? Math.max(...all.map((l) => l.fetched_at));
  return { models, as_of: new Date(priced).toISOString().slice(0, 10) };
}
