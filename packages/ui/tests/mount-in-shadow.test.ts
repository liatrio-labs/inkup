// mountInShadow: the compiled stylesheet lands in the shadow root, scoped to :host, and the host document gains
// nothing (R1.4). happy-dom has constructed sheets and adoptedStyleSheets.
import { afterEach, describe, expect, it } from 'vitest';
import { mountInShadow, toShadowCss } from '../src/mount-in-shadow';
import shadowCss from '../src/styles/shadow.css?inline';

function host(): ShadowRoot {
  const el = document.createElement('div');
  document.body.append(el);
  return el.attachShadow({ mode: 'open' });
}

const cssText = (sheet: CSSStyleSheet) =>
  Array.from(sheet.cssRules)
    .map((r) => r.cssText)
    .join('\n');

afterEach(() => {
  document.body.replaceChildren();
});

describe('mountInShadow', () => {
  it('adopts one stylesheet that declares the theme on :host, and adds nothing to the host document', () => {
    const headBefore = document.head.childNodes.length;
    const stylesBefore = document.querySelectorAll('style, link').length;
    const root = host();

    const added = mountInShadow(root);

    expect(added).toBeInstanceOf(CSSStyleSheet);
    expect(root.adoptedStyleSheets).toHaveLength(1);
    const text = cssText(root.adoptedStyleSheets[0] as CSSStyleSheet);
    expect(text).toMatch(/:host\s*\{[^}]*--background:/);
    expect(text).toContain(':host([data-theme="dark"])');
    expect(text).not.toContain(':root');
    expect(text).not.toContain('@font-face');
    expect(text).not.toContain('@property');
    // Nothing outside the shadow root: no <style>, <link> or font in the document, and the shadow tree holds no nodes.
    expect(document.head.childNodes.length).toBe(headBefore);
    expect(document.querySelectorAll('style, link').length).toBe(stylesBefore);
    expect(root.childNodes).toHaveLength(0);
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it('uses the system font stack in the shadow root', () => {
    // happy-dom drops @layer blocks from cssRules, so read the text mountInShadow adopts. A real browser computing
    // the font in a shadow root is in the T01 proofs (Chromium, Firefox, WebKit).
    const text = toShadowCss(shadowCss);
    // The theme layer declares the stack on :host, and preflight sets it as the family of `html, :host`.
    expect(text).toMatch(/:host, :host \{[^}]*--font-sans: ui-sans-serif, system-ui,/);
    expect(text).toMatch(/html, :host \{[^}]*font-family: var\(--default-font-family/);
    expect(text).not.toMatch(/Schibsted|Fragment Mono|@font-face|@import|url\(/);
  });

  it('shares one sheet between shadow roots and adopts it once per root', () => {
    const a = host();
    const b = host();
    const first = mountInShadow(a);
    expect(mountInShadow(a)).toBe(first);
    expect(mountInShadow(b)).toBe(first);
    expect(a.adoptedStyleSheets).toHaveLength(1);
    expect(b.adoptedStyleSheets).toHaveLength(1);
  });

  it('falls back to a <style> inside the shadow root when a constructed sheet is refused', () => {
    const root = host();
    const headBefore = document.head.childNodes.length;
    Object.defineProperty(root, 'adoptedStyleSheets', {
      get: () => [],
      set: () => {
        throw new DOMException('Sharing constructed stylesheets in multiple documents is not allowed');
      },
    });

    const added = mountInShadow(root);

    expect(added).toBeInstanceOf(HTMLStyleElement);
    expect(root.firstChild).toBe(added);
    expect((added as HTMLStyleElement).textContent).toContain(':host');
    expect(mountInShadow(root)).toBe(added);
    expect(root.querySelectorAll('style')).toHaveLength(1);
    expect(document.head.childNodes.length).toBe(headBefore);
  });
});

describe('toShadowCss', () => {
  it('moves :root and its data-theme switches to :host', () => {
    expect(toShadowCss(':root{--a:1}')).toBe(':host{--a:1}');
    expect(toShadowCss(':root[data-theme="dark"]{--a:2}')).toBe(':host([data-theme="dark"]){--a:2}');
    expect(toShadowCss(':root:not([data-theme="light"]){--a:2}')).toBe(':host(:not([data-theme="light"])){--a:2}');
    expect(toShadowCss('.x:where(:root[data-theme="dark"] *){color:red}')).toBe(
      '.x:where(:host([data-theme="dark"]) *){color:red}',
    );
    expect(toShadowCss(':root, :host{--b:1}')).toBe(':host, :host{--b:1}');
  });

  it('declares @property initial values on every element, since a shadow root cannot register them', () => {
    const out = toShadowCss(
      '@property --tw-x{syntax:"*";inherits:false;initial-value:0}@property --tw-y{syntax:"*";inherits:false}.a{b:c}',
    );
    expect(out).not.toContain('@property');
    expect(out).toBe('@layer properties{:host,*,::before,::after,::backdrop{--tw-x:0}}\n.a{b:c}');
  });
});
