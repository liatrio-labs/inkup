// E4 grounding: Candidate sources and element crops copied onto Change Items after Process, and carried through the
// export (review.md, the zip plan).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { planExport, promptCitations } from '../src/export/bundle';
import { renderReviewMarkdown } from '../src/export/review-md';
import type { ChangeItem } from '../src/process/change-item';
import { CROP_PROMPT_PREFIX, groundItems, SOURCE_PROMPT_PREFIX } from '../src/process/grounding';
import { buildSessionDocument, type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { EventOf, TimelineEvent } from '../src/timeline';

const SOURCE = { file: 'src/App.js', line: 6, components: ['CtaButton', 'PricingCard', 'App'] };

/** Fixture (a) where Annotation #1's button reports a source and has an element crop. */
function session(): { doc: SessionDocument; events: TimelineEvent[]; shot: string } {
  const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));
  let shot = '';
  const events = doc.events.map((e): TimelineEvent => {
    if (e.type !== 'annotation' || e.index !== 1) return e;
    shot = e.screenshot_id!;
    return {
      ...e,
      candidates: e.candidates.map((c) => (c.selector === 'button.cta' ? { ...c, source: SOURCE } : c)),
      crop: {
        blob_id: `${shot}.crop`,
        path: `screenshots/${shot}.crop.png`,
        rect: { x: 84, y: 184, width: 152, height: 72 },
      },
    } satisfies EventOf<'annotation'>;
  });
  return { doc, events, shot };
}

const item = (shot: string, extra: Partial<ChangeItem> = {}): ChangeItem => ({
  id: 'item_0001',
  title: "Move 'Get started' into the header",
  category: 'layout',
  intent: 'The CTA belongs in the header.',
  locations: [
    {
      role: 'subject',
      selector: 'button.cta',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: shot,
      annotation: 1,
    },
    { role: 'destination', selector: 'nav', element: 'nav', url: '/pricing.html', screenshot: null, annotation: 2 },
  ],
  evidence: { video: null, screenshots: [shot] },
  transcript: 'this button should go here',
  confidence: 0.9,
  agent_prompt: `Move button.cta into the nav. See screenshots/${shot}.png.`,
  pinned: false,
  ...extra,
});

describe('groundItems', () => {
  it("copies the named Candidate's source onto its Location, and the Annotation's crop into Evidence and the prompt", () => {
    const { events, shot } = session();
    const [g] = groundItems([item(shot)], events);
    expect(g!.locations[0]!.source).toEqual(SOURCE);
    expect(g!.locations[1]).not.toHaveProperty('source');
    expect(g!.evidence.crops).toEqual([`${shot}.crop`]);
    expect(g!.agent_prompt).toContain(
      `${SOURCE_PROMPT_PREFIX} button.cta is rendered at src/App.js:6 (CtaButton ← PricingCard ← App).`,
    );
    expect(g!.agent_prompt).toContain(`${CROP_PROMPT_PREFIX} screenshots/${shot}.crop.png`);
    // Both the screenshot and its crop are citations the export must carry.
    expect(promptCitations(g!.agent_prompt)).toEqual([shot, `${shot}.crop`]);
  });

  it('is idempotent, and replaces what the model made up', () => {
    const { events, shot } = session();
    const invented = item(shot, {
      locations: [
        {
          role: 'subject',
          selector: 'nav',
          element: 'nav',
          url: '/pricing.html',
          screenshot: null,
          annotation: 2,
          source: { file: 'made/up.ts', components: [] },
        },
      ],
      evidence: { video: null, screenshots: [shot], crops: ['nope'] },
    });
    const once = groundItems([invented], events);
    expect(once[0]!.locations[0]).not.toHaveProperty('source');
    expect(once[0]!.evidence).not.toHaveProperty('crops');
    const [a] = groundItems([item(shot)], events);
    expect(groundItems([a!], events)[0]).toEqual(a);
  });

  it('leaves an item with nothing to ground as it was', () => {
    const { doc, shot } = session();
    const plain = item(shot);
    expect(groundItems([plain], doc.events)[0]).toEqual(plain);
  });
});

describe('export of a grounded item', () => {
  function doc(): { doc: SessionDocument; shot: string } {
    const { doc: base, events, shot } = session();
    const [g] = groundItems([item(shot)], events);
    return {
      shot,
      doc: buildSessionDocument({
        session: base.session,
        events,
        blobs: [
          ...base.blobs,
          {
            id: `${shot}.crop`,
            kind: 'screenshot_crop',
            mime: 'image/png',
            size: 10,
            path: `screenshots/${shot}.crop.png`,
          },
        ],
        audio: null,
        now: new Date('2026-09-23T10:00:00.000Z'),
        process_run: { id: 'run-1', model: 'claude-sonnet-5', items: [g!] },
      }),
    };
  }

  it('the zip holds the crop next to its screenshot', () => {
    const { doc: d, shot } = doc();
    const plan = planExport(d);
    expect(plan.issues).toEqual([]);
    expect(plan.files.map((f) => f.path)).toContain(`screenshots/${shot}.crop.png`);
    expect(plan.files.find((f) => f.path === `screenshots/${shot}.crop.png`)).toEqual({
      path: `screenshots/${shot}.crop.png`,
      blob_id: `${shot}.crop`,
    });
  });

  it('review.md cites the source on the Location and the crop in the Evidence', () => {
    const { doc: d, shot } = doc();
    const md = renderReviewMarkdown(d, { include: { video: false, audio: false } });
    expect(md).toContain(
      "- Subject: button 'Get started' `button.cta` on /pricing.html (Annotation #1) · source `src/App.js:6 (CtaButton ← PricingCard ← App)`",
    );
    expect(md).toContain(`- screenshots/${shot}.crop.png (cropped to the element)`);
    expect(md).toContain(`![Close-up ${shot}.crop](screenshots/${shot}.crop.png)`);
  });

  it('a crop whose image is missing is an export issue', () => {
    const { doc: d, shot } = doc();
    const broken = { ...d, blobs: d.blobs.filter((b) => b.kind !== 'screenshot_crop') };
    expect(planExport(broken).issues).toContain(`screenshot ${shot}.crop is referenced but its image is missing`);
    expect(SessionDocumentSchema.safeParse(broken).success).toBe(false);
  });
});
