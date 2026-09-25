// Review-page edits folded over the append-only timeline (PRD P0-11, P0-12).
//
// - Transcript: each `transcript_edit` replaces a segment's text; the latest one wins. Process, review.md and
//   the review page read the edited text; session.json keeps both the raw segment and the edits.
// - Change Items: the generated items of one Process run, then its `item_edit` events in order. Edits for an
//   older run are ignored, so Process again starts from the new run's items.
// - Merge: `merge` unions the two items in code; the review page then asks the merge model for one coherent title,
//   intent and prompt (process/combine.ts) and logs its answer as an `edit` with `origin: 'combine'`. Replay only
//   applies that edit; it never calls a model.
// - Undo and Redo (F5): `undo` and `redo` are ops in the same log, so the log stays append-only. effectiveItemEdits
//   folds them away first: a step is one op, except that a merge's combine joins the merge's step, so undoing a
//   merge brings both originals back and drops the combined words. A new step clears what can be redone.
// - Name: the latest `session_rename` names the Session; before any, its start page's title (sessionName).
// - Acceptance rate (PRD §8): generated items that reach the final list with no edit ÷ generated items.
import { type ChangeItem, isLowConfidence, sortForReview } from './process/change-item.ts';
import type { EventOf, ItemEditOp, TimelineEvent } from './timeline.ts';
import { activeTranscript } from './transcription-runs.ts';

type Ev<T extends TimelineEvent['type']> = EventOf<T>;

/** segment_id → edited text (the latest edit). */
export function transcriptEdits(events: readonly TimelineEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) if (e.type === 'transcript_edit') out.set(e.segment_id, e.text);
  return out;
}

/** The Session's name: the latest `session_rename`, else the start page's title, else its URL. */
export function sessionName(
  session: { start_title: string; start_url: string },
  events: readonly TimelineEvent[],
): string {
  let name: string | null = null;
  for (const e of events) if (e.type === 'session_rename') name = e.name;
  return name || session.start_title || session.start_url;
}

/**
 * The timeline as Process reads it: only the active transcription run (transcription-runs.ts), with edited
 * segment texts in place. An edited segment loses its word timings (they described the old words), so pairing
 * treats it as one span. The edit events themselves are dropped. Edits are keyed by segment_id, so an edit made
 * on one run never touches another run.
 */
export function applyTranscriptEdits<E extends TimelineEvent>(events: readonly E[]): E[] {
  const edits = transcriptEdits(events);
  return activeTranscript(events)
    .filter((e) => e.type !== 'transcript_edit')
    .map((e) => {
      if (e.type !== 'transcript_segment') return e;
      const text = edits.get(e.segment_id);
      return text === undefined || text === e.text ? e : ({ ...e, text, words: null } as E);
    });
}

const locationKey = (l: ChangeItem['locations'][number]) =>
  `${l.role}|${l.selector ?? ''}|${l.url}|${l.annotation ?? ''}|${l.element}`;
const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

/** `from` folded into `into`: `into` keeps its id, title and category; Locations and Evidence are unioned. */
export function mergeItems(into: ChangeItem, from: ChangeItem): ChangeItem {
  const locations = [...into.locations];
  const seen = new Set(locations.map(locationKey));
  for (const l of from.locations)
    if (!seen.has(locationKey(l))) {
      seen.add(locationKey(l));
      locations.push(l);
    }
  const videos = [into.evidence.video, from.evidence.video].filter((v): v is NonNullable<typeof v> => v !== null);
  const confidence = Math.min(into.confidence, from.confidence);
  const ambiguity = unique([into.ambiguity, from.ambiguity].filter((a): a is string => !!a?.trim())).join(' ');
  return {
    ...into,
    intent: into.intent === from.intent ? into.intent : `${into.intent} ${from.intent}`,
    locations,
    evidence: {
      video: videos.length
        ? { start: Math.min(...videos.map((v) => v.start)), end: Math.max(...videos.map((v) => v.end)) }
        : null,
      screenshots: unique([...into.evidence.screenshots, ...from.evidence.screenshots]),
      ...(into.evidence.crops || from.evidence.crops
        ? { crops: unique([...(into.evidence.crops ?? []), ...(from.evidence.crops ?? [])]) }
        : {}),
    },
    transcript: [into.transcript, from.transcript].filter((t) => t.trim()).join(' ... '),
    confidence,
    ...(ambiguity ? { ambiguity } : {}),
    // Both prompts, so every evidence screenshot stays cited.
    agent_prompt: `${into.agent_prompt}\n\n${from.agent_prompt}`,
    pinned: into.pinned || from.pinned,
    ...(into.style_changes || from.style_changes
      ? {
          style_changes: [
            ...(into.style_changes ?? []),
            ...(from.style_changes ?? []).filter(
              (c) => !into.style_changes?.some((x) => x.annotation === c.annotation),
            ),
          ],
        }
      : {}),
  };
}

export interface EditedItems {
  items: ChangeItem[];
  /** Generated item ids that an edit, delete, merge or split touched. A reorder is not an edit. */
  touched: Set<string>;
  /**
   * Merged items whose words are still the concatenation: no edit (the merge model's or the reviewer's) came after
   * their latest merge. The review page offers Combine with AI on these.
   */
  uncombined: Set<string>;
}

type Step = Exclude<ItemEditOp, { op: 'undo' | 'redo' }>;
interface History {
  done: Step[][];
  /** Undone steps, the latest last: the next redo puts back the last one. */
  undone: Step[][];
}

/** The item ids an op changes; a reorder changes none. */
function opIds(op: Step): string[] {
  switch (op.op) {
    case 'edit':
    case 'delete':
      return [op.item_id];
    case 'merge':
      return [op.into, op.from];
    case 'split':
      return [op.item_id, op.new_id];
    case 'reorder':
      return [];
  }
}

function history(edits: readonly ItemEditOp[]): History {
  const done: Step[][] = [];
  const undone: Step[][] = [];
  const mergesInto = (step: Step[], id: string) => step.some((o) => o.op === 'merge' && o.into === id);
  for (const op of edits) {
    if (op.op === 'undo') {
      const step = done.pop();
      if (step) undone.push(step);
      continue;
    }
    if (op.op === 'redo') {
      const step = undone.pop();
      if (step) done.push(step);
      continue;
    }
    if (op.op === 'edit' && op.origin === 'combine') {
      // The merge model's answer belongs to the latest merge into the item, if nothing changed the item since.
      const k = done.findLastIndex((step) => mergesInto(step, op.item_id));
      if (k >= 0 && done.slice(k + 1).every((step) => step.every((o) => !opIds(o).includes(op.item_id)))) {
        done[k]!.push(op);
        continue;
      }
      // Its merge was undone before the answer came: the answer is void, and redo still puts the merge back.
      const u = undone.findLastIndex((step) => mergesInto(step, op.item_id));
      if (u >= 0 && k < 0) continue;
    }
    done.push([op]);
    undone.length = 0;
  }
  return { done, undone };
}

/** The ops that stand once undo and redo are folded away, in log order. */
export function effectiveItemEdits(edits: readonly ItemEditOp[]): Step[] {
  return history(edits).done.flat();
}

/** Whether an undo or a redo would change anything now. */
export function undoState(edits: readonly ItemEditOp[]): { canUndo: boolean; canRedo: boolean } {
  const { done, undone } = history(edits);
  return { canUndo: done.length > 0, canRedo: undone.length > 0 };
}

/** Folds the edits over the generated items. The starting order is the review order (unsure items first). */
export function applyItemEdits(generated: readonly ChangeItem[], log: readonly ItemEditOp[]): EditedItems {
  const edits = effectiveItemEdits(log);
  let items = sortForReview(generated);
  const touched = new Set<string>();
  // A split copy counts against the item it came from.
  const origin = new Map<string, string>(generated.map((i) => [i.id, i.id]));
  const touch = (id: string) => {
    const o = origin.get(id);
    if (o) touched.add(o);
  };
  const uncombined = new Set<string>();
  const at = (id: string) => items.findIndex((i) => i.id === id);
  for (const edit of edits) {
    switch (edit.op) {
      case 'edit': {
        const i = at(edit.item_id);
        if (i < 0) break;
        const { ambiguity, ...rest } = edit.changes;
        const changes = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        const { ambiguity: before, ...item } = { ...items[i]!, ...changes };
        // null clears the ambiguity, except on a low-confidence item, which must keep one.
        const kept = ambiguity === undefined || (ambiguity === null && isLowConfidence(item)) ? before : ambiguity;
        items = items.with(i, kept ? { ...item, ambiguity: kept } : item);
        touch(edit.item_id);
        uncombined.delete(edit.item_id);
        break;
      }
      case 'delete': {
        if (at(edit.item_id) < 0) break;
        items = items.filter((x) => x.id !== edit.item_id);
        touch(edit.item_id);
        uncombined.delete(edit.item_id);
        break;
      }
      case 'merge': {
        const i = at(edit.into);
        const j = at(edit.from);
        if (i < 0 || j < 0 || i === j) break;
        const merged = mergeItems(items[i]!, items[j]!);
        items = items.with(i, merged).filter((_x, k) => k !== j);
        touch(edit.into);
        touch(edit.from);
        uncombined.delete(edit.from);
        uncombined.add(edit.into);
        break;
      }
      case 'split': {
        const i = at(edit.item_id);
        if (i < 0 || at(edit.new_id) >= 0) break;
        items = [...items.slice(0, i + 1), { ...items[i]!, id: edit.new_id }, ...items.slice(i + 1)];
        origin.set(edit.new_id, origin.get(edit.item_id) ?? edit.item_id);
        touch(edit.item_id);
        break;
      }
      case 'reorder': {
        const rank = new Map(edit.order.map((id, k) => [id, k]));
        // Items the order does not name keep their place after the named ones.
        items = items
          .map((x, k) => ({ x, k }))
          .sort((a, b) => (rank.get(a.x.id) ?? edit.order.length + a.k) - (rank.get(b.x.id) ?? edit.order.length + b.k))
          .map((p) => p.x);
        break;
      }
    }
  }
  return { items, touched, uncombined };
}

/** The two items the latest merge into `itemId` folded together, as they were just before it (Combine with AI again). */
export function mergeSources(
  generated: readonly ChangeItem[],
  log: readonly ItemEditOp[],
  itemId: string,
): { into: ChangeItem; from: ChangeItem } | null {
  const edits = effectiveItemEdits(log);
  const k = edits.findLastIndex((e) => e.op === 'merge' && e.into === itemId);
  if (k < 0) return null;
  const merge = edits[k] as Extract<ItemEditOp, { op: 'merge' }>;
  const before = applyItemEdits(generated, edits.slice(0, k)).items;
  const into = before.find((i) => i.id === merge.into);
  const from = before.find((i) => i.id === merge.from);
  return into && from ? { into, from } : null;
}

/** The item_edit ops of one run, in log order. */
export function itemEditsFor(events: readonly TimelineEvent[], runId: string): ItemEditOp[] {
  return events.filter((e): e is Ev<'item_edit'> => e.type === 'item_edit' && e.run_id === runId).map((e) => e.edit);
}

export interface Acceptance {
  generated: number;
  /** Generated items exported exactly as generated. */
  unedited: number;
  /** unedited ÷ generated; null when nothing was generated. */
  rate: number | null;
}

/** PRD §8 item acceptance rate for one run. */
export function acceptanceRate(generated: readonly ChangeItem[], edits: readonly ItemEditOp[]): Acceptance {
  const { items, touched } = applyItemEdits(generated, edits);
  const final = new Set(items.map((i) => i.id));
  const unedited = generated.filter((g) => final.has(g.id) && !touched.has(g.id)).length;
  return { generated: generated.length, unedited, rate: generated.length ? unedited / generated.length : null };
}

/** The next free item_NNNN id, past every id ever used in the run (including split copies). */
export function nextItemId(ids: readonly string[]): string {
  const max = Math.max(0, ...ids.map((id) => Number(/^item_(\d+)/.exec(id)?.[1] ?? 0)));
  return `item_${String(max + 1).padStart(4, '0')}`;
}
