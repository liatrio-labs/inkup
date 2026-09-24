// F1 in Firefox (#16, #21): the toolbar's Start frame starts the Session on its first click, every time, and the page
// has the Session by the time the toolbar says Recording: Alt+Shift+O, pressed at that moment, turns Object Select on
// within the bound. The frame's button is disabled until its script listens, and the toolbar marks the frame ready.
import { armStartProbe, MODES_WITHIN_MS, startProbe } from '../e2e/helpers/start-probe';
import { expect, test } from './fixtures';

const STARTS = 20;

test(`Firefox: the Start frame's first click starts the Session ${STARTS} times in a row, and modes answer within ${MODES_WITHIN_MS} ms of Recording`, async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(STARTS * 20_000);
  const onboarding = await extPage('/onboarding.html');
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });

  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const toolbar = pricing.getByTestId('toolbar');
  const frame = pricing.getByTestId('toolbar-start-frame');
  const active = () =>
    onboarding.evaluate(
      async () =>
        ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | null)?.id ?? null,
    );

  const selectMode = () =>
    onboarding.evaluate(
      async () =>
        ((await chrome.storage.session.get('activeSession')).activeSession as { select_mode?: string | null } | null)
          ?.select_mode ?? null,
    );
  const gaps: number[] = [];
  for (let i = 0; i < STARTS; i++) {
    await expect(toolbar).toHaveAttribute('data-state', 'idle');
    await expect(frame).toHaveAttribute('data-ready', 'true');
    await expect(frame).toBeVisible();
    await armStartProbe(pricing);
    const box = (await frame.boundingBox())!;
    // One click, no retry.
    await pricing.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(toolbar, `start ${i + 1}: the first click starts`).toHaveAttribute('data-state', 'recording', {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await startProbe(pricing)).pressedAt, {
        message: `start ${i + 1}: Object Select answers`,
        timeout: 5_000,
      })
      .not.toBe(null);
    const probe = await startProbe(pricing);
    gaps.push(Math.round(probe.pressedAt! - probe.recordingAt!));
    expect(gaps.at(-1)!, `start ${i + 1}: states ${probe.states.join(' → ')}`).toBeLessThan(MODES_WITHIN_MS);
    // The background took the request too: the page showed it at once, and the Session holds it.
    await expect.poll(selectMode).toBe('object');
    await pricing.keyboard.press('Escape');
    await expect.poll(selectMode).toBe(null);
    await pricing.getByTestId('toolbar-stop').click();
    await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await expect.poll(active, { timeout: 30_000 }).toBe(null);
    // The review page each Stop opens.
    await onboarding.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('/review.html*') });
      await chrome.tabs.remove(tabs.map((t) => t.id!));
    });
  }
  console.log(`Recording → Object Select on, ms: ${gaps.join(', ')}`);
});
