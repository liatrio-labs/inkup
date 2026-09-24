import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox } from '@playwright/test';
import { Rdp } from './rdp.ts';

const EXT = join(import.meta.dirname, '../../extensions/web/.output/firefox-mv3');
const ID = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
const UUID = '6c1f2a8e-0000-4000-8000-000000000001';
const PORT = 6124;
const ctx = await firefox.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ff-')), {
  headless: true,
  args: ['-start-debugger-server', String(PORT)],
  firefoxUserPrefs: {
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'devtools.chrome.enabled': true,
    'extensions.webextensions.uuids': JSON.stringify({ [ID]: UUID }),
  },
});
const rdp = await Rdp.connect(PORT);
const root = await rdp.request('root', 'getRoot');
console.log(await rdp.request(root.addonsActor as string, 'installTemporaryAddon', { addonPath: EXT }));
await new Promise((r) => setTimeout(r, 3000));
const tabs = await rdp.request('root', 'listTabs');
console.log(JSON.stringify(tabs).slice(0, 800));
const addons = await rdp.request('root', 'listAddons');
const addon = (addons.addons as { id: string; actor: string }[]).find((a) => a.id === ID);
console.log('addon', JSON.stringify(addon).slice(0, 400));
const tab = (tabs.tabs as { url: string; actor: string }[]).find((t) => t.url.includes('onboarding'));
for (const [actor, type] of [
  [tab!.actor, 'getTarget'],
  [addon!.actor, 'getWatcher'],
  [tab!.actor, 'getWatcher'],
] as const) {
  try {
    console.log(type, JSON.stringify(await rdp.request(actor, type)).slice(0, 700));
  } catch (e) {
    console.log(type, 'ERR', String(e).slice(0, 200));
  }
}
rdp.close();
await ctx.close();
