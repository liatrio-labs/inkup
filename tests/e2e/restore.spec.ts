// Feedback batch 1, U1: restore from file. Record → Process (Anthropic stub) → Export zip → delete → restore the
// zip: the review page shows the same items, screenshots and video. A bare session.json restores without media,
// an id clash asks Open existing / Replace, and old, newer or garbage files are refused with a clear message.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { SCHEMA_VERSION } from '../../packages/core/src/timeline.ts';
import { messageReply, scriptOf, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, ROOT, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';

test.use({ fakeAudio: 'review-two-notes.wav' });

/** Clicks Export and returns the path of the finished download. */
async function exportZip(review: Page, sw: Worker): Promise<string> {
  await review.evaluate(() => delete document.body.dataset.exportDownloadId);
  await review.getByTestId('export-zip').click();
  await expect(review.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const id = Number(await review.evaluate(() => document.body.dataset.exportDownloadId));
  const item = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!, id);
  expect(item.state).toBe('complete');
  return item.filename;
}

/** What the review page shows for a Session: item titles, Annotation screenshots that loaded, the screenshots inside the Change Item cards, and the player. */
async function reviewView(review: Page) {
  await expect(review.getByTestId('change-item').first()).toBeVisible({ timeout: 20_000 });
  const titles = await review.getByTestId('item-title').allTextContents();
  const loaded = (sel: string) =>
    review
      .locator(sel)
      .evaluateAll(
        (els) => els.filter((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0).length,
      );
  await review.getByTestId('item-title').first().click();
  const annotationShots = await loaded('[data-testid="annotation-screenshot"] img');
  const evidenceShots = await review
    .getByTestId('change-item')
    .getByTestId('evidence-shot')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-screenshot-id')));
  const evidenceLoaded = await loaded('[data-testid="change-item"] [data-testid="evidence-shot"] img');
  const video = (await review.getByTestId('evidence-video').count())
    ? await review.getByTestId('evidence-video').evaluate(async (v: HTMLVideoElement) => {
        if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
        return Number.isFinite(v.duration) ? Math.round(v.duration) : -1;
      })
    : null;
  const segments = await review.getByTestId('transcript-segment').count();
  return { titles, annotationShots, evidenceShots, evidenceLoaded, video, segments };
}

async function openReviewFrom(page: Page, row: ReturnType<Page['locator']>): Promise<Page> {
  const opened = page.context().waitForEvent('page', (p) => p.url().includes('/review.html'));
  await row.click();
  const review = await opened;
  await expect(review.getByRole('heading', { name: 'Session review' })).toBeVisible();
  return review;
}

test('an exported zip restores the Session with the same items, screenshots and video; a clash asks Open existing or Replace; a bare session.json restores without media', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(180_000);
  const stub = await startAnthropicStub({
    onMessage: (req) => {
      const shot = /screenshot (s\d+)/.exec(scriptOf(req))?.[1] ?? 's1';
      const item = {
        id: 'item_0001',
        title: "Move 'Get started' into the header",
        category: 'layout',
        intent: 'The primary CTA should sit in the site header instead of the hero card.',
        locations: [
          {
            role: 'subject',
            selector: 'button.cta',
            element: "button 'Get started'",
            url: '/pricing.html',
            screenshot: shot,
            annotation: 1,
          },
        ],
        evidence: { video: { start: 1, end: 2.5 }, screenshots: [shot] },
        transcript: 'this button should go in the header',
        confidence: 0.85,
        agent_prompt: `On /pricing.html move button.cta into the header. See screenshots/${shot}.png.`,
        pinned: false,
      };
      return messageReply(req.body.model, JSON.stringify({ items: [item] }));
    },
  });
  try {
    // Record with video, draw around the CTA, Stop, Process.
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
    await serviceWorker.evaluate(async (base) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        anthropicKey: 'sk-ant-e2e-restore-key',
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
      });
    }, stub.baseURL);
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await expect(panel.getByTestId('video-status')).toHaveAttribute('data-state', 'recording');
    await panel.getByTestId('draw-toggle').click();
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
    await panel.waitForTimeout(2500);
    const firstReview = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await firstReview;
    await expect(review.getByTestId('evidence-video')).toBeVisible({ timeout: 20_000 });
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
    const sessionId = new URL(review.url()).searchParams.get('session')!;
    const before = await reviewView(review);
    expect(before.annotationShots).toBe(1);
    expect(before.evidenceLoaded).toBe(1);
    expect(before.video).toBeGreaterThan(0);
    const zip = await exportZip(review, serviceWorker);
    await review.close();

    // Delete it from the Sessions page, then restore the zip there.
    const list = await openExtensionPage('sessions.html');
    const row = list.locator(`[data-session="${sessionId}"]`);
    await row.getByTestId('delete-session').click();
    await row.getByTestId('confirm-delete').click();
    await expect(list.getByTestId('session-row')).toHaveCount(0);
    await list.getByTestId('restore-input').setInputFiles(zip);
    await expect(list.getByTestId('restore-done')).toContainText('Restored Pricing Fixture.');
    await expect(list.getByTestId('restore-done')).toHaveAttribute('data-session', sessionId);
    await expect(list.getByTestId('session-row')).toHaveCount(1);
    await expect(row.getByTestId('session-items')).toHaveText('1 Change Item');
    const restored = await openReviewFrom(list, list.getByTestId('restore-open-review'));
    expect(await reviewView(restored)).toEqual(before);

    // Edit the restored item, then restore the zip again: the clash dialog opens the existing copy…
    const item = restored.getByTestId('change-item').first();
    await item.getByTestId('edit-item').click();
    await item.getByTestId('edit-title').fill('An edit the Replace throws away');
    await item.getByTestId('save-item').click();
    await expect(restored.getByTestId('item-title')).toHaveText('An edit the Replace throws away');
    await list.getByTestId('restore-input').setInputFiles(zip);
    await expect(list.getByTestId('restore-clash')).toContainText('already stored');
    const existing = await openReviewFrom(list, list.getByTestId('clash-open-existing'));
    await expect(existing).toHaveURL(new RegExp(`session=${sessionId}`));
    await expect(existing.getByTestId('item-title')).toHaveText('An edit the Replace throws away');
    await expect(list.getByTestId('restore-clash')).toHaveCount(0);
    await existing.close();

    // …or replaces it with the file.
    await list.getByTestId('restore-input').setInputFiles(zip);
    await list.getByTestId('clash-replace').click();
    await expect(list.getByTestId('restore-done')).toContainText('Restored Pricing Fixture.');
    await expect(list.getByTestId('session-row')).toHaveCount(1);
    await expect(restored.getByTestId('item-title')).toHaveText(before.titles[0]!);
    await restored.close();

    // A bare session.json, restored from the side panel: items and transcript, no screenshots or media.
    const dir = mkdtempSync(join(tmpdir(), 'var-restore-'));
    execFileSync('unzip', ['-q', zip, 'session.json', '-d', dir]);
    const json = readFileSync(join(dir, 'session.json'), 'utf8');
    expect(json).not.toContain('sk-ant-');
    await row.getByTestId('delete-session').click();
    await row.getByTestId('confirm-delete').click();
    await expect(list.getByTestId('session-row')).toHaveCount(0);
    await panel.reload();
    await panel.getByTestId('restore-input').setInputFiles(join(dir, 'session.json'));
    await expect(panel.getByTestId('restore-done')).toContainText('without screenshots or media');
    await expect(panel.getByTestId('previous-sessions').getByTestId('session-row')).toHaveCount(1);
    const bare = await openReviewFrom(panel, panel.getByTestId('restore-open-review'));
    await expect(bare.getByTestId('no-recording')).toBeVisible();
    const view = await reviewView(bare);
    expect(view).toEqual({ ...before, annotationShots: 0, evidenceShots: [], evidenceLoaded: 0, video: null });
    // The keys stay where they were: a restore writes no settings.
    expect(
      await serviceWorker.evaluate(async () => (await chrome.storage.local.get('anthropicKey')).anthropicKey),
    ).toBe('sk-ant-e2e-restore-key');
  } finally {
    await stub.close();
  }
});

test('garbage, newer and unreadable old files are refused with a clear message and nothing is stored', async ({
  openExtensionPage,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'var-restore-bad-'));
  const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/sessions/a-move-here.word.json'), 'utf8'));
  const write = (name: string, body: string | Buffer) => {
    writeFileSync(join(dir, name), body);
    return join(dir, name);
  };
  const panel = await openExtensionPage('sidepanel.html');
  const input = panel.getByTestId('restore-input');
  const error = panel.getByTestId('restore-error');

  await input.setInputFiles(write('garbage.zip', Buffer.from('PK\x03\x04 this is not really a zip')));
  await expect(error).toContainText('This zip cannot be read');
  await input.setInputFiles(write('notes.json', 'just some text'));
  await expect(error).toContainText('neither an export zip nor a session.json');
  await input.setInputFiles(write('newer.json', JSON.stringify({ ...fixture, schema_version: SCHEMA_VERSION + 1 })));
  await expect(error).toContainText('newer version of the extension');
  const drafts = {
    ...fixture,
    schema_version: 4,
    events: [
      ...fixture.events,
      {
        id: 'd1',
        type: 'draft_item',
        t: 99_999,
        draft_id: 'd1',
        title: 'x',
        category: 'copy',
        location_names: [],
        annotation_ids: [],
      },
    ],
  };
  await input.setInputFiles(write('v4-drafts.json', JSON.stringify(drafts)));
  await expect(error).toContainText('schema version 4 and has Draft Items');
  await expect(panel.getByTestId('previous-sessions').getByTestId('no-sessions')).toBeVisible();

  // The same fixture at the current version restores.
  await input.setInputFiles(write('ok.json', JSON.stringify(fixture)));
  await expect(panel.getByTestId('restore-done')).toContainText('Restored Pricing Fixture');
  await expect(panel.getByTestId('previous-sessions').getByTestId('session-row')).toHaveCount(1);
});
