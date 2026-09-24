// Text Comments in Process (E3). Each one becomes a `copy` Change Item on the element that holds the selection.
//
// - An explicit replacement ("This should say Pricing plans", `"Pricing plans"`, `minutes -> seconds`) needs no
//   model: it is converted in code with confidence 0.95, and the script shows it as already handled.
// - Any other comment goes to the model on a TEXT COMMENT line with its anchor and the speech said while the text
//   was selected. If the model's items leave its element out, it is converted in code too, so none is lost.
// - Speech while the text was selected (from the selection to the save) belongs to the comment: it is quoted on the
//   comment's line and joins its item's transcript.
// - A Session whose only content is explicit comments (and typed Annotation comments, E11) makes no model call at all
//   (needsModel, ./in-code.ts).

import { nextItemId } from '../review-edits.ts';
import type { EventOf, TimelineEvent } from '../timeline.ts';
import { stripCommandPhrase } from '../voice-command-effects.ts';
import { type ChangeItem, ChangeItemSchema, screenshotCitation } from './change-item.ts';
import { insertByTime } from './pins.ts';
import { displayUrl } from './script.ts';
import { liveAnnotations } from './windows.ts';

type Ev<T extends TimelineEvent['type']> = EventOf<T>;
export type TextComment = Ev<'text_comment'>;

/** Confidence of an item converted from an explicit replacement, and from any other comment the model left out. */
export const EXPLICIT_CONFIDENCE = 0.95;
export const CONVERTED_CONFIDENCE = 0.8;

export interface Replacement {
  /** The text to replace: the selection, or the part of it the comment names. */
  before: string;
  after: string;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const QUOTED = /^["“”'‘’«](.*)["“”'‘’»][.!]?$/s;

// Phrasings that state the new text outright (English). "should be" counts only with quotes: "this should be
// bigger" is a style request, not new copy.
const AFTER_ONLY: RegExp[] = [
  /^(?:(?:this|it|that)\s+)?(?:should|must|needs?\s+to|has\s+to|is\s+supposed\s+to)\s+(?:say|read)\s*:?\s*(.+)$/is,
  /^(?:(?:this|it|that)\s+)?(?:should|must|needs?\s+to)\s+be\s*:?\s*(["“‘'].+)$/is,
  /^(?:change|rename|reword|update)(?:\s+(?:this|it|that|the\s+text))?\s+to\s*:?\s*(.+)$/is,
  /^replace(?:\s+(?:this|it|that))?\s+(?:with|by)\s*:?\s*(.+)$/is,
  /^(?:say|read)\s*:\s*(.+)$/is,
  /^(?:->|→|=>)\s*(.+)$/s,
];
const BEFORE_AFTER: RegExp[] = [
  /^(?:change|rename)\s+(["“‘'].+?["”’'])\s+to\s*:?\s*(.+)$/is,
  /^(.+?)\s*(?:->|→|=>)\s*(.+)$/s,
];

function newText(raw: string, selected: string): string | null {
  const t = raw.trim();
  const quoted = QUOTED.exec(t);
  if (quoted) return quoted[1]!.trim() || null;
  let out = t.replace(/\s+(?:instead|please)[.!]?$/i, '');
  // A closing period is punctuation of the comment, unless the old text ended with one too.
  if (/[.!]$/.test(out) && !/[.!]$/.test(selected.trim())) out = out.slice(0, -1);
  return out.trim() || null;
}

const unquote = (s: string) => QUOTED.exec(s.trim())?.[1] ?? s.trim();

/** The comment's replacement text when it states one outright; null for any other comment. */
export function detectReplacement(comment: string, selected: string): Replacement | null {
  const c = comment.trim();
  const sel = collapse(selected);
  const done = (before: string, after: string | null): Replacement | null =>
    after && collapse(after) !== collapse(before) ? { before, after } : null;
  for (const re of BEFORE_AFTER) {
    const m = re.exec(c);
    if (!m) continue;
    const named = collapse(unquote(m[1]!));
    // "minutes -> seconds" on "Ship reviews in minutes": only "minutes" changes. A name the selection does not
    // contain is not a before-text (e.g. "Heading -> Pricing plans"), so the whole selection is replaced.
    const at = named ? sel.toLowerCase().indexOf(named.toLowerCase()) : -1;
    return done(at >= 0 ? sel.slice(at, at + named.length) : sel, newText(m[2]!, sel));
  }
  for (const re of AFTER_ONLY) {
    const m = re.exec(c);
    if (m) return done(sel, newText(m[1]!, sel));
  }
  const quoted = QUOTED.exec(c);
  return quoted ? done(sel, quoted[1]!.trim()) : null;
}

export const textComments = (events: readonly TimelineEvent[]): TextComment[] =>
  events.filter((e): e is TextComment => e.type === 'text_comment');

/** Speech said while the comment's text was selected, Voice Command phrases removed. `events` as Process reads them. */
export function textCommentSpeech(c: Pick<TextComment, 't' | 't_end'>, events: readonly TimelineEvent[]): string {
  const phrases = new Map<string, string[]>();
  for (const e of events)
    if (e.type === 'voice_command' && e.segment_id)
      phrases.set(e.segment_id, [...(phrases.get(e.segment_id) ?? []), e.phrase]);
  return events
    .filter((e): e is Ev<'transcript_segment'> => e.type === 'transcript_segment' && e.t <= c.t_end && e.t_end >= c.t)
    .map((e) => (phrases.get(e.segment_id) ?? []).reduce(stripCommandPhrase, e.text).trim())
    .filter(Boolean)
    .join(' ... ');
}

const short = (s: string, max = 60) => {
  const t = collapse(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** "heading 'Ship reviews in minutes'", as Locations name elements. */
export function textCommentElement(c: TextComment): string {
  const label = c.element.name || c.element.text;
  return `${c.element.role ?? c.element.tag}${label ? ` '${short(label)}'` : ''}`;
}

/** A Text Comment as a Change Item, built in code. `replacement` null: a comment that states no new text. */
export function textCommentToChangeItem(
  c: TextComment,
  events: readonly TimelineEvent[],
  startUrl: string,
  id: string,
  replacement = detectReplacement(c.comment, c.selected_text),
): ChangeItem {
  const url = displayUrl(c.url, startUrl);
  const element = textCommentElement(c);
  const speech = textCommentSpeech(c, events);
  const screenshots = c.screenshot_id ? [c.screenshot_id] : [];
  const where = `On ${url}, in ${element} (${c.element.selector})`;
  const context = `The text sits between "${c.anchor.prefix ? `…${c.anchor.prefix}` : ''}" and "${c.anchor.suffix ? `${c.anchor.suffix}…` : ''}".`;
  const shot = c.screenshot_id ? `${screenshotCitation(c.screenshot_id)} shows the selected text.` : null;
  const lines = replacement
    ? [`${where}, replace the text "${replacement.before}" with "${replacement.after}".`, context, shot]
    : [
        `${where}, change the text "${c.anchor.exact}" as the reviewer asks: ${c.comment}`,
        context,
        speech ? `The reviewer also said: "${speech}".` : null,
        shot,
      ];
  const secs = (ms: number) => Math.round(ms / 100) / 10;
  return ChangeItemSchema.parse({
    id,
    title: replacement
      ? `Change "${short(replacement.before, 40)}" to "${short(replacement.after, 40)}"`
      : `Revise "${short(c.anchor.exact, 50)}"`,
    category: 'copy',
    intent: replacement
      ? `Replace the text "${replacement.before}" with "${replacement.after}".`
      : `The reviewer commented on the text "${short(c.anchor.exact, 120)}": ${c.comment}`,
    locations: [
      { role: 'subject', selector: c.element.selector, element, url, screenshot: c.screenshot_id, annotation: null },
    ],
    evidence: { video: { start: secs(c.t), end: secs(Math.max(c.t, c.t_end)) }, screenshots },
    transcript: [c.comment, speech].filter(Boolean).join(' ... '),
    confidence: replacement ? EXPLICIT_CONFIDENCE : CONVERTED_CONFIDENCE,
    agent_prompt: lines.filter(Boolean).join('\n'),
    pinned: false,
  });
}

const subjectsOn = (item: ChangeItem, c: TextComment, startUrl: string) =>
  item.locations.some((l) => l.selector === c.element.selector && l.url === displayUrl(c.url, startUrl));

/**
 * False when the model has nothing to do (./in-code.ts builds the items): every Text Comment is explicit, every live
 * Annotation has a typed comment (E11), and nothing was said outside the explicit comments. A Session with neither
 * Text Comments nor Annotations goes to the model, as before.
 */
export function needsModel(events: readonly TimelineEvent[]): boolean {
  const comments = textComments(events);
  const annotations = liveAnnotations(events);
  if (comments.length === 0 && annotations.length === 0) return true;
  const explicit = comments.filter((c) => detectReplacement(c.comment, c.selected_text));
  if (explicit.length < comments.length || annotations.some((a) => !(a.page_api?.comment ?? a.comment)?.trim()))
    return true;
  const phrases = new Map<string, string[]>();
  for (const e of events)
    if (e.type === 'voice_command' && e.segment_id)
      phrases.set(e.segment_id, [...(phrases.get(e.segment_id) ?? []), e.phrase]);
  return events.some(
    (e) =>
      e.type === 'transcript_segment' &&
      (phrases.get(e.segment_id) ?? []).reduce(stripCommandPhrase, e.text).trim() !== '' &&
      !explicit.some((c) => e.t <= c.t_end && e.t_end >= c.t),
  );
}

export interface TextCommentMerge {
  items: ChangeItem[];
  /** comment_id → the item id that carries it (explicit ones and the ones converted because the model left them out). */
  converted: Record<string, string>;
  /** Model item ids dropped as rewrites of an explicit comment. */
  dropped: string[];
}

/** Items with every Text Comment accounted for. `items` carry stored screenshot ids (after restoreScreenshotIds). */
export function mergeTextComments(
  items: readonly ChangeItem[],
  events: readonly TimelineEvent[],
  startUrl: string,
): TextCommentMerge {
  let out = [...items];
  const result: TextCommentMerge = { items: [], converted: {}, dropped: [] };
  const ids = () => [...items.map((i) => i.id), ...out.map((i) => i.id)];
  for (const c of textComments(events)) {
    const replacement = detectReplacement(c.comment, c.selected_text);
    if (replacement) {
      // The model was told this one is handled; an item of its own about the same text is a rewrite.
      const dupes = out
        .filter(
          (i) =>
            !i.pinned &&
            i.category === 'copy' &&
            subjectsOn(i, c, startUrl) &&
            i.locations.every((l) => l.annotation === null),
        )
        .map((i) => i.id);
      result.dropped.push(...dupes);
      out = out.filter((i) => !dupes.includes(i.id));
    } else if (out.some((i) => subjectsOn(i, c, startUrl))) {
      continue;
    }
    const item = textCommentToChangeItem(c, events, startUrl, nextItemId(ids()), replacement);
    out = insertByTime(out, item);
    result.converted[c.comment_id] = item.id;
  }
  result.items = out;
  return result;
}
