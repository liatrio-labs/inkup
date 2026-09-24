import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  groupByOrigin,
  originLabel,
  originOf,
  softCapMessage,
  softCapsReached,
  storageLevel,
} from '../src/session-list';

const s = (id: string, start_url: string, started_at: string) => ({ id, start_url, started_at });

describe('Session list rules', () => {
  it('groups by starting origin, newest first, groups by their newest Session', () => {
    const groups = groupByOrigin([
      s('a', 'http://localhost:4401/pricing.html', '2026-09-20T10:00:00.000Z'),
      s('b', 'http://127.0.0.1:4402/second/checkout.html', '2026-09-21T10:00:00.000Z'),
      s('c', 'http://localhost:4401/docs.html', '2026-09-22T10:00:00.000Z'),
      s('d', '', '2026-09-19T10:00:00.000Z'),
    ]);
    expect(groups.map((g) => [g.origin, g.sessions.map((x) => x.id)])).toEqual([
      ['http://localhost:4401', ['c', 'a']],
      ['http://127.0.0.1:4402', ['b']],
      ['unknown page', ['d']],
    ]);
  });

  it('names file: and other opaque origins by what they are', () => {
    expect(originOf('file:///Users/x/page.html')).toBe('file:///Users/x/page.html');
    expect(originOf('https://example.com/a?b')).toBe('https://example.com');
  });

  it('warns at 80% of the quota, never with an unknown quota', () => {
    expect(storageLevel(79, 100).warn).toBe(false);
    expect(storageLevel(80, 100)).toEqual({ usage: 80, quota: 100, ratio: 0.8, warn: true });
    expect(storageLevel(5, 0).warn).toBe(false);
    expect(storageLevel(undefined, undefined).ratio).toBe(0);
  });

  it('formats sizes in decimal units', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(41_012)).toBe('41.0 KB');
    expect(formatBytes(270_000_000)).toBe('270 MB');
    expect(formatBytes(3_400_000_000)).toBe('3.4 GB');
  });

  it('reaches the soft caps at 45 and 60 minutes', () => {
    expect(softCapsReached(44 * 60_000 + 59_999)).toEqual([]);
    expect(softCapsReached(45 * 60_000)).toEqual([45]);
    expect(softCapsReached(75 * 60_000)).toEqual([45, 60]);
    expect(softCapMessage(45)).toContain('Recording continues');
  });

  it('labels our own origin "This extension", another extension by name when known, else its raw origin (U5)', () => {
    const own = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const other = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
    expect(originLabel(own, own)).toBe('This extension');
    expect(originLabel(other, own)).toBe(other);
    expect(originLabel(other, own, new Map([['ponmlkjihgfedcbaponmlkjihgfedcba', 'Password Keeper']]))).toBe(
      'Password Keeper (extension)',
    );
    expect(originLabel('https://example.com', own)).toBe('https://example.com');
    expect(originLabel(originOf(`${own}/sessions.html`), own)).toBe('This extension');
  });
});
