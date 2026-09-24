import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, normalizeAddress, parsePairLink, probeHosts, probeList } from '@/adapters/host';

describe('finding a Host on the LAN', () => {
  it('probes the .local names first, then saved addresses, once each', () => {
    expect(probeList(['192.168.7.149', 'http://inkup.local:47823/'])).toEqual([
      'http://inkup.local:47823',
      'http://inkup-2.local:47823',
      'http://inkup-3.local:47823',
      'http://inkup-4.local:47823',
      'http://inkup-5.local:47823',
      'http://192.168.7.149:47823',
    ]);
  });

  it('turns what the reviewer typed into an address', () => {
    expect(normalizeAddress('192.168.1.20')).toBe('http://192.168.1.20:47823');
    expect(normalizeAddress(' studio.local:5000/ ')).toBe('http://studio.local:5000');
    expect(normalizeAddress('http://127.0.0.1:47823')).toBe('http://127.0.0.1:47823');
    expect(normalizeAddress('http://10.0.0.2:80')).toBe('http://10.0.0.2:80');
    expect(normalizeAddress('ftp://x')).toBeNull();
    expect(normalizeAddress('')).toBeNull();
  });

  it('reads a pair link, and nothing else', () => {
    expect(parsePairLink('inkup://pair?url=http://inkup.local:47823&code=042917')).toEqual({
      url: 'http://inkup.local:47823',
      code: '042917',
    });
    expect(parsePairLink('inkup://pair?url=http%3A%2F%2F192.168.1.5%3A47823&code=123%20456')).toEqual({
      url: 'http://192.168.1.5:47823',
      code: '123456',
    });
    expect(parsePairLink('inkup://pair?url=http://x.local:1&code=12345')).toBeNull();
    expect(parsePairLink('http://inkup.local:47823')).toBeNull();
  });

  it('knows loopback from the network', () => {
    expect(isLoopbackUrl('http://127.0.0.1:47823')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1')).toBe(true);
    expect(isLoopbackUrl('http://inkup.local:47823')).toBe(false);
    expect(isLoopbackUrl('http://192.168.7.149:47823')).toBe(false);
  });

  it('lists the addresses that answer as a Host, and not the rest', async () => {
    const health = (name?: string) =>
      new Response(
        JSON.stringify({
          name: 'inkup',
          version: '0.1.0',
          protocol_version: 1,
          capabilities: [],
          ...(name ? { hub_name: name } : {}),
        }),
      );
    const fetch = async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith('http://live:1')) return health('inkup on studio');
      if (u.startsWith('http://plain:1')) return health();
      if (u.startsWith('http://other:1')) return new Response(JSON.stringify({ name: 'something else' }));
      if (u.startsWith('http://slow:1')) return new Promise<Response>(() => {});
      throw new TypeError('Failed to fetch');
    };
    const found = await probeHosts(
      ['http://dead:1', 'http://live:1', 'http://other:1', 'http://slow:1', 'http://plain:1'],
      { fetch: fetch as typeof globalThis.fetch, timeoutMs: 50 },
    );
    expect(found).toEqual([
      { url: 'http://live:1', name: 'inkup on studio', version: '0.1.0' },
      { url: 'http://plain:1', name: null, version: '0.1.0' },
    ]);
  });
});
