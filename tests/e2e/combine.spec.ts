// E12 proof: merging two Change Items on the review page shows the union at once, then the merge model's rewrite
// (one title, intent and prompt), through the real review page, service worker and Anthropic adapter pointed at the
// local stub. The Session is a restored fixture session.json with a finished Process run, so no recording is needed.
// Also: with no key the concatenated merge stays with a quiet note and a retry once a key exists; an edit made
// while the model is still answering wins over the late rewrite; the Merge model setting is the model called.
// F5: Undo takes back a merge and its rewrite in one step (both originals return), Redo puts both back, by button and
// by Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z; a text field keeps its own undo; an Undo before the rewrite arrives drops it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import type { ChangeItem } from '../../packages/core/src/process/change-item.ts';
import { applyItemEdits } from '../../packages/core/src/review-edits.ts';
import { buildSessionDocument, SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import {
  type AnthropicStub,
  isCombineRequest,
  messageReply,
  type StubReply,
  scriptOf,
  startAnthropicStub,
} from '../support/anthropic-stub';
import { expect, ROOT, test } from './fixtures';

const RUN = 'run-e12';
const base = SessionDocumentSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'fixtures/sessions/a-move-here.word.json'), 'utf8')),
);
const [SHOT1, SHOT2] = base.events.flatMap((e) => (e.type === 'screenshot' ? [e.screenshot_id] : []));

const move: ChangeItem = {
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
      screenshot: SHOT1!,
      annotation: 1,
    },
  ],
  evidence: { video: { start: 1, end: 3 }, screenshots: [SHOT1!] },
  transcript: 'this button should go in the header',
  confidence: 0.9,
  agent_prompt: `On /pricing.html move button.cta into the header. See screenshots/${SHOT1}.png.`,
  pinned: false,
};
const blue: ChangeItem = {
  id: 'item_0002',
  title: 'Make the CTA brand blue',
  category: 'style',
  intent: 'It should use the brand colour.',
  locations: [
    {
      role: 'subject',
      selector: 'nav',
      element: 'header nav',
      url: '/pricing.html',
      screenshot: SHOT2!,
      annotation: 2,
    },
  ],
  evidence: { video: { start: 5, end: 7 }, screenshots: [SHOT2!] },
  transcript: 'and make it blue',
  confidence: 0.85,
  agent_prompt: `Give button.cta var(--brand). See screenshots/${SHOT2}.png.`,
  pinned: false,
};

const COMBINED = {
  title: "Move 'Get started' into the header and make it brand blue",
  category: 'layout',
  intent: 'The CTA belongs in the header nav and should use the brand colour.',
  // Aliases: s1 is the first item's screenshot, s2 the second's.
  agent_prompt:
    'On /pricing.html move button.cta into the header nav and give it var(--brand). See screenshots/s1.png and screenshots/s2.png.',
  ambiguity: null,
};

/** The fixture with a finished Process run of the two items, restored from the side panel; the review page open on it. */
async function restoreAndReview(
  sw: Worker,
  openExtensionPage: (p: string) => Promise<Page>,
  storage: Record<string, unknown>,
): Promise<Page> {
  const doc = buildSessionDocument({
    session: base.session,
    events: base.events,
    blobs: base.blobs,
    audio: null,
    now: new Date(),
    process_run: { id: RUN, model: 'claude-sonnet-5', items: [move, blue] },
  });
  const file = join(mkdtempSync(join(tmpdir(), 'var-combine-')), 'session.json');
  writeFileSync(file, JSON.stringify(doc));
  await sw.evaluate((s) => chrome.storage.local.set(s), storage);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('restore-input').setInputFiles(file);
  await expect(panel.getByTestId('restore-done')).toBeVisible();
  const review = await openExtensionPage(`review.html?session=${encodeURIComponent(base.session.id)}`);
  await expect(review.getByTestId('change-item')).toHaveCount(2, { timeout: 20_000 });
  return review;
}

async function mergeBoth(review: Page) {
  await review.getByTestId('select-item').nth(0).check();
  await review.getByTestId('select-item').nth(1).check();
  await review.getByTestId('merge-items').click();
  await expect(review.getByTestId('change-item')).toHaveCount(1);
}

/** The run's item_edit ops in log order, and the items they give. */
async function logged(review: Page) {
  const events = await review.evaluate(async (sid) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    return new Promise<(TimelineEvent & { seq: number })[]>((res) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(sid);
      r.onsuccess = () => res(r.result);
    });
  }, base.session.id);
  const edits = events
    .filter((e): e is EventOf<'item_edit'> & { seq: number } => e.type === 'item_edit' && e.run_id === RUN)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.edit);
  return { edits, items: applyItemEdits([move, blue], edits).items };
}

/** A stub whose combine answers wait for `release()`; anything else is a test failure. */
function gatedCombine() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release,
    onMessage: async (req: Parameters<typeof isCombineRequest>[0]): Promise<StubReply> => {
      if (!isCombineRequest(req)) throw new Error(`unexpected request: ${JSON.stringify(req.body?.system)}`);
      await gate;
      return messageReply(req.body.model, JSON.stringify(COMBINED));
    },
  };
}

test('merge two items: the union shows at once, then the merge model rewrites it as one item', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const gated = gatedCombine();
  const stub: AnthropicStub = await startAnthropicStub({ onMessage: gated.onMessage });
  try {
    const review = await restoreAndReview(serviceWorker, openExtensionPage, {
      anthropicKey: 'sk-ant-e2e-combine',
      devOverrides: { anthropicBaseUrl: stub.baseURL },
    });
    await mergeBoth(review);
    const card = review.getByTestId('change-item');
    // The deterministic union, while the model is still answering.
    await expect(card.getByTestId('item-combining')).toHaveText('Combining…');
    await expect(card.getByTestId('item-intent')).toHaveText(`${move.intent} ${blue.intent}`);
    await expect(card.getByTestId('item-location')).toHaveCount(2);

    gated.release();
    await expect(card.getByTestId('item-title')).toHaveText(COMBINED.title);
    await expect(card.getByTestId('item-intent')).toHaveText(COMBINED.intent);
    await expect(card.getByTestId('item-category')).toHaveText('layout');
    await expect(card.getByTestId('item-combining')).toHaveCount(0);
    await expect(card.getByTestId('item-combined-plain')).toHaveCount(0);
    await expect(card.getByTestId('item-location')).toHaveCount(2);
    const prompt = await card.getByTestId('agent-prompt').textContent();
    expect(prompt).toBe(
      `On /pricing.html move button.cta into the header nav and give it var(--brand). See screenshots/${SHOT1}.png and screenshots/${SHOT2}.png.`,
    );

    // One call, with the default Merge model, carrying both items as text.
    expect(stub.messages()).toHaveLength(1);
    const req = stub.messages()[0]!;
    expect(req.body.model).toBe('claude-haiku-4-5-20251001');
    expect(scriptOf(req)).toContain(`title: ${JSON.stringify(move.title)}`);
    expect(scriptOf(req)).toContain(`title: ${JSON.stringify(blue.title)}`);
    expect(JSON.stringify(req.body.messages)).not.toContain('"image"');

    // Logged as the merge, then an edit marked combine; replayed without a model, Evidence stays unioned.
    const { edits, items } = await logged(review);
    expect(edits.map((e) => [e.op, e.op === 'edit' ? (e.origin ?? null) : null])).toEqual([
      ['merge', null],
      ['edit', 'combine'],
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'item_0001',
      title: COMBINED.title,
      intent: COMBINED.intent,
      agent_prompt: prompt,
    });
    expect(items[0]!.evidence.screenshots).toEqual([SHOT1, SHOT2]);
    expect(items[0]!.locations.map((l) => l.selector)).toEqual(['button.cta', 'nav']);
    // The combine call is counted on the run with Process's.
    const calls = await review.evaluate(
      async (run) =>
        new Promise<{ kind: string }[]>((res) => {
          const r = indexedDB.open('inkup');
          r.onsuccess = () => {
            const g = r.result.transaction('processRuns').objectStore('processRuns').get(run);
            g.onsuccess = () => res(g.result.calls);
          };
        }),
      RUN,
    );
    expect(calls.map((c) => c.kind)).toEqual(['combine']);

    // A reload replays the log: same item, no model call.
    await review.reload();
    await expect(review.getByTestId('item-title')).toHaveText(COMBINED.title);
    expect(stub.messages()).toHaveLength(1);
  } finally {
    await stub.close();
  }
});

test('with no key the merge keeps the concatenation, noted "Combined without AI"; once a key exists, Combine with AI rewrites it', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const stub = await startAnthropicStub({ onMessage: (req) => messageReply(req.body.model, JSON.stringify(COMBINED)) });
  try {
    const review = await restoreAndReview(serviceWorker, openExtensionPage, {
      devOverrides: { anthropicBaseUrl: stub.baseURL },
    });
    await mergeBoth(review);
    const card = review.getByTestId('change-item');
    await expect(card.getByTestId('item-combined-plain')).toHaveText('Combined without AI');
    await expect(card.getByTestId('item-combine-retry')).toHaveCount(0);
    await expect(card.getByTestId('item-title')).toHaveText(move.title);
    await expect(card.getByTestId('item-intent')).toHaveText(`${move.intent} ${blue.intent}`);
    await expect(card.getByTestId('agent-prompt')).toHaveText(`${move.agent_prompt}\n\n${blue.agent_prompt}`, {
      useInnerText: false,
    });
    expect(stub.messages()).toHaveLength(0);

    // A key saved later: the retry appears and rewrites the same merge.
    await serviceWorker.evaluate(() => chrome.storage.local.set({ anthropicKey: 'sk-ant-e2e-combine' }));
    await card.getByTestId('item-combine-retry').click();
    await expect(card.getByTestId('item-title')).toHaveText(COMBINED.title);
    await expect(card.getByTestId('item-combined-plain')).toHaveCount(0);
    expect(stub.messages()).toHaveLength(1);
    expect(scriptOf(stub.messages()[0]!)).toContain(`title: ${JSON.stringify(blue.title)}`);
  } finally {
    await stub.close();
  }
});

test('an edit made while the model is still answering wins: the late rewrite is dropped; the Merge model setting is the model called', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const gated = gatedCombine();
  const stub = await startAnthropicStub({ onMessage: gated.onMessage });
  try {
    await serviceWorker.evaluate(
      (b) => chrome.storage.local.set({ devOverrides: { anthropicBaseUrl: b } }),
      stub.baseURL,
    );
    const options = await openExtensionPage('options.html');
    await options.getByTestId('anthropic-key').fill('sk-ant-e2e-combine');
    await options.getByTestId('merge-model').fill('claude-merge-e2e');
    await options.getByTestId('save-processing').click();
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          async () =>
            (
              (await chrome.storage.local.get('processingSettings')).processingSettings as
                | { mergeModel?: string }
                | undefined
            )?.mergeModel,
        ),
      )
      .toBe('claude-merge-e2e');

    const review = await restoreAndReview(serviceWorker, openExtensionPage, {});
    await mergeBoth(review);
    const card = review.getByTestId('change-item');
    await expect(card.getByTestId('item-combining')).toBeVisible();
    await card.getByTestId('edit-item').click();
    await card.getByTestId('edit-title').fill('My own title');
    await card.getByTestId('save-item').click();
    await expect(card.getByTestId('item-title')).toHaveText('My own title');

    gated.release();
    await expect(card.getByTestId('item-combining')).toHaveCount(0);
    expect(stub.messages()).toHaveLength(1);
    expect(stub.messages()[0]!.body.model).toBe('claude-merge-e2e');
    await expect(card.getByTestId('item-title')).toHaveText('My own title');
    await expect(card.getByTestId('item-intent')).toHaveText(`${move.intent} ${blue.intent}`);
    await expect(card.getByTestId('item-combined-plain')).toHaveCount(0);
    const { edits } = await logged(review);
    expect(edits.map((e) => [e.op, e.op === 'edit' ? (e.origin ?? null) : null])).toEqual([
      ['merge', null],
      ['edit', null],
    ]);
  } finally {
    await stub.close();
  }
});

/** The titles of the cards, in order. */
const titles = (review: Page) => review.getByTestId('item-title').allTextContents();

test('Undo takes back a merge and its rewrite in one step; Redo puts both back; the shortcuts do the same, and survive a reload', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const stub = await startAnthropicStub({ onMessage: (req) => messageReply(req.body.model, JSON.stringify(COMBINED)) });
  try {
    const review = await restoreAndReview(serviceWorker, openExtensionPage, {
      anthropicKey: 'sk-ant-e2e-combine',
      devOverrides: { anthropicBaseUrl: stub.baseURL },
    });
    const undo = review.getByTestId('undo-items');
    const redo = review.getByTestId('redo-items');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await mergeBoth(review);
    await expect(review.getByTestId('item-title')).toHaveText(COMBINED.title);

    // The button: both originals back, as generated; the combined words are gone.
    await undo.click();
    await expect.poll(() => titles(review)).toEqual([move.title, blue.title]);
    await expect(review.getByTestId('item-intent')).toHaveText([move.intent, blue.intent]);
    await expect(review.getByTestId('item-combined-plain')).toHaveCount(0);
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect.poll(() => titles(review)).toEqual([COMBINED.title]);
    await expect(review.getByTestId('item-location')).toHaveCount(2);
    await expect(redo).toBeDisabled();

    // The shortcuts, with focus on the page.
    await review.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => titles(review)).toEqual([move.title, blue.title]);
    await review.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => titles(review)).toEqual([COMBINED.title]);

    // In a text field the shortcut is the field's own undo, not the list's.
    const card = review.getByTestId('change-item');
    await card.getByTestId('edit-item').click();
    await card.getByTestId('edit-title').fill('Typing');
    await card.getByTestId('edit-title').press('ControlOrMeta+z');
    await expect(review.getByTestId('change-item')).toHaveCount(1);
    await card.getByRole('button', { name: 'Cancel' }).click();

    // The log keeps every op; the model was called once (redo replays its answer).
    const { edits, items } = await logged(review);
    expect(edits.map((e) => e.op)).toEqual(['merge', 'edit', 'undo', 'redo', 'undo', 'redo']);
    expect(items.map((i) => i.title)).toEqual([COMBINED.title]);
    expect(stub.messages()).toHaveLength(1);

    // A reload replays the same log, and Undo still reaches the merge.
    await review.reload();
    await expect.poll(() => titles(review)).toEqual([COMBINED.title]);
    await review.getByTestId('undo-items').click();
    await expect.poll(() => titles(review)).toEqual([move.title, blue.title]);
    expect(stub.messages()).toHaveLength(1);
  } finally {
    await stub.close();
  }
});

test('an Undo made while the model is still answering drops the late rewrite; Redo brings back the plain merge', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const gated = gatedCombine();
  const stub = await startAnthropicStub({ onMessage: gated.onMessage });
  try {
    const review = await restoreAndReview(serviceWorker, openExtensionPage, {
      anthropicKey: 'sk-ant-e2e-combine',
      devOverrides: { anthropicBaseUrl: stub.baseURL },
    });
    await mergeBoth(review);
    await expect(review.getByTestId('item-combining')).toBeVisible();
    await review.getByTestId('undo-items').click();
    await expect.poll(() => titles(review)).toEqual([move.title, blue.title]);

    gated.release();
    await expect(review.getByTestId('item-combining')).toHaveCount(0);
    expect(stub.messages()).toHaveLength(1);
    await expect.poll(() => titles(review)).toEqual([move.title, blue.title]);
    await review.getByTestId('redo-items').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1);
    await expect(review.getByTestId('item-intent')).toHaveText(`${move.intent} ${blue.intent}`);
    await expect(review.getByTestId('item-title')).toHaveText(move.title);
    const { edits } = await logged(review);
    expect(edits.map((e) => e.op)).toEqual(['merge', 'undo', 'redo']);
  } finally {
    await stub.close();
  }
});
