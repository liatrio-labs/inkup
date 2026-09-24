// E10 in Firefox: Cancel and Mute from the page's toolbar (no host here; the host path is Chrome's cancel-mute.spec).
// Cancel after a drawn Annotation and a typed Object Select pick: the toolbar goes idle with "Session discarded · Undo";
// Undo keeps the Session as stopped with both Annotations, and a lapsed window leaves no row, event or blob behind.
// Mute: Firefox's fake microphone is a tone, not speech, so the scripted transcript stands in for the engine and the
// Voice Command part is proven in Chrome only. No segment reaches into the muted span; both events are logged.
import type { Page } from '@playwright/test';
import { circle } from '../e2e/helpers/draw';
import { type ExtPage, expect, test } from './fixtures';

type Row = { type: string; t: number; seq: number; t_end: number; [k: string]: unknown };

function rows(page: ExtPage, store: string, sessionId: string): Promise<Row[]> {
  return page.evaluate(
    async ({ store, id }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return new Promise<Row[]>((res, rej) => {
        const r =
          store === 'sessions'
            ? idb.transaction(store).objectStore(store).getAll()
            : idb.transaction(store).objectStore(store).index('session_id').getAll(id);
        r.onsuccess = () =>
          res(
            (r.result as Row[])
              .filter((x) => (store === 'sessions' ? x.id === id : true))
              .sort((a, b) => a.t - b.t || a.seq - b.seq),
          );
        r.onerror = () => rej(r.error);
      });
    },
    { store, id: sessionId },
  );
}

/** Setup with a scripted transcript, then Start from the toolbar frame on the pricing page. */
async function start(
  extPage: (part: string) => Promise<ExtPage>,
  page: Page,
  origin: string,
  script: unknown,
  overrides: Record<string, unknown> = {},
) {
  const onboarding = await extPage('/onboarding.html');
  await onboarding.evaluate((o) => chrome.storage.local.set({ devOverrides: { transcription: 'scripted', ...o } }), {
    script,
    ...overrides,
  });
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });
  await page.goto(`${origin}/pricing.html`);
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const toolbar = page.getByTestId('toolbar');
  const frame = page.getByTestId('toolbar-start-frame');
  await expect(frame).toBeVisible();
  await page.waitForTimeout(1000);
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toolbar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () => (await chrome.storage.session.get('activeSession')).activeSession as { id: string; t0: number },
  );
  return { onboarding, session };
}

async function drawAndPick(pricing: Page, onboarding: ExtPage, sessionId: string) {
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  await pricing.getByTestId('toolbar-draw').click();
  await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  await circle(pricing, cta);
  await pricing.getByTestId('toolbar-object-select').click();
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
  await pricing.mouse.move(cta.x + 10, cta.y + 10);
  await pricing.mouse.click(cta.x + cta.width / 2, cta.y + cta.height / 2);
  const input = pricing.getByTestId('object-select-input');
  await expect(input).toBeFocused({ timeout: 15_000 });
  await input.pressSequentially('Make this roomier');
  await input.press('Enter');
  await expect
    .poll(async () => (await rows(onboarding, 'events', sessionId)).filter((e) => e.type === 'annotation').length, {
      timeout: 15_000,
    })
    .toBe(2);
}

const SCRIPT = { timestamp_quality: 'approximate', cues: [{ at_ms: 1500, duration_ms: 800, text: 'this button' }] };

test('Firefox: Cancel, then Undo keeps the Session as stopped with its Annotations', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  const pricing = await context.newPage();
  const { onboarding, session } = await start(extPage, pricing, site.primaryOrigin, SCRIPT);
  await drawAndPick(pricing, onboarding, session.id);
  await pricing.getByTestId('toolbar-cancel').click();
  await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });
  await expect(pricing.getByTestId('toolbar-toast')).toHaveText('Session discarded · Undo');
  await pricing.getByTestId('toolbar-undo-discard').click();
  await expect(pricing.getByTestId('toolbar-toast')).toBeHidden();
  await extPage('/review.html');
  await expect
    .poll(async () => (await rows(onboarding, 'sessions', session.id))[0]?.status, { timeout: 30_000 })
    .toBe('ended');
  const events = await rows(onboarding, 'events', session.id);
  expect(events.filter((e) => e.type === 'annotation').map((a) => a.comment ?? null)).toEqual([
    null,
    'Make this roomier',
  ]);
  expect(events.at(-1)!.type).toBe('session_end');
  await pricing.waitForTimeout(11_000);
  expect(await rows(onboarding, 'sessions', session.id)).toHaveLength(1);
});

test('Firefox: Cancel and let the window lapse: nothing of the Session is left', async ({ context, extPage, site }) => {
  test.setTimeout(120_000);
  const pricing = await context.newPage();
  const { onboarding, session } = await start(extPage, pricing, site.primaryOrigin, SCRIPT, { discardUndoMs: 3000 });
  await drawAndPick(pricing, onboarding, session.id);
  await pricing.getByTestId('toolbar-cancel').click();
  await expect(pricing.getByTestId('toolbar-toast')).toHaveText('Session discarded · Undo');
  await expect(pricing.getByTestId('toolbar-toast')).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => (await rows(onboarding, 'sessions', session.id)).length, { timeout: 30_000 }).toBe(0);
  expect(await rows(onboarding, 'events', session.id)).toEqual([]);
  expect(await rows(onboarding, 'blobs', session.id)).toEqual([]);
  expect(
    await onboarding.evaluate(async () => (await chrome.storage.local.get('discardPending')).discardPending),
  ).toEqual([]);
});

test('Firefox: muted from the toolbar, nothing is transcribed until Alt+Shift+M turns it back on', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  // A cue every second; each spans the second before it.
  const script = {
    timestamp_quality: 'approximate',
    cues: Array.from({ length: 14 }, (_, i) => ({ at_ms: 1000 * (i + 1), duration_ms: 800, text: `cue ${i + 1}` })),
  };
  const pricing = await context.newPage();
  const { onboarding, session } = await start(extPage, pricing, site.primaryOrigin, script);
  const segments = async () =>
    (await rows(onboarding, 'events', session.id)).filter((e) => e.type === 'transcript_segment');
  await expect.poll(async () => (await segments()).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await pricing.getByTestId('toolbar-mute').click();
  await expect(pricing.getByTestId('toolbar-mute')).toHaveAttribute('aria-pressed', 'true');
  await pricing.waitForTimeout(3500);
  await pricing.keyboard.press('Alt+Shift+M');
  await expect(pricing.getByTestId('toolbar-mute')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await segments()).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await pricing.waitForTimeout(2500);
  const events = await rows(onboarding, 'events', session.id);
  const off = events.find((e) => e.type === 'mic_muted')!;
  const on = events.find((e) => e.type === 'mic_unmuted')!;
  expect([off.via, on.via]).toEqual(['button', 'shortcut']);
  expect(on.t - off.t).toBeGreaterThan(3000);
  const all = events.filter((e) => e.type === 'transcript_segment');
  expect(all.filter((s) => s.t < on.t && s.t_end > off.t)).toEqual([]);
  // Speech before and after the mute is there.
  expect(all.some((s) => s.t_end <= off.t)).toBe(true);
  expect(all.some((s) => s.t >= on.t)).toBe(true);
  await pricing.getByTestId('toolbar-stop').click();
  await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});
