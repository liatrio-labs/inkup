// E3: Text Comments. The text-quote anchor the page builds, the replacement detection that lets Process skip the model,
// the item built in code, the merge with the model's items, and the TEXT COMMENT script line.
import { describe, expect, it } from 'vitest';
import {
  buildProcessPrompt,
  type ChangeItem,
  ChangeItemSchema,
  detectReplacement,
  mergeTextComments,
  needsModel,
  textCommentSpeech,
  textCommentToChangeItem,
} from '../src/process';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import { textQuoteAnchor } from '../src/text-quote';
import { type EventOf, SCHEMA_VERSION, type TimelineEvent, TimelineEventSchema } from '../src/timeline';

const START = 'http://localhost:4401/pricing.html';
const page = { url: START, scroll: { x: 0, y: 0 }, viewport: { width: 1280, height: 720 }, dpr: 2 };

function comment(over: Partial<EventOf<'text_comment'>> = {}): EventOf<'text_comment'> {
  return TimelineEventSchema.parse({
    id: 'tc-1',
    type: 'text_comment',
    t: 2000,
    t_end: 5000,
    comment_id: 'c1',
    index: 1,
    selected_text: 'Ship reviews in minutes',
    anchor: { exact: 'Ship reviews in minutes', prefix: 'Pricing Fixture ', suffix: ' Record a spoken review' },
    element: {
      selector: '#hero-title',
      tag: 'h1',
      role: 'heading',
      name: 'Ship reviews in minutes',
      text: 'Ship reviews in minutes',
      testid: null,
      id: 'hero-title',
      classes: [],
      bbox: { x: 40, y: 80, width: 600, height: 48 },
    },
    comment: 'This should say Pricing plans',
    bbox: { x: 40, y: 80, width: 420, height: 48 },
    ...page,
    screenshot_id: 'shot-tc',
    ...over,
  }) as EventOf<'text_comment'>;
}

const shot = (id: string, t: number, trigger: EventOf<'screenshot'>['trigger']): TimelineEvent => ({
  id: `ev-${id}`,
  type: 'screenshot',
  t,
  screenshot_id: id,
  path: `screenshots/${id}.png`,
  mime: 'image/png',
  trigger,
  annotation_id: null,
  ...page,
});

const segment = (id: string, t: number, t_end: number, text: string): TimelineEvent => ({
  id: `ev-${id}`,
  type: 'transcript_segment',
  t,
  t_end,
  segment_id: id,
  text,
  engine: 'scripted',
  local: true,
  timestamp_quality: 'approximate',
  words: null,
  confidence: null,
  run_id: null,
  target: null,
});

function docOf(events: TimelineEvent[]): SessionDocument {
  return SessionDocumentSchema.parse({
    schema_version: SCHEMA_VERSION,
    generated_at: '2026-09-23T00:00:11.000Z',
    session: {
      id: 's1',
      tab_id: 1,
      t0: 1_790_000_000_000,
      started_at: '2026-09-23T00:00:00.000Z',
      ended_at: '2026-09-23T00:00:10.000Z',
      duration_ms: 10_000,
      start_url: START,
      start_title: 'Pricing Fixture',
      status: 'ended',
      transcription: { engine: 'scripted', local: true, timestamp_quality: 'approximate' },
      video_off_reason: null,
      media_deleted_at: null,
    },
    media: { audio: null, video: null },
    blobs: events.flatMap((e) =>
      e.type === 'screenshot'
        ? [{ id: e.screenshot_id, kind: 'screenshot', mime: 'image/png', size: 1, path: e.path }]
        : [],
    ),
    events: [
      {
        id: 'ev-start',
        type: 'session_start',
        t: 0,
        tab_id: 1,
        url: START,
        title: 'Pricing Fixture',
        t0: 1_790_000_000_000,
      },
      ...[...events].sort((a, b) => a.t - b.t),
      { id: 'ev-end', type: 'session_end', t: 10_000, reason: 'stop', duration_ms: 10_000 },
    ],
  });
}

describe('text-quote anchor', () => {
  const text = 'Pricing Fixture\n\n   Ship reviews in minutes\n   Record a spoken review of any page.';

  it('quotes the selection with up to 32 characters either side, whitespace collapsed', () => {
    const start = text.indexOf('reviews');
    expect(textQuoteAnchor(text, start, start + 'reviews in'.length)).toEqual({
      exact: 'reviews in',
      prefix: 'Pricing Fixture Ship ',
      suffix: ' minutes Record a spoken review ',
    });
  });

  it('moves whitespace at the edges of the selection into the prefix and suffix', () => {
    const start = text.indexOf('\n   Ship');
    const end = text.indexOf('minutes') + 'minutes'.length + 2;
    expect(textQuoteAnchor(text, start, end)).toEqual({
      exact: 'Ship reviews in minutes',
      prefix: 'Pricing Fixture ',
      suffix: ' Record a spoken review of any p',
    });
  });

  it('keeps only the nearest context and accepts reversed offsets', () => {
    const long = `${'a'.repeat(50)} target ${'b'.repeat(50)}`;
    const s = long.indexOf('target');
    const a = textQuoteAnchor(long, s + 6, s, 5)!;
    expect(a).toEqual({ exact: 'target', prefix: 'aaaa ', suffix: ' bbbb' });
  });

  it('is null for a selection of whitespace only', () => {
    expect(textQuoteAnchor('a   b', 1, 4)).toBeNull();
  });
});

describe('replacement detection', () => {
  const sel = 'Ship reviews in minutes';
  it.each([
    ['This should say Pricing plans', 'Pricing plans'],
    ['this should say Pricing plans.', 'Pricing plans'],
    ['It should read: "Plans & pricing"', 'Plans & pricing'],
    ['should be “Pricing plans”', 'Pricing plans'],
    ['Change to “Get started free”.', 'Get started free'],
    ['change this to Pricing plans instead', 'Pricing plans'],
    ['Replace with Pricing plans', 'Pricing plans'],
    ['"Pricing plans"', 'Pricing plans'],
    ['-> Pricing plans', 'Pricing plans'],
  ])('%s → %s', (text, after) => {
    expect(detectReplacement(text, sel)).toEqual({ before: sel, after });
  });

  it('names the part of the selection that changes when the comment says which', () => {
    expect(detectReplacement('minutes -> seconds', sel)).toEqual({ before: 'minutes', after: 'seconds' });
    expect(detectReplacement('Change "Ship" to "Send"', sel)).toEqual({ before: 'Ship', after: 'Send' });
    // A name the selection does not hold is not the old text.
    expect(detectReplacement('Heading -> Pricing plans', sel)).toEqual({ before: sel, after: 'Pricing plans' });
  });

  it('keeps a closing period when the old text had one', () => {
    expect(detectReplacement('should say Record a review.', 'Record a spoken review.')).toEqual({
      before: 'Record a spoken review.',
      after: 'Record a review.',
    });
  });

  it.each(['This should be bigger', 'Make this bold', 'typo?', 'Is this right?', 'should say Ship reviews in minutes'])(
    'no replacement: %s',
    (text) => {
      expect(detectReplacement(text, sel)).toBeNull();
    },
  );
});

describe('Text Comments in Process', () => {
  it('an explicit replacement is a high-confidence copy item on the selector, quoting before and after', () => {
    const c = comment();
    const item = textCommentToChangeItem(c, [c], START, 'item_0001');
    expect(ChangeItemSchema.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      title: 'Change "Ship reviews in minutes" to "Pricing plans"',
      category: 'copy',
      confidence: 0.95,
      locations: [
        {
          role: 'subject',
          selector: '#hero-title',
          element: "heading 'Ship reviews in minutes'",
          url: '/pricing.html',
          screenshot: 'shot-tc',
          annotation: null,
        },
      ],
      evidence: { video: { start: 2, end: 5 }, screenshots: ['shot-tc'] },
      transcript: 'This should say Pricing plans',
    });
    expect(item.intent).toBe('Replace the text "Ship reviews in minutes" with "Pricing plans".');
    expect(item.agent_prompt).toContain('replace the text "Ship reviews in minutes" with "Pricing plans"');
    expect(item.agent_prompt).toContain('between "…Pricing Fixture " and " Record a spoken review…"');
    expect(item.agent_prompt).toContain('screenshots/shot-tc.png');
  });

  it('speech while the text was selected joins the comment, Voice Command phrases removed', () => {
    const events: TimelineEvent[] = [
      segment('g1', 500, 1500, 'before the selection'),
      segment('g2', 2500, 4000, 'the headline is wrong scratch that'),
      {
        id: 'vc',
        type: 'voice_command',
        t: 3800,
        t_end: 4000,
        command: 'scratch_that',
        phrase: 'scratch that',
        segment_id: 'g2',
        target: null,
      },
      segment('g3', 4800, 6000, 'it is about pricing'),
      segment('g4', 7000, 8000, 'after the save'),
    ];
    expect(textCommentSpeech(comment(), events)).toBe('the headline is wrong ... it is about pricing');
    expect(textCommentToChangeItem(comment(), [...events, comment()], START, 'item_0001').transcript).toBe(
      'This should say Pricing plans ... the headline is wrong ... it is about pricing',
    );
  });

  it('needs no model when explicit comments are all there is, speech during them included', () => {
    expect(needsModel([comment()])).toBe(false);
    expect(needsModel([comment(), segment('g1', 3000, 4000, 'this is the old tagline')])).toBe(false);
    // Anything else goes to the model: speech outside the comment, another kind of comment, a Session without comments.
    expect(needsModel([comment(), segment('g1', 6000, 7000, 'and the button is too small')])).toBe(true);
    expect(needsModel([comment({ comment: 'feels off' })])).toBe(true);
    expect(needsModel([])).toBe(true);
  });

  const modelItem = (over: Partial<ChangeItem> = {}): ChangeItem =>
    ChangeItemSchema.parse({
      id: 'item_0001',
      title: 'Rename the headline',
      category: 'copy',
      intent: 'x',
      locations: [
        {
          role: 'subject',
          selector: '#hero-title',
          element: 'h1',
          url: '/pricing.html',
          screenshot: null,
          annotation: null,
        },
      ],
      evidence: { video: { start: 1, end: 2 }, screenshots: [] },
      transcript: '',
      confidence: 0.9,
      agent_prompt: 'Rename it.',
      pinned: false,
      ...over,
    });

  it("an explicit comment replaces the model's rewrite of it; an item elsewhere stays", () => {
    const other = modelItem({
      id: 'item_0002',
      title: 'Bigger CTA',
      category: 'style',
      locations: [
        {
          role: 'subject',
          selector: 'button.cta',
          element: 'button',
          url: '/pricing.html',
          screenshot: null,
          annotation: 1,
        },
      ],
      evidence: { video: { start: 8, end: 9 }, screenshots: [] },
    });
    const r = mergeTextComments([modelItem(), other], [comment()], START);
    expect(r.dropped).toEqual(['item_0001']);
    expect(r.converted).toEqual({ c1: 'item_0003' });
    expect(r.items.map((i) => [i.id, i.title])).toEqual([
      ['item_0003', 'Change "Ship reviews in minutes" to "Pricing plans"'],
      ['item_0002', 'Bigger CTA'],
    ]);
  });

  it("another comment is the model's to write; converted in code only when the model left its element out", () => {
    const vague = comment({ comment: 'Too salesy, tone it down' });
    expect(mergeTextComments([modelItem()], [vague], START)).toMatchObject({
      converted: {},
      dropped: [],
      items: [{ id: 'item_0001' }],
    });
    const r = mergeTextComments([], [vague], START);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      title: 'Revise "Ship reviews in minutes"',
      category: 'copy',
      confidence: 0.8,
      locations: [{ selector: '#hero-title' }],
    });
    expect(r.items[0]!.agent_prompt).toContain('as the reviewer asks: Too salesy, tone it down');
  });

  it('the script shows each comment, marks the explicit one HANDLED and the speech said during it', () => {
    const doc = docOf([
      shot('shot-tc', 5100, 'text_comment'),
      segment('g1', 3000, 4000, 'the tagline is off'),
      comment({ t: 2000, t_end: 5000 }),
      shot('shot-2', 7100, 'text_comment'),
      comment({
        id: 'tc-2',
        comment_id: 'c2',
        index: 2,
        t: 6000,
        t_end: 7000,
        comment: 'Too salesy',
        screenshot_id: 'shot-2',
      }),
    ]);
    const { script } = buildProcessPrompt(doc);
    expect(script).toContain('SPEECH "the tagline is off" · 00:03.0–00:04.0 · near none · during TEXT COMMENT t1');
    expect(script).toMatch(
      /TEXT COMMENT t1 on #hero-title <h1 role=heading> "Ship reviews in minutes" · at \/pricing\.html · screenshot s1 · "Ship reviews in minutes" → "Pricing plans" · HANDLED/,
    );
    expect(script).toMatch(
      /TEXT COMMENT t2 on #hero-title .* screenshot s2\n {4}selected "Ship reviews in minutes" after "…Pricing Fixture" before "Record a spoken review…"\n {4}comment "Too salesy"/,
    );
    // Their screenshots are cited on the comment lines, not as separate SCREENSHOT lines.
    expect(script).not.toContain('SCREENSHOT s');
  });
});
