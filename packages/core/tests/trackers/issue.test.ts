import { describe, expect, it } from 'vitest';
import { ChangeItemSchema } from '../../src/process/change-item';
import { applyItemEdits, latestLinks, trackerLinksFor } from '../../src/review-edits';
import { SCHEMA_VERSION, type TimelineEvent, TimelineEventSchema, type TrackerLink } from '../../src/timeline';
import {
  buildIssue,
  type IssueItem,
  itemImageIds,
  MAX_BODY_CHARS,
  rewriteCitations,
  statusLabel,
  TRUNCATED_NOTE,
} from '../../src/trackers';

const item = (over: Partial<IssueItem> = {}): IssueItem => ({
  id: 'item_0001',
  title: 'Make the Get started button larger',
  category: 'visual',
  intent: 'The primary call to action is too small to notice.',
  locations: [
    {
      role: 'subject',
      element: "button 'Get started'",
      selector: 'main .hero button.cta',
      url: '/pricing.html',
    },
    { role: 'reference', element: 'the header links', selector: null, url: '/pricing.html' },
  ],
  transcript: 'this button is way too small\nmake it bigger',
  ambiguity: 'How much larger is not said.',
  agent_prompt: 'Enlarge button.cta on /pricing.html. See screenshots/s-abc.png and screenshots/s-abc.crop.png.',
  evidence: { screenshots: ['s-abc', 's-def'], crops: ['s-abc.crop'] },
  ...over,
});

const URLS = new Map([
  ['s-abc', 'https://example.test/s-abc.png'],
  ['s-def', 'https://example.test/s-def.png'],
  ['s-abc.crop', 'https://example.test/s-abc.crop.png'],
]);

const SESSION = { name: 'Pricing page review' };

/** The `## ` headings of a body, in order. */
const headings = (body: string) => [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

describe('buildIssue', () => {
  it('has the title and every part in order, with the footer last', () => {
    const { title, body } = buildIssue(item(), SESSION, URLS);
    expect(title).toBe('Make the Get started button larger');
    expect(headings(body)).toEqual(['Intent', 'Where', 'What was said', 'Screenshots', 'Agent prompt', 'Ambiguity']);
    expect(body).toContain('**Category:** visual');
    expect(body).toContain(
      "- **Subject:** button 'Get started' (`main .hero button.cta`), on /pricing.html\n- **Reference:** the header links, on /pricing.html",
    );
    expect(body).toContain('> this button is way too small\n> make it bigger');
    expect(body).toContain('![Screenshot s-abc](https://example.test/s-abc.png)');
    expect(body).toContain('![Screenshot s-def](https://example.test/s-def.png)');
    expect(body).toContain('![Element close-up s-abc.crop](https://example.test/s-abc.crop.png)');
    expect(body).toContain('How much larger is not said.');
    expect(body.endsWith('Sent from InkUp · Pricing page review · item_0001')).toBe(true);
  });

  it('collapses the agent prompt and cites the uploaded images by URL', () => {
    const { body } = buildIssue(item(), SESSION, URLS);
    const details = /<details>\n<summary>[^<]+<\/summary>\n\n```text\n([\s\S]*?)\n```\n\n<\/details>/.exec(body);
    expect(details?.[1]).toBe(
      'Enlarge button.cta on /pricing.html. See https://example.test/s-abc.png and https://example.test/s-abc.crop.png.',
    );
    expect(body).not.toContain('screenshots/s-abc');
  });

  it('names the app for a Location with no url, and leaves out an empty ambiguity', () => {
    const { body } = buildIssue(
      item({
        locations: [
          { role: 'subject', element: 'Save button', surface: { app: 'Figma' } } as IssueItem['locations'][0],
        ],
        ambiguity: undefined,
      }),
      SESSION,
      URLS,
    );
    expect(body).toContain('- **Subject:** Save button, in Figma');
    expect(body).not.toMatch(/undefined|null|on ,|on \n/);
    expect(headings(body)).not.toContain('Ambiguity');
  });

  it('takes the url over the app, and an element with neither as it is', () => {
    const { body } = buildIssue(
      item({
        locations: [
          { role: 'subject', element: 'Hero', url: '/', surface: { app: 'Safari' } },
          { role: 'destination', element: 'Sidebar', url: '', surface: null },
        ],
      }),
      SESSION,
      URLS,
    );
    expect(body).toContain('- **Subject:** Hero, on /\n- **Destination:** Sidebar\n');
  });

  it('shows only uploaded images, and no Screenshots part without any', () => {
    expect(buildIssue(item(), SESSION, { 's-def': 'https://example.test/d.png' }).body).not.toContain('s-abc.png)');
    expect(headings(buildIssue(item(), SESSION, new Map()).body)).not.toContain('Screenshots');
  });

  it('keeps a prompt that has backtick fences inside its own fence', () => {
    const { body } = buildIssue(item({ agent_prompt: 'Run:\n```sh\npnpm test\n```' }), SESSION, URLS);
    expect(body).toContain('````text\nRun:\n```sh\npnpm test\n```\n````');
  });

  it('cuts an 80,000-character prompt to fit under 65,536 characters, with a note, and keeps the rest whole', () => {
    const huge = `See screenshots/s-abc.png. ${'x'.repeat(80_000)}`;
    const whole = buildIssue(item({ agent_prompt: 'short' }), SESSION, URLS).body;
    const { body } = buildIssue(item({ agent_prompt: huge }), SESSION, URLS);
    expect(body.length).toBeLessThan(MAX_BODY_CHARS);
    expect(body.length).toBeGreaterThan(MAX_BODY_CHARS - 200);
    expect(body).toContain(TRUNCATED_NOTE);
    // The prompt part ends with the note, inside its block.
    expect(body).toMatch(
      new RegExp(`…\\n\`\`\`\\n\\n${TRUNCATED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n</details>`),
    );
    // Everything before the prompt is as it is for a short prompt, and so is everything after it.
    const head = (b: string) => b.slice(0, b.indexOf('## Agent prompt'));
    const tail = (b: string) => b.slice(b.indexOf('</details>'));
    expect(head(body)).toBe(head(whole));
    expect(tail(body)).toBe(tail(whole));
    expect(buildIssue(item(), SESSION, URLS).body).not.toContain(TRUNCATED_NOTE);
  });

  it('stays under the limit even when everything else is too long, keeping the footer', () => {
    const { body } = buildIssue(
      item({ transcript: 'y'.repeat(70_000), agent_prompt: 'z'.repeat(70_000) }),
      SESSION,
      URLS,
    );
    expect(body.length).toBeLessThan(MAX_BODY_CHARS);
    expect(body.endsWith('Sent from InkUp · Pricing page review · item_0001')).toBe(true);
  });

  it('rewrites citations of longer ids before shorter ones', () => {
    expect(
      rewriteCitations('screenshots/s1.png screenshots/s1.crop.png screenshots/s10.png', {
        s1: 'A',
        's1.crop': 'B',
        s10: 'C',
      }),
    ).toBe('A B C');
  });

  it('lists the images to upload: screenshots, then crops, once each', () => {
    expect(itemImageIds(item({ evidence: { screenshots: ['a', 'b', 'a'], crops: ['a.crop'] } }))).toEqual([
      'a',
      'b',
      'a.crop',
    ]);
  });
});

describe('statusLabel', () => {
  it('reads each state as its badge', () => {
    expect(statusLabel({ state: 'open' })).toBe('open');
    expect(statusLabel({ state: 'closed', reason: 'completed' })).toBe('closed (completed)');
    expect(statusLabel({ state: 'closed', reason: 'not_planned' })).toBe('closed (not planned)');
    expect(statusLabel({ state: 'closed', reason: null })).toBe('closed');
  });
});

describe('tracker links on Change Items', () => {
  const RUN = 'run-1';
  const generated = [1, 2].map((n) =>
    ChangeItemSchema.parse({
      id: `item_000${n}`,
      title: `Item ${n}`,
      category: 'layout',
      intent: 'Intent.',
      locations: [{ role: 'subject', selector: '.x', element: 'x', url: '/', screenshot: null, annotation: null }],
      evidence: { video: null, screenshots: [] },
      transcript: '',
      confidence: 0.9,
      agent_prompt: 'Do it.',
    }),
  );
  const link = (key: string, at: string): Omit<TrackerLink, never> => ({
    tracker: 'github',
    destination: 'acme/web',
    key,
    url: `https://github.com/acme/web/issues/${key.slice(1)}`,
    created_at: at,
  });
  let n = 0;
  const ev = (e: Record<string, unknown>) =>
    TimelineEventSchema.parse({ id: `e${++n}`, t: 1000, ...e }) as TimelineEvent;
  const edit = (op: Record<string, unknown>) =>
    ev({ type: 'item_edit', run_id: RUN, edited_at: '2026-10-07T10:00:00.000Z', edit: op });
  const sent = (item_id: string, key: string, run_id = RUN) =>
    ev({ type: 'tracker_link', item_id, run_id, ...link(key, '2026-10-07T10:01:00.000Z') });

  it('is schema version 21', () => {
    expect(SCHEMA_VERSION).toBe(21);
  });

  it('puts each link of the run on its item, and nothing on the others', () => {
    const events = [sent('item_0001', '#1'), sent('item_0002', '#9', 'old-run'), sent('item_0001', '#2')];
    const { items } = applyItemEdits(generated, [], trackerLinksFor(events, RUN));
    expect(items[0]!.tracker_links?.map((l) => l.key)).toEqual(['#1', '#2']);
    expect(items[1]).not.toHaveProperty('tracker_links');
    expect(latestLinks(items[0]!.tracker_links).map((l) => l.key)).toEqual(['#2']);
    expect(ChangeItemSchema.parse(items[0])).toEqual(items[0]);
  });

  it('keeps a link through Undo and Redo, which only fold item_edit ops', () => {
    const events = [
      edit({ op: 'edit', item_id: 'item_0001', changes: { title: 'Renamed' } }),
      sent('item_0001', '#1'),
      edit({ op: 'undo' }),
      edit({ op: 'undo' }),
      edit({ op: 'redo' }),
    ];
    const ops = events.flatMap((e) => (e.type === 'item_edit' ? [e.edit] : []));
    const { items } = applyItemEdits(generated, ops, trackerLinksFor(events, RUN));
    const first = items.find((i) => i.id === 'item_0001')!;
    expect(first.title).toBe('Renamed');
    expect(first.tracker_links?.map((l) => l.key)).toEqual(['#1']);
  });
});
