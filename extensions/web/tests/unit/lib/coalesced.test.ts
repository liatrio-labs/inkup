// coalesced (src/lib/coalesced.ts), which the toolbar's pushes go through: a push that read the state before a change
// must not land after the push that carries it. In Firefox e2e, a push read the Session just before Object Select went
// on, took longer (its viewport check) than the next push, landed last, and the button stayed off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesced } from '@/lib/coalesced';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A push that reads `state()` at once and delivers what it read after `slowMs` (a slow viewport check). */
function pusher(state: () => string, delays: number[]) {
  const delivered: string[] = [];
  let running = 0;
  let overlapped = false;
  const push = async () => {
    running++;
    if (running > 1) overlapped = true;
    const read = state();
    await new Promise((r) => setTimeout(r, delays.shift() ?? 0));
    delivered.push(read);
    running--;
  };
  return { push, delivered, overlapped: () => overlapped };
}

describe('coalesced', () => {
  it('runs once for a burst of calls', async () => {
    const task = vi.fn(async () => {});
    const call = coalesced(task, 30);
    call();
    call();
    call();
    await vi.advanceTimersByTimeAsync(30);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('never runs twice at once, and the last run reads the state after the last change', async () => {
    let mode = 'draw';
    // The first push is slow (200 ms), the second quick: run side by side, the first would deliver last.
    const p = pusher(() => mode, [200, 5]);
    const push = coalesced(p.push, 30);
    push(); // an Annotation's toast
    await vi.advanceTimersByTimeAsync(40);
    mode = 'object-select';
    push(); // Object Select turned on while the first push is still out
    await vi.advanceTimersByTimeAsync(500);
    expect(p.overlapped()).toBe(false);
    expect(p.delivered).toEqual(['draw', 'object-select']);
  });

  it('keeps going after a run that fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const call = coalesced(async () => {
      n++;
      if (n === 1) throw new Error('no tab');
    }, 30);
    call();
    await vi.advanceTimersByTimeAsync(30);
    call();
    await vi.advanceTimersByTimeAsync(30);
    expect(n).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
