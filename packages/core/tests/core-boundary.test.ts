// Architecture rule (docs/PLAN.md): packages/core/src never imports chrome.* / WXT or touches the DOM.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE = join(__dirname, '../src');
const FORBIDDEN: [string, RegExp][] = [
  ['chrome.* API', /\bchrome\s*\./],
  ['browser.* API', /\bbrowser\s*\./],
  // Usage, not words: `document.x`, `window[...]`, `: HTMLElement`, `instanceof Element`. Plain prose such as
  // "session-document.ts" in a string must not trip it.
  [
    'DOM global',
    /(?<![\w$.-])(document|window|navigator)\s*[.[]|(?::|instanceof|new|<)\s*(HTMLElement|Element|Node|Document)\b/,
  ],
  ['WXT import', /from\s+['"](wxt|#imports|wxt\/[^'"]*)['"]/],
];

function violations(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  return FORBIDDEN.filter(([, re]) => re.test(code)).map(([name]) => name);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('packages/core/src boundary', () => {
  it('detects forbidden usage', () => {
    expect(violations('const r = document.querySelector("a")')).toEqual(['DOM global']);
    expect(violations('await chrome.storage.local.get()')).toEqual(['chrome.* API']);
    expect(violations("import { storage } from '#imports'")).toEqual(['WXT import']);
    expect(violations('export const add = (a: number, b: number) => a + b; // chrome.x in a comment')).toEqual([]);
    expect(violations('const w = window.innerWidth')).toEqual(['DOM global']);
    expect(violations('function f(e: HTMLElement) {}')).toEqual(['DOM global']);
    expect(violations('if (x instanceof Element) {}')).toEqual(['DOM global']);
    expect(violations("const s = 'see session-document.ts, the document root'")).toEqual([]);
  });

  it.each(files(CORE).map((f) => [f.slice(CORE.length + 1), f]))('%s is pure', (_rel, file) => {
    expect(violations(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
