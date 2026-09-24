// Graceful simplification (ADR 0004): a never-paired extension is the whole product. Session → Process → edit →
// export works as before, nothing is written to the host outbox, and the only host UI is the options page's
// pairing hint.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import { messageReply, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { storeRows } from './helpers/seed';

test.use({ fakeAudio: 'review-two-notes.wav' });

test('never paired: Session, Process, edit and export work, with no outbox rows and no host UI', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const stub = await startAnthropicStub({
    onMessage: (req) =>
      messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            {
              id: 'item_0001',
              title: "Move 'Get started' into the header",
              category: 'layout',
              intent: 'The primary CTA should sit in the site header.',
              locations: [
                {
                  role: 'subject',
                  selector: 'button.cta',
                  element: "button 'Get started'",
                  url: '/pricing.html',
                  screenshot: 's1',
                  annotation: 1,
                },
              ],
              evidence: { video: null, screenshots: ['s1'] },
              transcript: 'this button should go in the header',
              confidence: 0.9,
              agent_prompt: 'On /pricing.html move button.cta into the header. See screenshots/s1.png.',
              pinned: false,
            },
          ],
        }),
      ),
  });
  try {
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await serviceWorker.evaluate(async (base) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        anthropicKey: 'sk-ant-e2e-standalone',
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
      });
    }, stub.baseURL);

    await panel.getByTestId('draw-toggle').click();
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
    // The panel has no host line at all.
    await expect(panel.getByTestId('host-indicator')).toHaveCount(0);

    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
    // A review edit (appended to the timeline) must not queue anything either.
    const item = review.getByTestId('change-item').first();
    await item.getByTestId('edit-item').click();
    await item.getByTestId('edit-title').fill('Put Get started in the header');
    await item.getByTestId('save-item').click();
    await expect(review.getByTestId('item-title').filter({ hasText: 'Put Get started in the header' })).toHaveCount(1);

    await review.getByTestId('export-zip').click();
    await expect(review.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
    const id = Number(await review.evaluate(() => document.body.dataset.exportDownloadId));
    const zip = await serviceWorker.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!, id);
    expect(zip.state).toBe('complete');
    const dir = mkdtempSync(join(tmpdir(), 'var-standalone-'));
    execFileSync('unzip', ['-q', zip.filename, '-d', dir]);
    const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    expect(doc.change_items!.map((i) => i.title)).toEqual(['Put Get started in the header']);
    expect(doc.events.filter((e) => e.type === 'item_edit')).toHaveLength(1);

    // Nothing extra was stored for a host, and nothing about one was set.
    expect(await storeRows(review, 'outbox')).toEqual([]);
    const stored = await serviceWorker.evaluate(async () => ({
      local: Object.keys(await chrome.storage.local.get(['hostPairing'])),
      session: (await chrome.storage.session.get('hostStatus')).hostStatus ?? null,
    }));
    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual({ state: 'unpaired' });

    // Settings: one hint and a Pair button; no status, no Forget.
    const options = await openExtensionPage('options.html');
    await expect(options.getByTestId('host-hint')).toHaveText(/Pair a host to hand items to agents/);
    await expect(options.getByTestId('host-pair')).toBeVisible();
    await expect(options.getByTestId('host-status')).toHaveCount(0);
    await expect(options.getByTestId('host-forget')).toHaveCount(0);
  } finally {
    await stub.close();
  }
});
