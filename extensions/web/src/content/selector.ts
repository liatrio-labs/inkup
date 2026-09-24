// Stable CSS selectors for Candidates (docs/PLAN.md): prefer a test attribute (data-testid, data-test, data-cy,
// data-qa), then a unique non-generated id, then css-selector-generator with generated/utility classes and noisy
// attributes blacklisted.
//
// Shadow-aware (E2): an element inside an open shadow root gets its host's selector, then ` >>> `, then a selector
// unique inside that shadow root (the piercing convention of Playwright and Puppeteer). resolveSelector reads one back.
import { getCssSelector } from 'css-selector-generator';

type SelectorTypes = NonNullable<NonNullable<Parameters<typeof getCssSelector>[1]>['selectors']>;

/** Class selectors that change between builds or say nothing about the element's role. */
export const CLASS_BLACKLIST: RegExp[] = [
  /^\.(css|sc|emotion|jss|makeStyles|styled)-/i, // CSS-in-JS prefixes
  /^\.[\w-]*[_-](?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$/i, // name_hash / name-a1b2c (CSS modules, hashed suffixes)
  /^\._[\w-]{4,}$/, // _3fGhK
  /^\.[\w-]*[_-]\d{3,}$/, // jsx-123, ember456
  /\\[:[/.]/, // Tailwind variants and arbitrary values: .hover\:bg-x, .w-\[12px\], .w-1\/2
  /^\.-?(?:p[xytblr]?|m[xytblr]?|w|h|min-[wh]|max-[wh]|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|left|right|bottom|z|order|basis|grow|shrink|text|font|leading|tracking|bg|from|via|to|border(?:-[xytblr])?|rounded(?:-[a-z]+)?|shadow|ring|outline|opacity|fill|stroke|flex|grid|col|row|items|justify|self|place|content|overflow|cursor|transition|duration|delay|ease|translate-[xy]|scale|rotate|skew|origin|aspect|object|line-clamp|decoration|underline-offset)(?:-[\w.]+)*$/,
  /^\.(?:flex|grid|block|inline|inline-block|inline-flex|hidden|contents|static|fixed|absolute|relative|sticky|container|truncate|uppercase|lowercase|capitalize|italic|underline|sr-only|visible|invisible|grow|shrink)$/,
];

/** Attribute selectors worth keeping; everything else (style, class, src, data-v-*, aria-* state) is noise. */
const ATTRIBUTE_WHITELIST =
  /^\[(data-testid|data-test|data-cy|data-qa|aria-label|name|role|type|href|alt|title|for|placeholder)=/;
const ATTRIBUTE_BLACKLIST = (s: string) => s.startsWith('[') && !ATTRIBUTE_WHITELIST.test(s);

/** Attributes written for tests, most common first: a selector on one survives restyling and refactors. */
export const TEST_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'data-qa'] as const;
/** Joins a shadow host's selector to one inside its shadow root. */
export const SHADOW_SEPARATOR = ' >>> ';

/** The element's first test attribute and its value, or null. */
export function testAttributeOf(el: Element): { name: string; value: string } | null {
  for (const name of TEST_ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value) return { name, value };
  }
  return null;
}

/** Looks machine-generated: long digit runs or a hash-like tail (e.g. radix-:r3:, ember123, a1b2c3d4e5). */
const GENERATED_ID = /(^:|:$|\d{3,}|^[a-f0-9]{8,}$|[_-](?=[a-z0-9]*\d)[a-z0-9]{5,}$)/i;

const SELECTOR_ATTEMPTS: SelectorTypes[] = [
  ['class'],
  ['attribute'],
  ['class', 'attribute', 'nthoftype'],
  ['tag', 'class', 'attribute', 'nthoftype'],
];

/** css-selector-generator ends with an opaque `:scope > :nth-child(…)` chain; ours is easier to read. */
const isLibraryFallback = (sel: string) => /^:(scope|root)\b/.test(sel);

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

function unique(root: ParentNode, sel: string, el: Element): boolean {
  try {
    const found = root.querySelectorAll(sel);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

export function selectorFor(el: Element): string {
  const root = el.getRootNode();
  if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot)
    return `${selectorFor(root.host)}${SHADOW_SEPARATOR}${selectorIn(el, root)}`;
  return selectorIn(el, el.ownerDocument);
}

/** The element a selectorFor() selector names, descending into open shadow roots at each ` >>> `. */
export function resolveSelector(selector: string, doc: Document = document): Element | null {
  let scope: ParentNode | null = doc;
  let found: Element | null = null;
  for (const part of selector.split(SHADOW_SEPARATOR)) {
    if (!scope) return null;
    try {
      found = scope.querySelector(part);
    } catch {
      return null;
    }
    scope = found?.shadowRoot ?? null;
  }
  return found;
}

function selectorIn(el: Element, root: ParentNode): string {
  for (const name of TEST_ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const sel = `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
    if (unique(root, sel, el)) return sel;
  }
  if (el.id && !GENERATED_ID.test(el.id)) {
    const sel = `#${esc(el.id)}`;
    if (unique(root, sel, el)) return sel;
  }
  const options = {
    root,
    blacklist: [
      ...CLASS_BLACKLIST,
      ATTRIBUTE_BLACKLIST,
      (sel: string) => sel.startsWith('#') && GENERATED_ID.test(sel.slice(1)),
    ],
    whitelist: [/^\[data-(testid|test|cy|qa)=/],
    includeTag: true,
    combineWithinSelector: true,
    combineBetweenSelectors: true,
    // The library heuristic rejects short real names such as `cta`; CLASS_BLACKLIST covers hashes instead.
    ignoreGeneratedClassNames: false,
    maxCombinations: 50,
    maxCandidates: 50,
  };
  // Most meaningful first: `button.cta` beats a bare `button` that happens to be unique today.
  for (const selectors of SELECTOR_ATTEMPTS) {
    try {
      const sel = getCssSelector(el, { ...options, selectors });
      if (!isLibraryFallback(sel) && unique(root, sel, el)) return sel;
    } catch {
      /* try the next set */
    }
  }
  return structuralPath(el);
}

/** Always-unique fallback: html > body > main:nth-of-type(1) > … (inside a shadow root, from its top element). */
export function structuralPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur?.parentElement) {
    const tag = cur.tagName.toLowerCase();
    const same = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = cur.parentElement;
  }
  parts.unshift(cur ? cur.tagName.toLowerCase() : 'html');
  return parts.join(' > ');
}
