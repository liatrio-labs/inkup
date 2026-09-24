// Long Sessions (PRD P0-11): Process runs in windows (chunks planned at natural boundaries by ./sections.ts) with a
// 1-minute overlap on each side, then the windows' Change Items are merged. Pure, so ownership, the overlap dedupe
// and pin passthrough are unit-tested (tests/unit/core/windows.test.ts).
//
// - A window owns the events that start inside its core range [start, end). Its script also shows the overlap
//   (OVERLAP_MS before and after) so speech that trails across a boundary still pairs with its Annotation.
// - Screenshot aliases and Annotation numbers are Session-wide (renderEvents walks every event), so items from
//   different windows name the same things the same way.
// - Each window must account for every Annotation it owns: used by an item, or listed in `dropped_annotations`
//   with a reason. The adapter enforces that through the repair retry, so nothing is lost silently.
// - Merge: an item from one window is a duplicate of an item from another when they share a subject (Annotation
//   number, or the same selector on the same page), have a similar intent, and the duplicate points at no
//   Annotation the kept item lacks. The kept item is the one whose window owns its subject.
// - Pinned Draft Items are listed only in the window that owns them and are left out of the dedupe; the pin merge
//   (./pins.ts) runs once over the merged list, so each pinned draft ends up as exactly one unchanged item.

import { applyTranscriptEdits } from '../review-edits.ts';
import type { SessionDocument } from '../session-document.ts';
import type { EventOf, TimelineEvent } from '../timeline.ts';
import type { ChangeItem } from './change-item.ts';
import { buildProcessPrompt, type ProcessPrompt, stamp } from './script.ts';

export const OVERLAP_MS = 60_000;
/** Sessions up to this long are processed in one call when the answer fits: a 12-minute Session is not worth two. */
export const SINGLE_WINDOW_MAX_MS = 12 * 60_000;

export interface ProcessWindow {
  /** 0-based. */
  index: number;
  count: number;
  /** Core range owned by this window: [start, end). The last window's end is Infinity. */
  start: number;
  end: number;
  /** Range shown in the script: the core plus the overlap on each side. */
  from: number;
  to: number;
}

/** The Session length Process windows over: session_end, else the last event. */
export function sessionLength(doc: SessionDocument): number {
  const end = doc.events.find((e): e is EventOf<'session_end'> => e.type === 'session_end');
  if (end) return end.duration_ms;
  return (
    doc.session.duration_ms ??
    doc.events.reduce((m, e) => Math.max(m, 't_end' in e && typeof e.t_end === 'number' ? e.t_end : e.t), 0)
  );
}

export const owns = (w: Pick<ProcessWindow, 'start' | 'end'>, t: number) => t >= w.start && t < w.end;

const spanEnd = (e: TimelineEvent) => ('t_end' in e && typeof e.t_end === 'number' ? e.t_end : e.t);
/** Shown in a window's script when the event overlaps its shown range. */
export const shownIn = (w: Pick<ProcessWindow, 'from' | 'to'>, e: TimelineEvent) => e.t <= w.to && spanEnd(e) >= w.from;

/** Annotations that were not taken back by "scratch that". */
export function liveAnnotations(events: readonly TimelineEvent[]): EventOf<'annotation'>[] {
  const scratched = new Set(
    events.flatMap((e) => (e.type === 'voice_command' && e.target?.kind === 'annotation' ? [e.target.id] : [])),
  );
  return events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation' && !scratched.has(e.annotation_id));
}

/** Annotation numbers a window must account for. */
export function ownedAnnotations(events: readonly TimelineEvent[], w: ProcessWindow): number[] {
  return liveAnnotations(events)
    .filter((a) => owns(w, a.t))
    .map((a) => a.index);
}

export interface WindowPrompt extends ProcessPrompt {
  window: ProcessWindow;
  /** Annotation numbers this window must use or list as dropped. */
  owned: number[];
}

/**
 * The prompt for one window: the Session-wide system prompt and context, with only the events shown in the window
 * rendered, and a header naming the window and the Annotations it must account for. A single window is the plain
 * Process prompt plus the coverage line.
 */
export function buildWindowPrompt(doc: SessionDocument, w: ProcessWindow): WindowPrompt {
  const events = applyTranscriptEdits(doc.events);
  const owned = ownedAnnotations(events, w);
  const draftOwned = (e: EventOf<'draft_item'>) => owns(w, e.t);
  const base = buildProcessPrompt(doc, w.count === 1 ? {} : { include: (e) => shownIn(w, e), pinnedDraft: draftOwned });
  const coverage = `ANNOTATIONS TO ACCOUNT FOR: ${owned.length ? owned.map((n) => `#${n}`).join(', ') : 'none'}. Each must appear in some item's Locations, or in "dropped_annotations" with a one-sentence reason (for example: no request was made about it).`;
  const header =
    w.count === 1
      ? [coverage]
      : [
          `WINDOW ${w.index + 1} of ${w.count}: this part of the Session runs ${stamp(w.start)}–${w.end === Infinity ? 'end' : stamp(w.end)}. The script also shows ${w.index > 0 ? `from ${stamp(w.from)}` : 'from the start'} ${w.to === Infinity ? 'to the end' : `to ${stamp(w.to)}`} for context. Produce items for what starts inside this part; the other parts are processed separately and duplicates are merged afterwards.`,
          coverage,
        ];
  return { ...base, script: `${header.join('\n')}\n${base.script}`, window: w, owned };
}

// ---------------------------------------------------------------------------------------------------------------
// Merge

export interface DroppedAnnotation {
  annotation: number;
  reason: string;
}

export interface WindowResult {
  window: ProcessWindow;
  items: readonly ChangeItem[];
  dropped: readonly DroppedAnnotation[];
}

export interface WindowMerge {
  /** Renumbered item_0001… in time order; pinned items are not yet reconciled (run mergePinnedDrafts next). */
  items: ChangeItem[];
  /** Merged-away duplicates: the item id kept (after renumbering) and the window and id of the one dropped. */
  duplicates: { kept: string; dropped: { window: number; id: string } }[];
  /** Annotations some window's model said it dropped, and why (first reason wins). */
  dropped: DroppedAnnotation[];
  /** The window each merged item came from, by its new id. */
  source: Record<string, number>;
}

const STOP = new Set(
  'the a an and or of to in on at for with this that these those it its is be should make more less than as by from into onto so very just like same one'.split(
    ' ',
  ),
);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
export function jaccard(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

const subjects = (i: ChangeItem) => i.locations.filter((l) => l.role === 'subject');
export function sameSubject(a: ChangeItem, b: ChangeItem): boolean {
  return subjects(a).some((x) =>
    subjects(b).some(
      (y) =>
        (x.annotation !== null && x.annotation === y.annotation) ||
        (x.selector !== null && x.selector === y.selector && x.url === y.url) ||
        (x.selector === null &&
          y.selector === null &&
          x.annotation === null &&
          y.annotation === null &&
          x.url === y.url),
    ),
  );
}

/** Same category and the same words: the title and intent, or the reviewer's own transcript excerpt. */
export function similarIntent(a: ChangeItem, b: ChangeItem): boolean {
  if (a.category !== b.category) return false;
  return (
    jaccard(`${a.title} ${a.intent}`, `${b.title} ${b.intent}`) >= 0.5 ||
    (a.transcript.trim() !== '' && jaccard(a.transcript, b.transcript) >= 0.6)
  );
}

const annotationsOf = (i: ChangeItem) =>
  new Set(i.locations.map((l) => l.annotation).filter((n): n is number => n !== null));

/** When an item happens: its subject Annotation's start, else its evidence start, else null. */
function anchor(item: ChangeItem, annotationT: ReadonlyMap<number, number>): number | null {
  for (const l of subjects(item))
    if (l.annotation !== null && annotationT.has(l.annotation)) return annotationT.get(l.annotation)!;
  return item.evidence.video ? Math.round(item.evidence.video.start * 1000) : null;
}

export function mergeWindowResults(results: readonly WindowResult[], events: readonly TimelineEvent[]): WindowMerge {
  const annotationT = new Map(
    events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation').map((a) => [a.index, a.t]),
  );
  type Tagged = { item: ChangeItem; window: ProcessWindow; order: number };
  const all: Tagged[] = results.flatMap((r, wi) =>
    r.items.map((item, i) => ({ item, window: r.window, order: wi * 10_000 + i })),
  );
  const ownedHere = (t: Tagged) => {
    const at = anchor(t.item, annotationT);
    return at !== null && owns(t.window, at);
  };
  const removed = new Set<Tagged>();
  const pairs: { kept: Tagged; dropped: Tagged }[] = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i]!;
    if (removed.has(a) || a.item.pinned) continue;
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j]!;
      if (removed.has(b) || b.item.pinned || b.window.index === a.window.index) continue;
      if (!sameSubject(a.item, b.item) || !similarIntent(a.item, b.item)) continue;
      // Prefer the item whose window owns its subject; then the more confident; then the earlier window.
      const score = (t: Tagged) => [ownedHere(t) ? 1 : 0, t.item.confidence, -t.window.index] as const;
      const [sa, sb] = [score(a), score(b)];
      const keepB = sb[0] > sa[0] || (sb[0] === sa[0] && (sb[1] > sa[1] || (sb[1] === sa[1] && sb[2] > sa[2])));
      let [keep, drop] = keepB ? [b, a] : [a, b];
      // Never lose an Annotation: the dropped item may only point at Annotations the kept one also uses. When the
      // preferred item is the smaller one, keep the other; when neither covers the other, they are different items.
      const covers = (x: Tagged, y: Tagged) => {
        const xs = annotationsOf(x.item);
        return [...annotationsOf(y.item)].every((n) => xs.has(n));
      };
      if (!covers(keep, drop)) {
        if (!covers(drop, keep)) continue;
        [keep, drop] = [drop, keep];
      }
      removed.add(drop);
      pairs.push({ kept: keep, dropped: drop });
      if (drop === a) break;
    }
  }
  const survivors = all
    .filter((t) => !removed.has(t))
    .map((t) => ({ ...t, at: anchor(t.item, annotationT) }))
    .sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity) || x.order - y.order);
  const source: Record<string, number> = {};
  const newIdByOrder = new Map<number, string>();
  const items = survivors.map((t, i) => {
    const id = `item_${String(i + 1).padStart(4, '0')}`;
    source[id] = t.window.index;
    newIdByOrder.set(t.order, id);
    return { ...t.item, id };
  });
  const dropped = new Map<number, DroppedAnnotation>();
  for (const r of results) for (const d of r.dropped) if (!dropped.has(d.annotation)) dropped.set(d.annotation, d);
  return {
    items,
    duplicates: pairs.map((p) => ({
      kept: newIdByOrder.get(p.kept.order)!,
      dropped: { window: p.dropped.window.index, id: p.dropped.item.id },
    })),
    dropped: [...dropped.values()].sort((a, b) => a.annotation - b.annotation),
    source,
  };
}

/** Live Annotations no item uses and no window listed as dropped. Empty means nothing was lost. */
export function unaccountedAnnotations(
  items: readonly ChangeItem[],
  dropped: readonly DroppedAnnotation[],
  events: readonly TimelineEvent[],
): number[] {
  const used = new Set(items.flatMap((i) => [...annotationsOf(i)]));
  for (const d of dropped) used.add(d.annotation);
  return liveAnnotations(events)
    .map((a) => a.index)
    .filter((n) => !used.has(n));
}

/** Coverage issues for one window's answer, fed to the repair retry. */
export function coverageIssues(
  items: readonly ChangeItem[],
  dropped: readonly DroppedAnnotation[],
  owned: readonly number[],
  known: ReadonlySet<number>,
): string[] {
  const issues: string[] = [];
  dropped.forEach((d, i) => {
    if (!known.has(d.annotation))
      issues.push(`dropped_annotations.${i}.annotation: there is no Annotation #${d.annotation}`);
  });
  const used = new Set(items.flatMap((i) => [...annotationsOf(i)]));
  for (const d of dropped) used.add(d.annotation);
  const missing = owned.filter((n) => !used.has(n));
  if (missing.length)
    issues.push(
      `Annotations ${missing.map((n) => `#${n}`).join(', ')} are neither used by an item nor listed in dropped_annotations with a reason`,
    );
  return issues;
}

/** item_0001… in list order, after the pin merge dropped rewrites; `from` maps each new id to the old one. */
export function renumberItems(items: readonly ChangeItem[]): { items: ChangeItem[]; from: Record<string, string> } {
  const from: Record<string, string> = {};
  const out = items.map((item, i) => {
    const id = `item_${String(i + 1).padStart(4, '0')}`;
    from[id] = item.id;
    return { ...item, id };
  });
  return { items: out, from };
}
