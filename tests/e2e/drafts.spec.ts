// Slice 5 proof (docs/PLAN.md): live Draft Items through the real service worker, offscreen VAD and Anthropic
// adapter, pointed at the local Anthropic stub. The fake mic plays fixtures/audio/drafts-session.wav and the
// scripted transcript replays its clips the way Web Speech would (as in voice-commands.spec.ts):
//
//   [2.0]  "this button should go in the header"   (the CTA is circled meanwhile) → draft pass → card d1
//   [14.6] "pin that"                               between silences → d1 pinned by voice
//   [18.1] "make this card taller"                  (the Pro card is circled meanwhile) → card d2, discarded by click
//
// Then Stop and Process. The stub's Process answer leaves the pinned draft out on purpose and rewrites it
// instead; the pinned item must still be in the Change Items with pinned: true, and the Process request must
// carry the pinned draft and the rejected one. A second test runs without a key: Annotation cards instead.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import {
  type AnthropicStub,
  isDraftRequest,
  messageReply,
  type StubRequest,
  scriptOf,
  startAnthropicStub,
} from '../support/anthropic-stub';
import { AUDIO_DIR, expect, grantMic, test, useScript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'drafts-session.wav' });

const DRAFT_MODEL = 'claude-haiku-4-5-20251001';
const PROCESS_MODEL = 'claude-sonnet-5';
const PINNED_TITLE = "Move 'Get started' into the header";
const REJECTED_TITLE = 'Make the Pro card taller';

const ARRIVAL_MS = 600;
const clips = JSON.parse(readFileSync(join(AUDIO_DIR, 'drafts-session.timing.json'), 'utf8')) as {
  start: number;
  end: number;
  text: string;
}[];
const script = {
  timestamp_quality: 'approximate' as const,
  cues: clips.map((c) => ({
    at_ms: Math.round(c.end * 1000) + ARRIVAL_MS,
    duration_ms: Math.round((c.end - c.start) * 1000) + ARRIVAL_MS - 300,
    text: c.text,
  })),
};

/** The Draft model answers from the NEW EVENTS it was sent: a draft per Annotation it recognizes. */
function draftReply(req: StubRequest) {
  const fresh = scriptOf(req).split('NEW EVENTS:')[1] ?? '';
  const items = [];
  if (/ANNOTATION #1 /.test(fresh)) {
    items.push({
      title: PINNED_TITLE,
      category: 'layout',
      intent: 'The primary CTA should sit in the site header.',
      transcript: 'this button should go in the header',
      locations: [
        { role: 'subject', element: "button 'Get started'", selector: 'button.cta', annotation: 1 },
        { role: 'destination', element: 'site header', selector: 'header.site-header', annotation: null },
      ],
    });
  }
  if (/ANNOTATION #2 /.test(fresh)) {
    items.push({
      title: REJECTED_TITLE,
      category: 'layout',
      intent: 'The Pro plan card should be taller.',
      transcript: 'make this card taller',
      locations: [{ role: 'subject', element: 'Pro plan card', selector: '#plan-pro', annotation: 2 }],
    });
  }
  return messageReply(DRAFT_MODEL, JSON.stringify({ items }), { input_tokens: 700, output_tokens: 90 });
}

/** Process leaves the pinned draft out: it rewrites it (same Annotation, unpinned) and adds a page-level item. */
function processReply(req: StubRequest) {
  const text = scriptOf(req);
  const shot = /ANNOTATION #1 .*screenshot (s\d+)/.exec(text)?.[1] ?? 's1';
  const rewrite = {
    id: 'item_0001',
    title: 'Restyle the CTA',
    category: 'style',
    intent: 'A model rewrite of the pinned draft.',
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
    evidence: { video: { start: 2, end: 4 }, screenshots: [shot] },
    transcript: 'this button should go in the header',
    confidence: 0.9,
    agent_prompt: `Restyle button.cta. See screenshots/${shot}.png.`,
    pinned: false,
  };
  const pageItem = {
    id: 'item_0002',
    title: 'Check the page header spacing',
    category: 'question',
    intent: 'The reviewer talked about the header.',
    locations: [
      { role: 'subject', selector: null, element: 'page', url: '/pricing.html', screenshot: null, annotation: null },
    ],
    evidence: { video: null, screenshots: [] },
    transcript: 'in the header',
    confidence: 0.8,
    agent_prompt: 'Check the spacing of the header on /pricing.html.',
    pinned: false,
  };
  return messageReply(PROCESS_MODEL, JSON.stringify({ items: [rewrite, pageItem] }));
}

async function setStorage(sw: Worker, values: Record<string, unknown>) {
  await sw.evaluate(async (v) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({
      ...v,
      devOverrides: { ...(devOverrides ?? {}), ...((v.devOverrides as object) ?? {}) },
    });
  }, values);
}

async function downloadDoc(review: Page, sw: Worker): Promise<unknown> {
  await review.getByTestId('download-session').click();
  const id = Number(
    await review.evaluate(async () => {
      for (let i = 0; i < 50 && !document.body.dataset.downloadId; i++) await new Promise((r) => setTimeout(r, 100));
      return document.body.dataset.downloadId;
    }),
  );
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  const file = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('Draft Items: a card after an Annotation and silence, pinned by voice, another discarded by click; Process keeps the pin', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const stub: AnthropicStub = await startAnthropicStub({
    onMessage: (req) => (isDraftRequest(req) ? draftReply(req) : processReply(req)),
  });
  try {
    await useScript(serviceWorker, script);
    await setStorage(serviceWorker, {
      anthropicKey: 'sk-ant-e2e-stub-key',
      devOverrides: { anthropicBaseUrl: stub.baseURL },
    });
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.setViewportSize({ width: 1280, height: 720 });
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionPage('sidepanel.html');

    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    const sessionId = (await activeSessionId(serviceWorker))!;
    await expect(panel.getByTestId('draft-list')).toBeVisible();
    await expect(panel.getByTestId('annotation-list')).toHaveCount(0);

    // Circle the CTA while "this button should go in the header" plays.
    await panel.getByTestId('draw-toggle').click();
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });

    // About 3 s after the Annotation closed and the speech stopped, the first Draft Item card appears.
    const cards = panel.getByTestId('draft-card');
    const d1 = panel.locator('[data-testid="draft-card"][data-draft-id="d1"]');
    await expect(d1).toBeVisible({ timeout: 15_000 });
    await expect(d1.getByTestId('draft-title')).toHaveText(PINNED_TITLE);
    await expect(d1.getByTestId('draft-category')).toHaveText('layout');
    await expect(d1.getByTestId('draft-location').nth(0)).toHaveText("Subject: button 'Get started' (#1)");
    await expect(d1.getByTestId('draft-location').nth(1)).toHaveText('Destination: site header');
    const firstPass = stub.messages().filter(isDraftRequest);
    expect(firstPass).toHaveLength(1);
    const [annotation] = ofType(await sessionEvents(panel, sessionId), 'annotation');
    const [draft1] = ofType(await sessionEvents(panel, sessionId), 'draft_item');
    expect(draft1!.t).toBeGreaterThan(annotation!.t_end);
    expect(draft1!.t - annotation!.t_end).toBeGreaterThanOrEqual(2900);

    // "pin that", spoken between silences, pins it.
    await expect(panel.getByTestId('voice-commands')).toContainText('say "scratch that"', { timeout: 15_000 });
    await expect(d1).toHaveAttribute('data-state', 'pinned', { timeout: 20_000 });
    await expect(d1.getByTestId('draft-state')).toHaveText('Pinned by voice');

    // Circle the Pro card while "make this card taller" plays; its card appears and is discarded by click.
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('#plan-pro').boundingBox())!);
    const d2 = panel.locator('[data-testid="draft-card"][data-draft-id="d2"]');
    await expect(d2).toBeVisible({ timeout: 20_000 });
    await expect(cards.first()).toHaveAttribute('data-draft-id', 'd2'); // newest first
    await d2.getByTestId('draft-discard').click();
    await expect(d2).toHaveAttribute('data-state', 'discarded');
    await expect(d1).toHaveAttribute('data-state', 'pinned');

    // Each pass sent only what was new, as text, to the Draft model, with the recent drafts for continuity.
    const passes = stub.messages().filter(isDraftRequest);
    expect(passes.length).toBeGreaterThanOrEqual(2);
    const second = scriptOf(passes[1]!);
    expect(second).toContain('ANNOTATION #2 ');
    expect(second).not.toContain('ANNOTATION #1 ');
    expect(second).toMatch(/- d1 "Move 'Get started' into the header" \(layout\) .* PINNED by the reviewer/);
    for (const p of passes) {
      expect(p.body.model).toBe(DRAFT_MODEL);
      expect(typeof p.body.messages[0].content).toBe('string');
    }

    const events = await sessionEvents(panel, sessionId);
    expect(ofType(events, 'draft_action').map((a) => [a.draft_id, a.action, a.source])).toEqual([
      ['d1', 'pin', 'voice'],
      ['d2', 'discard', 'click'],
    ]);
    expect(ofType(events, 'voice_command').find((c) => c.command === 'pin_that')?.target).toEqual({
      kind: 'draft_item',
      id: 'd1',
    });
    await test.info().attach('events.json', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });

    // Stop → review page: Draft Items listed with their state, next to the Annotations.
    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    await expect(review.getByTestId('review-draft')).toHaveCount(2);
    await expect(review.locator('[data-testid="review-draft"][data-draft-id="d1"]')).toHaveAttribute(
      'data-state',
      'pinned',
    );
    await expect(review.locator('[data-testid="review-draft"][data-draft-id="d2"]')).toHaveAttribute(
      'data-state',
      'discarded',
    );
    await expect(review.locator('[data-testid="review-draft"][data-draft-id="d2"]')).toHaveClass(/opacity-50/);

    // Process: the model left the pinned draft out and rewrote it; the pin is still there, unchanged.
    const before = stub.messages().length;
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    const items = review.getByTestId('change-item');
    await expect(items).toHaveCount(2, { timeout: 20_000 });
    const pinned = review.locator('[data-testid="change-item"][data-pinned="true"]');
    await expect(pinned).toHaveCount(1);
    await expect(pinned.getByTestId('item-title')).toHaveText(PINNED_TITLE);
    await expect(pinned.getByTestId('item-pinned')).toBeVisible();
    await expect(review.getByTestId('change-items')).not.toContainText('Restyle the CTA');

    const processReq = stub
      .messages()
      .slice(before)
      .find((r) => !isDraftRequest(r))!;
    const sent = scriptOf(processReq);
    expect(sent).toMatch(/PINNED DRAFT ITEMS \(fixed: [^\n]*\n- d1 "Move 'Get started' into the header" \(layout\)/);
    expect(sent).toContain(`the reviewer rejected: d2 "${REJECTED_TITLE}" (layout)`);
    expect(sent).toMatch(/DRAFT d1 → PINNED by user/);
    expect(sent).toMatch(/DRAFT d2 → DISCARDED by user/);

    const doc = SessionDocumentSchema.parse(await downloadDoc(review, serviceWorker));
    const pinnedItem = doc.change_items!.find((i) => i.pinned)!;
    expect(pinnedItem).toMatchObject({ title: PINNED_TITLE, category: 'layout', pinned: true });
    expect(pinnedItem.locations[0]).toMatchObject({ role: 'subject', selector: 'button.cta', annotation: 1 });
    expect(pinnedItem.evidence.screenshots).toEqual([annotation!.screenshot_id]);
    expect(doc.change_items!.map((i) => i.title).sort()).toEqual(
      ['Check the page header spacing', PINNED_TITLE].sort(),
    );
  } finally {
    await stub.close();
  }
});

test('no Anthropic key: the panel shows Annotation cards with a thumbnail, the pick and the paired speech', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(60_000);
  await useScript(serviceWorker, script);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.setViewportSize({ width: 1280, height: 720 });
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');

  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await expect(panel.getByTestId('annotation-list')).toBeVisible();
  await expect(panel.getByTestId('draft-list')).toHaveCount(0);

  await panel.getByTestId('draw-toggle').click();
  await pricing.bringToFront();
  await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
  const card = panel.getByTestId('annotation-card');
  await expect(card).toHaveCount(1, { timeout: 10_000 });
  await expect(card.getByTestId('annotation-pick')).toHaveText('“Get started” button.cta');
  await expect(card.getByTestId('annotation-thumb')).toBeVisible();
  expect(
    await card.getByTestId('annotation-thumb').evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
  // The whole screenshot shows, letterboxed, instead of a crop of its top.
  expect(await card.getByTestId('annotation-thumb').evaluate((img) => getComputedStyle(img).objectFit)).toBe('contain');
  await expect(card.getByTestId('annotation-speech')).toHaveText('“this button should go in the header”', {
    timeout: 10_000,
  });
  await expect(card).toHaveAttribute('data-discarded', 'false');
  // No key: no Draft Item pass, so nothing but the Annotation reached the log.
  const events = await sessionEvents(panel, (await activeSessionId(serviceWorker))!);
  expect(ofType(events, 'draft_item')).toHaveLength(0);
  await panel.getByTestId('stop').click();
});
