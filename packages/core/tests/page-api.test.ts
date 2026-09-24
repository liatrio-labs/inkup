// E5 page API: an Annotation made by a script on the page (`window.__inkup.annotate`) has no Strokes,
// carries the script's comment, reads as such in the Process script, and tags the Change Items it grounds.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { renderReviewMarkdown } from '../src/export/review-md';
import type { ChangeItem } from '../src/process/change-item';
import { groundItems } from '../src/process/grounding';
import { buildProcessPrompt, buildSystemPrompt } from '../src/process/script';
import { attachStyleChanges } from '../src/process/style-changes';
import { buildSessionDocument, type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { EventOf, TimelineEvent } from '../src/timeline';

const NOTE = { comment: 'Make the CTA stand out more' };
const EDIT = {
  changes: { 'background-color': { from: 'rgb(37, 99, 235)', to: 'rebeccapurple' } },
  text: { from: 'Get started', to: 'Start free' },
};

/** Fixture (a) with Annotation #1 remade as a page API one: no Strokes, a comment, and its changes as a style_edit. */
function session(): { doc: SessionDocument; events: TimelineEvent[] } {
  const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));
  const drawn = new Set(doc.events.flatMap((e) => (e.type === 'annotation' && e.index === 1 ? e.stroke_ids : [])));
  const events = doc.events
    .filter((e) => !(e.type === 'stroke' && drawn.has(e.stroke_id)))
    .flatMap((e): TimelineEvent[] => {
      if (e.type !== 'annotation' || e.index !== 1) return [e];
      const a = {
        ...e,
        stroke_ids: [],
        close_reason: 'page_api',
        source: 'page_api',
        page_api: NOTE,
      } satisfies EventOf<'annotation'>;
      return [
        a,
        {
          id: 'se-1',
          type: 'style_edit',
          t: e.t,
          annotation_id: e.annotation_id,
          selector: 'button.cta',
          ...EDIT,
        } satisfies EventOf<'style_edit'>,
      ];
    });
  return { doc: { ...doc, events }, events };
}

const item = (annotations: number[]): ChangeItem => ({
  id: 'item_0001',
  title: 'Make the CTA stand out',
  category: 'style',
  intent: 'The CTA should be purple and say "Start free".',
  locations: annotations.map((n) => ({
    role: 'subject' as const,
    selector: 'button.cta',
    element: "button 'Get started'",
    url: '/pricing.html',
    screenshot: null,
    annotation: n,
  })),
  evidence: { video: null, screenshots: [] },
  transcript: '',
  confidence: 0.9,
  agent_prompt: 'Restyle button.cta.',
  pinned: false,
});

describe('page API Annotations', () => {
  it('are valid with no Strokes; a drawn Annotation still needs one', () => {
    const { doc } = session();
    expect(SessionDocumentSchema.safeParse(doc).success).toBe(true);
    const unmarked = {
      ...doc,
      events: doc.events.map((e) => (e.type === 'annotation' && e.index === 1 ? { ...e, source: undefined } : e)),
    };
    const r = SessionDocumentSchema.safeParse(unmarked);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(
      'only an Object Select pick or a page_api Annotation has no Strokes',
    );
  });

  it('read in the Process script as made by a script, with the comment and changes', () => {
    const { doc } = session();
    const { script } = buildProcessPrompt(doc);
    const lines = script.split('\n');
    const at = lines.findIndex((l) => l.includes('ANNOTATION #1 PAGE API'));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at]).toContain('made by a script on the page');
    expect(lines[at]).not.toContain('Stroke');
    expect(lines[at]).not.toContain('closed by');
    expect(script).toContain('says: "Make the CTA stand out more"');
    expect(script).toContain('STYLE CHANGES');
    expect(script).toContain('background-color: rgb(37, 99, 235) → rebeccapurple; text: "Get started" → "Start free"');
    expect(buildSystemPrompt()).toContain('PAGE API');
  });

  it('tag the Change Items grounded only on them', () => {
    const { events } = session();
    const [only, mixed] = groundItems([item([1]), item([1, 2])], events);
    expect(only!.source).toBe('page_api');
    expect(mixed).not.toHaveProperty('source');
    // A source the model wrote is not kept.
    expect(groundItems([{ ...item([2]), source: 'page_api' }], events)[0]).not.toHaveProperty('source');
  });

  it("pass their changes through as the item's style_changes (E2's pass-through), then tag it", () => {
    const { events } = session();
    const [styled] = attachStyleChanges([item([1])], events, 'http://localhost:4400/pricing.html').items;
    expect(styled!.style_changes).toEqual([{ annotation: 1, selector: 'button.cta', ...EDIT }]);
    expect(styled!.agent_prompt).toContain('background-color: rgb(37, 99, 235) → rebeccapurple');
    expect(groundItems([styled!], events)[0]!.source).toBe('page_api');
  });

  it('review.md says the item came from the page API', () => {
    const { doc: base, events } = session();
    const [g] = groundItems([item([1])], events);
    const d = buildSessionDocument({
      session: base.session,
      events,
      blobs: base.blobs,
      audio: null,
      now: new Date('2026-09-23T10:00:00.000Z'),
      process_run: { id: 'run-1', model: 'claude-sonnet-5', items: [g!] },
    });
    expect(renderReviewMarkdown(d, { include: { video: false, audio: false } })).toContain(
      '**Category:** style · from the page API',
    );
  });
});
