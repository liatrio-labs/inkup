// Process without a model (E11). A Session of typed comments needs no model to become Change Items, and a reviewer
// with no Anthropic key still gets a list:
//
// - Every live Annotation becomes one item on its picked element (a region when nothing resolved): its typed comment
//   is the intent, and any speech said during it is quoted. One with neither is kept as a low-confidence item.
// - Every Text Comment becomes its `copy` item (./text-comments.ts), pinned Draft Items their items (./pins.ts).
// - With a key, the model is skipped only when it would have nothing to add (needsModel in ./text-comments.ts):
//   no speech outside explicit Text Comments, every Annotation commented, every Text Comment explicit.
// - Without a key, every Session goes this way (the deterministic fallback); speech with no Annotation is not made
//   into items, since only a model can split it into requests.

import { nextItemId } from '../review-edits.ts';
import type { Category, EventOf, TimelineEvent } from '../timeline.ts';
import { stripCommandPhrase } from '../voice-command-effects.ts';
import { type ChangeItem, ChangeItemSchema, screenshotCitation } from './change-item.ts';
import { insertByTime, mergePinnedDrafts } from './pins.ts';
import { displayUrl } from './script.ts';
import { mergeTextComments } from './text-comments.ts';
import { liveAnnotations } from './windows.ts';

type Annotation = EventOf<'annotation'>;
type Cat = (typeof Category)['options'][number];

/** Confidence of an item made from a typed Annotation comment, and of one with nothing said or typed. */
export const COMMENT_CONFIDENCE = 0.8;
export const BARE_CONFIDENCE = 0.3;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const short = (s: string, max: number) => {
  const t = collapse(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Speech said during the span, Voice Command phrases removed. `events` as Process reads them (active transcript). */
export function speechDuring(span: { t: number; t_end: number }, events: readonly TimelineEvent[]): string {
  const phrases = new Map<string, string[]>();
  for (const e of events)
    if (e.type === 'voice_command' && e.segment_id)
      phrases.set(e.segment_id, [...(phrases.get(e.segment_id) ?? []), e.phrase]);
  return events
    .filter(
      (e): e is EventOf<'transcript_segment'> =>
        e.type === 'transcript_segment' && e.t <= span.t_end && e.t_end >= span.t,
    )
    .map((e) => (phrases.get(e.segment_id) ?? []).reduce(stripCommandPhrase, e.text).trim())
    .filter(Boolean)
    .join(' ... ');
}

/** A category from the comment's words; `content` when nothing points elsewhere. */
export function guessCategory(comment: string): Cat {
  const c = comment.toLowerCase();
  if (/\?\s*$/.test(c)) return 'question';
  if (/\b(broken|doesn'?t work|does not work|crash|error|bug|fails?)\b/.test(c)) return 'bug';
  if (/\b(say|says|read|reads|wording|typo|spelling|rename|text|label|copy)\b/.test(c)) return 'copy';
  if (/\b(move|align|aligned|left|right|above|below|center|centre|order|layout|column|row|stack)\b/.test(c))
    return 'layout';
  if (
    /\b(colou?r|bigger|smaller|larger|font|bold|padding|margin|spacing|roomier|tighter|border|shadow|rounded|contrast|size|darker|lighter)\b/.test(
      c,
    )
  )
    return 'style';
  if (/\b(click|opens?|navigate|link|submit|hover|scroll|should go)\b/.test(c)) return 'behavior';
  return 'content';
}

/** "button 'Get started'", as Locations name elements; "region" when nothing resolved. */
function elementOf(a: Annotation): { selector: string | null; element: string } {
  const c = a.pick !== null ? a.candidates[a.pick] : undefined;
  if (!c || a.resolution === 'region') return { selector: null, element: 'region of the page' };
  const label = c.name || c.text;
  return { selector: c.selector, element: `${c.role ?? c.tag}${label ? ` '${short(label, 60)}'` : ''}` };
}

/** One Annotation as a Change Item, built in code from its comment (or the speech during it). */
export function annotationToChangeItem(
  a: Annotation,
  events: readonly TimelineEvent[],
  startUrl: string,
  id: string,
): ChangeItem {
  const url = displayUrl(a.url, startUrl);
  const { selector, element } = elementOf(a);
  const comment = a.page_api?.comment?.trim() || a.comment?.trim() || '';
  const speech = speechDuring(a, events);
  const said = comment || speech;
  const where = `On ${url}, ${selector ? `${element} (${selector})` : `the ${element} the reviewer marked`}`;
  const shot = a.screenshot_id ? `${screenshotCitation(a.screenshot_id)} shows Annotation #${a.index}.` : null;
  const lines = said
    ? [`${where}: ${said}`, comment && speech ? `The reviewer also said: "${speech}".` : null, shot]
    : [
        `${where}. The reviewer marked it without saying or typing what should change; look at the screenshot and ask them if it is unclear.`,
        shot,
      ];
  const secs = (ms: number) => Math.round(ms / 100) / 10;
  return ChangeItemSchema.parse({
    id,
    title: said ? short(said.charAt(0).toUpperCase() + said.slice(1), 80) : `Look at ${short(element, 60)}`,
    category: said ? guessCategory(said) : 'question',
    intent: said || `The reviewer marked ${element} on ${url} without a comment.`,
    locations: [{ role: 'subject', selector, element, url, screenshot: a.screenshot_id, annotation: a.index }],
    evidence: {
      video: { start: secs(a.t), end: secs(Math.max(a.t, a.t_end)) },
      screenshots: a.screenshot_id ? [a.screenshot_id] : [],
    },
    transcript: [comment, speech].filter(Boolean).join(' ... '),
    confidence: said ? COMMENT_CONFIDENCE : BARE_CONFIDENCE,
    ...(said ? {} : { ambiguity: 'Nothing was said or typed about this Annotation.' }),
    agent_prompt: lines.filter(Boolean).join('\n'),
    pinned: false,
  });
}

export interface InCodeResult {
  items: ChangeItem[];
  /** Pinned Draft Items converted (all of them: no model saw them). */
  pins_converted: string[];
  pins_dropped: string[];
}

/** Change Items without a model. `events` as Process reads them (applyTranscriptEdits). */
export function processInCode(events: readonly TimelineEvent[], startUrl: string): InCodeResult {
  let items = mergeTextComments([], events, startUrl).items;
  for (const a of liveAnnotations(events)) {
    items = insertByTime(items, annotationToChangeItem(a, events, startUrl, nextItemId(items.map((i) => i.id))));
  }
  // Numbered in time order, as the model numbers its items.
  items = items.map((item, i) => ({ ...item, id: `item_${String(i + 1).padStart(4, '0')}` }));
  const pins = mergePinnedDrafts(items, events, startUrl);
  return { items: pins.items, pins_converted: pins.converted, pins_dropped: pins.dropped };
}
