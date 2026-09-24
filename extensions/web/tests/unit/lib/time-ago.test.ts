import { describe, expect, it } from 'vitest';
import { timeAgo } from '@/lib/time-ago';

describe('timeAgo', () => {
  it('says just now, then minutes, hours and days', () => {
    const now = 1_790_000_000_000;
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now + 5_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3 d ago');
  });
});
