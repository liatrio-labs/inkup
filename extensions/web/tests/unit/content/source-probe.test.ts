// E4: the probe round trip between the isolated overlay and the MAIN-world bridge, over the DOM (both worlds share
// it; here both run in one happy-dom window).
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_READY, PROBE_ATTR } from '@/bridge/protocol';

describe('probeSources', () => {
  // First: a bridge registered by a later test would answer before the spoof.
  it('drops malformed answers from a page that spoofs the result event', async () => {
    vi.resetModules();
    const { probeSources } = await import('@/content/source-probe');
    const { SOURCE_PROBE, SOURCE_RESULT } = await import('@/bridge/protocol');
    const spoof = (e: Event) => {
      const { id } = JSON.parse(String((e as CustomEvent).detail));
      document.dispatchEvent(
        new CustomEvent(SOURCE_RESULT, {
          detail: JSON.stringify({ id, results: [{ file: 42, line: -1, components: ['Ok', 7, 'x'.repeat(500)] }] }),
        }),
      );
    };
    document.addEventListener(SOURCE_PROBE, spoof);
    document.body.innerHTML = '<p></p>';
    expect(await probeSources([document.body.firstElementChild!], 5000)).toEqual([{ components: ['Ok'] }]);
    document.removeEventListener(SOURCE_PROBE, spoof);
  });

  it('without a bridge: waits out the timeout once, then answers at once until the bridge announces itself', async () => {
    vi.resetModules();
    const { probeSources } = await import('@/content/source-probe');
    document.body.innerHTML = '<div data-source-file="src/A.tsx"></div>';
    const el = document.body.firstElementChild!;
    const t0 = Date.now();
    expect(await probeSources([el], 50)).toEqual([null]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    const t1 = Date.now();
    expect(await probeSources([el], 5000)).toEqual([null]);
    expect(Date.now() - t1).toBeLessThan(100);

    // The bridge starts late: it announces itself and the next probe is answered.
    const { serveSourceProbes } = await import('@/bridge/serve');
    serveSourceProbes();
    document.dispatchEvent(new CustomEvent(BRIDGE_READY));
    expect(await probeSources([el], 5000)).toEqual([{ file: 'src/A.tsx', components: [] }]);
  });

  it('with the bridge: answered inside dispatchEvent, in order, and the tags are removed', async () => {
    vi.resetModules();
    const { serveSourceProbes } = await import('@/bridge/serve');
    const { probeSources } = await import('@/content/source-probe');
    serveSourceProbes();
    document.body.innerHTML =
      '<p data-source-file="src/P.tsx" data-line="3"></p><i></i><b data-nextjs-path="app/page.tsx"></b>';
    const els = [...document.body.children];
    let resolvedSync = false;
    const pending = probeSources(els, 5000).then((r) => {
      resolvedSync = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvedSync).toBe(true);
    expect(await pending).toEqual([
      { file: 'src/P.tsx', line: 3, components: [] },
      null,
      { file: 'app/page.tsx', components: [] },
    ]);
    expect(document.querySelectorAll(`[${PROBE_ATTR}]`)).toHaveLength(0);
  });
});
