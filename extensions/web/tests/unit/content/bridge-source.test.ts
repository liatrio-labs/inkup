// E4: what the MAIN-world bridge reads from an element. Fibers and Vue instances are faked with the fields each
// framework's development build sets; the React 19 owner stack is the one a real React 19.3 build produced for
// fixtures/site/react.html (tests/e2e/source-map.spec.ts runs the real thing).
import { describe, expect, it } from 'vitest';
import { firstAppFrame, isReadableComponentName, readSource } from '@/bridge/source';

const REACT19_STACK = `Error: react-stack-top-frame
    at e.createElement (http://localhost:4401/vendor/react-dev.js:24:9275)
    at CtaButton (http://localhost:4401/src/App.js:6:10)
    at Object.react_stack_bottom_frame (http://localhost:4401/vendor/react-dev.js:267:267)
    at Ya (http://localhost:4401/vendor/react-dev.js:160:803)`;

function el(html = '<button>Go</button>'): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

const fn = (name: string) => Object.defineProperty(() => {}, 'name', { value: name });

describe('firstAppFrame', () => {
  it('skips React and the message line in a Chrome stack', () =>
    expect(firstAppFrame(REACT19_STACK)).toEqual({ file: 'http://localhost:4401/src/App.js', line: 6 }));
  it('reads a Firefox stack', () =>
    expect(
      firstAppFrame(
        'createElement@http://localhost:5173/node_modules/.vite/deps/react.js?v=1:12:3\nCard@http://localhost:5173/src/Card.tsx?t=9:21:7',
      ),
    ).toEqual({ file: 'http://localhost:5173/src/Card.tsx?t=9', line: 21 }));
  it('keeps parentheses inside a webpack module id', () =>
    expect(firstAppFrame('    at Page (webpack-internal:///(app-pages-browser)/./app/page.tsx:14:9)')).toEqual({
      file: 'webpack-internal:///(app-pages-browser)/./app/page.tsx',
      line: 14,
    }));
  it('null when every frame is library code', () =>
    expect(firstAppFrame('Error\n    at x (http://h/node_modules/react/index.js:1:1)')).toBeNull());
});

describe('isReadableComponentName', () => {
  it.each(['Button', 'PricingCard', 'App', 'Nav2'])('keeps %s', (n) => expect(isReadableComponentName(n)).toBe(true));
  it.each(['Xe', 't', 'Ya', 'ABC', 'div', '$e', undefined])('drops %s', (n) =>
    expect(isReadableComponentName(n)).toBe(false),
  );
});

describe('readSource', () => {
  it('React 19: the owner stack gives file and line, the owner chain the components', () => {
    const e = el();
    const app = { type: fn('App'), _debugOwner: null };
    const card = { type: fn('PricingCard'), _debugOwner: app };
    const button = { type: fn('CtaButton'), _debugOwner: card };
    Object.assign(e, {
      __reactFiber$abc: { type: 'button', _debugOwner: button, _debugStack: { stack: REACT19_STACK }, return: button },
    });
    expect(readSource(e)).toEqual({ file: 'src/App.js', line: 6, components: ['CtaButton', 'PricingCard', 'App'] });
  });

  it('React 16-18: _debugSource, and minified or wrapped component names', () => {
    const e = el();
    const minified = { type: fn('Xe'), _debugOwner: null };
    const memo = { type: { $$typeof: Symbol.for('react.memo'), type: fn('Card') }, _debugOwner: minified };
    const fwd = { type: { render: fn('FancyButton') }, _debugOwner: memo };
    Object.assign(e, {
      __reactInternalInstance$x: {
        type: 'button',
        _debugOwner: fwd,
        _debugSource: { fileName: '/Users/dev/shop/src/ui/FancyButton.jsx', lineNumber: 18 },
      },
    });
    expect(readSource(e)).toEqual({ file: 'src/ui/FancyButton.jsx', line: 18, components: ['FancyButton', 'Card'] });
  });

  it('a production React build: no source, component names from the fiber parents when they survived', () => {
    const e = el();
    const root = { type: null, return: null };
    const page = { type: fn('CheckoutPage'), return: root };
    Object.assign(e, {
      __reactFiber$p: { type: 'button', return: { type: 'div', return: { type: fn('e'), return: page } } },
    });
    expect(readSource(e)).toEqual({ components: ['CheckoutPage'] });
  });

  it('Vue 3: the component file and its parents', () => {
    const e = el('<div><span>Hi</span></div>');
    const root = { type: { name: 'App', __file: '/Users/dev/site/src/App.vue' }, parent: null };
    const nav = { type: { __name: 'NavBar', __file: '/Users/dev/site/src/components/NavBar.vue' }, parent: root };
    Object.assign(e, { __vueParentComponent: nav });
    expect(readSource(e.querySelector('span')!)).toEqual({
      file: 'src/components/NavBar.vue',
      components: ['NavBar', 'App'],
    });
  });

  it('Vue 2: $options.__file', () => {
    const e = el();
    Object.assign(e, {
      __vue__: { $options: { name: 'SignupForm', __file: 'src/components/SignupForm.vue' }, $parent: null },
    });
    expect(readSource(e)).toEqual({ file: 'src/components/SignupForm.vue', components: ['SignupForm'] });
  });

  it('build-plugin attributes on the element or an ancestor', () => {
    const footer = el(
      '<footer data-source-file="/Users/dev/acme/src/components/Footer.tsx" data-line="12"><p>USD</p></footer>',
    );
    expect(readSource(footer.querySelector('p')!)).toEqual({
      file: 'src/components/Footer.tsx',
      line: 12,
      components: [],
    });
    const next = el('<div data-nextjs-path="app/pricing/page.tsx:40:3"><b>x</b></div>');
    expect(readSource(next.querySelector('b')!)).toEqual({ file: 'app/pricing/page.tsx', line: 40, components: [] });
  });

  it('React components with no file take the file from the attributes', () => {
    const e = el('<section data-source-file="src/Hero.tsx"><button>Go</button></section>');
    const b = e.querySelector('button')!;
    Object.assign(b, { __reactFiber$z: { type: 'button', _debugOwner: { type: fn('Hero'), _debugOwner: null } } });
    expect(readSource(b)).toEqual({ file: 'src/Hero.tsx', components: ['Hero'] });
  });

  it('nothing known is null, and a hostile fiber does not throw', () => {
    expect(readSource(el())).toBeNull();
    const e = el();
    Object.defineProperty(e, '__reactFiber$bad', {
      enumerable: true,
      get: () => ({
        get _debugStack() {
          throw new Error('no');
        },
        get _debugOwner() {
          throw new Error('no');
        },
      }),
    });
    expect(readSource(e)).toBeNull();
  });
});
