// F1: times, in the page, how long after the toolbar says Recording the page's mode shortcuts answer.
import type { Page } from '@playwright/test';

/** The page has the Session by the time the toolbar says Recording: a mode shortcut answers within this. */
export const MODES_WITHIN_MS = 300;

/**
 * In the page: waits for the toolbar to say Recording, presses Alt+Shift+O at once and times how long Object Select
 * takes to come on. Measured in the page, so Playwright's own latency is not counted.
 */
export function armStartProbe(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __startProbe?: { recordingAt: number | null; pressedAt: number | null; states: string[] };
    };
    const probe = {
      recordingAt: null as number | null,
      pressedAt: null as number | null,
      states: [] as string[],
    };
    w.__startProbe = probe;
    const find = (): ShadowRoot | null => {
      for (const el of document.querySelectorAll('*'))
        if (el.shadowRoot?.querySelector('[data-testid="toolbar"]')) return el.shadowRoot;
      return null;
    };
    const root = find()!;
    const bar = root.querySelector<HTMLElement>('[data-testid="toolbar"]')!;
    const watch = new MutationObserver(() => {
      const state = bar.dataset.state ?? '';
      if (probe.states.at(-1) !== state) probe.states.push(state);
      if (probe.recordingAt === null && state === 'recording') {
        probe.recordingAt = performance.now();
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'KeyO',
            key: 'O',
            altKey: true,
            shiftKey: true,
            bubbles: true,
            composed: true,
          }),
        );
      }
      if (
        probe.recordingAt !== null &&
        probe.pressedAt === null &&
        root.querySelector('[data-testid="toolbar-object-select"]')?.getAttribute('aria-pressed') === 'true'
      ) {
        probe.pressedAt = performance.now();
        watch.disconnect();
      }
    });
    watch.observe(root, { subtree: true, childList: true, attributes: true });
  });
}

export const startProbe = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __startProbe: { recordingAt: number | null; pressedAt: number | null; states: string[] };
        }
      ).__startProbe,
  );
