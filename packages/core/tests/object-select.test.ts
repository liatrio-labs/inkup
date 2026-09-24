// E7, Object Select: the pick is an Annotation (close reason object_select, one definite Candidate, no Strokes) that
// spans the time until its comment was done, with the comment typed on it. Recorded `style_edit` events (the page
// API's data path) are passed through by Process as `style_changes`, stated exactly in agent_prompt, and listed in
// review.md. Exports from before E7 upgrade `inspect_pick` to `object_select`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { type ElementSnapshot, objectSelectRanking } from '../src/candidates';
import { renderReviewMarkdown } from '../src/export/review-md';
import { groupAll, stepGrouping } from '../src/grouping';
import {
  attachStyleChanges,
  buildProcessPrompt,
  buildSystemPrompt,
  type ChangeItem,
  ChangeItemSchema,
  ChangeItemsOutputSchema,
  latestStyleEdits,
} from '../src/process';
import { mergeItems } from '../src/review-edits';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import { upgradeSessionDocument } from '../src/session-file';
import { type EventOf, type TimelineEvent, TimelineEventSchema } from '../src/timeline';

const base = (): SessionDocument =>
  SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));

const cta: ElementSnapshot = {
  key: 'e0',
  parent: null,
  depth: 5,
  tag: 'button',
  role: 'button',
  name: 'Get started',
  text: 'Get started',
  selector: '[data-testid="hero-cta"]',
  testid: 'hero-cta',
  id: null,
  classes: ['cta'],
  bbox: { x: 600, y: 300, width: 160, height: 56 },
  stroke_hit: false,
};

const PICK_T = 12_000;
const DONE_T = 15_000;

/** Fixture (a) plus an Object Select pick of the CTA (#3) with a typed comment, its screenshot and two style edits (the second wins). */
function withPick(): { doc: SessionDocument; pick: EventOf<'annotation'> } {
  const doc = base();
  const last = doc.events.filter((e) => e.type === 'annotation').at(-1)!;
  const ranking = objectSelectRanking(cta);
  const pick: EventOf<'annotation'> = {
    ...last,
    id: 'ev-pick',
    annotation_id: 'pick-1',
    index: last.index + 1,
    t: PICK_T,
    t_end: DONE_T,
    stroke_ids: [],
    close_reason: 'object_select',
    bbox: cta.bbox,
    connector: null,
    ...ranking,
    screenshot_id: 'shot-pick',
    comment: 'Make this roomier',
  };
  const shot = {
    id: 'ev-shot',
    type: 'screenshot',
    t: PICK_T,
    screenshot_id: 'shot-pick',
    path: 'screenshots/shot-pick.png',
    mime: 'image/png',
    trigger: 'annotation',
    annotation_id: 'pick-1',
    url: pick.url,
    scroll: pick.scroll,
    viewport: pick.viewport,
    dpr: pick.dpr,
  } as const;
  const edit = (
    id: string,
    t: number,
    changes: Record<string, { from: string; to: string }>,
    text?: { from: string; to: string },
  ): EventOf<'style_edit'> => ({
    id,
    type: 'style_edit',
    t,
    annotation_id: 'pick-1',
    selector: '[data-testid="hero-cta"]',
    changes,
    ...(text ? { text } : {}),
  });
  const events = [
    ...doc.events.filter((e) => e.type !== 'session_end'),
    shot,
    pick,
    edit('ev-e1', PICK_T + 2000, { padding: { from: '14px 28px', to: '18px 30px' } }),
    edit(
      'ev-e2',
      PICK_T + 4000,
      {
        padding: { from: '14px 28px', to: '20px 32px' },
        'background-color': { from: 'rgb(59, 91, 219)', to: 'var(--accent)' },
      },
      { from: 'Get started', to: 'Start free' },
    ),
    ...doc.events.filter((e) => e.type === 'session_end').map((e) => ({ ...e, t: Math.max(e.t, PICK_T + 5000) })),
  ] as TimelineEvent[];
  const blobs = [
    ...doc.blobs,
    { id: 'shot-pick', kind: 'screenshot', mime: 'image/png', size: 1000, path: 'screenshots/shot-pick.png' },
  ];
  return { doc: SessionDocumentSchema.parse({ ...doc, events, blobs }), pick };
}

const modelItem = (annotation: number, shot: string, prompt: string): ChangeItem => ({
  id: 'item_0001',
  title: 'Restyle the Get started button',
  category: 'style',
  intent: 'Roomier, accent-coloured CTA.',
  locations: [
    {
      role: 'subject',
      selector: '[data-testid="hero-cta"]',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: shot,
      annotation,
    },
  ],
  evidence: { video: { start: 12, end: 16 }, screenshots: [shot] },
  transcript: 'make this roomier',
  confidence: 0.9,
  agent_prompt: prompt,
  pinned: false,
});

describe('timeline schema', () => {
  it('accepts a style_edit with changes and an optional text change', () => {
    const e = {
      id: 'x',
      type: 'style_edit',
      t: 5,
      annotation_id: 'a',
      selector: 'button.cta',
      changes: { 'font-size': { from: '18px', to: '20px' } },
    };
    expect(TimelineEventSchema.parse(e)).toEqual(e);
    expect(TimelineEventSchema.parse({ ...e, changes: {}, text: { from: 'a', to: 'b' } })).toMatchObject({
      text: { from: 'a', to: 'b' },
    });
    expect(TimelineEventSchema.safeParse({ ...e, changes: { color: { from: 'red' } } }).success).toBe(false);
  });

  it('a pick has no Strokes; any other Annotation without Strokes is invalid, as is an edit of an unknown Annotation', () => {
    const { doc, pick } = withPick();
    expect(SessionDocumentSchema.safeParse(doc).success).toBe(true);
    const drawn = {
      ...doc,
      events: doc.events.map((e) => (e.id === pick.id ? { ...pick, close_reason: 'time_gap' } : e)),
    };
    expect(SessionDocumentSchema.safeParse(drawn).error?.issues[0]?.message).toBe(
      'only an Object Select pick or a page_api Annotation has no Strokes',
    );
    const orphan = {
      ...doc,
      events: doc.events.map((e) => (e.type === 'style_edit' ? { ...e, annotation_id: 'nope' } : e)),
    };
    expect(SessionDocumentSchema.safeParse(orphan).error?.issues[0]?.message).toBe(
      'style edit of unknown annotation nope',
    );
  });

  it('an Object Select pick is one definite Candidate covering its whole box', () => {
    expect(objectSelectRanking(cta)).toEqual({
      resolution: 'element',
      pick: 0,
      candidates: [
        {
          selector: '[data-testid="hero-cta"]',
          tag: 'button',
          role: 'button',
          name: 'Get started',
          text: 'Get started',
          testid: 'hero-cta',
          id: null,
          classes: ['cta'],
          bbox: cta.bbox,
          relation: 'pick',
          coverage: 1,
        },
      ],
    });
  });
});

describe('upgrade', () => {
  it('maps an Inspect pick (inspect_pick, schema 11) to object_select with no comment', () => {
    const { doc, pick } = withPick();
    const old = {
      ...doc,
      schema_version: 11,
      events: doc.events.map((e) => {
        if (e.id !== pick.id) return e;
        const { comment: _gone, ...rest } = e as EventOf<'annotation'>;
        return { ...rest, close_reason: 'inspect_pick' };
      }),
    };
    const up = upgradeSessionDocument(JSON.parse(JSON.stringify(old)));
    expect(up.events.find((e) => e.id === pick.id)).toMatchObject({ close_reason: 'object_select', comment: null });
    // A drawn Annotation gets no comment.
    expect(
      up.events
        .filter((e) => e.type === 'annotation' && e.id !== pick.id)
        .every((e) => (e as EventOf<'annotation'>).comment === null),
    ).toBe(true);
  });
});

describe('grouping', () => {
  it('an Object Select pick closes the open Annotation with close reason object_select', () => {
    const { state } = groupAll([
      { kind: 'pointer_down', t: 0 },
      { kind: 'stroke', stroke: { stroke_id: 'a', t: 0, t_end: 300, bbox: { x: 0, y: 0, width: 10, height: 10 } } },
    ]);
    const r = stepGrouping(state, { kind: 'signal', reason: 'object_select', t: 900 });
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0]).toMatchObject({ close_reason: 'object_select', closed_at: 900 });
    expect(r.state.open).toBeNull();
  });
});

describe('Process', () => {
  it('shows the pick, its span, its comment and its latest changes in the script, and explains them in the system prompt', () => {
    const { doc, pick } = withPick();
    const { script, context } = buildProcessPrompt(doc);
    expect(script).toContain(
      '[00:12.0] ANNOTATION #3 OBJECT SELECT · 00:12.0–00:15.0 · at /pricing.html · screenshot s3',
    );
    expect(script).toContain('    COMMENT "Make this roomier"');
    expect(script).toContain(
      '    c0 [data-testid="hero-cta"] · <button role=button class="cta"> "Get started" · PICK · covers 100%',
    );
    expect(script).toContain(
      '    STYLE CHANGES at 00:16.0 (exact): padding: 14px 28px → 20px 32px; background-color: rgb(59, 91, 219) → var(--accent); text: "Get started" → "Start free"',
    );
    expect(script).not.toContain('18px 30px');
    expect(context.annotations[3]).toEqual({
      selectors: ['[data-testid="hero-cta"]'],
      screenshot: 's3',
      url: pick.url,
    });
    expect(buildSystemPrompt()).toContain('OBJECT SELECT');
    expect(buildSystemPrompt()).toContain('COMMENT (under an OBJECT SELECT)');
    expect(buildSystemPrompt()).not.toMatch(/inspect|made live/i);
    expect(buildSystemPrompt()).toContain('use the token rather than the raw value');
  });

  it('keeps style_changes out of the model output schema', () => {
    const shape = (
      ChangeItemsOutputSchema.shape.items.element as unknown as {
        _zod: { def: { in?: { shape: object }; shape?: object } };
      }
    )._zod.def;
    const keys = Object.keys((shape.in ?? shape).shape ?? {});
    expect(keys).toContain('agent_prompt');
    expect(keys).not.toContain('style_changes');
  });

  it("passes the latest edits through to the model's item and makes its agent_prompt state each one exactly", () => {
    const { doc } = withPick();
    const item = modelItem(
      3,
      'shot-pick',
      'On /pricing.html make [data-testid="hero-cta"] roomier. See screenshots/shot-pick.png.',
    );
    const { items, added } = attachStyleChanges([item], doc.events, doc.session.start_url);
    expect(added).toEqual([]);
    const out = ChangeItemSchema.parse(items[0]);
    expect(out.style_changes).toEqual([
      {
        annotation: 3,
        selector: '[data-testid="hero-cta"]',
        changes: {
          padding: { from: '14px 28px', to: '20px 32px' },
          'background-color': { from: 'rgb(59, 91, 219)', to: 'var(--accent)' },
        },
        text: { from: 'Get started', to: 'Start free' },
      },
    ]);
    expect(out.agent_prompt).toContain('- [data-testid="hero-cta"] (Annotation #3): padding: 14px 28px → 20px 32px');
    expect(out.agent_prompt).toContain(
      '- [data-testid="hero-cta"] (Annotation #3): background-color: rgb(59, 91, 219) → var(--accent)',
    );
    expect(out.agent_prompt).toContain(
      '- [data-testid="hero-cta"] (Annotation #3): text: "Get started" → "Start free"',
    );
    expect(out.agent_prompt).toContain('a value written as var(--name) names the token to use');
    // A prompt that already states every edit is left as the model wrote it.
    const stated = attachStyleChanges(items, doc.events, doc.session.start_url).items[0]!;
    expect(stated.agent_prompt).toBe(out.agent_prompt);
  });

  it('adds an item for an edited pick no item covers, and replaces style_changes a model made up', () => {
    const { doc } = withPick();
    const other = {
      ...modelItem(1, 'x', 'Move it.'),
      evidence: { video: null, screenshots: [] },
      style_changes: [{ annotation: 1, selector: 'x', changes: { color: { from: 'a', to: 'b' } } }],
    };
    const { items, added } = attachStyleChanges([other], doc.events, doc.session.start_url);
    expect(items[0]!.style_changes).toBeUndefined();
    expect(added).toEqual(['item_0002']);
    const made = ChangeItemSchema.parse(items[1]);
    expect(made).toMatchObject({
      id: 'item_0002',
      title: "Restyle button 'Get started'",
      category: 'style',
      locations: [
        {
          role: 'subject',
          selector: '[data-testid="hero-cta"]',
          annotation: 3,
          screenshot: 'shot-pick',
          url: '/pricing.html',
        },
      ],
      evidence: { video: { start: 12, end: 16 }, screenshots: ['shot-pick'] },
    });
    expect(made.agent_prompt).toContain('screenshots/shot-pick.png');
    expect(made.style_changes?.[0]?.changes.padding).toEqual({ from: '14px 28px', to: '20px 32px' });
  });

  it('ignores a scratched pick and an edit that undid everything', () => {
    const { doc, pick } = withPick();
    const scratch = {
      id: 'vc',
      type: 'voice_command',
      t: PICK_T + 4500,
      t_end: PICK_T + 4600,
      command: 'scratch_that',
      phrase: 'scratch that',
      segment_id: null,
      target: { kind: 'annotation', id: pick.annotation_id },
    } as TimelineEvent;
    expect(attachStyleChanges([], [...doc.events, scratch], doc.session.start_url).items).toEqual([]);
    const undone = {
      id: 'ev-e3',
      type: 'style_edit',
      t: PICK_T + 4800,
      annotation_id: 'pick-1',
      selector: 'x',
      changes: {},
    } as TimelineEvent;
    expect(latestStyleEdits([...doc.events, undone]).size).toBe(0);
  });

  it('a merge keeps both items’ style changes once', () => {
    const { doc } = withPick();
    const [a] = attachStyleChanges(
      [modelItem(3, 'shot-pick', 'See screenshots/shot-pick.png.')],
      doc.events,
      doc.session.start_url,
    ).items;
    expect(mergeItems(a!, a!).style_changes).toHaveLength(1);
  });
});

describe('review.md', () => {
  it('lists the style changes of an item, exactly', () => {
    const { doc } = withPick();
    const { items } = attachStyleChanges(
      [modelItem(3, 'shot-pick', 'See screenshots/shot-pick.png.')],
      doc.events,
      doc.session.start_url,
    );
    const md = renderReviewMarkdown({ ...doc, change_items: items }, { include: { video: false, audio: false } });
    expect(md).toContain('**Style changes** (exact; apply as given)');
    expect(md).toContain('- `[data-testid="hero-cta"]` (Annotation #3): `padding: 14px 28px → 20px 32px`');
    expect(md).toContain(
      '- `[data-testid="hero-cta"]` (Annotation #3): `background-color: rgb(59, 91, 219) → var(--accent)`',
    );
    expect(md).toContain('- `[data-testid="hero-cta"]` (Annotation #3): `text: "Get started" → "Start free"`');
  });
});
