// The Session list (PRD P0-14) and the long-Session warnings (P0-1), as pure rules: grouping by starting origin,
// the storage warning level, and the soft-cap thresholds. The pages and the panel render what these return.

/** Warn when the extension uses this share of its storage quota (P0-14). */
export const STORAGE_WARN_RATIO = 0.8;
/** Soft cap (P0-1): the panel warns at these elapsed times; recording continues. */
export const SOFT_CAP_MINUTES = [45, 60] as const;

export interface ListedSession {
  id: string;
  start_url: string;
  started_at: string;
}

export interface OriginGroup<S extends ListedSession> {
  origin: string;
  sessions: S[];
}

/** `https://example.com`; the raw string for a URL that does not parse (e.g. an empty start URL). */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? `${u.protocol}//${u.host || u.pathname}` : u.origin;
  } catch {
    return url || 'unknown page';
  }
}

/**
 * How the list names an origin: our own extension pages are "This extension"; another extension's by its name
 * when the caller knows it (only with an already granted `management` permission), else its raw origin.
 * @param ownOrigin `chrome-extension://<our id>`
 * @param extensionNames extension id → name
 */
export function originLabel(
  origin: string,
  ownOrigin: string,
  extensionNames: ReadonlyMap<string, string> = new Map(),
): string {
  if (origin === ownOrigin) return 'This extension';
  const id = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1];
  const name = id ? extensionNames.get(id) : undefined;
  return name ? `${name} (extension)` : origin;
}

/** Groups by starting origin: newest Session first inside a group, groups ordered by their newest Session. */
export function groupByOrigin<S extends ListedSession>(sessions: readonly S[]): OriginGroup<S>[] {
  const groups = new Map<string, S[]>();
  const newestFirst = [...sessions].sort(
    (a, b) => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id),
  );
  for (const s of newestFirst) {
    const o = originOf(s.start_url);
    groups.set(o, [...(groups.get(o) ?? []), s]);
  }
  return [...groups.entries()].map(([origin, list]) => ({ origin, sessions: list }));
}

export interface StorageLevel {
  usage: number;
  quota: number;
  /** usage / quota, 0 when the quota is unknown. */
  ratio: number;
  warn: boolean;
}

export function storageLevel(usage: number | undefined, quota: number | undefined): StorageLevel {
  const u = Math.max(0, usage ?? 0);
  const q = Math.max(0, quota ?? 0);
  const ratio = q > 0 ? u / q : 0;
  return { usage: u, quota: q, ratio, warn: q > 0 && ratio >= STORAGE_WARN_RATIO };
}

/** 1.2 MB, 850 KB, 3.4 GB (decimal units, like Chrome's own storage settings). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Soft-cap thresholds (minutes) the elapsed recording time has reached, e.g. [45] at 50 minutes. */
export function softCapsReached(elapsedMs: number): number[] {
  return SOFT_CAP_MINUTES.filter((m) => elapsedMs >= m * 60_000);
}

export function softCapMessage(minutes: number): string {
  return minutes >= 60
    ? `This Session has run for ${minutes} minutes. Recording continues; long Sessions take longer to process and export.`
    : `This Session has run for ${minutes} minutes. Recording continues; consider stopping soon and starting a new Session.`;
}
