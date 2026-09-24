import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import type { ChangeItem } from '../src/process/change-item';
import { buildProcessPrompt } from '../src/process/script';
import {
  acceptanceRate,
  applyItemEdits,
  applyTranscriptEdits,
  effectiveItemEdits,
  mergeItems,
  mergeSources,
  nextItemId,
  undoState,
} from '../src/review-edits';
import { buildSessionDocument, type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { ItemEditOp, TimelineEvent } from '../src/timeline';

const item = (n: number, over: Partial<ChangeItem> = {}): ChangeItem => ({
  id: `item_000${n}`,
  title: `Item ${n}`,
  category: 'layout',
  intent: `Intent ${n}.`,
  locations: [
    {
      role: 'subject',
      selector: `.x${n}`,
      element: `element ${n}`,
      url: '/pricing.html',
      screenshot: `shot${n}`,
      annotation: n,
    },
  ],
  evidence: { video: { start: n, end: n + 1 }, screenshots: [`shot${n}`] },
  transcript: `words ${n}`,
  confidence: 0.9,
  agent_prompt: `Do ${n}. See screenshots/shot${n}.png.`,
  pinned: false,
  ...over,
});

const ids = (items: ChangeItem[]) => items.map((i) => i.id);

describe('applyItemEdits', () => {
  const generated = [item(1), item(2), item(3, { confidence: 0.4, ambiguity: 'Which card?' })];

  it('starts in review order: unsure items first', () => {
    expect(ids(applyItemEdits(generated, []).items)).toEqual(['item_0003', 'item_0001', 'item_0002']);
  });

  it('edits title, intent and category only where given', () => {
    const { items, touched } = applyItemEdits(generated, [
      { op: 'edit', item_id: 'item_0001', changes: { title: 'New title', category: 'style' } },
    ]);
    expect(items.find((i) => i.id === 'item_0001')).toMatchObject({
      title: 'New title',
      category: 'style',
      intent: 'Intent 1.',
    });
    expect([...touched]).toEqual(['item_0001']);
  });

  it('deletes', () => {
    expect(ids(applyItemEdits(generated, [{ op: 'delete', item_id: 'item_0002' }]).items)).toEqual([
      'item_0003',
      'item_0001',
    ]);
  });

  it('merges two items into the first, unioning Locations and Evidence', () => {
    const { items, touched } = applyItemEdits(generated, [{ op: 'merge', into: 'item_0001', from: 'item_0003' }]);
    expect(ids(items)).toEqual(['item_0001', 'item_0002']);
    const merged = items[0]!;
    expect(merged.title).toBe('Item 1');
    expect(merged.locations.map((l) => l.selector)).toEqual(['.x1', '.x3']);
    expect(merged.evidence).toEqual({ video: { start: 1, end: 4 }, screenshots: ['shot1', 'shot3'] });
    expect(merged.transcript).toBe('words 1 ... words 3');
    expect(merged.confidence).toBe(0.4);
    expect(merged.ambiguity).toBe('Which card?');
    expect(merged.agent_prompt).toContain('screenshots/shot1.png');
    expect(merged.agent_prompt).toContain('screenshots/shot3.png');
    expect([...touched].sort()).toEqual(['item_0001', 'item_0003']);
  });

  it('a merged item still satisfies the Change Item rules', () => {
    const doc = docWith([item(1), item(2)], [{ op: 'merge', into: 'item_0002', from: 'item_0001' }]);
    expect(doc.change_items).toHaveLength(1);
  });

  it('keeps one copy of a Location both items share', () => {
    const a = item(1);
    const b = item(2, { locations: a.locations });
    expect(mergeItems(a, b).locations).toHaveLength(1);
  });

  it('splits into a copy right after the original, which can then be edited', () => {
    const edits: ItemEditOp[] = [
      { op: 'split', item_id: 'item_0001', new_id: 'item_0004' },
      { op: 'edit', item_id: 'item_0004', changes: { title: 'Second half' } },
    ];
    const { items, touched } = applyItemEdits(generated, edits);
    expect(ids(items)).toEqual(['item_0003', 'item_0001', 'item_0004', 'item_0002']);
    expect(items[2]).toMatchObject({ title: 'Second half', locations: item(1).locations });
    expect([...touched]).toEqual(['item_0001']);
  });

  it('reorders; items the order leaves out keep their relative place after it', () => {
    expect(
      ids(applyItemEdits(generated, [{ op: 'reorder', order: ['item_0002', 'item_0001', 'item_0003'] }]).items),
    ).toEqual(['item_0002', 'item_0001', 'item_0003']);
    expect(ids(applyItemEdits(generated, [{ op: 'reorder', order: ['item_0002'] }]).items)).toEqual([
      'item_0002',
      'item_0003',
      'item_0001',
    ]);
  });

  it('ignores edits of items that no longer exist', () => {
    const edits: ItemEditOp[] = [
      { op: 'delete', item_id: 'item_0002' },
      { op: 'edit', item_id: 'item_0002', changes: { title: 'x' } },
      { op: 'merge', into: 'item_0001', from: 'item_0002' },
    ];
    expect(ids(applyItemEdits(generated, edits).items)).toEqual(['item_0003', 'item_0001']);
  });
});

describe('a combined merge (E12)', () => {
  const generated = [item(1), item(2), item(3, { confidence: 0.4, ambiguity: 'Which card?' })];
  const merge: ItemEditOp = { op: 'merge', into: 'item_0001', from: 'item_0002' };
  const combine: ItemEditOp = {
    op: 'edit',
    item_id: 'item_0001',
    origin: 'combine',
    changes: {
      title: 'Do 1 and 2',
      intent: 'Both at once.',
      category: 'style',
      agent_prompt: 'Do 1 and 2. See screenshots/shot1.png and screenshots/shot2.png.',
      ambiguity: 'Left or right?',
    },
  };

  it('replays the merge, then the combine edit: combined words over the unioned Locations and Evidence', () => {
    const { items, uncombined } = applyItemEdits(generated, [merge, combine]);
    const merged = items.find((i) => i.id === 'item_0001')!;
    expect(merged).toMatchObject({
      title: 'Do 1 and 2',
      intent: 'Both at once.',
      category: 'style',
      agent_prompt: combine.changes.agent_prompt,
      ambiguity: 'Left or right?',
    });
    expect(merged.locations.map((l) => l.selector)).toEqual(['.x1', '.x2']);
    expect(merged.evidence.screenshots).toEqual(['shot1', 'shot2']);
    expect(merged.transcript).toBe('words 1 ... words 2');
    expect([...uncombined]).toEqual([]);
  });

  it('a merge with no edit after it is uncombined until one comes, whoever wrote it', () => {
    expect([...applyItemEdits(generated, [merge]).uncombined]).toEqual(['item_0001']);
    expect([
      ...applyItemEdits(generated, [merge, { op: 'edit', item_id: 'item_0001', changes: { title: 'Mine' } }])
        .uncombined,
    ]).toEqual([]);
    expect([...applyItemEdits(generated, [merge, { op: 'delete', item_id: 'item_0001' }]).uncombined]).toEqual([]);
    // Merged again into another item: only the survivor is uncombined.
    expect([
      ...applyItemEdits(generated, [merge, { op: 'merge', into: 'item_0003', from: 'item_0001' }]).uncombined,
    ]).toEqual(['item_0003']);
  });

  it('null ambiguity clears it, except on a low-confidence item, which keeps its own', () => {
    const clear = (id: string): ItemEditOp => ({
      op: 'edit',
      item_id: id,
      origin: 'combine',
      changes: { ambiguity: null },
    });
    const withAmbiguity = [item(1, { ambiguity: 'Maybe.' }), item(3, { confidence: 0.4, ambiguity: 'Which card?' })];
    const { items } = applyItemEdits(withAmbiguity, [clear('item_0001'), clear('item_0003')]);
    expect(items.find((i) => i.id === 'item_0001')!).not.toHaveProperty('ambiguity');
    expect(items.find((i) => i.id === 'item_0003')!.ambiguity).toBe('Which card?');
  });

  it('session.json carries the combined item and still validates', () => {
    const doc = docWith(
      [item(1), item(2)],
      [merge, { ...combine, changes: { ...combine.changes, agent_prompt: undefined } }],
    );
    expect(doc.change_items).toHaveLength(1);
    expect(doc.change_items![0]).toMatchObject({ title: 'Do 1 and 2', ambiguity: 'Left or right?' });
    expect(doc.events.at(-1)).toMatchObject({ type: 'item_edit', edit: { op: 'edit', origin: 'combine' } });
  });

  it('mergeSources: the two items just before the latest merge into an item', () => {
    const edits: ItemEditOp[] = [{ op: 'edit', item_id: 'item_0002', changes: { title: 'Two' } }, merge, combine];
    const sources = mergeSources(generated, edits, 'item_0001')!;
    expect(sources.into.title).toBe('Item 1');
    expect(sources.from.title).toBe('Two');
    expect(mergeSources(generated, edits, 'item_0002')).toBeNull();
  });
});

describe('undo and redo (F5)', () => {
  const generated = [item(1), item(2), item(3, { confidence: 0.4, ambiguity: 'Which card?' })];
  const merge: ItemEditOp = { op: 'merge', into: 'item_0001', from: 'item_0002' };
  const combine: ItemEditOp = {
    op: 'edit',
    item_id: 'item_0001',
    origin: 'combine',
    changes: { title: 'Do 1 and 2', intent: 'Both at once.' },
  };
  const undo: ItemEditOp = { op: 'undo' };
  const redo: ItemEditOp = { op: 'redo' };
  const titles = (edits: ItemEditOp[]) => applyItemEdits(generated, edits).items.map((i) => i.title);

  it('undoing a combined merge brings both originals back and drops the combined words', () => {
    const { items, touched, uncombined } = applyItemEdits(generated, [merge, combine, undo]);
    expect(ids(items)).toEqual(['item_0003', 'item_0001', 'item_0002']);
    expect(items.find((i) => i.id === 'item_0001')).toEqual(item(1));
    expect(items.find((i) => i.id === 'item_0002')).toEqual(item(2));
    expect([...touched]).toEqual([]);
    expect([...uncombined]).toEqual([]);
    expect(undoState([merge, combine, undo])).toEqual({ canUndo: false, canRedo: true });
  });

  it('redo puts the merge back with its combined words', () => {
    const edits = [merge, combine, undo, redo];
    expect(applyItemEdits(generated, edits)).toEqual(applyItemEdits(generated, [merge, combine]));
    expect(titles(edits)).toEqual(['Item 3', 'Do 1 and 2']);
    expect(undoState(edits)).toEqual({ canUndo: true, canRedo: false });
  });

  it('a combine that came after another change to the item is its own step', () => {
    const mine: ItemEditOp = { op: 'edit', item_id: 'item_0001', changes: { title: 'Mine' } };
    // Combine with AI again, after the reviewer's own edit: undo takes back the rewrite only.
    expect(titles([merge, mine, combine, undo])).toEqual(['Item 3', 'Mine']);
    // An edit of another item in between does not split the merge from its combine.
    const other: ItemEditOp = { op: 'edit', item_id: 'item_0003', changes: { title: 'Three' } };
    expect(effectiveItemEdits([merge, other, combine, undo])).toEqual([merge, combine]);
    expect(titles([merge, other, combine, undo, undo])).toEqual(['Item 3', 'Item 1', 'Item 2']);
  });

  it('a combine answer for a merge already undone is void, and redo still brings the merge back', () => {
    const edits = [merge, undo, combine];
    expect(titles(edits)).toEqual(['Item 3', 'Item 1', 'Item 2']);
    expect(undoState(edits)).toEqual({ canUndo: false, canRedo: true });
    expect(titles([...edits, redo])).toEqual(['Item 3', 'Item 1']);
  });

  it('undo and redo chains walk every kind of step back and forth', () => {
    const steps: ItemEditOp[] = [
      { op: 'edit', item_id: 'item_0001', changes: { title: 'One' } },
      { op: 'split', item_id: 'item_0002', new_id: 'item_0004' },
      { op: 'delete', item_id: 'item_0003' },
      { op: 'reorder', order: ['item_0004', 'item_0002', 'item_0001'] },
      merge,
      combine,
    ];
    const after = (n: number) => applyItemEdits(generated, steps.slice(0, n)).items;
    // Five steps (the combine joins the merge): undo each in turn, then redo each in turn.
    const states = [0, 1, 2, 3, 4, 6].map(after);
    const log: ItemEditOp[] = [...steps];
    for (let k = 4; k >= 0; k--) {
      log.push(undo);
      expect(applyItemEdits(generated, log).items).toEqual(states[k]);
    }
    log.push(undo); // nothing left to undo
    expect(applyItemEdits(generated, log).items).toEqual(states[0]);
    expect(undoState(log)).toEqual({ canUndo: false, canRedo: true });
    for (let k = 1; k <= 5; k++) {
      log.push(redo);
      expect(applyItemEdits(generated, log).items).toEqual(states[k]);
    }
    log.push(redo); // nothing left to redo
    expect(applyItemEdits(generated, log).items).toEqual(states[5]);
    expect(undoState(log)).toEqual({ canUndo: true, canRedo: false });
  });

  it('a new step after an undo clears what can be redone', () => {
    const edits: ItemEditOp[] = [
      { op: 'edit', item_id: 'item_0001', changes: { title: 'A' } },
      undo,
      { op: 'edit', item_id: 'item_0002', changes: { title: 'B' } },
      redo,
    ];
    expect(titles(edits)).toEqual(['Item 3', 'Item 1', 'B']);
    expect(undoState(edits)).toEqual({ canUndo: true, canRedo: false });
  });

  it('undone edits do not count against the acceptance rate, and mergeSources skips an undone merge', () => {
    expect(acceptanceRate(generated, [merge, combine, undo]).unedited).toBe(3);
    expect(mergeSources(generated, [merge, undo], 'item_0001')).toBeNull();
    expect(mergeSources(generated, [merge, undo, redo], 'item_0001')!.from.id).toBe('item_0002');
  });

  it('after a reload, session.json replays the log to the same list and keeps every op', () => {
    const edits = [
      merge,
      combine,
      undo,
      { op: 'edit', item_id: 'item_0002', changes: { title: 'Two' } } as ItemEditOp,
      undo,
      redo,
    ];
    const doc = docWith([item(1), item(2)], edits);
    expect(doc.change_items!.map((i) => i.title)).toEqual(['Item 1', 'Two']);
    expect(doc.process_run!.acceptance).toEqual({ generated: 2, unedited: 1, rate: 0.5 });
    expect(doc.events.filter((e) => e.type === 'item_edit').map((e) => (e as { edit: ItemEditOp }).edit.op)).toEqual([
      'merge',
      'edit',
      'undo',
      'edit',
      'undo',
      'redo',
    ]);
    // The exported file reads back to the same document.
    expect(SessionDocumentSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});

describe('acceptanceRate', () => {
  const generated = [item(1), item(2), item(3), item(4)];
  it('counts generated items exported without an edit; reorder is not an edit, delete is', () => {
    expect(
      acceptanceRate(generated, [
        { op: 'reorder', order: ['item_0004', 'item_0003', 'item_0002', 'item_0001'] },
        { op: 'edit', item_id: 'item_0001', changes: { intent: 'Changed.' } },
        { op: 'delete', item_id: 'item_0002' },
      ]),
    ).toEqual({ generated: 4, unedited: 2, rate: 0.5 });
  });
  it('is null when nothing was generated', () => {
    expect(acceptanceRate([], [])).toEqual({ generated: 0, unedited: 0, rate: null });
  });
});

describe('nextItemId', () => {
  it('continues past the highest id', () => {
    expect(nextItemId(['item_0002', 'item_0010', 'other'])).toBe('item_0011');
    expect(nextItemId([])).toBe('item_0001');
  });
});

const fixture = (): SessionDocument =>
  SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('b-same-height', 'word'), 'utf8')));

function docWith(items: ChangeItem[], edits: ItemEditOp[]): SessionDocument {
  const base = fixture();
  const shots = base.events
    .filter((e) => e.type === 'screenshot')
    .map((e) => (e as { screenshot_id: string }).screenshot_id);
  const rename = (i: ChangeItem, n: number): ChangeItem => ({
    ...i,
    locations: i.locations.map((l) => ({ ...l, screenshot: shots[n % shots.length]! })),
    evidence: { ...i.evidence, screenshots: [shots[n % shots.length]!] },
    agent_prompt: `Do it. See screenshots/${shots[n % shots.length]}.png.`,
  });
  const end = base.session.duration_ms!;
  const events: TimelineEvent[] = [
    ...base.events,
    ...edits.map((edit, k) => ({
      id: `edit-${k}`,
      type: 'item_edit' as const,
      t: end,
      run_id: 'run-1',
      edited_at: '2026-09-22T13:00:00.000Z',
      edit,
    })),
  ];
  return buildSessionDocument({
    session: base.session,
    events,
    blobs: base.blobs,
    audio: null,
    now: new Date('2026-09-22T13:00:00.000Z'),
    process_run: { id: 'run-1', model: 'claude-sonnet-5', items: items.map(rename) },
  });
}

describe('session.json with review edits', () => {
  it('change_items are the edited list; process_run keeps what was generated and the acceptance rate', () => {
    const doc = docWith([item(1), item(2)], [{ op: 'edit', item_id: 'item_0002', changes: { title: 'Edited' } }]);
    expect(doc.change_items!.map((i) => i.title)).toEqual(['Item 1', 'Edited']);
    expect(doc.process_run!.generated_items.map((i) => i.title)).toEqual(['Item 1', 'Item 2']);
    expect(doc.process_run!.acceptance).toEqual({ generated: 2, unedited: 1, rate: 0.5 });
  });

  it('edits of another run are ignored', () => {
    const base = docWith([item(1)], []);
    const other = {
      id: 'x',
      type: 'item_edit' as const,
      t: base.session.duration_ms!,
      run_id: 'run-0',
      edited_at: '2026-09-22T13:00:00.000Z',
      edit: { op: 'delete' as const, item_id: 'item_0001' },
    };
    const doc = buildSessionDocument({
      ...base,
      audio: null,
      now: new Date(),
      events: [...base.events, other],
      process_run: { id: 'run-1', model: 'm', items: base.process_run!.generated_items },
    });
    expect(doc.change_items).toHaveLength(1);
  });
});

describe('transcript edits', () => {
  it('the latest edit replaces the segment text and drops its word timings', () => {
    const doc = fixture();
    const end = doc.session.duration_ms!;
    const events = [
      ...doc.events,
      {
        id: 'e1',
        type: 'transcript_edit' as const,
        t: end,
        segment_id: 'g1',
        text: 'first try',
        edited_at: '2026-09-22T13:00:00.000Z',
      },
      {
        id: 'e2',
        type: 'transcript_edit' as const,
        t: end,
        segment_id: 'g1',
        text: 'make this card as tall as that one',
        edited_at: '2026-09-22T13:01:00.000Z',
      },
    ];
    const applied = applyTranscriptEdits(events);
    const seg = applied.find((e) => e.type === 'transcript_segment')!;
    expect(seg).toMatchObject({ text: 'make this card as tall as that one', words: null });
    expect(applied.some((e) => e.type === 'transcript_edit')).toBe(false);
  });

  it('Process reads the edited text', () => {
    const doc = fixture();
    const edited = SessionDocumentSchema.parse({
      ...doc,
      events: [
        ...doc.events,
        {
          id: 'e1',
          type: 'transcript_edit',
          t: doc.session.duration_ms,
          segment_id: 'g1',
          text: 'make this card as tall as that one',
          edited_at: '2026-09-22T13:00:00.000Z',
        },
      ],
    });
    const { script } = buildProcessPrompt(edited);
    expect(script).toContain('SPEECH "make this card as tall as that one"');
    expect(script).not.toContain('the same height');
  });

  it('session.json rejects an edit of a segment that does not exist', () => {
    const doc = fixture();
    const bad = {
      ...doc,
      events: [
        ...doc.events,
        {
          id: 'e1',
          type: 'transcript_edit',
          t: doc.session.duration_ms,
          segment_id: 'nope',
          text: 'x',
          edited_at: '2026-09-22T13:00:00.000Z',
        },
      ],
    };
    expect(SessionDocumentSchema.safeParse(bad).success).toBe(false);
  });
});
