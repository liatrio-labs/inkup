import { describe, expect, it } from 'vitest';
import { createSessionClock, formatElapsed, toOffset } from '../src/clock';

describe('Session clock', () => {
  it('stamps offsets from t0 in whole ms', () => {
    let now = 1_000_000;
    const clock = createSessionClock(1_000_000, () => now);
    expect(clock.offset()).toBe(0);
    now += 1234.6;
    expect(clock.offset()).toBe(1235);
    expect(clock.offset(1_000_500)).toBe(500);
  });

  it('clamps times before t0 to 0 (another context read the clock a hair early)', () => {
    expect(toOffset(5000, 4999)).toBe(0);
  });

  it('rejects an invalid t0', () => {
    expect(() => createSessionClock(Number.NaN)).toThrow(RangeError);
    expect(() => createSessionClock(-1)).toThrow(RangeError);
  });

  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [1000, '00:01'],
    [59_999, '00:59'],
    [60_000, '01:00'],
    [75 * 60_000 + 3000, '75:03'],
    [-500, '00:00'],
  ])('formats %d ms as %s', (ms, s) => {
    expect(formatElapsed(ms)).toBe(s);
  });
});
