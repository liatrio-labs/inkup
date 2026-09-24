// E12 in Firefox: merge two Change Items on the review page; the merge model's rewrite (the Anthropic stub) replaces
// the concatenation and the Locations stay unioned. The Session is a fixture session.json with a finished Process
// run, restored from the side panel (the file is handed to the input from the page, as RDP cannot upload one).
// F5: Undo brings both originals back and drops the rewrite; Redo puts the merge and its rewrite back; then the same by
// Ctrl+Z and Shift+Ctrl+Z (keydown events dispatched in the page, as RDP has no keyboard).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeItem } from '../../packages/core/src/process/change-item.ts';
import { buildSessionDocument, SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import { isCombineRequest, messageReply, startAnthropicStub } from '../support/anthropic-stub';
import { expect, ROOT, test } from './fixtures';

const base = SessionDocumentSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'fixtures/sessions/a-move-here.word.json'), 'utf8')),
);
const [SHOT1, SHOT2] = base.events.flatMap((e) => (e.type === 'screenshot' ? [e.screenshot_id] : []));

const item = (n: 1 | 2, over: Partial<ChangeItem>): ChangeItem => ({
  id: `item_000${n}`,
  title: `Item ${n}`,
  category: 'layout',
  intent: `Intent ${n}.`,
  locations: [
    {
      role: 'subject',
      selector: n === 1 ? 'button.cta' : 'nav',
      element: `element ${n}`,
      url: '/pricing.html',
      screenshot: (n === 1 ? SHOT1 : SHOT2)!,
      annotation: n,
    },
  ],
  evidence: { video: { start: n, end: n + 1 }, screenshots: [(n === 1 ? SHOT1 : SHOT2)!] },
  transcript: `words ${n}`,
  confidence: 0.9,
  agent_prompt: `Do ${n}. See screenshots/${n === 1 ? SHOT1 : SHOT2}.png.`,
  pinned: false,
  ...over,
});

const COMBINED = {
  title: 'Do 1 and 2 as one change',
  category: 'style',
  intent: 'Both, together.',
  agent_prompt: 'Do 1 and 2. See screenshots/s1.png and screenshots/s2.png.',
  ambiguity: null,
};

test('Firefox: merge two items; the merge model rewrites them as one, Locations unioned; Undo and Redo take it back and put it back', async ({
  extPage,
  openExtensionWindow,
}) => {
  test.setTimeout(90_000);
  const stub = await startAnthropicStub({
    onMessage: (req) =>
      isCombineRequest(req)
        ? messageReply(req.body.model, JSON.stringify(COMBINED))
        : { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'stub: unexpected call' } } },
  });
  try {
    const doc = buildSessionDocument({
      session: base.session,
      events: base.events,
      blobs: base.blobs,
      audio: null,
      now: new Date(),
      process_run: { id: 'run-e12', model: 'claude-sonnet-5', items: [item(1, {}), item(2, {})] },
    });
    const onboarding = await extPage('/onboarding.html');
    await onboarding.evaluate(
      (b) => chrome.storage.local.set({ anthropicKey: 'sk-ant-e2e-firefox', devOverrides: { anthropicBaseUrl: b } }),
      stub.baseURL,
    );
    const panel = await openExtensionWindow('sidepanel.html');
    await panel.waitFor((json) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="restore-input"]');
      if (!input) return false;
      const dt = new DataTransfer();
      dt.items.add(new File([json], 'session.json', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, JSON.stringify(doc));
    await panel.waitForText('restore-done', /Restored/);
    await panel.evaluate(
      (id) => chrome.windows.create({ url: `/review.html?session=${encodeURIComponent(id)}` }).then(() => true),
      base.session.id,
    );
    const review = await extPage('/review.html', 20_000);
    await review.waitFor(() => document.querySelectorAll('[data-testid="change-item"]').length === 2, undefined, {
      timeout: 20_000,
      what: 'two Change Items',
    });
    await review.evaluate(() =>
      document.querySelectorAll<HTMLInputElement>('[data-testid="select-item"]').forEach((c) => {
        c.click();
      }),
    );
    await review.click('merge-items');
    await review.waitForText('item-title', /^Do 1 and 2 as one change$/);
    expect(await review.text('item-intent')).toBe('Both, together.');
    expect(await review.text('item-category')).toBe('style');
    expect(await review.evaluate(() => document.querySelectorAll('[data-testid="change-item"]').length)).toBe(1);
    expect(await review.evaluate(() => document.querySelectorAll('[data-testid="item-location"]').length)).toBe(2);
    expect(await review.evaluate(() => document.querySelector('[data-testid="agent-prompt"]')?.textContent ?? '')).toBe(
      `Do 1 and 2. See screenshots/${SHOT1}.png and screenshots/${SHOT2}.png.`,
    );
    expect(await review.evaluate(() => document.querySelectorAll('[data-testid="item-combined-plain"]').length)).toBe(
      0,
    );
    expect(stub.messages()).toHaveLength(1);
    expect(stub.messages()[0]!.body.model).toBe('claude-haiku-4-5-20251001');

    const titles = () =>
      review.evaluate(() =>
        [...document.querySelectorAll('[data-testid="item-title"]')].map((t) => t.textContent?.trim()).join(' | '),
      );
    const shown = (want: string) =>
      review.waitFor(
        (w) =>
          [...document.querySelectorAll('[data-testid="item-title"]')].map((t) => t.textContent?.trim()).join(' | ') ===
          w,
        want,
        { what: `titles ${want}` },
      );
    const disabled = (id: string) =>
      review.evaluate((i) => (document.querySelector(`[data-testid="${i}"]`) as HTMLButtonElement).disabled, id);
    await review.click('undo-items');
    await shown('Item 1 | Item 2');
    expect(
      await review.evaluate(() =>
        [...document.querySelectorAll('[data-testid="item-intent"]')].map((t) => t.textContent?.trim()),
      ),
    ).toEqual(['Intent 1.', 'Intent 2.']);
    expect(await disabled('undo-items')).toBe(true);
    await review.click('redo-items');
    await shown('Do 1 and 2 as one change');
    expect(await review.evaluate(() => document.querySelectorAll('[data-testid="item-location"]').length)).toBe(2);
    expect(await disabled('redo-items')).toBe(true);

    const key = (shiftKey: boolean) =>
      review.evaluate(
        (shift) =>
          document.body.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: shift ? 'Z' : 'z',
              ctrlKey: true,
              shiftKey: shift,
              bubbles: true,
              cancelable: true,
            }),
          ),
        shiftKey,
      );
    await key(false);
    await shown('Item 1 | Item 2');
    await key(true);
    await shown('Do 1 and 2 as one change');
    expect(await titles()).toBe('Do 1 and 2 as one change');
    expect(stub.messages()).toHaveLength(1);
  } finally {
    await stub.close();
  }
});
