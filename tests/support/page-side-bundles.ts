// The scripts a built extension runs inside web pages (#31): its content scripts and the extension pages a web page
// can frame (web_accessible_resources), each with every chunk it imports. Neither gets storage.session in Firefox, and
// Chrome gives content scripts none by default, while @wxt-dev/storage reads an item as soon as it is defined; so
// none of these may define a `session:` item (src/session-state.ts holds them all).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/** Every script under `out` that runs in a web page, keyed by its path relative to `out`. */
export function pageSideScripts(out: string): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
    content_scripts?: { js?: string[] }[];
    web_accessible_resources?: { resources: string[] }[] | string[];
  };
  const roots: string[] = (manifest.content_scripts ?? []).flatMap((c) => c.js ?? []);
  const resources = (manifest.web_accessible_resources ?? []).flatMap((r) =>
    typeof r === 'string' ? [r] : r.resources,
  );
  for (const html of resources.filter((r) => r.endsWith('.html'))) {
    const page = readFileSync(join(out, html), 'utf8');
    for (const m of page.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)) roots.push(m[1]!);
  }
  const seen = new Map<string, string>();
  const visit = (rel: string) => {
    const path = normalize(rel);
    if (seen.has(path) || !existsSync(join(out, path))) return;
    const code = readFileSync(join(out, path), 'utf8');
    seen.set(path, code);
    for (const m of code.matchAll(/(?:from|import)\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]/g))
      visit(join(dirname(path), m[1]!));
  };
  roots.forEach(visit);
  return seen;
}

/** The `session:` storage keys a script defines. */
export const sessionKeys = (code: string): string[] =>
  [...code.matchAll(/["'`]session:([A-Za-z]+)["'`]/g)].map((m) => m[1]!);
