// #31: no script that runs inside a web page (content scripts, the toolbar's Start frame) defines a storage.session
// item. Firefox gives them no storage.session, and @wxt-dev/storage reads an item as soon as it is defined, so each
// one threw "browser.storage.session is undefined" on every page. A check of the built extension (pnpm build:firefox).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { pageSideScripts, sessionKeys } from '../support/page-side-bundles';
import { EXTENSION_PATH } from './fixtures';

test('Firefox: content scripts and page-framed extension pages define no storage.session item', () => {
  const scripts = pageSideScripts(EXTENSION_PATH);
  expect([...scripts.keys()]).toEqual(
    expect.arrayContaining([
      'content-scripts/content.js',
      'content-scripts/viewport-frame.js',
      expect.stringMatching(/^chunks\/toolbar-start-.*\.js$/),
    ]),
  );
  expect([...scripts].flatMap(([path, code]) => sessionKeys(code).map((k) => `${path}: ${k}`))).toEqual([]);
  // The service worker still defines them, so the check can see one.
  expect(sessionKeys(readFileSync(join(EXTENSION_PATH, 'background.js'), 'utf8'))).toContain('activeSession');
});
