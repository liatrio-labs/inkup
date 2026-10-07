// Styles for @inkup/ui inside a shadow root (the extension's in-page surfaces): the compiled Tailwind + theme, scoped
// to the shadow root and its host, with nothing added to the host document (ADR 0011, ADR 0012, ADR 0029).
import shadowCss from './styles/shadow.css?inline';

/** `:root(...)` with attribute or `:not()` parts, which become `:host(...)`. */
const ROOT_WITH_PARTS = /:root((?:\[[^\]]*\]|:not\((?:[^()]|\([^()]*\))*\))+)/g;

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
const isNameChar = (ch: string | undefined) => ch !== undefined && /[\w-]/.test(ch);

/** Index of the first non-space character at or after `i`. */
function skipSpace(text: string, i: number): number {
  while (isSpace(text[i])) i++;
  return i;
}

/** The text of the first `initial-value: …` declaration in a rule body, trimmed (up to the next `;`, or the end). */
function initialValue(body: string): string | undefined {
  let at = body.indexOf('initial-value');
  while (at !== -1) {
    const colon = skipSpace(body, at + 'initial-value'.length);
    if (body[colon] === ':') {
      const start = colon + 1;
      const semi = body.indexOf(';', start);
      const end = semi === -1 ? body.length : semi;
      if (end > start) return body.slice(start, end).trim();
    }
    at = body.indexOf('initial-value', at + 1);
  }
  return undefined;
}

/**
 * Removes each `@property --name { … }` rule with one forward scan (no backtracking, so no crafted input can blow up),
 * calling `onRule` with the name and body of every rule it removes. Text that only looks like a rule stays as it is.
 */
function stripPropertyRules(css: string, onRule: (name: string, body: string) => void): string {
  let out = '';
  let copied = 0;
  let at = css.indexOf('@property');
  let closeable = true; // false once no `}` is left anywhere after the scan position
  while (at !== -1 && closeable) {
    const afterKeyword = at + '@property'.length;
    let i = skipSpace(css, afterKeyword);
    const nameStart = i;
    if (i > afterKeyword && css.startsWith('--', i)) {
      i += 2;
      while (isNameChar(css[i])) i++;
      const nameEnd = i;
      i = skipSpace(css, i);
      if (css[i] === '{') {
        const close = css.indexOf('}', i + 1);
        if (close === -1) {
          closeable = false;
        } else {
          out += css.slice(copied, at);
          onRule(css.slice(nameStart, nameEnd), css.slice(i + 1, close));
          copied = close + 1;
          at = css.indexOf('@property', copied);
          continue;
        }
      }
    }
    at = css.indexOf('@property', afterKeyword);
  }
  return out + css.slice(copied);
}

/**
 * The page stylesheet as a shadow root needs it. `:root` matches nothing in a shadow tree, so the theme's variables
 * and its `data-theme` switches move to `:host` (`:root[data-theme="dark"]` → `:host([data-theme="dark"])`). And
 * `@property` registers nothing from a shadow root, so each registered property's initial value is declared on every
 * element instead, in a layer below the utilities, as Tailwind's own fallback for browsers without `@property` does.
 */
export function toShadowCss(css: string): string {
  const initials: string[] = [];
  const withoutProperties = stripPropertyRules(css, (name, body) => {
    const initial = initialValue(body);
    if (initial !== undefined) initials.push(`${name}:${initial}`);
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
