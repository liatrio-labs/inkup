import { describe, expect, it } from 'vitest';
import { describeSource, normalizeSourcePath } from '../src/source-path';

describe('normalizeSourcePath', () => {
  it.each([
    ['http://localhost:5173/src/components/Button.tsx?t=1712', 'src/components/Button.tsx'],
    ['http://localhost:4401/src/App.js', 'src/App.js'],
    ['webpack-internal:///(app-pages-browser)/./app/page.tsx', 'app/page.tsx'],
    ['webpack:///./src/index.jsx', 'src/index.jsx'],
    ['/Users/dev/acme/src/components/Footer.tsx', 'src/components/Footer.tsx'],
    // The last src/ wins, so a checkout under a folder named app/ keeps only the project path.
    ['/Users/dev/app/shop/src/Cart.tsx', 'src/Cart.tsx'],
    // src/ before app/: Next.js with a src directory keeps its src/.
    ['/home/me/site/src/app/layout.tsx', 'src/app/layout.tsx'],
    ['/home/me/site/app/(shop)/cart/page.tsx', 'app/(shop)/cart/page.tsx'],
    ['C:\\work\\site\\src\\Nav.vue', 'src/Nav.vue'],
    ['file:///Users/dev/acme/src/main.ts', 'src/main.ts'],
    ['http://localhost:5173/@fs/Users/dev/acme/src/App.vue', 'src/App.vue'],
    ['components/Header.tsx', 'components/Header.tsx'],
    ['http://localhost:3000/components/Header.tsx#L3', 'components/Header.tsx'],
  ])('%s → %s', (raw, want) => expect(normalizeSourcePath(raw)).toBe(want));

  it.each([
    'http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=1',
    '/Users/dev/acme/node_modules/react/index.js',
    'http://localhost:4401/vendor/react-dev.js',
    '',
    null,
  ])('library code and nothing usable are null: %s', (raw) => expect(normalizeSourcePath(raw)).toBeNull());

  it('a file named src or app is not a folder', () => expect(normalizeSourcePath('/a/b/src')).toBe('a/b/src'));
});

describe('describeSource', () => {
  it('file, line and components', () =>
    expect(describeSource({ file: 'src/App.js', line: 6, components: ['CtaButton', 'App'] })).toBe(
      'src/App.js:6 (CtaButton ← App)',
    ));
  it('components only', () => expect(describeSource({ components: ['Card'] })).toBe('component Card'));
  it('nothing', () => expect(describeSource({ components: [] })).toBeNull());
});
