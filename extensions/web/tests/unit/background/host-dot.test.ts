import { describe, expect, it } from 'vitest';
import { HOST_DOT_COLORS, hostDot } from '@/background/host-dot';

describe('the toolbar icon dot', () => {
  it('is green with a connected Host', () => {
    expect(hostDot({ state: 'connected', host_version: '0.1.0', capabilities: [] }).color).toBe(
      HOST_DOT_COLORS.connected,
    );
  });

  it('is blue when no Host is paired: the extension works on its own', () => {
    expect(hostDot({ state: 'unpaired' })).toEqual({
      color: HOST_DOT_COLORS.local,
      title: 'InkUp: local only (no Host paired)',
    });
  });

  it('is amber while a paired Host is being reached or is away', () => {
    expect(hostDot({ state: 'connecting' }).color).toBe(HOST_DOT_COLORS.offline);
    expect(hostDot({ state: 'pairing' }).color).toBe(HOST_DOT_COLORS.offline);
    expect(hostDot({ state: 'offline', error: 'refused', retry: true }).color).toBe(HOST_DOT_COLORS.offline);
  });

  it('uses three distinct colours', () => {
    expect(new Set(Object.values(HOST_DOT_COLORS)).size).toBe(3);
  });
});
