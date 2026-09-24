// Folds the Resolutions a paired Host pushed (ADR 0004) into each Change Item's current status. Pure, so the review
// page's cards and the Session list's counts read them the same way.
import type { ResolutionRow } from './index';

/**
 * The latest Resolution of each item, by item id. The Host orders an item's Resolutions by its own seq, which is not
 * pushed here, so this orders by `created_at` and breaks a same-millisecond tie on the Resolution id: stable, and the
 * same answer on every page.
 */
export function latestResolutions(rows: readonly ResolutionRow[]): Map<string, ResolutionRow> {
  const sorted = [...rows].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((r) => [r.item_id, r]));
}

/** How a Session's Change Items stand: done is resolved plus won't fix; an item with no Resolution is open. */
export interface ItemStatusCounts {
  total: number;
  open: number;
  in_progress: number;
  done: number;
  needs_info: number;
}

/** Counts over the current item ids only, so a Resolution of an item since deleted or merged away is not counted. */
export function itemStatusCounts(itemIds: readonly string[], rows: readonly ResolutionRow[]): ItemStatusCounts {
  const latest = latestResolutions(rows);
  const counts: ItemStatusCounts = { total: itemIds.length, open: 0, in_progress: 0, done: 0, needs_info: 0 };
  for (const id of itemIds) {
    const status = latest.get(id)?.status;
    if (status === undefined) counts.open++;
    else if (status === 'resolved' || status === 'wont_fix') counts.done++;
    else counts[status]++;
  }
  return counts;
}
