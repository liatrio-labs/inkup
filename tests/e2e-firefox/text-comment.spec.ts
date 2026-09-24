// E3/E7 in Firefox: a Text Comment on the fixture heading. With Select Text off, selecting it does nothing special;
// Alt+Shift+T turns Select Text on, and selecting it with the mouse opens the comment box: type "This should say
// Pricing plans", Enter. The `text_comment` event holds the heading's selector and a text-quote anchor, its
// screenshot does not show the comment box, and Process (the Anthropic stub) makes a `copy` Change Item with no model call.
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { startAnthropicStub } from '../support/anthropic-stub';
import { type ExtPage, expect, test } from './fixtures';

function sessionEvents(page: ExtPage, sessionId: string): Promise<TimelineEvent[]> {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<TimelineEvent[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as TimelineEvent[]);
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
}

/** RGB of one pixel of a stored screenshot. */
function pixel(page: ExtPage, id: string, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ id, x, y }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const row = await new Promise<{ blob: Blob }>((res, rej) => {
        const r = idb.transaction('blobs').objectStore('blobs').get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const bmp = await createImageBitmap(row.blob);
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    { id, x, y },
  );
}

test('Firefox: comment on the selected heading; Process makes a copy item on its selector with no model call', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  test.setTimeout(120_000);
  const stub = await startAnthropicStub({
    onMessage: () => ({
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'stub: no call expected' } },
    }),
  });
  try {
    const onboarding = await extPage('/onboarding.html');
    await onboarding.evaluate(
      (base) =>
        chrome.storage.local.set({
          anthropicKey: 'sk-ant-e2e-firefox',
          devOverrides: {
            transcription: 'scripted',
            script: { timestamp_quality: 'approximate', cues: [] },
            anthropicBaseUrl: base,
          },
        }),
      stub.baseURL,
    );
    await onboarding.click('allow-mic');
    await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
      timeout: 20_000,
      what: 'the mic grant',
    });

    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionWindow('sidepanel.html');
    await panel.click('start');
    await panel.waitForText('status', /^Recording$/);
    const sessionId = await panel.waitFor(
      async () =>
        ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
      undefined,
      {
        what: 'an active Session',
      },
    );
    await pricing.bringToFront();

    const selectHeading = async () => {
      const ends = await pricing.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#hero-title')!);
        const rects = [...range.getClientRects()];
        const first = rects[0]!;
        const last = rects.at(-1)!;
        return {
          from: { x: first.left + 1, y: first.top + first.height / 2 },
          to: { x: last.right - 1, y: last.top + last.height / 2 },
        };
      });
      await pricing.mouse.move(ends.from.x, ends.from.y);
      await pricing.mouse.down();
      await pricing.mouse.move(ends.to.x, ends.to.y, { steps: 10 });
      await pricing.mouse.up();
    };
    // Select Text off: a selection is just a selection.
    await selectHeading();
    await pricing.waitForTimeout(500);
    await expect(pricing.getByTestId('text-comment-box')).toBeHidden();
    await pricing.evaluate(() => document.getSelection()?.removeAllRanges());
    // The page hears the shortcut once it has the Session (sent when the microphone has started): press until it takes.
    for (let i = 0; ; i++) {
      await pricing.keyboard.press('Alt+Shift+KeyT');
      try {
        await panel.waitFor(
          async () =>
            ((await chrome.storage.session.get('activeSession')).activeSession as { select_mode?: string } | undefined)
              ?.select_mode === 'text',
          undefined,
          { timeout: 2_000, what: 'Select Text on' },
        );
        break;
      } catch (err) {
        if (i >= 8) throw err;
      }
    }
    await selectHeading();
    await expect(pricing.getByTestId('text-comment-box')).toBeVisible({ timeout: 10_000 });
    const input = pricing.getByTestId('text-comment-input');
    await expect(input).toBeFocused();
    await input.pressSequentially('This should say Pricing plans');
    const box = (await pricing.getByTestId('text-comment-box').boundingBox())!;
    await input.press('Enter');
    await expect(pricing.getByTestId('text-comment-box')).toBeHidden();
    await panel.waitFor(
      async (id) => {
        const idb = await new Promise<IDBDatabase>((res) => {
          const r = indexedDB.open('inkup');
          r.onsuccess = () => res(r.result);
        });
        const rows = await new Promise<{ type: string }[]>((res) => {
          const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
          r.onsuccess = () => res(r.result as { type: string }[]);
        });
        return rows.some((e) => e.type === 'text_comment');
      },
      sessionId,
      { what: 'the text_comment' },
    );

    await panel.click('stop');
    const review = await extPage('/review.html', 20_000);
    // The page renders before it has read the key, with "Process without a model" under the same test id.
    await review.waitForText('process-button', /^Process$/);
    await review.click('process-button');
    await review.click('process-confirm');
    await review.waitFor(() => document.querySelectorAll('[data-testid="change-item"]').length === 1, undefined, {
      timeout: 20_000,
      what: 'one Change Item',
    });
    expect(await review.text('item-category')).toBe('copy');
    expect(await review.text('item-title')).toBe('Change "Ship reviews in minutes" to "Pricing plans"');
    expect(
      await review.evaluate(() => document.querySelector('[data-testid="item-location"]')?.textContent ?? ''),
    ).toContain('#hero-title');
    expect(stub.requests.filter((r) => r.path.startsWith('/v1/messages'))).toEqual([]);

    const events = await sessionEvents(review, sessionId);
    const comment = events.find(
      (e): e is Extract<TimelineEvent, { type: 'text_comment' }> => e.type === 'text_comment',
    )!;
    expect(comment).toMatchObject({
      selected_text: 'Ship reviews in minutes',
      anchor: { exact: 'Ship reviews in minutes' },
      element: { selector: '#hero-title', tag: 'h1' },
    });
    const shot = events.find(
      (e): e is Extract<TimelineEvent, { type: 'screenshot' }> =>
        e.type === 'screenshot' && e.screenshot_id === comment.screenshot_id,
    )!;
    expect(shot).toMatchObject({ trigger: 'text_comment' });
    // The comment box is not in its screenshot: most points across its place are not its dark background.
    let dark = 0;
    for (const fx of [0.2, 0.5, 0.8]) {
      for (const fy of [0.3, 0.7]) {
        const [r, g, b] = await pixel(
          review,
          shot.screenshot_id,
          (box.x + box.width * fx) * shot.dpr,
          (box.y + box.height * fy) * shot.dpr,
        );
        if (r < 60 && g < 60 && b < 60) dark++;
      }
    }
    expect(dark, 'dark points at the comment box place').toBeLessThan(3);
  } finally {
    await stub.close();
  }
});
