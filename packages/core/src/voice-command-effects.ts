// What a Voice Command acts on, decided from the timeline alone (PRD P0-8). No matching libraries here: the
// service worker and the Process prompt builder import this module.
//
// - `scratch that` discards the latest Draft Item, or the latest Annotation if no Draft Item is newer.
// - `pin that` pins the latest Draft Item.
// Draft Items are `draft_item` events, pinned or discarded by `draft_action` events (./drafts.ts). The service
// worker logs the command with the target resolved here, then a `draft_action` with source `voice`.
import { draftStates } from './drafts.ts';
import type { EventOf, TimelineEvent } from './timeline.ts';

export type CommandTarget = { kind: 'annotation'; id: string } | { kind: 'draft_item'; id: string };

/** Annotations discarded by `scratch that`. */
export function discardedAnnotationIds(events: readonly TimelineEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) if (e.type === 'voice_command' && e.target?.kind === 'annotation') out.add(e.target.id);
  return out;
}

function draftState(events: readonly TimelineEvent[]) {
  const states = draftStates(events);
  const having = (s: string) => new Set([...states].filter(([, v]) => v === s).map(([k]) => k));
  return { discarded: having('discarded'), pinned: having('pinned') };
}

const latest = <T extends { t: number }>(xs: readonly T[]): T | undefined =>
  xs.reduce<T | undefined>((a, b) => (!a || b.t >= a.t ? b : a), undefined);

/** Target of `scratch that`, or null when there is nothing left to discard. `events` in log order. */
export function resolveScratchTarget(events: readonly TimelineEvent[]): CommandTarget | null {
  const gone = discardedAnnotationIds(events);
  const { discarded } = draftState(events);
  const ann = latest(
    events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation' && !gone.has(e.annotation_id)),
  );
  const draft = latest(
    events.filter((e): e is EventOf<'draft_item'> => e.type === 'draft_item' && !discarded.has(e.draft_id)),
  );
  // A Draft Item is written after the Annotations it covers, so "newer" compares when each was logged.
  if (draft && (!ann || draft.t >= ann.t_end)) return { kind: 'draft_item', id: draft.draft_id };
  return ann ? { kind: 'annotation', id: ann.annotation_id } : null;
}

/** Target of `pin that`: the latest Draft Item that is neither discarded nor already pinned. */
export function resolvePinTarget(events: readonly TimelineEvent[]): CommandTarget | null {
  const { discarded, pinned } = draftState(events);
  const draft = latest(
    events.filter(
      (e): e is EventOf<'draft_item'> =>
        e.type === 'draft_item' && !discarded.has(e.draft_id) && !pinned.has(e.draft_id),
    ),
  );
  return draft ? { kind: 'draft_item', id: draft.draft_id } : null;
}

/** The segment text without the command phrase (first occurrence, case-insensitive), tidied. */
export function stripCommandPhrase(text: string, phrase: string): string {
  const i = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (i < 0 || !phrase) return text;
  return `${text.slice(0, i)} ${text.slice(i + phrase.length)}`
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])[,.!?;:]+/g, '$1')
    .replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
