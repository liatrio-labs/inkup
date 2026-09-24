// The live Draft Item pass (PRD P0-10): a small, fast model reads what happened since the previous pass and
// proposes Draft Items for the side panel. Pure, like the Process prompt builder it shares a renderer with.
//
// - Input: the §7 script format, but only the events since the previous pass, plus the last 2 Draft Items (and
//   their pinned or discarded state) for continuity. Text only: screenshots are named, never attached.
// - Output: a small DraftItem schema, validated with Zod through the same structured-output path and repair
//   retry as Process (src/adapters/llm/anthropic.ts).
import { z } from 'zod';
import { draftLocationSummary, draftViews } from '../drafts.ts';
import { applyTranscriptEdits } from '../review-edits.ts';
import { Category, DraftLocationSchema, type EventOf, type TimelineEvent } from '../timeline.ts';
import { renderEvents, scriptHeader, scriptQuality, stamp } from './script.ts';

export const RECENT_DRAFTS = 2;
export const MAX_DRAFTS_PER_PASS = 5;

const DraftOutputItemObject = z.object({
  title: z.string().min(1).describe('imperative, under ~60 chars'),
  category: Category,
  intent: z.string().min(1).describe('what the reviewer wants, one sentence'),
  transcript: z.string().describe("the reviewer's words this draft came from, verbatim"),
  locations: z.array(DraftLocationSchema).min(1),
});
export const DraftOutputItemSchema = DraftOutputItemObject.superRefine((item, ctx) => {
  if (!item.locations.some((l) => l.role === 'subject'))
    ctx.addIssue({ code: 'custom', path: ['locations'], message: 'at least one Location must have role "subject"' });
});
export type DraftOutputItem = z.infer<typeof DraftOutputItemSchema>;
export const DraftOutputSchema = z.object({ items: z.array(DraftOutputItemSchema).max(MAX_DRAFTS_PER_PASS) });
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export interface DraftContext {
  /** Annotation number → annotation_id, for every Annotation not taken back by scratch that. */
  annotations: Record<number, string>;
}

export interface DraftPrompt {
  system: string;
  script: string;
  context: DraftContext;
  /** No new Annotation and no new speech: nothing to draft, so no call is made. */
  empty: boolean;
}

export interface DraftPromptInput {
  /** The whole timeline so far, in log order. */
  events: readonly TimelineEvent[];
  /** Ids of the events that arrived since the previous pass: only these are rendered. */
  fresh: ReadonlySet<string>;
  start_url: string;
}

type Ev<T extends TimelineEvent['type']> = EventOf<T>;

export function buildDraftPrompt({ events: raw, fresh, start_url }: DraftPromptInput): DraftPrompt {
  const events = applyTranscriptEdits(raw);
  const quality = scriptQuality(events, undefined);
  // Drafts, actions and commands are context, not new content: the recent drafts section covers them.
  const content = (e: TimelineEvent) =>
    fresh.has(e.id) && e.type !== 'draft_item' && e.type !== 'draft_action' && e.type !== 'voice_command';
  const { lines, context, rendered } = renderEvents(events, start_url, quality, content);
  const since = events.filter((e) => fresh.has(e.id)).reduce((m, e) => Math.min(m, e.t), Infinity);

  const recent = draftViews(events).slice(-RECENT_DRAFTS);
  const recentLines = recent.map((v) => {
    const where = draftLocationSummary(v.draft, true);
    const state =
      v.state === 'pinned'
        ? ' · PINNED by the reviewer'
        : v.state === 'discarded'
          ? ' · DISCARDED by the reviewer: do not produce this reading again'
          : '';
    return `- ${v.draft.draft_id} ${JSON.stringify(v.draft.title)} (${v.draft.category})${where ? ` · ${where}` : ''}${state}`;
  });

  const script = [
    ...scriptHeader(quality),
    `LIVE PASS: events since ${Number.isFinite(since) ? stamp(since) : 'the start'}; earlier events were covered by earlier passes.`,
    '',
    'RECENT DRAFT ITEMS (already shown to the reviewer; do not repeat them):',
    ...(recentLines.length ? recentLines : ['- none yet']),
    '',
    'NEW EVENTS:',
    ...lines,
  ].join('\n');

  const annotations: Record<number, string> = {};
  for (const e of events)
    if (e.type === 'annotation' && e.index in context.annotations) annotations[e.index] = e.annotation_id;
  return {
    system: buildDraftSystemPrompt(),
    script,
    context: { annotations },
    empty: rendered.annotations + rendered.speech === 0,
  };
}

/** Stable across Sessions, so it can be prompt-cached. */
export function buildDraftSystemPrompt(): string {
  return `You write Draft Items: quick, provisional readings of a live review of a web page, shown in a side panel while the reviewer is still talking and drawing. The reviewer glances at each card and pins it (right) or discards it (wrong). A later, careful pass writes the final Change Items, so be quick and literal.

## Input
A time-ordered script. Times are [mm:ss.s] from the start of the Session.
- TIMESTAMP QUALITY and PAIRING WINDOW say how precise speech times are.
- ANNOTATION #n: Strokes the reviewer drew, with its Candidates: c0 is the geometric PICK; the others are ancestors, covered siblings and enclosed descendants. "nouns:" lists what each can be called. A CONNECTOR arrow means a move from its tail (subject) to its head (destination).
- SPEECH: what the reviewer said, with the Annotations near each pointing word ("this", "here", "that").
- RECENT DRAFT ITEMS: what the panel already shows. Never repeat one. Never produce a DISCARDED reading again.
- NEW EVENTS: only what happened since the previous pass. Draft only from these.

## Output
{"items": [...]}, at most ${MAX_DRAFTS_PER_PASS}. One item per change the reviewer asked for in NEW EVENTS; "this" at one Annotation and "should go here" at another is one item. No items when the new events ask for nothing (filler, an unfinished thought, a restatement of a recent draft).
- title: imperative, under ~60 characters, e.g. "Move 'Get started' into the header".
- category: layout (position, size, spacing, order), style (color, font, weight), copy (wording), content (add or remove), behavior (interaction), bug (broken), question (the reviewer asks).
- intent: one sentence.
- transcript: the reviewer's own words for it, verbatim.
- locations: at least one "subject". Each has role (subject | reference | destination), element (a short name like button 'Get started'), selector (the chosen Candidate's selector copied exactly, or null for a region or the page) and annotation (its number, or null for speech with no Annotation). If the speech names a noun, pick the Candidate whose nouns include it; otherwise the PICK.`;
}

/** Problems a draft answer has against the Session (unknown or discarded Annotations). Feeds the repair retry. */
export function checkDraftOutput(items: readonly DraftOutputItem[], ctx: DraftContext): string[] {
  const issues: string[] = [];
  items.forEach((item, i) => {
    item.locations.forEach((l, j) => {
      if (l.annotation !== null && !(l.annotation in ctx.annotations))
        issues.push(`items.${i}.locations.${j}.annotation: there is no Annotation #${l.annotation}`);
    });
  });
  return issues;
}

/** The Annotations a draft covers, by id, in number order. */
export function coveredAnnotationIds(item: Pick<DraftOutputItem, 'locations'>, ctx: DraftContext): string[] {
  const idx = [...new Set(item.locations.map((l) => l.annotation).filter((a): a is number => a !== null))].sort(
    (a, b) => a - b,
  );
  return idx.map((n) => ctx.annotations[n]).filter((id): id is string => !!id);
}

/** The next free draft id: d1, d2, … */
export function nextDraftId(events: readonly TimelineEvent[]): string {
  const max = Math.max(
    0,
    ...events
      .filter((e): e is Ev<'draft_item'> => e.type === 'draft_item')
      .map((e) => Number(/^d(\d+)$/.exec(e.draft_id)?.[1] ?? 0)),
  );
  return `d${max + 1}`;
}
