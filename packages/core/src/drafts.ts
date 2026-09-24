// Draft Item state (PRD P0-10): each `draft_item` is shown, pinned or discarded. `draft_action` events decide it,
// by a click on the panel card or by voice (scratch that, pin that); the latest action for a draft wins. The
// panel, the review page, the Process script and `pnpm validate:session` all read it from here.
import type { EventOf, TimelineEvent } from './timeline.ts';

export type DraftState = 'shown' | 'pinned' | 'discarded';

type Ev<T extends TimelineEvent['type']> = EventOf<T>;

/** draft_id → its state after every action. Drafts with no action are 'shown'. `events` in log order. */
export function draftStates(events: readonly TimelineEvent[]): Map<string, DraftState> {
  const out = new Map<string, DraftState>();
  for (const e of events) {
    if (e.type === 'draft_item' && !out.has(e.draft_id)) out.set(e.draft_id, 'shown');
    if (e.type === 'draft_action') out.set(e.draft_id, e.action === 'pin' ? 'pinned' : 'discarded');
  }
  return out;
}

export interface DraftView {
  draft: Ev<'draft_item'>;
  state: DraftState;
  /** How the current state was reached; null while shown. */
  source: 'click' | 'voice' | null;
}

/** Every Draft Item with its state, in the order written. */
export function draftViews(events: readonly TimelineEvent[]): DraftView[] {
  const last = new Map<string, Ev<'draft_action'>>();
  for (const e of events) if (e.type === 'draft_action') last.set(e.draft_id, e);
  return events
    .filter((e): e is Ev<'draft_item'> => e.type === 'draft_item')
    .map((draft) => {
      const a = last.get(draft.draft_id);
      return { draft, state: a ? (a.action === 'pin' ? 'pinned' : 'discarded') : 'shown', source: a?.source ?? null };
    });
}

export interface DraftStats {
  drafts: number;
  pinned: number;
  discarded: number;
  discarded_by: { click: number; voice: number };
  /** PRD §8: discarded ÷ drafts; null with no drafts. Target under 25%. */
  discard_rate: number | null;
}

/** PRD §8 Draft Item discard rate, from the timeline alone (session.json is enough). */
export function draftStats(events: readonly TimelineEvent[]): DraftStats {
  const views = draftViews(events);
  const discarded = views.filter((v) => v.state === 'discarded');
  return {
    drafts: views.length,
    pinned: views.filter((v) => v.state === 'pinned').length,
    discarded: discarded.length,
    discarded_by: {
      click: discarded.filter((v) => v.source === 'click').length,
      voice: discarded.filter((v) => v.source === 'voice').length,
    },
    discard_rate: views.length ? discarded.length / views.length : null,
  };
}

/** One line per Location: "subject button 'Get started' #1". */
export function draftLocationSummary(d: Pick<Ev<'draft_item'>, 'locations'>, withSelectors = false): string {
  return d.locations
    .map(
      (l) =>
        `${l.role} ${l.element}${withSelectors && l.selector ? ` (${l.selector})` : ''}${l.annotation !== null ? ` #${l.annotation}` : ''}`,
    )
    .join(' · ');
}
