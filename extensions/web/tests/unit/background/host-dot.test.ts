import { describe, expect, it } from 'vitest';
import { dotGeometry, HOST_DOT_COLORS, hostDot } from '@/background/host-dot';

describe('the toolbar icon dot', () => {
  it('is green with a connected Host', () => {
    expect(hostDot({ state: 'connected', host_version: '0.1.0', capabilities: [] })).toMatchObject({
      state: 'connected',
      color: HOST_DOT_COLORS.connected,
    });
  });

  it('is blue when no Host is paired: the extension works on its own', () => {
    expect(hostDot({ state: 'unpaired' })).toEqual({
      state: 'local',
      color: HOST_DOT_COLORS.local,
      title: 'InkUp: local only (no Host paired)',
    });
  });

  it('is amber while a paired Host is being reached or is away', () => {
    for (const status of [
      { state: 'connecting' },
      { state: 'pairing' },
      { state: 'offline', error: 'refused', retry: true },
    ] as const) {
      expect(hostDot(status)).toMatchObject({ state: 'offline', color: HOST_DOT_COLORS.offline });
    }
  });

  it('uses three distinct colours', () => {
    expect(new Set(Object.values(HOST_DOT_COLORS)).size).toBe(3);
  });

  it('is a small circle in the bottom-right corner, ring included, inside the icon', () => {
    for (const size of [16, 32]) {
      const { cx, cy, r, ring } = dotGeometry(size);
      expect(cx + r + ring).toBeLessThanOrEqual(size);
      expect(cy + r + ring).toBeLessThanOrEqual(size);
      expect(cx).toBeGreaterThan(size / 2);
      expect(cy).toBeGreaterThan(size / 2);
      // Covers well under a quarter of the icon, unlike the badge it replaces.
      expect((Math.PI * (r + ring) ** 2) / size ** 2).toBeLessThan(0.25);
    }
  });
});
