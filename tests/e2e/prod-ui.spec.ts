// Slice 7: the release build shows no dev-only UI. The dev/test hooks (src/settings.ts `devOverrides`: the scripted
// transcript, the stub base URLs, the short chunk and retry intervals) are only reachable by writing that storage
// item from the service worker; no page offers them. This loads every extension page of the built extension
// (`pnpm build`, the same build `pnpm zip` packs) with no overrides set and checks for any trace of them, then checks
// the built manifest and bundles.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_PATH, expect, test } from './fixtures';

const DEV_TEXT = /scripted|base ?url|override|stub|localhost|127\.0\.0\.1|dev[- ]only|debug/i;

for (const page of ['sidepanel.html', 'options.html', 'sessions.html', 'onboarding.html']) {
  test(`${page} shows no dev-only control or text`, async ({ openExtensionPage }) => {
    const p = await openExtensionPage(page);
    await expect(p.locator('body')).not.toBeEmpty();
    await p.waitForLoadState('networkidle');
    const text = await p.locator('body').innerText();
    expect(text).not.toMatch(DEV_TEXT);
    // Every option of every select, and every input's label and placeholder, too.
    const controls = await p.evaluate(() =>
      [...document.querySelectorAll('option, input, textarea, [role="option"], [role="radio"]')].map((el) =>
        [
          el.textContent,
          el.getAttribute('value'),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('name'),
        ].join(' '),
      ),
    );
    for (const c of controls) expect(c).not.toMatch(DEV_TEXT);
  });
}

test('the built manifest asks for nothing dev-only and the bundles are a production build', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_PATH, 'manifest.json'), 'utf8'));
  expect(manifest.key).toBeUndefined();
  // E14's network hubs are the one allowed ws:// pattern, asked for on the Find hubs or Connect click; anything else
  // with ws://, localhost or 127.0.0.1 would be the dev server.
  const { optional_host_permissions: optional, ...rest } = manifest;
  expect(optional).toEqual(['http://*/*', 'ws://*/*']);
  expect(JSON.stringify(rest)).not.toMatch(/localhost|127\.0\.0\.1|ws:\/\//);
  expect(manifest.content_security_policy.extension_pages).toBe(
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  );
  // A production build (wxt build, not the dev server): no reload client, no Vite HMR.
  const chunks = readdirSync(join(EXTENSION_PATH, 'chunks')).filter((f) => f.endsWith('.js'));
  const code = chunks.map((f) => readFileSync(join(EXTENSION_PATH, 'chunks', f), 'utf8')).join('\n');
  expect(code).not.toMatch(/@vite\/client|import\.meta\.hot|wxt:reload-extension/);
});
