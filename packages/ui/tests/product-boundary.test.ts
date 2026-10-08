// Architecture rule (ADR 0029, spec 02 R1.2): @inkup/ui takes its data as props and its actions as callbacks, so the
// desktop app can render the same components. Nothing under packages/ui/src imports the extension's storage (Dexie,
// dexie-react-hooks, @wxt-dev/storage), its messaging (@webext-core/messaging), WXT, an `@/` extension module, or
// touches the chrome / browser extension globals.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
const FORBIDDEN: [string, RegExp][] = [
  ['Dexie import', /from\s+['"](dexie|dexie-react-hooks)(\/[^'"]*)?['"]|import\(\s*['"]dexie/],
  ['messaging import', /from\s+['"]@webext-core\/messaging(\/[^'"]*)?['"]/],
  ['storage import', /from\s+['"]@wxt-dev\/[^'"]+['"]/],
  ['WXT import', /from\s+['"](wxt|#imports|wxt\/[^'"]*)['"]/],
  ['extension module import', /from\s+['"]@@?\/[^'"]*['"]|import\(\s*['"]@@?\//],
  ['chrome.* API', /(?<![\w$.-])chrome\s*[.?[]/],
  ['browser.* API', /(?<![\w$.-])browser\s*[.?[]/],
];

function violations(source: string): string[] {
  // Comments and string contents do not count: "the browser.storage note" in prose is not a use.
  const code = source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '');
  return FORBIDDEN.filter(([, re]) => re.test(code)).map(([name]) => name);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('packages/ui/src boundary', () => {
  it('detects forbidden usage', () => {
    expect(violations("import { useLiveQuery } from 'dexie-react-hooks'")).toEqual(['Dexie import']);
    expect(violations("import Dexie from 'dexie'")).toEqual(['Dexie import']);
    expect(violations("import { defineExtensionMessaging } from '@webext-core/messaging'")).toEqual([
      'messaging import',
    ]);
    expect(violations("import { storage } from '@wxt-dev/storage'")).toEqual(['storage import']);
    expect(violations("import { browser } from 'wxt/browser'")).toEqual(['WXT import']);
    expect(violations("import { db } from '@/db'")).toEqual(['extension module import']);
    expect(violations("import { sendMessage } from '@/messaging'")).toEqual(['extension module import']);
    expect(violations('await chrome.tabs.create({ url })')).toEqual(['chrome.* API']);
    expect(violations('browser.runtime.getURL("/x")')).toEqual(['browser.* API']);
    expect(violations("import { cn } from '../lib/utils'; // chrome.tabs in a comment")).toEqual([]);
    expect(violations("import { Button } from '@inkup/ui/components/button'")).toEqual([]);
    expect(violations('const label = node.browserName;')).toEqual([]);
  });

  const all = files(SRC);
  it('scans the product components', () => {
    expect(all.some((f) => f.endsWith(join('product', 'item-card.tsx')))).toBe(true);
  });

  it.each(all.map((f) => [f.slice(SRC.length + 1), f]))('%s takes its data as props', (_rel, file) => {
    expect(violations(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
