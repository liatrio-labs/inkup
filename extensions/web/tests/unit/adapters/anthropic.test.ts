// @vitest-environment node
// The real Anthropic adapter (SDK, structured output, repair, second pass) against the local stub server.
import { readFileSync } from 'node:fs';
import { SessionDocumentSchema } from '@inkup/core/session-document';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnthropicAdapter, ProcessError } from '@/adapters/llm';
import { fixtureFile } from '../../../../../scripts/gen-session-fixtures.ts';
import {
  type AnthropicStub,
  errorReply,
  isDraftRequest,
  messageReply,
  scriptOf,
  startAnthropicStub,
} from '../../../../../tests/support/anthropic-stub';

const MODEL = 'claude-sonnet-5';
const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));
const shots = doc.events.filter((e) => e.type === 'screenshot').map((e) => e.screenshot_id);

const item = (over: Record<string, unknown> = {}) => ({
  id: 'item_0001',
  title: "Move 'Get started' into the header nav",
  category: 'layout',
  intent: 'The CTA belongs in the header, right of Docs.',
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
  transcript: 'okay so this button ... should go here in the header next to docs',
  confidence: 0.92,
  agent_prompt:
    'On /pricing.html move button.cta into the header nav right of Docs. See screenshots/s1.png and screenshots/s2.png.',
  pinned: false,
  ...over,
});
const lowItem = (over: Record<string, unknown> = {}) =>
  item({
    id: 'item_0002',
    title: 'Check the nav link',
    confidence: 0.4,
    ambiguity: 'Unclear whether "here" means the nav or the Docs link.',
    ...over,
  });

let stub: AnthropicStub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});
const adapter = () =>
  createAnthropicAdapter({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: stub!.baseURL, maxRetries: 0 });

describe('Anthropic adapter against the stub', () => {
  it('sends the script with structured output and restores screenshot ids', async () => {
    stub = await startAnthropicStub({ onMessage: () => messageReply(MODEL, JSON.stringify({ items: [item()] })) });
    const r = await adapter().process({ doc, model: MODEL });
    expect(stub.messages()).toHaveLength(1);
    const req = stub.messages()[0]!;
    expect(req.headers['x-api-key']).toBe('sk-ant-test-not-a-real-key');
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(req.body.model).toBe(MODEL);
    expect(req.body.output_config.format.type).toBe('json_schema');
    expect(req.body.output_config.format.schema.properties.items.type).toBe('array');
    expect(req.body.system[0].text).toContain('PAIRING WINDOW');
    expect(scriptOf(req)).toContain('SPEECH "okay so this button"');
    expect(r.items[0]!.evidence.screenshots).toEqual(shots);
    expect(r.items[0]!.agent_prompt).toContain(`screenshots/${shots[0]}.png`);
    expect(r.calls.map((c) => c.kind)).toEqual(['main']);
  });

  it('a malformed first answer triggers exactly one repair retry, which carries the raw answer and the issues', async () => {
    const bad = JSON.stringify({ items: [item({ confidence: 0.3 })] }); // low confidence without ambiguity
    stub = await startAnthropicStub({
      onMessage: (_r, i) => messageReply(MODEL, i === 0 ? bad : JSON.stringify({ items: [item()] })),
    });
    const r = await adapter().process({ doc, model: MODEL });
    expect(stub.messages()).toHaveLength(2);
    const repair = stub.messages()[1]!.body.messages;
    expect(repair).toHaveLength(3);
    expect(repair[1]).toEqual({ role: 'assistant', content: bad });
    expect(repair[2].content).toContain('ambiguity is required when confidence < 0.6');
    expect(r.calls.map((c) => c.kind)).toEqual(['main', 'repair']);
    expect(r.items).toHaveLength(1);
  });

  it('invalid JSON and unknown screenshot ids are repaired too', async () => {
    stub = await startAnthropicStub({
      onMessage: (_r, i) =>
        messageReply(
          MODEL,
          i === 0
            ? '{"items": ['
            : i === 1
              ? JSON.stringify({
                  items: [item({ evidence: { video: null, screenshots: ['s9'] }, agent_prompt: 'screenshots/s9.png' })],
                })
              : 'unused',
        ),
    });
    await expect(adapter().process({ doc, model: MODEL })).rejects.toMatchObject({
      code: 'invalid_output',
      message: expect.stringContaining('"s9" is not a screenshot id'),
    });
    // Exactly one repair: two calls in total, never a third.
    expect(stub.messages()).toHaveLength(2);
    expect(stub.messages()[1]!.body.messages[2].content).toContain('JSON');
  });

  it('re-sends low-confidence items with their screenshots and replaces them', async () => {
    const secondAmbiguity = 'Second pass: the ink circles the nav, not the Docs link.';
    const revised = lowItem({ confidence: 0.55, ambiguity: secondAmbiguity });
    stub = await startAnthropicStub({
      onMessage: (_r, i) => messageReply(MODEL, JSON.stringify({ items: i === 0 ? [item(), lowItem()] : [revised] })),
    });
    const loaded: string[] = [];
    const r = await adapter().process({
      doc,
      model: MODEL,
      loadScreenshot: async (id) => {
        loaded.push(id);
        return { media_type: 'image/png', data: Buffer.from(`png-${id}`).toString('base64') };
      },
    });
    expect(stub.messages()).toHaveLength(2);
    const content = stub.messages()[1]!.body.messages[0].content;
    expect(content.filter((b: { type: string }) => b.type === 'image')).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Screenshot s1:' });
    expect(content.at(-1).text).toContain('"id": "item_0002"');
    expect(content.at(-1).text).toContain('screenshots/s1.png');
    expect(loaded).toEqual(shots);
    expect(r.second_pass).toEqual(['item_0002']);
    expect(r.items[1]).toMatchObject({ id: 'item_0002', confidence: 0.55, ambiguity: secondAmbiguity });
    expect(r.calls.map((c) => c.kind)).toEqual(['main', 'second_pass']);
  });

  it('skips the second pass when no screenshot bytes are available', async () => {
    stub = await startAnthropicStub({ onMessage: () => messageReply(MODEL, JSON.stringify({ items: [lowItem()] })) });
    const r = await adapter().process({ doc, model: MODEL, loadScreenshot: async () => null });
    expect(stub.messages()).toHaveLength(1);
    expect(r.second_pass).toEqual([]);
  });

  it('estimates from count_tokens and the price table', async () => {
    stub = await startAnthropicStub({
      onMessage: () => errorReply(500, 'api_error', 'unused'),
      inputTokens: () => 5000,
    });
    const e = await adapter().estimate({ doc, model: MODEL });
    expect(stub.requests.map((r) => r.path)).toEqual(['/v1/messages/count_tokens']);
    expect(stub.requests[0]!.body.system[0].text).toContain('Change Items');
    expect(e).toMatchObject({ model: MODEL, input_tokens: 5000, output_tokens: 600 + 2 * 700 });
    expect(e.usd).toBeCloseTo((5000 * 2 + 2000 * 10) / 1e6, 10);
  });

  it('maps API errors, refusals and truncation to ProcessError codes', async () => {
    stub = await startAnthropicStub({ onMessage: () => errorReply(401, 'authentication_error', 'invalid x-api-key') });
    await expect(adapter().process({ doc, model: MODEL })).rejects.toMatchObject({ code: 'auth' });
    await stub.close();
    stub = await startAnthropicStub({
      onMessage: () => messageReply(MODEL, JSON.stringify({ items: [] }), undefined, 'refusal'),
    });
    await expect(adapter().process({ doc, model: MODEL })).rejects.toBeInstanceOf(ProcessError);
  });

  it('test() makes a free count and a one-token call', async () => {
    stub = await startAnthropicStub({
      onMessage: (r) => messageReply(r.body.model, 'OK', { input_tokens: 10, output_tokens: 1 }),
    });
    const t = await adapter().test([MODEL, 'claude-haiku-4-5-20251001']);
    expect(t).toEqual({ ok: true, message: 'Key works with claude-sonnet-5 and claude-haiku-4-5-20251001.' });
    expect(stub.messages()[0]!.body).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 1 });
    // One model: the count and the one-token call both use it.
    expect(await adapter().test([MODEL])).toEqual({ ok: true, message: 'Key works with claude-sonnet-5.' });
    expect(stub.messages()[1]!.body.model).toBe(MODEL);
  });

  it('sends effort in output_config only when set, next to the format, on every call kind', async () => {
    stub = await startAnthropicStub({ onMessage: () => messageReply(MODEL, JSON.stringify({ items: [item()] })) });
    await adapter().process({ doc, model: MODEL, effort: 'low' });
    await adapter().process({ doc, model: MODEL });
    await adapter().estimate({ doc, model: MODEL, effort: 'max' });
    const [withEffort, without] = stub.messages();
    expect(withEffort!.body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(without!.body.output_config).not.toHaveProperty('effort');
    const count = stub.requests.find((r) => r.path === '/v1/messages/count_tokens')!;
    expect(count.body.output_config.effort).toBe('max');
  });

  it('names the Gateway in its errors and prices a Gateway model from the catalog', async () => {
    stub = await startAnthropicStub({ onMessage: () => errorReply(401, 'authentication_error', 'bad key') });
    const gateway = createAnthropicAdapter({
      apiKey: 'vck-test-not-a-real-key',
      baseURL: stub.baseURL,
      vendor: 'Vercel AI Gateway',
      maxRetries: 0,
      catalog: {
        as_of: '2026-09-24',
        models: {
          'google/gemini-3.1-pro-preview': {
            id: 'google/gemini-3.1-pro-preview',
            price: { input: 2, output: 12 },
            context_window: 1_000_000,
            max_tokens: 64_000,
          },
        },
      },
    });
    await expect(gateway.process({ doc, model: 'anthropic/claude-sonnet-5' })).rejects.toMatchObject({
      code: 'auth',
      message: 'The Vercel AI Gateway key was rejected (401).',
    });
    const e = await gateway.estimate({ doc, model: 'google/gemini-3.1-pro-preview' });
    expect(e.usd).not.toBeNull();
    expect(e.prices_as_of).toBe('2026-09-24');
  });

  it("Process keeps a pinned Draft Item the model left out, pinned, and drops the model's rewrite of it", async () => {
    const [a1, a2] = doc.events.filter((e) => e.type === 'annotation');
    const pinnedDoc = {
      ...doc,
      events: [
        ...doc.events,
        {
          id: 'dr1',
          type: 'draft_item' as const,
          t: 9800,
          draft_id: 'd1',
          pass_id: 'p1',
          model: DRAFT_MODEL,
          title: "Move 'Get started' into the header",
          category: 'layout' as const,
          intent: 'CTA in the header.',
          transcript: 'this button ... should go here',
          locations: [
            { role: 'subject' as const, element: "button 'Get started'", selector: 'button.cta', annotation: 1 },
            { role: 'destination' as const, element: 'header nav', selector: 'nav', annotation: 2 },
          ],
          annotation_ids: [a1!.annotation_id, a2!.annotation_id],
        },
        {
          id: 'da1',
          type: 'draft_action' as const,
          t: 9900,
          draft_id: 'd1',
          action: 'pin' as const,
          source: 'voice' as const,
        },
      ].sort((a, b) => a.t - b.t),
    };
    stub = await startAnthropicStub({
      onMessage: () => messageReply(MODEL, JSON.stringify({ items: [item({ title: 'A model rewrite' })] })),
    });
    const r = await adapter().process({ doc: pinnedDoc, model: MODEL });
    expect(scriptOf(stub.messages()[0]!)).toContain('PINNED DRAFT ITEMS');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      title: "Move 'Get started' into the header",
      pinned: true,
      evidence: { screenshots: shots },
    });
    expect(r.pins_converted).toEqual(['d1']);
    expect(r.pins_dropped).toEqual(['item_0001']);
  });
});

describe('Text Comments in Process (E3)', () => {
  const page = {
    url: 'http://localhost:4401/pricing.html',
    scroll: { x: 0, y: 0 },
    viewport: { width: 1280, height: 720 },
    dpr: 2,
  };
  const textComment = (t: number, comment: string, n = 1) => [
    {
      id: `tcs${n}`,
      type: 'screenshot' as const,
      t: t + 900,
      screenshot_id: `tc-shot-${n}`,
      path: `screenshots/tc-shot-${n}.png`,
      mime: 'image/png',
      trigger: 'text_comment' as const,
      annotation_id: null,
      ...page,
    },
    {
      id: `tc${n}`,
      type: 'text_comment' as const,
      t,
      t_end: t + 800,
      comment_id: `c${n}`,
      index: n,
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
      comment,
      bbox: { x: 40, y: 80, width: 420, height: 48 },
      ...page,
      screenshot_id: `tc-shot-${n}`,
    },
  ];
  const onlyComments = (...extra: ReturnType<typeof textComment>) => ({
    ...doc,
    events: [...doc.events.filter((e) => e.type === 'session_start' || e.type === 'session_end'), ...extra].sort(
      (a, b) => a.t - b.t,
    ),
  });

  it('a Session of explicit replacements makes no call: the items are built in code', async () => {
    stub = await startAnthropicStub({ onMessage: () => messageReply(MODEL, JSON.stringify({ items: [] })) });
    const only = onlyComments(...textComment(2000, 'This should say Pricing plans'));
    const estimate = await adapter().estimate({ doc: only, model: MODEL });
    expect(estimate).toMatchObject({ input_tokens: 0, output_tokens: 0, chunks: 0 });
    const r = await adapter().process({ doc: only, model: MODEL });
    expect(stub.requests).toHaveLength(0);
    expect(r.calls).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      title: 'Change "Ship reviews in minutes" to "Pricing plans"',
      category: 'copy',
      confidence: 0.95,
      locations: [{ selector: '#hero-title', screenshot: 'tc-shot-1', annotation: null }],
      evidence: { screenshots: ['tc-shot-1'] },
    });
  });

  it('other comments go to the model with their anchor; one the model left out is converted in code', async () => {
    stub = await startAnthropicStub({ onMessage: () => messageReply(MODEL, JSON.stringify({ items: [item()] })) });
    const mixed = {
      ...doc,
      events: [...doc.events, ...textComment(9500, 'Too salesy, tone it down')].sort((a, b) => a.t - b.t),
    };
    const r = await adapter().process({ doc: mixed, model: MODEL });
    expect(stub.messages()).toHaveLength(1);
    const script = scriptOf(stub.messages()[0]!);
    expect(script).toMatch(
      /TEXT COMMENT t1 on #hero-title <h1 role=heading> "Ship reviews in minutes" · at \/pricing\.html · screenshot s3\n {4}selected "Ship reviews in minutes" after "…Pricing Fixture" before "Record a spoken review…"\n {4}comment "Too salesy, tone it down"/,
    );
    expect(r.items.map((i) => i.title)).toEqual([
      "Move 'Get started' into the header nav",
      'Revise "Ship reviews in minutes"',
    ]);
    expect(r.items[1]).toMatchObject({
      category: 'copy',
      locations: [{ selector: '#hero-title' }],
      evidence: { screenshots: ['tc-shot-1'] },
    });
  });

  it("the model's own item for an explicit comment is replaced by the one built in code", async () => {
    const rewrite = item({
      title: 'Rename the headline',
      category: 'copy',
      locations: [
        {
          role: 'subject',
          selector: '#hero-title',
          element: 'h1',
          url: '/pricing.html',
          screenshot: 's3',
          annotation: null,
        },
      ],
      evidence: { video: null, screenshots: ['s3'] },
      agent_prompt: 'Rename it. See screenshots/s3.png.',
    });
    stub = await startAnthropicStub({
      onMessage: () => messageReply(MODEL, JSON.stringify({ items: [item(), { ...rewrite, id: 'item_0002' }] })),
    });
    const mixed = {
      ...doc,
      events: [...doc.events, ...textComment(9500, '"Pricing plans"')].sort((a, b) => a.t - b.t),
    };
    const r = await adapter().process({ doc: mixed, model: MODEL });
    expect(scriptOf(stub.messages()[0]!)).toContain('"Ship reviews in minutes" → "Pricing plans" · HANDLED');
    expect(r.items.map((i) => [i.id, i.title])).toEqual([
      ['item_0001', "Move 'Get started' into the header nav"],
      ['item_0003', 'Change "Ship reviews in minutes" to "Pricing plans"'],
    ]);
  });
});

const DRAFT_MODEL = 'claude-haiku-4-5-20251001';
const draftItem = (over: Record<string, unknown> = {}) => ({
  title: "Move 'Get started' into the header",
  category: 'layout',
  intent: 'The CTA belongs in the header.',
  transcript: 'okay so this button',
  locations: [{ role: 'subject', element: "button 'Get started'", selector: 'button.cta', annotation: 1 }],
  ...over,
});

describe('Draft Item pass against the stub', () => {
  const fresh = new Set(doc.events.map((e) => e.id));

  it('sends the new events as text with the small schema, and maps Locations to Annotation ids', async () => {
    stub = await startAnthropicStub({
      onMessage: (r) =>
        messageReply(r.body.model, JSON.stringify({ items: [draftItem()] }), { input_tokens: 900, output_tokens: 80 }),
    });
    const r = await adapter().draft({
      events: doc.events,
      fresh,
      start_url: doc.session.start_url,
      model: DRAFT_MODEL,
    });
    const req = stub.messages()[0]!;
    expect(isDraftRequest(req)).toBe(true);
    expect(req.body).toMatchObject({
      model: DRAFT_MODEL,
      max_tokens: 2000,
      output_config: { format: { type: 'json_schema' } },
    });
    expect(req.body.output_config.format.schema.properties.items.type).toBe('array');
    expect(typeof req.body.messages[0].content).toBe('string'); // text only, never an image block
    expect(scriptOf(req)).toContain('NEW EVENTS:\n[00:00.8] SPEECH "okay so this button"');
    const ann = doc.events.find((e) => e.type === 'annotation' && e.index === 1)!;
    expect(r).toMatchObject({ skipped: false, calls: [{ kind: 'draft', input_tokens: 900, output_tokens: 80 }] });
    expect(r.items).toEqual([{ ...draftItem(), annotation_ids: [(ann as { annotation_id: string }).annotation_id] }]);
  });

  it('repairs an unknown Annotation once, and makes no call when nothing is new', async () => {
    stub = await startAnthropicStub({
      onMessage: (_r, i) =>
        messageReply(
          DRAFT_MODEL,
          JSON.stringify({
            items: [
              draftItem(
                i === 0 ? { locations: [{ role: 'subject', element: 'x', selector: null, annotation: 9 }] } : {},
              ),
            ],
          }),
        ),
    });
    const r = await adapter().draft({
      events: doc.events,
      fresh,
      start_url: doc.session.start_url,
      model: DRAFT_MODEL,
    });
    expect(stub.messages()).toHaveLength(2);
    expect(stub.messages()[1]!.body.messages[2].content).toContain('there is no Annotation #9');
    expect(r.calls.map((c) => c.kind)).toEqual(['draft', 'draft_repair']);
    const none = await adapter().draft({
      events: doc.events,
      fresh: new Set(),
      start_url: doc.session.start_url,
      model: DRAFT_MODEL,
    });
    expect(none).toEqual({ items: [], calls: [], skipped: true });
    expect(stub.messages()).toHaveLength(2);
  });
});

describe('combine (E12) against the stub', () => {
  const HAIKU = 'claude-haiku-4-5-20251001';
  const into = item({
    agent_prompt: `Move button.cta into the nav. See screenshots/${shots[0]}.png.`,
    evidence: { video: null, screenshots: [shots[0]] },
    locations: [{ ...item().locations[0], screenshot: shots[0] }],
  });
  const from = item({
    id: 'item_0002',
    title: 'Make the CTA blue',
    category: 'style',
    intent: 'Brand colour.',
    agent_prompt: `Make button.cta use var(--brand). See screenshots/${shots[1]}.png.`,
    evidence: { video: null, screenshots: [shots[1]] },
    locations: [{ ...item().locations[0], screenshot: shots[1] }],
  });
  const combined = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      title: 'Move the CTA into the nav and make it brand blue',
      category: 'layout',
      intent: 'The CTA belongs in the header and should use the brand colour.',
      agent_prompt:
        'On /pricing.html move button.cta into the header nav and give it var(--brand). See screenshots/s1.png and screenshots/s2.png.',
      ambiguity: null,
      ...over,
    });

  it('sends both items as text with aliases and returns the rewrite with stored ids', async () => {
    stub = await startAnthropicStub({ onMessage: () => messageReply(HAIKU, combined()) });
    const r = await adapter().combine({ into: into as never, from: from as never, model: HAIKU });
    const req = stub.messages()[0]!;
    expect(req.body.model).toBe(HAIKU);
    expect(req.body.system[0].text).toContain('You combine two Change Items into one');
    expect(req.body.output_config.format.schema.properties.agent_prompt.type).toBe('string');
    expect(scriptOf(req)).toContain(
      'REQUIRED CITATIONS (the agent_prompt must contain each): screenshots/s1.png, screenshots/s2.png',
    );
    expect(JSON.stringify(req.body.messages)).not.toContain('"image"');
    expect(r.changes).toEqual({
      title: 'Move the CTA into the nav and make it brand blue',
      category: 'layout',
      intent: 'The CTA belongs in the header and should use the brand colour.',
      agent_prompt: `On /pricing.html move button.cta into the header nav and give it var(--brand). See screenshots/${shots[0]}.png and screenshots/${shots[1]}.png.`,
      ambiguity: null,
    });
    expect(r.calls.map((c) => c.kind)).toEqual(['combine']);
  });

  it('an answer that drops a citation gets exactly one repair; a second failure is invalid_output', async () => {
    const dropped = combined({ agent_prompt: 'Do it. See screenshots/s1.png.' });
    stub = await startAnthropicStub({ onMessage: (_r, i) => messageReply(HAIKU, i === 0 ? dropped : combined()) });
    const r = await adapter().combine({ into: into as never, from: from as never, model: HAIKU });
    expect(stub.messages()).toHaveLength(2);
    const repair = stub.messages()[1]!.body.messages;
    expect(repair[1]).toEqual({ role: 'assistant', content: dropped });
    expect(repair[2].content).toContain('agent_prompt: must cite screenshots/s2.png');
    expect(repair[2].content).toContain('Return the complete corrected JSON object');
    expect(r.calls.map((c) => c.kind)).toEqual(['combine', 'combine_repair']);

    await stub.close();
    stub = await startAnthropicStub({ onMessage: () => messageReply(HAIKU, dropped) });
    await expect(adapter().combine({ into: into as never, from: from as never, model: HAIKU })).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(stub.messages()).toHaveLength(2);
  });

  it('an API error surfaces as a ProcessError', async () => {
    stub = await startAnthropicStub({ onMessage: () => errorReply(401, 'authentication_error', 'bad key') });
    await expect(adapter().combine({ into: into as never, from: from as never, model: HAIKU })).rejects.toMatchObject({
      code: 'auth',
    });
  });
});
