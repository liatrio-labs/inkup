// Anthropic adapter (PRD P0-10, P0-11, D4): structured output through `messages.stream` + `zodOutputFormat`, one
// repair retry when the output fails validation, and a second pass with screenshots for low-confidence items.
// Live Draft Item passes use the same call path with a smaller schema and model, and so does a review-page Combine
// (two merged items rewritten as one, packages/core/src/process/combine.ts). Pinned Draft Items are enforced
// on the Process output in code (packages/core/src/process/pins.ts).
//
// Process (feedback batch 1, U4): the Session is cut into budgeted chunks (packages/core/src/process/sections.ts), run two at
// a time, each streamed with max_tokens at the model's output cap. Completed items are reported as they arrive
// (`onProgress`). A chunk that stops at max_tokens is split in two and both halves run; a truncated answer is never
// sent back for repair.
// Runs in the service worker (dangerouslyAllowBrowser: the key is the user's own, stored locally) and in Node
// for `pnpm eval`. The Vercel AI Gateway serves the same Messages API, so a Gateway role uses this adapter with the
// Gateway's base URL and key (`vendor` names it in errors).
import Anthropic from '@anthropic-ai/sdk';
import { partialParse } from '@anthropic-ai/sdk/_vendor/partial-json-parser/parser';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { processEvents } from '@inkup/core/process/align';
import {
  type ChangeItem,
  ChangeItemSchema,
  ChangeItemsOutputSchema,
  isLowConfidence,
} from '@inkup/core/process/change-item';
import {
  buildCombinePrompt,
  buildCombineRepairMessage,
  CombineOutputSchema,
  checkCombineOutput,
  combinedChanges,
  missingCitations,
} from '@inkup/core/process/combine';
import { estimateCost, estimateOutputTokens, type ModelCatalog, outputCapFor } from '@inkup/core/process/cost';
import {
  buildDraftPrompt,
  checkDraftOutput,
  coveredAnnotationIds,
  type DraftOutputItem,
  DraftOutputSchema,
} from '@inkup/core/process/draft';
import { groundItems } from '@inkup/core/process/grounding';
import { processInCode } from '@inkup/core/process/in-code';
import { mergePinnedDrafts } from '@inkup/core/process/pins';
import {
  aliasScreenshotIds,
  buildRepairMessage,
  buildSecondPassMessage,
  checkAgainstSession,
  restoreScreenshotIds,
  type ScriptContext,
} from '@inkup/core/process/script';
import { planChunks, renumberWindows, splitWindow } from '@inkup/core/process/sections';
import { attachStyleChanges } from '@inkup/core/process/style-changes';
import { mergeTextComments, needsModel } from '@inkup/core/process/text-comments';
import { withViewportSizes } from '@inkup/core/process/viewport';
import {
  buildWindowPrompt,
  coverageIssues,
  mergeWindowResults,
  owns,
  type ProcessWindow,
  renumberItems,
  sessionLength,
  unaccountedAnnotations,
  type WindowPrompt,
  type WindowResult,
} from '@inkup/core/process/windows';
import type { SessionDocument } from '@inkup/core/session-document';
import pLimit from 'p-limit';
import type { z } from 'zod';
import { createMessagesTransport, outputConfig, systemBlocks } from './messages';
import type { Part, Transport, Turn } from './transport';
import {
  type CallRecord,
  type ChunkProgress,
  type CombineResult,
  type ConnectionTest,
  type DraftResult,
  type Effort,
  type LlmAdapter,
  ProcessError,
  type ProcessResult,
} from './types';

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** The Gateway's base URL, or a local stub server (e2e). Absent: the SDK default (api.anthropic.com). */
  baseURL?: string | null;
  /** Who answers, in error messages. Default 'Anthropic'. */
  vendor?: string;
  /** The cached model lists: output caps and prices of models the dated tables do not have. */
  catalog?: ModelCatalog | null;
  /** Override for tests. */
  fetch?: typeof fetch;
  maxRetries?: number;
}

const DRAFT_MAX_TOKENS = 2_000;
const COMBINE_MAX_TOKENS = 4_000;
/** The CallRecord kind of a call's repair retry. */
const REPAIR_KIND = {
  main: 'repair',
  second_pass: 'second_pass_repair',
  draft: 'draft_repair',
  combine: 'combine_repair',
} as const;
/** Process chunks streamed at once. */
const CONCURRENCY = 2;
/** How many times one part of the Session may be halved after running out of tokens. */
const MAX_SPLITS = 3;
/** Re-parse the streamed answer for completed items after this many new characters. */
const PARSE_EVERY_CHARS = 400;

type Messages = Turn[];

/**
 * One structured-output call. The root is usually `{items: [...]}` (Process may add `dropped_annotations`); a
 * combine answers one object.
 */
interface Call<O extends object, T = never> {
  model: string;
  /** Sent as `output_config.effort` only when set. */
  effort?: Effort;
  system: string;
  messages: Messages;
  schema: z.ZodType<O>;
  /** Session checks the schema cannot express (unknown screenshots or Annotations, Annotations left out). */
  check: (output: O) => string[];
  maxTokens: number;
  /** Called with each `items` entry that is complete while the answer streams (validated with this schema). */
  onItem?: { schema: z.ZodType<T>; emit: (item: T, index: number) => void };
  /** The repair turn's message. Default: the `{items: [...]}` one. */
  repairMessage?: (issues: readonly string[]) => string;
  /** Default: the Messages API. */
  transport?: Transport;
}

interface Attempt<O> {
  output: O | null;
  raw: string;
  issues: string[];
  usage: { input_tokens: number; output_tokens: number };
  /** The answer stopped at max_tokens: it is incomplete, so it is neither repaired nor used. */
  truncated: boolean;
}

/** A chunk whose answer did not fit: split it instead of repairing it. */
class Truncated extends Error {}

function toProcessError(e: unknown, vendor = 'Anthropic'): ProcessError {
  if (e instanceof ProcessError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new ProcessError('auth', `The ${vendor} key was rejected (${e.status}).`);
  if (e instanceof Anthropic.RateLimitError)
    return new ProcessError('rate_limit', `${vendor} rate limit reached. Try again in a minute.`);
  if (e instanceof Anthropic.APIConnectionError)
    return new ProcessError('network', `Could not reach ${vendor}: ${e.message}`);
  if (e instanceof Anthropic.APIError)
    return new ProcessError('api', `${vendor} API error ${e.status ?? ''}: ${e.message}`.trim());
  return new ProcessError('api', e instanceof Error ? e.message : String(e));
}

/**
 * A Session the model has nothing to add to (explicit Text Comments, typed Annotation comments, no other speech), or
 * any Session without a key (E11): its items are built in code and no call is made.
 */
export function processWithoutModel(doc: SessionDocument, model: string): ProcessResult {
  const events = processEvents(doc.events);
  const pins = processInCode(events, doc.session.start_url);
  // As after a model run: recorded style changes, viewport sizes and what the Session recorded go onto every item.
  const styled = attachStyleChanges(pins.items, events, doc.session.start_url).items;
  return {
    items: groundItems(withViewportSizes(styled, events), events),
    model,
    calls: [],
    second_pass: [],
    pins_converted: pins.pins_converted,
    pins_dropped: pins.pins_dropped,
    windows: 1,
    duplicates_merged: [],
    dropped_annotations: [],
    unaccounted_annotations: [],
  };
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): LlmAdapter {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    maxRetries: opts.maxRetries ?? 2,
    dangerouslyAllowBrowser: true,
  });
  const vendor = opts.vendor ?? 'Anthropic';
  const catalog = opts.catalog ?? null;
  const toError = (e: unknown) => toProcessError(e, vendor);
  const capFor = (model: string) => outputCapFor(model, catalog);
  const messages = createMessagesTransport(client, toError);

  /**
   * One structured-output call through its transport. Validation problems come back as issues, a max_tokens stop
   * as `truncated`, API failures throw. While it streams, items before the one still being written are complete:
   * they are validated and passed to `onItem` as soon as the next one starts.
   */
  async function attempt<O extends object, T>(call: Call<O, T>): Promise<Attempt<O>> {
    let emitted = 0;
    let parsedAt = 0;
    const emitComplete = (snapshot: string) => {
      if (!call.onItem || snapshot.length - parsedAt < PARSE_EVERY_CHARS) return;
      parsedAt = snapshot.length;
      let partial: unknown;
      try {
        partial = partialParse(snapshot);
      } catch {
        return;
      }
      const items = (partial as { items?: unknown[] } | null)?.items;
      if (!Array.isArray(items)) return;
      for (; emitted < items.length - 1; emitted++) {
        const ok = call.onItem.schema.safeParse(items[emitted]);
        if (ok.success) call.onItem.emit(ok.data, emitted);
      }
    };
    const { raw, usage, stop } = await (call.transport ?? messages).send({
      model: call.model,
      effort: call.effort,
      system: call.system,
      messages: call.messages,
      schema: call.schema,
      maxTokens: call.maxTokens,
      onText: call.onItem ? emitComplete : undefined,
    });
    if (stop === 'refusal') throw new ProcessError('refusal', 'The model declined to process this Session.');
    // Cut off at max_tokens: incomplete, so neither repaired nor used.
    if (stop === 'max_tokens') return { output: null, raw, issues: [], usage, truncated: true };
    if (!raw.trim()) return { output: null, raw, issues: ['the answer contained no JSON'], usage, truncated: false };
    let parsed: O;
    try {
      // The same JSON and Zod checks the SDK's structured-output helper runs, whichever transport answered.
      parsed = zodOutputFormat(call.schema).parse(raw);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        output: null,
        raw,
        issues: [message.replace(/^Failed to parse structured output: (Error: )?/, '')],
        usage,
        truncated: false,
      };
    }
    const issues = call.check(parsed);
    return { output: issues.length ? null : parsed, raw, issues, usage, truncated: false };
  }

  const tooLong = (call: { model: string; maxTokens: number }) =>
    new ProcessError(
      'max_tokens',
      `The answer did not fit in ${call.maxTokens.toLocaleString('en-US')} output tokens, the most ${call.model} can write in one answer.`,
    );

  /**
   * attempt(), plus exactly one repair retry when validation fails. A truncated answer is never repaired: it throws
   * Truncated when `splittable` (the caller splits the chunk), else a readable max_tokens error.
   */
  async function withRepair<O extends object, T>(
    call: Call<O, T>,
    calls: CallRecord[],
    kind: keyof typeof REPAIR_KIND,
    record: Partial<CallRecord> = {},
    splittable = false,
  ): Promise<O> {
    const onTruncated = (a: Attempt<O>) => {
      calls.push({ kind: 'truncated', ...a.usage, ...record });
      throw splittable ? new Truncated() : tooLong(call);
    };
    const first = await attempt(call);
    if (first.truncated) onTruncated(first);
    calls.push({ kind, ...first.usage, ...record });
    if (first.output) return first.output;
    const repair: Messages = [
      ...call.messages,
      { role: 'assistant', content: first.raw || '(no output)' },
      { role: 'user', content: (call.repairMessage ?? buildRepairMessage)(first.issues) },
    ];
    // Items already shown from the first answer stay; the repaired answer replaces them when the chunk is done.
    const second = await attempt({ ...call, messages: repair, onItem: undefined });
    if (second.truncated) onTruncated(second);
    calls.push({ kind: REPAIR_KIND[kind], ...second.usage, ...record });
    if (second.output) return second.output;
    throw new ProcessError('invalid_output', `The model's answer failed validation twice: ${second.issues.join('; ')}`);
  }

  type ProcessOutput = z.infer<typeof ChangeItemsOutputSchema>;
  const changeItemsCall = (
    model: string,
    effort: Effort | undefined,
    system: string,
    messages: Messages,
    ctx: ScriptContext,
    opts: {
      expectCount?: number;
      coverage?: { owned: number[] };
      onItem?: (item: ChangeItem, index: number) => void;
    } = {},
  ): Call<ProcessOutput, ChangeItem> => ({
    model,
    effort,
    system,
    messages,
    schema: ChangeItemsOutputSchema,
    check: ({ items, dropped_annotations }) => [
      ...checkAgainstSession(items, ctx),
      // Windowed Sessions: every Annotation the window owns is used or dropped with a reason (no silent truncation).
      ...(opts.coverage
        ? coverageIssues(
            items,
            dropped_annotations ?? [],
            opts.coverage.owned,
            new Set(Object.keys(ctx.annotations).map(Number)),
          )
        : []),
      ...(opts.expectCount !== undefined && items.length !== opts.expectCount
        ? [`items: expected exactly ${opts.expectCount} item, got ${items.length}`]
        : []),
    ],
    maxTokens: capFor(model),
    onItem: opts.onItem ? { schema: ChangeItemSchema, emit: opts.onItem } : undefined,
  });

  const planFor = (doc: SessionDocument, model: string) => {
    const events = processEvents(doc.events);
    const length = sessionLength(doc);
    return { events, length, windows: planChunks(events, length, { outputCap: capFor(model) }) };
  };
  /** Estimated answer size of one window: its own Annotations and speech (all of them for a single window). */
  const windowEstimate = (doc: SessionDocument, window: ProcessWindow, owned: number[]) =>
    estimateOutputTokens(
      owned.length,
      doc.events.filter((e) => e.type === 'transcript_segment' && (window.count === 1 || owns(window, e.t))).length,
    );

  return {
    async estimate({ doc, model, effort }) {
      // Every chunk is its own call, so the estimate sums them all.
      const calls: { input: number; output: number }[] = [];
      // Only explicit Text Comments: converted in code, no call to pay for.
      if (!needsModel(processEvents(doc.events))) return { ...estimateCost(model, 0, 0, catalog), chunks: 0 };
      const { windows } = planFor(doc, model);
      for (const window of windows) {
        const { system, script, owned } = buildWindowPrompt(doc, window);
        const count = await client.messages
          .countTokens({
            model,
            system: systemBlocks(system),
            messages: [{ role: 'user', content: script }],
            output_config: outputConfig(zodOutputFormat(ChangeItemsOutputSchema), effort),
          })
          .catch((e: unknown) => {
            throw toError(e);
          });
        calls.push({ input: count.input_tokens, output: windowEstimate(doc, window, owned) });
      }
      const input = calls.reduce((n, c) => n + c.input, 0);
      const output = calls.reduce((n, c) => n + c.output, 0);
      return { ...estimateCost(model, input, output, catalog), chunks: windows.length, chunk_tokens: calls };
    },

    async process({ doc, model, effort, loadScreenshot, onProgress }): Promise<ProcessResult> {
      if (!needsModel(processEvents(doc.events))) return processWithoutModel(doc, model);
      const { events: planned, length, windows: initial } = planFor(doc, model);
      const calls: CallRecord[] = [];
      const report = (p: ChunkProgress) => {
        try {
          onProgress?.(p);
        } catch {
          /* progress is best effort */
        }
      };

      // Chunks by a stable id; `live` holds the windows still standing (a split replaces one with its halves).
      let nextId = 0;
      type Chunk = { id: number; window: ProcessWindow; depth: number };
      let live: Chunk[] = initial.map((window) => ({ id: nextId++, window, depth: 0 }));
      const done = new Map<
        number,
        { prompt: WindowPrompt; items: ChangeItem[]; dropped: { annotation: number; reason: string }[] }
      >();
      const coreEnd = (w: ProcessWindow) => (w.end === Infinity ? null : w.end);
      for (const c of live)
        report({ chunk: c.id, start: c.window.start, end: coreEnd(c.window), status: 'queued', items: [] });

      const limit = pLimit(CONCURRENCY);
      const runChunk = async (chunk: Chunk): Promise<void> => {
        const outcome = await limit(async () => {
          // Numbered against the chunks standing now: a split renumbers the windows after it.
          const window = live.find((c) => c.id === chunk.id)?.window ?? chunk.window;
          const prompt = buildWindowPrompt(doc, window);
          const windowed = window.count > 1;
          const streamed: ChangeItem[] = [];
          report({ chunk: chunk.id, start: window.start, end: coreEnd(window), status: 'streaming', items: [] });
          try {
            const out = await withRepair(
              changeItemsCall(
                model,
                effort,
                prompt.system,
                [{ role: 'user', content: prompt.script }],
                prompt.context,
                {
                  ...(windowed ? { coverage: { owned: prompt.owned } } : {}),
                  onItem: (item) => {
                    streamed.push(restoreScreenshotIds(item, prompt.context));
                    report({
                      chunk: chunk.id,
                      start: window.start,
                      end: coreEnd(window),
                      status: 'streaming',
                      items: [...streamed],
                    });
                  },
                },
              ),
              calls,
              'main',
              { chunk: chunk.id, estimated_output: windowEstimate(doc, window, prompt.owned) },
              chunk.depth < MAX_SPLITS,
            );
            const items = out.items.map((item) => restoreScreenshotIds(item, prompt.context));
            done.set(chunk.id, { prompt, items, dropped: out.dropped_annotations ?? [] });
            report({ chunk: chunk.id, start: window.start, end: coreEnd(window), status: 'done', items });
            return null;
          } catch (e) {
            if (!(e instanceof Truncated)) throw e;
            const halves = splitWindow(planned, window, length);
            if (!halves) throw tooLong({ model, maxTokens: capFor(model) });
            return halves;
          }
        });
        if (!outcome) return;
        // Ran out of output tokens: replace the chunk with its two halves and run both.
        const halves = outcome.map((window) => ({ id: nextId++, window, depth: chunk.depth + 1 }));
        const renumbered = renumberWindows([
          ...live.filter((c) => c.id !== chunk.id).map((c) => c.window),
          ...halves.map((h) => h.window),
        ]);
        live = [...live.filter((c) => c.id !== chunk.id), ...halves].map((c) => ({
          ...c,
          window: renumbered.find((w) => w.start === c.window.start)!,
        }));
        report({ chunk: chunk.id, start: chunk.window.start, end: coreEnd(chunk.window), status: 'split', items: [] });
        for (const h of halves)
          report({ chunk: h.id, start: h.window.start, end: coreEnd(h.window), status: 'queued', items: [] });
        await Promise.all(halves.map(runChunk));
      };
      await Promise.all(live.map(runChunk));

      // Final numbering: the standing windows in time order.
      const ordered = [...live].sort((a, b) => a.window.start - b.window.start);
      const prompts = ordered.map((c) => done.get(c.id)!.prompt);
      const results: WindowResult[] = ordered.map((c, index) => ({
        window: { ...c.window, index, count: ordered.length },
        items: done.get(c.id)!.items,
        dropped: done.get(c.id)!.dropped,
      }));
      const windowed = results.length > 1;
      const events = processEvents(doc.events);
      const merged = windowed
        ? mergeWindowResults(results, events)
        : {
            items: [...results[0]!.items],
            duplicates: [],
            dropped: [...results[0]!.dropped],
            source: {} as Record<string, number>,
          };
      // Text Comments: explicit replacements, and comments the model left out, become items in code.
      const commented = mergeTextComments(merged.items, events, doc.session.start_url).items;
      // Pinned Draft Items are fixed: enforce them once over the merged list, before anything else can touch the items.
      const pins = mergePinnedDrafts(commented, events, doc.session.start_url);
      // Windowed: the pin merge can drop rewrites, so number the final list again (item_0001… in time order).
      const final = windowed ? renumberItems(pins.items) : { items: pins.items, from: {} as Record<string, string> };
      const items = final.items;
      const secondPass: string[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.pinned || !isLowConfidence(item) || !loadScreenshot) continue;
        const { script, context } = prompts[merged.source[final.from[item.id] ?? item.id] ?? 0] ?? prompts[0]!;
        const images: Part[] = [];
        const attached: string[] = [];
        for (const id of item.evidence.screenshots) {
          const img = await loadScreenshot(id);
          if (!img) continue;
          const alias = Object.entries(context.aliases).find(([, stored]) => stored === id)?.[0] ?? id;
          images.push(
            { type: 'text', text: `Screenshot ${alias}:` },
            { type: 'image', media_type: img.media_type, data: img.data },
          );
          attached.push(alias);
        }
        if (attached.length === 0) continue;
        const content: Part[] = [
          ...images,
          { type: 'text', text: buildSecondPassMessage(script, aliasScreenshotIds(item, context), attached) },
        ];
        const {
          items: [revised],
        } = await withRepair(
          changeItemsCall(model, effort, prompts[0]!.system, [{ role: 'user', content }], context, { expectCount: 1 }),
          calls,
          'second_pass',
        );
        items[i] = { ...restoreScreenshotIds(revised!, context), id: item.id, pinned: item.pinned };
        secondPass.push(item.id);
      }
      // Recorded style changes are exact: passed through from the timeline, whatever the model wrote.
      const styled = attachStyleChanges(items, events, doc.session.start_url).items;
      // Then the viewport sizes the Annotations were seen at, and what the Session recorded (Candidate sources,
      // element crops, page API origin) go onto every item, including the ones the style pass-through added.
      const grounded = groundItems(withViewportSizes(styled, events), events);
      return {
        items: grounded,
        model,
        calls,
        second_pass: secondPass,
        pins_converted: pins.converted,
        pins_dropped: pins.dropped,
        windows: results.length,
        duplicates_merged: merged.duplicates,
        dropped_annotations: merged.dropped,
        unaccounted_annotations: unaccountedAnnotations(grounded, merged.dropped, events),
      };
    },

    async draft({ model, effort, ...input }): Promise<DraftResult> {
      const prompt = buildDraftPrompt(input);
      if (prompt.empty) return { items: [], calls: [], skipped: true };
      const calls: CallRecord[] = [];
      const { items } = await withRepair<z.infer<typeof DraftOutputSchema>, DraftOutputItem>(
        {
          model,
          effort,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.script }],
          schema: DraftOutputSchema,
          check: (o) => checkDraftOutput(o.items, prompt.context),
          maxTokens: DRAFT_MAX_TOKENS,
        },
        calls,
        'draft',
      );
      return {
        items: items.map((item) => ({ ...item, annotation_ids: coveredAnnotationIds(item, prompt.context) })),
        calls,
        skipped: false,
      };
    },

    async combine({ into, from, model, effort }): Promise<CombineResult> {
      const prompt = buildCombinePrompt(into, from);
      const calls: CallRecord[] = [];
      const output = await withRepair(
        {
          model,
          effort,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.script }],
          schema: CombineOutputSchema,
          check: (o) => checkCombineOutput(o, prompt.context),
          maxTokens: COMBINE_MAX_TOKENS,
          repairMessage: buildCombineRepairMessage,
        },
        calls,
        'combine',
      );
      const changes = combinedChanges(output, prompt.context);
      // Belt and braces: the restored prompt still cites every screenshot and crop the two source prompts did.
      const missing = missingCitations(into, from, changes.agent_prompt);
      if (missing.length)
        throw new ProcessError(
          'invalid_output',
          `The combined prompt left out ${missing.map((id) => `screenshots/${id}.png`).join(', ')}.`,
        );
      return { changes, calls };
    },

    async test(models): Promise<ConnectionTest> {
      const [first, ...rest] = models;
      if (!first) return { ok: false, message: 'No model to test.' };
      try {
        // count_tokens is free and proves the key and the first model ID; one 1-token message proves each other one
        // (the first too when it is the only one).
        await client.messages.countTokens({ model: first, messages: [{ role: 'user', content: 'ping' }] });
        for (const model of rest.length ? rest : [first])
          await client.messages.create({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
          });
        const names = models.length > 1 ? `${models.slice(0, -1).join(', ')} and ${models.at(-1)}` : first;
        return { ok: true, message: `Key works with ${names}.` };
      } catch (e) {
        return { ok: false, message: toError(e).message };
      }
    },
  };
}
