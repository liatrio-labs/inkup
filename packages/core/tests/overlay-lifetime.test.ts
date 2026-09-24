import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expired, withTimeout } from '../src/overlay-lifetime.ts';

describe('overlay lifetime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an element expires only once its last activity is more than the cap ago', () => {
    expect(expired(1_000, 31_000, 30_000)).toBe(false);
    expect(expired(1_000, 31_001, 30_000)).toBe(true);
    // Activity (a keystroke, a pointer move) moves the start of the cap.
    expect(expired(20_000, 31_001, 30_000)).toBe(false);
  });

  it('withTimeout gives the fallback when the promise never settles', async () => {
    const hung = withTimeout(new Promise<string>(() => {}), 5_000, 'fallback');
    let got: string | undefined;
    void hung.then((v) => (got = v));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(got).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toBe('fallback');
  });

  it('withTimeout passes a value through, and turns a rejection into the fallback', async () => {
    await expect(withTimeout(Promise.resolve('shot'), 5_000, null)).resolves.toBe('shot');
    await expect(withTimeout(Promise.reject(new Error('gone')), 5_000, null)).resolves.toBeNull();
  });
});
