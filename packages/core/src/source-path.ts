// Source paths as a coding agent can open them (E4): whatever a framework reports (a dev-server URL, a bundler's
// module id, an absolute path on the developer's machine) cut down to start at the project's src/ or app/ folder.
// Pure, so the MAIN-world bridge and the tests share it.

/** Library code: never the place a reviewer's change goes. */
const LIBRARY = /(^|\/)(node_modules|\.vite\/deps|\.next\/static\/chunks|vendor)\//;

/**
 * `http://localhost:5173/src/App.tsx?t=1` → `src/App.tsx`; `webpack-internal:///(app-pages-browser)/./app/page.tsx`
 * → `app/page.tsx`; `/Users/me/app/shop/src/Cart.tsx` → `src/Cart.tsx`. The last `src/` segment wins, else the last
 * `app/` one (so `src/app/page.tsx` keeps its `src/`); a path with neither keeps its tail without the origin. Null
 * for library code and for nothing usable.
 */
export function normalizeSourcePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let p = raw.trim().replace(/\\/g, '/');
  p = p.replace(/[?#].*$/, '');
  p = p.replace(/^webpack(-internal)?:\/\/\/?/, '').replace(/^file:\/\/\/?/, '/');
  p = p.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '');
  p = p.replace(/^\/?\([^)]*\)\//, '').replace(/^\/@fs\//, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep it encoded */
  }
  if (LIBRARY.test(p)) return null;
  const segments = p.split('/');
  const last = (name: string) => segments.lastIndexOf(name);
  const at =
    last('src') >= 0 && last('src') < segments.length - 1
      ? last('src')
      : last('app') < segments.length - 1
        ? last('app')
        : -1;
  const out = (at >= 0 ? segments.slice(at) : segments).filter((s) => s !== '' && s !== '.').join('/');
  return out || null;
}

/** `src/App.tsx:12 (CtaButton ← PricingCard)`: one line for prompts and review.md. */
export function describeSource(source: { file?: string; line?: number; components: readonly string[] }): string | null {
  const where = source.file ? `${source.file}${source.line ? `:${source.line}` : ''}` : null;
  const chain = source.components.length ? source.components.join(' ← ') : null;
  if (where && chain) return `${where} (${chain})`;
  return where ?? (chain ? `component ${chain}` : null);
}
