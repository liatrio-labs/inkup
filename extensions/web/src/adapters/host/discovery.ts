// Finding a Host on the LAN (ADR 0006). An extension cannot browse mDNS, but the browser resolves `.local` names
// through the OS: a Host in network mode claims `inkup.local` (or `-2` … `-5` when that is taken), so the
// options page probes those names' /health, plus any address the reviewer saved. A Host can also be given as an
// address, or as the `inkup://pair?url=…&code=…` link its TUI shows (typed, pasted or scanned as a QR code).
import { Health } from '@inkup/protocol';

export const HOST_PORT = 47823;
/** The names a Host in network mode may hold, in the order it takes them. */
export const LOCAL_NAMES = ['inkup.local', 'inkup-2.local', 'inkup-3.local', 'inkup-4.local', 'inkup-5.local'];
export const PROBE_TIMEOUT_MS = 1_500;

export interface FoundHost {
  /** `http://inkup.local:47823`, as probed. */
  url: string;
  /** `inkup on studio-mac`, when the Host says. */
  name: string | null;
  version: string;
}

/** What Find hubs probes: the `.local` names, then the saved addresses, each once. */
export function probeList(saved: readonly string[]): string[] {
  return [
    ...new Set([
      ...LOCAL_NAMES.map((name) => `http://${name}:${HOST_PORT}`),
      ...saved.map(normalizeAddress).filter((u): u is string => !!u),
    ]),
  ];
}

/** Probes each address's /health at once; lists those that answer as an InkUp Host, in probe order. */
export async function probeHosts(
  urls: readonly string[],
  { timeoutMs = PROBE_TIMEOUT_MS, fetch: get = fetch } = {},
): Promise<FoundHost[]> {
  const probed = await Promise.all(
    urls.map(async (url): Promise<FoundHost | null> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((res) => {
        timer = setTimeout(() => {
          controller.abort();
          res(null);
        }, timeoutMs);
      });
      const answered = (async () => {
        const res = await get(`${url}/health`, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) return null;
        const health = Health.safeParse(await res.json());
        return health.success ? { url, name: health.data.hub_name ?? null, version: health.data.version } : null;
      })().catch(() => null);
      try {
        return await Promise.race([answered, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return probed.filter((h): h is FoundHost => h !== null);
}

/**
 * What the reviewer typed as a Host's address, as a base URL: `192.168.1.20` → `http://192.168.1.20:47823`,
 * `studio.local:5000` → `http://studio.local:5000`. Null for anything that is not an http address.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A port typed out is kept even when it is the scheme's default (which URL drops); none typed means the Host's.
  const authority = withScheme.split('://')[1]!.split('/')[0]!;
  const port = /:(\d+)$/.exec(authority)?.[1] ?? String(HOST_PORT);
  return `${url.protocol}//${url.hostname}:${port}`;
}

/** `inkup://pair?url=http://inkup.local:47823&code=042917` → its address and code; null otherwise. */
export function parsePairLink(input: string): { url: string; code: string } | null {
  const text = input.trim();
  if (!/^inkup:\/\/pair\?/i.test(text)) return null;
  const params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
  const url = normalizeAddress(params.get('url') ?? '');
  const code = (params.get('code') ?? '').replace(/\s/g, '');
  return url && /^\d{6}$/.test(code) ? { url, code } : null;
}

/** This machine's own Host: loopback, where no token or code is needed and nothing crosses the network. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}
