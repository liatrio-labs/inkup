// Styles for @inkup/ui inside a shadow root (the extension's in-page surfaces): the compiled Tailwind + theme, scoped
// to the shadow root and its host, with nothing added to the host document (ADR 0011, ADR 0012, ADR 0028).
import shadowCss from './styles/shadow.css?inline';

/** `:root(...)` with attribute or `:not()` parts, which become `:host(...)`. */
const ROOT_WITH_PARTS = /:root((?:\[[^\]]*\]|:not\((?:[^()]|\([^()]*\))*\))+)/g;
const PROPERTY_RULE = /@property\s+(--[\w-]+)\s*\{([^}]*)\}/g;

/**
 * The page stylesheet as a shadow root needs it. `:root` matches nothing in a shadow tree, so the theme's variables
 * and its `data-theme` switches move to `:host` (`:root[data-theme="dark"]` → `:host([data-theme="dark"])`). And
 * `@property` registers nothing from a shadow root, so each registered property's initial value is declared on every
 * element instead, in a layer below the utilities, as Tailwind's own fallback for browsers without `@property` does.
 */
export function toShadowCss(css: string): string {
  const initials: string[] = [];
  const withoutProperties = css.replace(PROPERTY_RULE, (_rule, name: string, body: string) => {
    const initial = /initial-value\s*:\s*([^;]+);?/.exec(body)?.[1]?.trim();
    if (initial !== undefined) initials.push(`${name}:${initial}`);
    return '';
  });
  const scoped = withoutProperties.replace(ROOT_WITH_PARTS, ':host($1)').replace(/:root\b/g, ':host');
  if (initials.length === 0) return scoped;
  return `@layer properties{:host,*,::before,::after,::backdrop{${initials.join(';')}}}\n${scoped}`;
}

const sheets = new WeakMap<object, CSSStyleSheet>();

/**
 * Adopts the @inkup/ui stylesheet into `shadowRoot`: Tailwind, the DESIGN.md theme on `:host` and the system font
 * stack (no web fonts). Set `data-theme="light" | "dark"` on the host to override the system scheme. Nothing is added
 * to the host document; where a browser refuses a constructed sheet (a Firefox content script's sheet belongs to
 * another realm), a `<style>` goes inside the shadow root instead. Returns what it added. Calling it twice adds once.
 */
export function mountInShadow(shadowRoot: ShadowRoot): CSSStyleSheet | HTMLStyleElement {
  const view = shadowRoot.ownerDocument.defaultView;
  const Sheet = view?.CSSStyleSheet ?? CSSStyleSheet;
  let sheet = sheets.get(Sheet);
  try {
    if (!sheet) {
      sheet = new Sheet();
      sheet.replaceSync(toShadowCss(shadowCss));
      sheets.set(Sheet, sheet);
    }
    if (!shadowRoot.adoptedStyleSheets.includes(sheet)) {
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
    }
    return sheet;
  } catch {
    const existing = shadowRoot.querySelector<HTMLStyleElement>('style[data-inkup-ui]');
    if (existing) return existing;
    const style = shadowRoot.ownerDocument.createElement('style');
    style.dataset.inkupUi = '';
    style.textContent = toShadowCss(shadowCss);
    shadowRoot.prepend(style);
    return style;
  }
}
