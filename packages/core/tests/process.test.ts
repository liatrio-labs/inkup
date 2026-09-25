import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, fixtureFile, loadCaptured, SCENARIOS } from '../../../scripts/gen-session-fixtures.ts';
import {
  aliasScreenshotIds,
  anthropicId,
  buildProcessPrompt,
  buildSystemPrompt,
  type ChangeItem,
  ChangeItemSchema,
  ChangeItemsOutputSchema,
  checkAgainstSession,
  contextWindowFor,
  DEFAULT_OUTPUT_CAP,
  estimateCost,
  estimateOutputTokens,
  formatUsd,
  gapMs,
  LIMIT_SHARE,
  limitWarnings,
  type ModelCatalog,
  outputCapFor,
  PAIRING_WINDOW_MS,
  PRICES,
  PRICES_AS_OF,
  pairSegment,
  priceFor,
  restoreScreenshotIds,
  shouldAutoRun,
  sortForReview,
  speechAnchors,
  stamp,
} from '../src/process';
import { demonstrativesInText, nounsForCandidate, nounsInText } from '../src/process/locale/en';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';

const MODES = ['word', 'approximate'] as const;
const load = (name: string, mode: (typeof MODES)[number]): SessionDocument =>
  SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile(name, mode), 'utf8')));

describe('session fixtures', () => {
  it.each(SCENARIOS.flatMap((s) => MODES.map((m) => [s.name, m] as const)))(
    '%s (%s) validates and matches its generator',
    (name, mode) => {
      const doc = load(name, mode);
      const s = SCENARIOS.find((x) => x.name === name)!;
      expect(build(loadCaptured(s), s, mode)).toEqual(doc);
      const segs = doc.events.filter((e) => e.type === 'transcript_segment');
      expect(
        segs.every((s) => s.timestamp_quality === mode && (mode === 'word' ? s.words !== null : s.words === null)),
      ).toBe(true);
    },
  );

  it('fixture (d) has button.cta as a descendant Candidate of the loose circle, and the card as the pick', () => {
    const ann = load('d-loose-circle-button', 'word').events.find((e) => e.type === 'annotation')!;
    expect(ann.candidates[0]).toMatchObject({ relation: 'pick', selector: 'div.hero-card' });
    expect(ann.candidates.find((c) => c.selector === 'button.cta')).toMatchObject({
      relation: 'descendant',
      role: 'button',
    });
  });
});

describe('prompt builder', () => {
  it.each(SCENARIOS.flatMap((s) => MODES.map((m) => [s.name, m] as const)))('script for %s (%s)', (name, mode) => {
    const { script, context } = buildProcessPrompt(load(name, mode));
    expect(script).toMatchSnapshot();
    expect(script.split('\n')[0]).toBe(`TIMESTAMP QUALITY: ${mode === 'word' ? 'word-level' : 'approximate'}`);
    expect(script).toContain(`PAIRING WINDOW: ${PAIRING_WINDOW_MS[mode] / 1000}s`);
    expect(Object.keys(context.aliases)).toEqual(Object.keys(context.annotations).map((_, i) => `s${i + 1}`));
  });

  it('marks the pick and every relation, and pairs demonstratives with Annotations', () => {
    const { script } = buildProcessPrompt(load('a-move-here', 'word'));
    expect(script).toMatch(/\[00:01\.0\] ANNOTATION #1 mark · .* · at \/pricing\.html · screenshot s1/);
    expect(script).toContain('c0 button.cta · <button role=button class="cta"> "Get started" · PICK');
    expect(script).toMatch(/c1 div\.hero-card · <div class="card hero-card"> .* · ancestor · .* · nouns: card/);
    expect(script).toMatch(/a:nth-of-type\(3\) · <a role=link> "Docs" · descendant/);
    expect(script).toContain(
      'SPEECH "okay so this button" · 00:00.8–00:01.9 · demonstratives: "this"@00:01.3 near #1 · nouns: button',
    );
    expect(script).toContain('demonstratives: "here"@00:07.7 near #2');
  });

  it('renders SCROLL, NAVIGATION, CLICK, voice commands, drafts and region-only Annotations', () => {
    const doc = load('a-move-here', 'word');
    const events = [...doc.events];
    const ann = events.find((e) => e.type === 'annotation')!;
    const extra = [
      {
        id: 'x1',
        type: 'scroll_settle',
        t: 4000,
        url: ann.url,
        scroll: { x: 0, y: 640 },
        viewport: ann.viewport,
        dpr: 1,
      },
      {
        id: 'x2',
        type: 'click',
        t: 4100,
        url: ann.url,
        scroll: { x: 0, y: 640 },
        viewport: ann.viewport,
        dpr: 1,
        point: { x: 1, y: 1 },
        selector: 'a#more',
        tag: 'a',
        name: 'More',
      },
      { id: 'x3', type: 'navigation', t: 4200, url: 'http://127.0.0.1:4402/second/other.html', title: 'Other' },
      { id: 'x4', type: 'voice_command', t: 4300, command: 'scratch_that', phrase: 'scratch that', segment_id: null },
      {
        id: 'x5',
        type: 'draft_item',
        t: 4400,
        draft_id: 'd2',
        pass_id: 'p1',
        model: 'claude-haiku-4-5-20251001',
        title: 'Move Get started into header nav',
        category: 'layout',
        intent: 'Put the CTA in the header.',
        transcript: 'this button should go here',
        locations: [{ role: 'subject', element: "button 'Get started'", selector: 'button.cta', annotation: 1 }],
        annotation_ids: [ann.annotation_id],
      },
      { id: 'x6', type: 'draft_action', t: 4500, draft_id: 'd2', action: 'pin', source: 'voice' },
      {
        ...ann,
        id: 'x7',
        index: 9,
        t: 4600,
        t_end: 4700,
        resolution: 'region',
        candidates: [],
        pick: null,
        screenshot_id: null,
      },
      {
        ...ann,
        id: 'x10',
        index: 10,
        t: 4650,
        t_end: 4750,
        resolution: 'region',
        candidates: [],
        pick: null,
        screenshot_id: null,
        close_reason: 'cleared',
      },
      { id: 'x8', type: 'mic_muted', t: 4800, via: 'button' },
      { id: 'x9', type: 'mic_unmuted', t: 4900, via: 'shortcut' },
    ] as SessionDocument['events'];
    const script = buildProcessPrompt({ ...doc, events: [...events, ...extra].sort((a, b) => a.t - b.t) }).script;
    expect(script).toContain('[00:04.0] SCROLL to y=640 at /pricing.html');
    expect(script).toContain('[00:04.1] CLICK a#more <a> "More" at /pricing.html');
    expect(script).toContain('[00:04.2] NAVIGATION to http://127.0.0.1:4402/second/other.html "Other"');
    expect(script).toContain('[00:04.3] VOICE COMMAND scratch that');
    expect(script).toContain(
      `[00:04.4] DRAFT d2 "Move Get started into header nav" (layout) · subject button 'Get started' #1`,
    );
    expect(script).toContain('[00:04.5] DRAFT d2 → PINNED by user');
    expect(script).toContain('[00:04.8] MIC MUTED: nothing the reviewer said until MIC ON was recorded');
    expect(script).toContain('[00:04.9] MIC ON');
    expect(script).toMatch(
      /ANNOTATION #9 .* screenshot none · closed by time gap\n {4}region only: x=\d+ y=\d+ \d+×\d+/,
    );
    // Clear all is for stuck ink, not a discard: its Annotation stays, named for what closed it.
    expect(script).toMatch(/ANNOTATION #10 .* closed by Clear all \(no screenshot\)/);
  });

  it('marks pages without drawing as URL + screenshot only, at the start and after a navigation (U5)', () => {
    const doc = load('a-move-here', 'word');
    const events = doc.events.map((e) =>
      e.type === 'session_start' ? { ...e, url: 'chrome://extensions/', overlay: 'none' as const } : e,
    );
    const nav = {
      id: 'n1',
      type: 'navigation',
      t: 4200,
      url: 'chrome-extension://zzzz/options.html',
      title: 'Other extension',
      overlay: 'none',
    } as SessionDocument['events'][number];
    const back = {
      id: 'n2',
      type: 'navigation',
      t: 4300,
      url: 'http://localhost:4401/pricing.html',
      title: 'Pricing',
      overlay: 'page',
    } as SessionDocument['events'][number];
    const { script, system } = buildProcessPrompt({
      ...doc,
      session: { ...doc.session, start_url: 'chrome://extensions/' },
      events: [...events, nav, back].sort((a, b) => a.t - b.t),
    });
    expect(script).toMatch(/^SESSION: starts at chrome:\/\/extensions\/ \(no drawing: URL and screenshots only\)/m);
    expect(script).toContain(
      '[00:04.2] NAVIGATION to chrome-extension://zzzz/options.html "Other extension" (no drawing: URL and screenshots only)',
    );
    expect(script).toContain('[00:04.3] NAVIGATION to http://localhost:4401/pricing.html "Pricing"\n');
    expect(system).toContain('NO DRAWING');
  });

  it('strips Voice Command phrases from SPEECH, drops emptied segments and marks scratched Annotations', () => {
    const doc = load('a-move-here', 'word');
    const [a1, a2] = doc.events.filter((e) => e.type === 'annotation');
    const seg = doc.events.find((e) => e.type === 'transcript_segment')!;
    const extra = [
      {
        ...seg,
        id: 'y1',
        segment_id: 'cmd1',
        t: 9500,
        t_end: 9900,
        text: 'Scratch that.',
        words: [
          { text: 'Scratch', t: 9500, t_end: 9700 },
          { text: 'that.', t: 9700, t_end: 9900 },
        ],
      },
      {
        id: 'y2',
        type: 'voice_command',
        t: 9500,
        t_end: 9900,
        command: 'scratch_that',
        phrase: 'Scratch that',
        segment_id: 'cmd1',
        target: { kind: 'annotation', id: a2!.annotation_id },
      },
      { ...seg, id: 'y3', segment_id: 'cmd2', t: 9950, t_end: 10_400, text: 'okay next', words: null },
      {
        id: 'y4',
        type: 'voice_command',
        t: 10_300,
        t_end: 10_400,
        command: 'next',
        phrase: 'next',
        segment_id: 'cmd2',
        target: null,
      },
    ] as SessionDocument['events'];
    const { script, context } = buildProcessPrompt({
      ...doc,
      events: [...doc.events, ...extra].sort((a, b) => a.t - b.t),
    });
    expect(script).not.toContain('Scratch that');
    expect(script).toContain('SPEECH "okay"');
    expect(script).toContain('[00:09.5] VOICE COMMAND scratch that → discarded Annotation #2');
    expect(script).toContain('[00:10.3] VOICE COMMAND next');
    expect(script).toMatch(
      /ANNOTATION #2 mark · .* closed by time gap · DISCARDED by the reviewer \("scratch that" at 00:09\.5\)\n\[/,
    );
    expect(script).not.toContain('c0 nav');
    expect(Object.keys(context.annotations)).toEqual([String(a1!.index)]);
    // The discarded Annotation no longer pairs with speech.
    expect(script).toContain('demonstratives: "here"@00:07.7 near none');
  });

  it('renders a Connector with tail and head Candidates', () => {
    const doc = load('a-move-here', 'word');
    const [a1, a2] = doc.events.filter((e) => e.type === 'annotation');
    const end = (a: typeof a1) => ({
      point: { x: a!.bbox.x, y: a!.bbox.y },
      bbox: a!.bbox,
      resolution: a!.resolution,
      candidates: a!.candidates.slice(0, 2),
      pick: 0,
    });
    const withArrow = doc.events.map((e) =>
      e === a1 ? { ...e, connector: { stroke_ids: e.stroke_ids, tail: end(a1), head: end(a2) } } : e,
    );
    const { script, context } = buildProcessPrompt({ ...doc, events: withArrow });
    expect(script).toMatch(/CONNECTOR arrow from \(\d+, \d+\) to \(\d+, \d+\): tail = subject, head = destination/);
    expect(script).toContain('    tail c0 button.cta · <button role=button class="cta"> "Get started" · PICK');
    expect(script).toContain('    head c0 nav · <nav role=navigation> "Main" · PICK');
    expect(script).toContain('    whole drawing:');
    expect(context.annotations[a1!.index]!.selectors).toEqual(expect.arrayContaining(['button.cta', 'nav']));
  });

  it('system prompt encodes the pairing windows, noun table, roles, categories and prompt rules', () => {
    const system = buildSystemPrompt();
    expect(system).toMatchSnapshot();
    for (const s of [
      '2s',
      '2.5s',
      '4s',
      'VAD-aligned',
      '- button: said as "button"',
      'subject',
      'reference',
      'destination',
      'layout',
      'question',
      'screenshots/s1.png',
      'ambiguity',
    ])
      expect(system).toContain(s);
  });

  it('formats stamps as mm:ss.s', () => {
    expect(stamp(0)).toBe('00:00.0');
    expect(stamp(12_449)).toBe('00:12.4');
    expect(stamp(75_050)).toBe('01:15.1');
  });
});

describe('pairing', () => {
  const ann = (index: number, t: number, t_end: number) => ({ index, t, t_end });
  it('gap is zero on overlap and the distance otherwise', () => {
    expect(gapMs({ t: 0, t_end: 100 }, { t: 50, t_end: 200 })).toBe(0);
    expect(gapMs({ t: 0, t_end: 100 }, { t: 2100, t_end: 2200 })).toBe(2000);
    expect(gapMs({ t: 3000, t_end: 3100 }, { t: 0, t_end: 500 })).toBe(2500);
  });

  it('word-level: anchors at each demonstrative word, window 2s', () => {
    const seg = {
      t: 1000,
      t_end: 5000,
      text: 'this should match that',
      words: [
        { text: 'this', t: 1000, t_end: 1200 },
        { text: 'should', t: 1300, t_end: 1500 },
        { text: 'match', t: 1600, t_end: 1800 },
        { text: 'That.', t: 4800, t_end: 5000 },
      ],
    };
    expect(speechAnchors(seg).map((a) => a.word)).toEqual(['this', 'that']);
    const pairs = pairSegment(seg, [ann(1, 500, 900), ann(2, 6500, 7000), ann(3, 7100, 7400)], 'word');
    expect(pairs.map((p) => p.annotations)).toEqual([[1], [2]]);
  });

  it('approximate: anchors span the segment, window 4s, nearest first', () => {
    const seg = { t: 3000, t_end: 4000, text: 'make this bigger', words: null };
    const pairs = pairSegment(seg, [ann(1, 0, 500), ann(2, 4200, 4500), ann(3, 9000, 9500)], 'approximate');
    expect(pairs).toEqual([{ anchor: { word: 'this', t: 3000, t_end: 4000 }, annotations: [2, 1] }]);
  });

  it('a segment without demonstratives anchors on itself', () => {
    expect(speechAnchors({ t: 1, t_end: 2, text: 'looks good overall', words: null })).toEqual([
      { word: null, t: 1, t_end: 2 },
    ]);
  });
});

describe('English tables', () => {
  it('finds spoken nouns and demonstratives', () => {
    expect(nounsInText('this Button')).toEqual(['button']);
    expect(nounsInText('these cards need more space')).toEqual(['card']);
    expect(nounsInText('the call to action should be green')).toEqual(['button']);
    expect(demonstrativesInText('make this the same height as that').map((d) => d.word)).toEqual(['this', 'that']);
  });
  it('matches Candidates by tag, role and appearance; a link styled as a button is a button', () => {
    const c = (tag: string, role: string | null, selector: string) => ({ tag, role, selector, id: null, testid: null });
    expect(nounsForCandidate(c('button', 'button', 'button.cta'))).toEqual(['button']);
    expect(nounsForCandidate(c('a', 'link', 'a.btn-primary'))).toEqual(['button', 'link']);
    expect(nounsForCandidate(c('div', null, 'div.hero-card'))).toEqual(['card']);
    expect(nounsForCandidate(c('p', null, 'div.hero-card p'))).toEqual(['text']);
    expect(nounsForCandidate(c('nav', 'navigation', 'nav'))).toEqual(['nav']);
  });
});

describe('cost', () => {
  it('multiplies tokens by the dated per-million prices', () => {
    expect(PRICES['claude-sonnet-5']).toEqual({ input: 2, output: 10 });
    const e = estimateCost('claude-sonnet-5', 10_000, 2_000);
    expect(e.usd).toBeCloseTo(0.02 + 0.02, 10);
    expect(e.prices_as_of).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(estimateCost('claude-haiku-4-5-20251001', 1_000_000, 0).usd).toBe(1);
  });
  it('returns null cost for unknown models', () => {
    expect(estimateCost('my-custom-model', 1000, 1000).usd).toBeNull();
  });
  it('prices and caps an Anthropic model behind the Gateway prefix, dots or dashes', () => {
    expect(anthropicId('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(anthropicId('openai/gpt-6.1')).toBe('openai/gpt-6.1');
    expect(priceFor('anthropic/claude-sonnet-5')).toEqual(PRICES['claude-sonnet-5']);
    expect(priceFor('anthropic/claude-haiku-4.5')).toEqual({ input: 1, output: 5 });
    expect(outputCapFor('anthropic/claude-opus-4.7')).toBe(128_000);
    expect(estimateCost('anthropic/claude-sonnet-5', 10_000, 2_000).usd).toBeCloseTo(0.04, 10);
  });
  it("prices other Gateway models from the cached model list, dated by the list's fetch", () => {
    const catalog: ModelCatalog = {
      as_of: '2026-09-24',
      models: {
        'google/gemini-3.1-pro-preview': {
          id: 'google/gemini-3.1-pro-preview',
          price: { input: 2, output: 12 },
          context_window: 1_000_000,
          max_tokens: 64_000,
        },
        'claude-sonnet-5': { id: 'claude-sonnet-5', price: null, context_window: 1_000_000, max_tokens: 128_000 },
      },
    };
    const e = estimateCost('google/gemini-3.1-pro-preview', 1_000_000, 100_000, catalog);
    expect(e.usd).toBeCloseTo(2 + 1.2, 10);
    expect(e.prices_as_of).toBe('2026-09-24');
    expect(outputCapFor('google/gemini-3.1-pro-preview', catalog)).toBe(64_000);
    expect(contextWindowFor('google/gemini-3.1-pro-preview', catalog)).toBe(1_000_000);
    // The dated table wins for Anthropic models; the list still gives their context window.
    expect(estimateCost('claude-sonnet-5', 1000, 0, catalog).prices_as_of).toBe(PRICES_AS_OF);
    expect(contextWindowFor('anthropic/claude-sonnet-5', catalog)).toBe(1_000_000);
    // Not listed anywhere: no price, the default cap, no context window.
    expect(estimateCost('mistral/unknown', 1000, 1000, catalog).usd).toBeNull();
    expect(outputCapFor('mistral/unknown', catalog)).toBe(DEFAULT_OUTPUT_CAP);
    expect(contextWindowFor('mistral/unknown', catalog)).toBeNull();
  });
  it('scales the output estimate with Annotations and speech', () => {
    expect(estimateOutputTokens(0, 0)).toBe(1300);
    expect(estimateOutputTokens(4, 2)).toBe(600 + 4 * 700);
    expect(estimateOutputTokens(1, 10)).toBe(600 + 5 * 700);
  });
  it('formats dollars', () => {
    expect(formatUsd(0.01234)).toBe('$0.0123');
    expect(formatUsd(2.5)).toBe('$2.50');
  });
});

describe('limit warnings', () => {
  const catalog: ModelCatalog = {
    as_of: '2026-09-24',
    models: { 'claude-sonnet-5': { id: 'claude-sonnet-5', price: null, context_window: 200_000, max_tokens: 128_000 } },
  };
  const est = (chunk_tokens: { input: number; output: number }[], model = 'claude-sonnet-5') => ({
    ...estimateCost(
      model,
      chunk_tokens.reduce((n, c) => n + c.input, 0),
      chunk_tokens.reduce((n, c) => n + c.output, 0),
    ),
    chunks: chunk_tokens.length,
    chunk_tokens,
  });

  it('warns at 80% of the context window, for the largest call only', () => {
    expect(LIMIT_SHARE).toBe(0.8);
    expect(limitWarnings(est([{ input: 159_999, output: 2000 }]), catalog)).toEqual([]);
    expect(
      limitWarnings(
        est([
          { input: 160_000, output: 2000 },
          { input: 190_000, output: 2000 },
          { input: 10_000, output: 2000 },
        ]),
        catalog,
      ),
    ).toEqual([{ limit: 'context_window', chunk: 2, chunks: 3, tokens: 190_000, max: 200_000 }]);
  });

  it("warns at 80% of the output cap (the dated table's, else the list's)", () => {
    // claude-sonnet-5: 128,000 → 102,400.
    expect(limitWarnings(est([{ input: 1000, output: 102_399 }]), catalog)).toEqual([]);
    expect(limitWarnings(est([{ input: 1000, output: 102_400 }]), catalog)).toEqual([
      { limit: 'output_cap', chunk: 1, chunks: 1, tokens: 102_400, max: 128_000 },
    ]);
    // Both limits at once.
    expect(limitWarnings(est([{ input: 199_000, output: 120_000 }]), catalog).map((w) => w.limit)).toEqual([
      'context_window',
      'output_cap',
    ]);
  });

  it('skips the input check when no list gives the context window', () => {
    expect(limitWarnings(est([{ input: 5_000_000, output: 1000 }]), null)).toEqual([]);
    expect(limitWarnings(est([{ input: 5_000_000, output: 1000 }], 'mistral/unknown'), catalog)).toEqual([]);
  });

  it('reads an estimate without per-call counts as one call, and a no-call estimate as none', () => {
    expect(limitWarnings(estimateCost('claude-sonnet-5', 170_000, 1000), catalog)).toHaveLength(1);
    expect(limitWarnings({ ...estimateCost('claude-sonnet-5', 0, 0), chunks: 0 }, catalog)).toEqual([]);
  });
});

describe('shouldAutoRun', () => {
  const warning = { limit: 'context_window' as const, chunk: 1, chunks: 1, tokens: 190_000, max: 200_000 };
  const base = { usd: 0.04, threshold: 0.5, done: false, warnings: [] };

  it('runs without asking only when priced under the threshold, with nothing to replace and no warning', () => {
    expect(shouldAutoRun(base)).toBe(true);
    expect(shouldAutoRun({ ...base, threshold: undefined })).toBe(false);
    expect(shouldAutoRun({ ...base, usd: null })).toBe(false);
    expect(shouldAutoRun({ ...base, usd: 0.5 })).toBe(false);
    expect(shouldAutoRun({ ...base, usd: 0.6 })).toBe(false);
    expect(shouldAutoRun({ ...base, done: true })).toBe(false);
    expect(shouldAutoRun({ ...base, warnings: [warning] })).toBe(false);
  });
});

const sampleItem = (over: Partial<ChangeItem> = {}): ChangeItem => ({
  id: 'item_0001',
  title: "Move 'Get started' into the header nav",
  category: 'layout',
  intent: 'The CTA should live in the header, right of Docs.',
  locations: [
    {
      role: 'subject',
      selector: 'button.cta',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: 's1',
      annotation: 1,
    },
    {
      role: 'destination',
      selector: 'nav',
      element: "nav right of link 'Docs'",
      url: '/pricing.html',
      screenshot: 's2',
      annotation: 2,
    },
  ],
  evidence: { video: { start: 0.8, end: 9.3 }, screenshots: ['s1', 's2'] },
  transcript: 'this button ... should go here',
  confidence: 0.9,
  agent_prompt:
    'On /pricing.html move button.cta into nav. See screenshots/s1.png (current) and screenshots/s2.png (target).',
  pinned: false,
  ...over,
});

describe('ChangeItem schema', () => {
  it('round-trips through JSON and defaults pinned to false', () => {
    const { pinned: _p, ...noPin } = sampleItem();
    const parsed = ChangeItemsOutputSchema.parse(JSON.parse(JSON.stringify({ items: [noPin] })));
    expect(parsed.items[0]).toEqual(sampleItem());
  });
  it('requires ambiguity below 0.6 confidence', () => {
    const r = ChangeItemSchema.safeParse(sampleItem({ confidence: 0.4 }));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['ambiguity']);
    expect(ChangeItemSchema.safeParse(sampleItem({ confidence: 0.4, ambiguity: 'Which link?' })).success).toBe(true);
  });
  it('requires the agent_prompt to cite every evidence screenshot and a subject Location', () => {
    const r = ChangeItemSchema.safeParse(sampleItem({ agent_prompt: 'See screenshots/s1.png.' }));
    expect(r.error!.issues.map((i) => i.message)).toEqual([
      'agent_prompt must cite evidence screenshot 1 as screenshots/s2.png',
    ]);
    const noSubject = sampleItem();
    noSubject.locations = noSubject.locations.filter((l) => l.role !== 'subject');
    expect(ChangeItemSchema.safeParse(noSubject).success).toBe(false);
  });
  it('rejects unknown categories and roles', () => {
    expect(ChangeItemSchema.safeParse({ ...sampleItem(), category: 'design' }).success).toBe(false);
  });
  it('sorts low-confidence items first, stably', () => {
    const items = [
      sampleItem({ id: 'a' }),
      sampleItem({ id: 'b', confidence: 0.3, ambiguity: 'x' }),
      sampleItem({ id: 'c' }),
      sampleItem({ id: 'd', confidence: 0.59, ambiguity: 'y' }),
    ];
    expect(sortForReview(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('screenshot aliases and Session checks', () => {
  const doc = load('a-move-here', 'word');
  const { context } = buildProcessPrompt(doc);
  const shots = doc.events.filter((e) => e.type === 'screenshot').map((e) => e.screenshot_id);

  it('restores stored ids everywhere, including agent_prompt citations, and aliases them back', () => {
    const restored = restoreScreenshotIds(sampleItem(), context);
    expect(restored.evidence.screenshots).toEqual(shots);
    expect(restored.locations.map((l) => l.screenshot)).toEqual(shots);
    expect(restored.agent_prompt).toContain(`screenshots/${shots[0]}.png`);
    expect(restored.agent_prompt).toContain(`screenshots/${shots[1]}.png`);
    expect(ChangeItemSchema.safeParse(restored).success).toBe(true);
    expect(aliasScreenshotIds(restored, context)).toEqual(sampleItem());
    // The restored item fits session.json.
    expect(SessionDocumentSchema.safeParse({ ...doc, change_items: [restored] }).success).toBe(true);
    expect(SessionDocumentSchema.safeParse({ ...doc, change_items: [sampleItem()] }).success).toBe(false);
  });

  it('flags unknown screenshots and Annotations', () => {
    const bad = sampleItem();
    bad.locations[1] = { ...bad.locations[1]!, screenshot: 's9', annotation: 7 };
    expect(checkAgainstSession([bad], context)).toEqual([
      'items.0.locations.1.screenshot: "s9" is not a screenshot id in the script',
      'items.0.locations.1.annotation: there is no Annotation #7',
    ]);
    expect(checkAgainstSession([sampleItem()], context)).toEqual([]);
  });
});
