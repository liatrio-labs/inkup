// Combine (E12): after the reviewer merges two Change Items on the review page, a small, fast model rewrites the
// merged item's words as one request. Pure, like the Process and Draft prompt builders.
//
// - The merge itself stays deterministic (mergeItems in ../review-edits.ts): Locations, Evidence, crops, style
//   changes, pinned and confidence are unioned in code and shown at once. The model only writes title, category,
//   intent, agent_prompt and ambiguity, logged as an `edit` op with `origin: 'combine'`. Replay never calls it.
// - Text only. Screenshot ids go to the model as short aliases (s1, s2, …) and come back restored.
// - Grounding lines (codebase source, element close-ups) are taken off the source prompts and put back on the
//   answer in code, so the crops are always cited whatever the model writes.
// - Every screenshot either source prompt cited must still be cited: checked, one repair, else the caller keeps
//   the concatenated merge.
import { z } from 'zod';
import { Category } from '../timeline.ts';
import { type ChangeItem, isLowConfidence, LOW_CONFIDENCE, screenshotCitation } from './change-item.ts';
import { CROP_PROMPT_PREFIX, SOURCE_PROMPT_PREFIX } from './grounding.ts';

export const CombineOutputSchema = z.object({
  title: z.string().min(1).describe('imperative, under ~80 chars, covering the whole combined request'),
  category: Category,
  intent: z.string().min(1).describe('what the reviewer wants and why, one or two sentences'),
  agent_prompt: z
    .string()
    .min(1)
    .describe(
      'one self-contained instruction for a coding agent; cites every REQUIRED CITATION as screenshots/<id>.png',
    ),
  ambiguity: z
    .string()
    .nullable()
    .describe('what is unclear or contradictory between the two requests, one sentence; null when nothing is'),
});
export type CombineOutput = z.infer<typeof CombineOutputSchema>;

/** What a combine writes onto the merged item: an `edit` op's changes. */
export interface CombinedChanges {
  title: string;
  category: ChangeItem['category'];
  intent: string;
  agent_prompt: string;
  /** null: the merged item has no ambiguity. */
  ambiguity: string | null;
}

export interface CombineContext {
  /** Alias (s1, s2, …) → stored screenshot or crop id. */
  aliases: Record<string, string>;
  /** Aliases the answer's agent_prompt must cite: every screenshot either source prompt body cited. */
  required: string[];
  /** The merged item is low confidence, so the answer must say what is unclear. */
  needs_ambiguity: boolean;
  /** Grounding lines of both source prompts, deduplicated, put back after the answer (crop line rebuilt). */
  source_lines: string[];
  crops: string[];
}

export interface CombinePrompt {
  system: string;
  script: string;
  context: CombineContext;
}

const CITATION = /screenshots\/([\w.-]+?)\.png/g;
const citations = (text: string) => [...text.matchAll(CITATION)].map((m) => m[1]!);
const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

/** A prompt without the grounding lines grounding.ts appends. */
function splitGrounding(prompt: string): { body: string; sources: string[] } {
  const lines = prompt.split('\n');
  const body = lines.filter((l) => !l.startsWith(SOURCE_PROMPT_PREFIX) && !l.startsWith(CROP_PROMPT_PREFIX));
  return { body: body.join('\n').trimEnd(), sources: lines.filter((l) => l.startsWith(SOURCE_PROMPT_PREFIX)) };
}

const cropLine = (crops: readonly string[]) =>
  `${CROP_PROMPT_PREFIX} ${crops.map(screenshotCitation).join(', ')} (the screenshot cropped to the marked element).`;

/** `into` and `from` as they were before the merge; `into` is the one that keeps its id. */
export function buildCombinePrompt(into: ChangeItem, from: ChangeItem): CombinePrompt {
  const parts = [into, from].map((item) => ({ item, ...splitGrounding(item.agent_prompt) }));
  const ids = unique(
    parts.flatMap(({ item, body }) => [
      ...citations(body),
      ...item.evidence.screenshots,
      ...item.locations.flatMap((l) => (l.screenshot ? [l.screenshot] : [])),
    ]),
  );
  const aliasOf = new Map(ids.map((id, i) => [id, `s${i + 1}`]));
  const alias = (id: string) => aliasOf.get(id) ?? id;
  const aliasText = (text: string) => text.replace(CITATION, (_m, id: string) => screenshotCitation(alias(id)));
  const required = unique(parts.flatMap((p) => citations(p.body))).map(alias);
  const needs_ambiguity = isLowConfidence({ confidence: Math.min(into.confidence, from.confidence) });

  const block = (label: string, { item, body }: (typeof parts)[number]) =>
    [
      `ITEM ${label}`,
      `title: ${JSON.stringify(item.title)}`,
      `category: ${item.category}`,
      `intent: ${JSON.stringify(item.intent)}`,
      `transcript: ${JSON.stringify(item.transcript)}`,
      `ambiguity: ${item.ambiguity?.trim() ? JSON.stringify(item.ambiguity) : 'none'}`,
      'locations:',
      ...item.locations.map(
        (l) =>
          `- ${l.role}: ${l.element}${l.selector ? ` (${l.selector})` : ''} on ${l.url}${l.annotation !== null ? ` · Annotation #${l.annotation}` : ''}${l.screenshot ? ` · screenshot ${alias(l.screenshot)}` : ''}`,
      ),
      `screenshots: ${item.evidence.screenshots.map(alias).join(', ') || 'none'}`,
      'agent_prompt:',
      aliasText(body),
    ].join('\n');

  const script = [
    block('A', parts[0]!),
    '',
    block('B', parts[1]!),
    '',
    `REQUIRED CITATIONS (the agent_prompt must contain each): ${required.map(screenshotCitation).join(', ') || 'none'}`,
    ...(needs_ambiguity ? [`One item is unsure (confidence under ${LOW_CONFIDENCE}): ambiguity is required.`] : []),
  ].join('\n');

  return {
    system: buildCombineSystemPrompt(),
    script,
    context: {
      aliases: Object.fromEntries([...aliasOf].map(([id, a]) => [a, id])),
      required,
      needs_ambiguity,
      source_lines: unique(parts.flatMap((p) => p.sources)),
      crops: unique([...(into.evidence.crops ?? []), ...(from.evidence.crops ?? [])]),
    },
  };
}

/** Stable, so it can be prompt-cached. */
export function buildCombineSystemPrompt(): string {
  return `You combine two Change Items into one. A reviewer recorded a review of a web page; a model turned it into Change Items (requests for a coding agent); the reviewer has now merged two of them because they are one change, or belong together. Write the merged item's words so it reads as one coherent request, not two pasted together.

## Input
ITEM A and ITEM B, each with its title, category, intent, the reviewer's words (transcript), ambiguity, Locations and agent_prompt. Screenshots are named s1, s2, …; you do not see them.

## Output
One JSON object:
- title: imperative, under ~80 characters, covering the whole combined request.
- category: layout (position, size, spacing, order), style (color, font, weight), copy (wording), content (add or remove), behavior (interaction), bug (broken), question (the reviewer asks). Pick the one that fits the combined request best.
- intent: one or two sentences: what the reviewer wants and why.
- agent_prompt: one self-contained instruction for a coding agent. Keep every concrete detail from both prompts (selectors, pages, values, wording), state each thing once, and resolve overlap. Cite every REQUIRED CITATION as screenshots/<id>.png, exactly as written.
- ambiguity: null when the two requests fit together. When they genuinely contradict each other (two different values for the same thing, "move it left" and "move it right"), or something stays unclear, say so in one sentence and keep both readings in agent_prompt instead of picking one. Required when the input says one item is unsure.

Do not invent requests neither item makes. Do not drop requests either item makes.`;
}

/** Problems an answer has that the schema cannot express. Feeds the repair retry. */
export function checkCombineOutput(output: CombineOutput, ctx: CombineContext): string[] {
  const issues: string[] = [];
  const cited = new Set(citations(output.agent_prompt));
  for (const a of ctx.required) if (!cited.has(a)) issues.push(`agent_prompt: must cite ${screenshotCitation(a)}`);
  for (const a of cited)
    if (!(a in ctx.aliases)) issues.push(`agent_prompt: ${screenshotCitation(a)} is not a screenshot of either item`);
  if (ctx.needs_ambiguity && !output.ambiguity?.trim())
    issues.push(`ambiguity: required, one item is unsure (confidence under ${LOW_CONFIDENCE})`);
  return issues;
}

/** The repair turn, for the single-object answer. */
export function buildCombineRepairMessage(issues: readonly string[]): string {
  return `Your answer did not pass validation:\n${issues.map((i) => `- ${i}`).join('\n')}\nReturn the complete corrected JSON object, fixing only what is listed.`;
}

/** A checked answer as the merged item's changes: stored ids restored, grounding lines put back. */
export function combinedChanges(output: CombineOutput, ctx: CombineContext): CombinedChanges {
  const body = splitGrounding(
    output.agent_prompt.replace(CITATION, (_m, a: string) => screenshotCitation(ctx.aliases[a] ?? a)),
  ).body;
  const extra = [...ctx.source_lines, ...(ctx.crops.length ? [cropLine(ctx.crops)] : [])];
  return {
    title: output.title.trim(),
    category: output.category,
    intent: output.intent.trim(),
    agent_prompt: extra.length ? `${body}\n${extra.join('\n')}` : body,
    ambiguity: output.ambiguity?.trim() || null,
  };
}

/** Screenshot and crop ids `into` and `from` cite that `prompt` does not: must be empty for a combine to be kept. */
export function missingCitations(
  into: Pick<ChangeItem, 'agent_prompt'>,
  from: Pick<ChangeItem, 'agent_prompt'>,
  prompt: string,
): string[] {
  const cited = new Set(citations(prompt));
  return unique([...citations(into.agent_prompt), ...citations(from.agent_prompt)]).filter((id) => !cited.has(id));
}
