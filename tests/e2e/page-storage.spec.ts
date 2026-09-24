// #31 in Chrome: no script that runs inside a web page defines a storage.session item. Chrome gives content scripts
// no storage.session by default (TRUSTED_CONTEXTS), and @wxt-dev/storage reads an item as soon as it is defined.
// A check of the built extension (pnpm build).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageSideScripts, sessionKeys } from '../support/page-side-bundles';
import { EXTENSION_PATH, expect, test } from './fixtures';

test('content scripts define no storage.session item; the service worker does', () => {
  const scripts = pageSideScripts(EXTENSION_PATH);
  expect([...scripts.keys()]).toEqual(
    expect.arrayContaining(['content-scripts/content.js', 'content-scripts/viewport-frame.js']),
  );
  expect([...scripts].flatMap(([path, code]) => sessionKeys(code).map((k) => `${path}: ${k}`))).toEqual([]);
  expect(sessionKeys(readFileSync(join(EXTENSION_PATH, 'background.js'), 'utf8'))).toContain('activeSession');
});
