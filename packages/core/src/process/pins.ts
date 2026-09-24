// Pinned Draft Items in Process (PRD P0-10, P0-11): fixed items the model may not rewrite. The prompt asks the
// model to keep them; this module makes it true whatever the model answers.
//
// For each Draft Item whose latest action is a pin, in the order written:
// - Its cover is the set of Annotation numbers it points at.
// - Match: a model item marked "pinned": true with the same cover (or, for a draft with no Annotation, the same
//   title). The model's item is kept for its agent prompt, selectors and evidence, but the draft's title,
//   category and intent overwrite the model's, and it is not "check me" (the reviewer confirmed it).
// - No match: the model left it out. The draft is converted to a Change Item in code (draftToChangeItem) and
//   inserted in time order.
// - Dedupe: every other model item with exactly the same cover is a rewrite of the pinned item and is dropped.
//   An item that only overlaps the cover (it also points at another Annotation) is a different change and stays.
// - A model item marked "pinned" that matches no pinned draft is unpinned: only the reviewer pins.
import { draftViews } from '../drafts.ts';
import { nextItemId } from '../review-edits.ts';
import type { EventOf, TimelineEvent } from '../timeline.ts';
import { type ChangeItem, ChangeItemSchema, LOW_CONFIDENCE, type Location, screenshotCitation } from './change-item.ts';
import { displayUrl } from './script.ts';

type Ev<T extends TimelineEvent['type']> = EventOf<T>;
type Draft = Ev<'draft_item'>;

const keyOf = (nums: readonly (number | null)[]) =>
  [...new Set(nums.filter((n): n is number => n !== null))].sort((a, b) => a - b).join(',');
const itemCover = (item: ChangeItem) => keyOf(item.locations.map((l) => l.annotation));
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The Draft Items pinned at the end of the timeline, in the order written. */
export function pinnedDrafts(events: readonly TimelineEvent[]): Draft[] {
  return draftViews(events)
    .filter((v) => v.state === 'pinned')
    .map((v) => v.draft);
}

function annotationsByIndex(events: readonly TimelineEvent[]) {
  return new Map(events.filter((e): e is Ev<'annotation'> => e.type === 'annotation').map((a) => [a.index, a]));
}

function draftCover(d: Draft, events: readonly TimelineEvent[]): string {
  const idOf = new Map(
    events.filter((e): e is Ev<'annotation'> => e.type === 'annotation').map((a) => [a.annotation_id, a.index]),
  );
  return keyOf([...d.annotation_ids.map((id) => idOf.get(id) ?? null), ...d.locations.map((l) => l.annotation)]);
}

/** A pinned Draft Item as a Change Item, built in code from the draft and the Annotations it points at. */
export function draftToChangeItem(
  d: Draft,
  events: readonly TimelineEvent[],
  startUrl: string,
  id: string,
): ChangeItem {
  const anns = annotationsByIndex(events);
  const locations: Location[] = d.locations.map((l) => {
    const a = l.annotation !== null ? anns.get(l.annotation) : undefined;
    return {
      role: l.role,
      selector: l.selector,
      element: l.element,
      url: displayUrl(a?.url ?? startUrl, startUrl),
      screenshot: a?.screenshot_id ?? null,
      annotation: a ? a.index : null,
    };
  });
  if (!locations.some((l) => l.role === 'subject'))
    locations.unshift({
      role: 'subject',
      selector: null,
      element: 'page',
      url: displayUrl(startUrl, startUrl),
      screenshot: null,
      annotation: null,
    });
  const used = locations
    .map((l) => (l.annotation !== null ? anns.get(l.annotation) : undefined))
    .filter((a): a is Ev<'annotation'> => !!a);
  const screenshots = [...new Set(locations.map((l) => l.screenshot).filter((s): s is string => !!s))];
  const secs = (ms: number) => Math.round(ms / 100) / 10;
  const video = used.length
    ? { start: secs(Math.min(...used.map((a) => a.t))), end: secs(Math.max(...used.map((a) => a.t_end))) }
    : null;
  const prompt = [
    `${d.title}.`,
    d.intent,
    'Locations:',
    ...locations.map(
      (l) =>
        `- ${l.role}: ${l.element}${l.selector ? ` (${l.selector})` : ''} on ${l.url}${l.screenshot ? `, shown in ${screenshotCitation(l.screenshot)}` : ''}`,
    ),
    'The reviewer pinned this item during the review; keep its meaning as written.',
  ].join('\n');
  return ChangeItemSchema.parse({
    id,
    title: d.title,
    category: d.category,
    intent: d.intent || d.title,
    locations,
    evidence: { video, screenshots },
    transcript: d.transcript,
    confidence: 1,
    agent_prompt: prompt,
    pinned: true,
  });
}

export interface PinMerge {
  items: ChangeItem[];
  /** draft_id → the item id that carries it. */
  pinned: Record<string, string>;
  /** Drafts the model left out, converted in code. */
  converted: string[];
  /** Model item ids dropped as rewrites of a pinned draft. */
  dropped: string[];
}

/** Items after the pins are enforced. `items` carry stored screenshot ids (after restoreScreenshotIds). */
export function mergePinnedDrafts(
  items: readonly ChangeItem[],
  events: readonly TimelineEvent[],
  startUrl: string,
): PinMerge {
  let out = items.map((i) => ({ ...i }));
  const claimed = new Set<string>();
  const result: PinMerge = { items: [], pinned: {}, converted: [], dropped: [] };
  for (const d of pinnedDrafts(events)) {
    const cover = draftCover(d, events);
    const same = (i: ChangeItem) =>
      !claimed.has(i.id) && (cover ? itemCover(i) === cover : itemCover(i) === '' && norm(i.title) === norm(d.title));
    const match = out.find((i) => i.pinned && same(i));
    let keep: ChangeItem;
    if (match) {
      const { ambiguity: _drop, ...rest } = match;
      keep = {
        ...rest,
        title: d.title,
        category: d.category,
        intent: d.intent || match.intent,
        confidence: Math.max(match.confidence, LOW_CONFIDENCE),
        pinned: true,
      };
      out = out.map((i) => (i.id === match.id ? keep : i));
    } else {
      keep = draftToChangeItem(d, events, startUrl, nextItemId([...items.map((i) => i.id), ...out.map((i) => i.id)]));
      out = insertByTime(out, keep);
      result.converted.push(d.draft_id);
    }
    claimed.add(keep.id);
    result.pinned[d.draft_id] = keep.id;
    if (cover) {
      const dupes = out.filter((i) => !claimed.has(i.id) && itemCover(i) === cover).map((i) => i.id);
      result.dropped.push(...dupes);
      out = out.filter((i) => !dupes.includes(i.id));
    }
  }
  result.items = out.map((i) => (i.pinned && !claimed.has(i.id) ? { ...i, pinned: false } : i));
  return result;
}

/** Before the first item that starts later; items without a time range keep their places. */
export function insertByTime(items: ChangeItem[], item: ChangeItem): ChangeItem[] {
  const start = item.evidence.video?.start;
  const at =
    start === undefined ? -1 : items.findIndex((i) => i.evidence.video !== null && i.evidence.video.start > start);
  return at < 0 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)];
}
