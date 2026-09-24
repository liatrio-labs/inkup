// The Resolution fold (src/db/resolutions.ts): the latest per item, and the Session list's counts over current items.
import { describe, expect, it } from 'vitest';
import type { ResolutionRow } from '@/db';
import { itemStatusCounts, latestResolutions } from '@/db/resolutions';

function row(id: string, item_id: string, status: ResolutionRow['status'], created_at: number): ResolutionRow {
  return { id, session_id: 's1', run_id: 'r1', item_id, status, note: '', source: 'mcp', created_at };
}

describe('latestResolutions', () => {
  it('keeps the latest Resolution of each item, whatever order the rows come in', () => {
    const latest = latestResolutions([
      row('c', 'item_0001', 'resolved', 300),
      row('a', 'item_0001', 'in_progress', 100),
      row('b', 'item_0002', 'needs_info', 200),
    ]);
    expect(latest.get('item_0001')?.status).toBe('resolved');
    expect(latest.get('item_0002')?.status).toBe('needs_info');
    expect(latest.size).toBe(2);
  });

  it('breaks a same-millisecond tie on the Resolution id, in either input order', () => {
    const first = row('res_01', 'item_0001', 'in_progress', 100);
    const second = row('res_02', 'item_0001', 'resolved', 100);
    expect(latestResolutions([first, second]).get('item_0001')?.id).toBe('res_02');
    expect(latestResolutions([second, first]).get('item_0001')?.id).toBe('res_02');
  });
});

describe('itemStatusCounts', () => {
  it('counts open, in work, done (resolved and won’t fix) and needs info', () => {
    const counts = itemStatusCounts(
      ['item_0001', 'item_0002', 'item_0003', 'item_0004', 'item_0005', 'item_0006'],
      [
        row('a', 'item_0001', 'in_progress', 1),
        row('b', 'item_0002', 'in_progress', 1),
        row('c', 'item_0002', 'resolved', 2),
        row('d', 'item_0003', 'wont_fix', 1),
        row('e', 'item_0004', 'needs_info', 1),
      ],
    );
    expect(counts).toEqual({ total: 6, open: 2, in_progress: 1, done: 2, needs_info: 1 });
  });

  it('ignores Resolutions of items no longer current (deleted, or merged away)', () => {
    // item_0002 was merged into item_0001 and item_0003 deleted; only item_0001 remains, and it has no Resolution.
    const counts = itemStatusCounts(
      ['item_0001'],
      [row('a', 'item_0002', 'resolved', 1), row('b', 'item_0003', 'in_progress', 1)],
    );
    expect(counts).toEqual({ total: 1, open: 1, in_progress: 0, done: 0, needs_info: 0 });
  });

  it('is all open with no Resolutions, and zero across the board with no items', () => {
    expect(itemStatusCounts(['item_0001', 'item_0002'], [])).toEqual({
      total: 2,
      open: 2,
      in_progress: 0,
      done: 0,
      needs_info: 0,
    });
    expect(itemStatusCounts([], [])).toEqual({ total: 0, open: 0, in_progress: 0, done: 0, needs_info: 0 });
  });
});
