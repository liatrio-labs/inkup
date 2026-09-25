import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { exportFileName, planExport, promptCitations, referencedScreenshots } from '../src/export/bundle';
import { allPrompts } from '../src/export/prompts';
import { renderReviewMarkdown } from '../src/export/review-md';
import type { ChangeItem } from '../src/process/change-item';
import { buildSessionDocument, type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { TimelineEvent } from '../src/timeline';

const base = (): SessionDocument =>
  SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));

/** Fixture (a) with media, a pause, a transcript edit and two Change Items citing its two screenshots. */
function sample(opts: { video?: boolean; badCitation?: boolean } = {}): SessionDocument {
  const doc = base();
  const [s1, s2] = doc.events
    .filter((e): e is Extract<TimelineEvent, { type: 'screenshot' }> => e.type === 'screenshot')
    .map((e) => e.screenshot_id);
  const seg = doc.events.find((e) => e.type === 'transcript_segment') as Extract<
    TimelineEvent,
    { type: 'transcript_segment' }
  >;
  const end = doc.session.duration_ms!;
  const items: ChangeItem[] = [
    {
      id: 'item_0001',
      title: "Move 'Get started' into the header nav",
      category: 'layout',
      intent: 'The CTA should live in the header, right of Docs.',
      locations: [
        {
          role: 'subject',
          selector: 'button.cta',
          element: "button 'Get started'",
          url: `${new URL(doc.session.start_url).origin}/pricing.html`,
          screenshot: s1!,
          annotation: 1,
        },
        {
          role: 'destination',
          selector: 'header nav',
          element: 'nav right of Docs',
          url: '/pricing.html',
          screenshot: s2!,
          annotation: 2,
        },
      ],
      evidence: { video: { start: 10, end: 12.5 }, screenshots: [s1!, s2!] },
      transcript: 'this button ... should go here',
      confidence: 0.9,
      agent_prompt: `Move button.cta into header nav. See screenshots/${s1}.png and screenshots/${s2}.png.${opts.badCitation ? ' Compare screenshots/nope.png.' : ''}`,
      pinned: false,
    },
    {
      id: 'item_0002',
      title: 'Check the nav spacing',
      category: 'question',
      intent: 'Unclear whether the nav needs more room.',
      locations: [
        { role: 'subject', selector: null, element: 'page', url: '/pricing.html', screenshot: null, annotation: null },
      ],
      evidence: { video: null, screenshots: [] },
      transcript: '',
      confidence: 0.4,
      ambiguity: 'No mark was drawn.',
      agent_prompt: 'Ask whether the header nav needs more spacing.',
      pinned: false,
    },
  ];
  const media = { mime: 'video/webm', duration_ms: 20_000, chunk_count: 20 };
  const events: TimelineEvent[] = [
    ...doc.events.filter((e) => e.type !== 'session_end'),
    { id: 'p', type: 'session_pause', t: 5000, via: 'button' },
    { id: 'r', type: 'session_resume', t: 8000, gap_ms: 3000, via: 'button' },
    doc.events.find((e) => e.type === 'session_end')!,
    {
      id: 'te',
      type: 'transcript_edit',
      t: end,
      segment_id: seg.segment_id,
      text: 'this button, edited',
      edited_at: '2026-09-22T13:00:00.000Z',
    },
    {
      id: 'ie',
      type: 'item_edit',
      t: end,
      run_id: 'run-1',
      edited_at: '2026-09-22T13:00:00.000Z',
      edit: { op: 'edit', item_id: 'item_0001', changes: { title: 'Put the CTA in the header' } },
    },
  ];
  return buildSessionDocument({
    session: doc.session,
    events,
    blobs: [
      ...doc.blobs,
      { id: 'a1', kind: 'audio', mime: 'audio/webm', size: 10, path: 'audio.webm' },
      ...(opts.video !== false
        ? [{ id: 'v1', kind: 'video' as const, mime: 'video/webm', size: 10, path: 'recording.webm' }]
        : []),
    ],
    audio: {
      blob_id: 'a1',
      mime: 'audio/webm',
      start_offset_ms: 200,
      duration_ms: 20_000,
      chunk_count: 1,
      path: 'audio.webm',
    },
    video:
      opts.video !== false
        ? {
            blob_id: 'v1',
            ...media,
            start_offset_ms: 500,
            seekable: true,
            label: 'Pricing Fixture',
            width: 1280,
            height: 720,
            path: 'recording.webm',
          }
        : null,
    now: new Date('2026-09-22T13:00:00.000Z'),
    process_run: { id: 'run-1', model: 'claude-sonnet-5', items },
  });
}

describe('review.md', () => {
  const doc = sample();
  const md = renderReviewMarkdown(doc, { include: { video: true, audio: true } });
  const shots = doc.events
    .filter((e) => e.type === 'screenshot')
    .map((e) => (e as { screenshot_id: string }).screenshot_id);

  it('numbers the items in review order, with the edited title, category and check-me badge', () => {
    expect(md).toMatch(/^## 1\. Check the nav spacing\n/m);
    expect(md).toMatch(/^## 2\. Put the CTA in the header\n/m);
    expect(md).toContain('**Category:** question · **check me**');
    expect(md).toContain('> No mark was drawn.');
    expect(md).not.toContain("Move 'Get started' into the header nav");
  });

  it('lists Locations with role, element, selector, page path and Annotation', () => {
    expect(md).toContain("- Subject: button 'Get started' `button.cta` on /pricing.html (Annotation #1)");
    expect(md).toContain('- Destination: nav right of Docs `header nav` on /pricing.html (Annotation #2)');
    expect(md).toContain('- Subject: page on /pricing.html');
  });

  it('embeds each screenshot by its path in the folder', () => {
    for (const id of shots) expect(md).toContain(`![Screenshot ${id}](screenshots/${id}.png)`);
  });

  it('links the video at media time: Session time minus the start offset and the pause', () => {
    // 10 s Session time − 0.5 s start − 3 s pause = 6.5 s into the file.
    expect(md).toContain('[video at 00:06–00:09](recording.webm#t=6.5,9.0) (Session time 00:10–00:12)');
  });

  it('falls back to an audio link without video, and to Session time without media', () => {
    const noVideo = renderReviewMarkdown(sample({ video: false }), { include: { video: false, audio: true } });
    expect(noVideo).toContain('(audio.webm#t=6.8,9.3)');
    expect(noVideo).toContain('Video: none.');
    const none = renderReviewMarkdown(sample({ video: false }), { include: { video: false, audio: false } });
    expect(none).toContain('Session time 00:10–00:12 (no recording in this folder)');
  });

  it('says when the mic was muted (E10), and says nothing when it never was', () => {
    expect(md).not.toContain('Mic muted');
    const muted = sample();
    muted.events.push(
      { id: 'mm', type: 'mic_muted', t: 3000, via: 'button' },
      { id: 'mu', type: 'mic_unmuted', t: 7500, via: 'shortcut' },
    );
    expect(renderReviewMarkdown(muted, { include: { video: true, audio: true } })).toContain(
      'Mic muted: 00:03–00:07. Nothing said then was recorded or transcribed.',
    );
  });

  it('carries the agent prompt and the edited transcript as an appendix', () => {
    expect(md).toContain('```text\nMove button.cta into header nav.');
    expect(md).toMatch(/## Transcript\n\n- \[\d\d:\d\d\] this button, edited/);
  });

  it('is deterministic', () => {
    expect(renderReviewMarkdown(doc, { include: { video: true, audio: true } })).toBe(md);
  });
});

describe('planExport', () => {
  it('holds review.md, session.json, every referenced screenshot, audio and video', () => {
    const doc = sample();
    const plan = planExport(doc);
    expect(plan.issues).toEqual([]);
    const shots = referencedScreenshots(doc);
    expect(shots.length).toBeGreaterThanOrEqual(2);
    expect(plan.files.map((f) => f.path).sort()).toEqual(
      [
        'audio.webm',
        'recording.webm',
        'review.md',
        'session.json',
        ...shots.map((id) => `screenshots/${id}.png`),
      ].sort(),
    );
    const json = plan.files.find((f) => f.path === 'session.json');
    expect(json && 'text' in json && SessionDocumentSchema.safeParse(JSON.parse(json.text)).success).toBe(true);
  });

  it('omits recording.webm when video was off', () => {
    const plan = planExport(sample({ video: false }));
    expect(plan.files.map((f) => f.path)).not.toContain('recording.webm');
    expect(plan.files.map((f) => f.path)).toContain('audio.webm');
  });

  it('refuses an agent_prompt that cites a screenshot the folder does not have', () => {
    const plan = planExport(sample({ badCitation: true }));
    expect(plan.issues.some((i) => i.includes('screenshots/nope.png'))).toBe(true);
  });

  it('every agent_prompt citation is a file in the plan', () => {
    const plan = planExport(sample());
    const paths = new Set(plan.files.map((f) => f.path));
    for (const item of sample().change_items!)
      for (const id of promptCitations(item.agent_prompt)) expect(paths).toContain(`screenshots/${id}.png`);
  });

  it('names the zip after the date and start page', () => {
    expect(exportFileName(sample())).toMatch(/^review-\d{4}-\d\d-\d\d-\d{4}-[a-z0-9-]+\.zip$/);
  });
});

describe('allPrompts', () => {
  it('numbers every item into one prompt', () => {
    const text = allPrompts([
      { title: 'A', agent_prompt: 'Do A. See screenshots/x.png.' },
      { title: 'B', agent_prompt: 'Do B.' },
    ]);
    expect(text).toBe(
      'Make these 2 changes from a recorded review of the site, in order. Screenshots are cited by path relative to the review folder.\n\n1. A\nDo A. See screenshots/x.png.\n\n2. B\nDo B.',
    );
    expect(allPrompts([])).toBe('');
  });
});
