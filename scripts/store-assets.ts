// `node scripts/store-assets.ts` (`pnpm store:assets`): renders the Chrome Web Store listing images into
// extensions/web/store/chrome from the site's product captures (apps/site/src/assets/captures, ADR 0026), the InkUp
// mark and the site's font. Each image is an HTML page screenshotted at its exact size by Playwright's Chromium, so
// the text uses Schibsted Grotesk on any machine and no image library is needed. The store's API cannot set listing
// media: the files are uploaded by hand in the developer dashboard (docs/releasing.md, "Chrome Web Store listing").
// Sizes follow https://developer.chrome.com/docs/webstore/images.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = new URL('..', import.meta.url).pathname;
const CAPTURES = join(ROOT, 'apps/site/src/assets/captures');
export const OUT = join(ROOT, 'extensions/web/store/chrome');
const FONT = join(
  ROOT,
  'apps/site/node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2',
);
const ICON = join(ROOT, 'extensions/web/assets/icon.svg');

const ink = '#1f2a44';
const ink2 = '#3a4663';
const paper2 = '#f4f6fa';

export type Kind = 'screenshot' | 'small-promo' | 'marquee-promo' | 'icon';

export interface StoreAsset {
  file: string;
  kind: Kind;
  width: number;
  height: number;
  /** The captures it is made from, by file name in apps/site/src/assets/captures. */
  from: string[];
  /** What the image says, for whoever uploads it. */
  caption: string;
}

/** Everything the listing needs, in upload order. The screenshots tell the review from start to finish. */
export const ASSETS: StoreAsset[] = [
  {
    file: 'screenshot-1-talk-and-draw.png',
    kind: 'screenshot',
    width: 1280,
    height: 800,
    from: ['toolbar-recording.png'],
    caption: 'Talk through the page and draw on it while InkUp records.',
  },
  {
    file: 'screenshot-2-circle.png',
    kind: 'screenshot',
    width: 1280,
    height: 800,
    from: ['stroke.png'],
    caption: 'Circle what you mean; InkUp ties the mark to the element under it.',
  },
  {
    file: 'screenshot-3-drafts.png',
    kind: 'screenshot',
    width: 1280,
    height: 800,
    from: ['drafts.png'],
    caption: 'Every note becomes a draft change while you talk.',
  },
  {
    file: 'screenshot-4-review.png',
    kind: 'screenshot',
    width: 1280,
    height: 800,
    from: ['review.png'],
    caption: 'Review the list of changes, then copy prompts for your coding agent or export them.',
  },
  {
    file: 'screenshot-5-phone-width.png',
    kind: 'screenshot',
    width: 1280,
    height: 800,
    from: ['stroke-mobile.png'],
    caption: 'Review a narrow layout the same way you review a wide one.',
  },
  {
    file: 'small-promo-440x280.png',
    kind: 'small-promo',
    width: 440,
    height: 280,
    from: [],
    caption: 'Review your site out loud.',
  },
  {
    file: 'marquee-promo-1400x560.png',
    kind: 'marquee-promo',
    width: 1400,
    height: 560,
    from: ['stroke.png'],
    caption: 'Review your site out loud.',
  },
  { file: 'icon-128.png', kind: 'icon', width: 128, height: 128, from: [], caption: 'The InkUp mark.' },
];

const dataUrl = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString('base64')}`;
const capture = (file: string) =>
  dataUrl(join(CAPTURES, file), file.endsWith('.jpg') ? 'image/jpeg' : `image/${file.split('.').pop()}`);

function page(width: number, height: number, body: string, css = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Schibsted Grotesk'; src: url(${dataUrl(FONT, 'font/woff2')}) format('woff2');
      font-weight: 400 900; }
    * { box-sizing: border-box; margin: 0; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
    body { font-family: 'Schibsted Grotesk', sans-serif; font-feature-settings: 'ss01'; color: ${ink};
      -webkit-font-smoothing: antialiased; }
    h1 { font-weight: 700; letter-spacing: -0.035em; line-height: 1.02; }
    p { line-height: 1.35; color: ${ink2}; }
    .brand { display: flex; align-items: center; color: inherit; font-weight: 750; letter-spacing: -0.035em; }
    .brand svg { display: block; }
    ${css}
  </style></head><body>${body}</body></html>`;
}

/** The mark from icon.svg; on the ink ground it gets a light ring, as the site's Mark does in dark mode. */
function mark(size: number, ring = false): string {
  const svg = readFileSync(ICON, 'utf8').replace(/<title>.*?<\/title>/s, '');
  const ringRect = ring
    ? '<rect x="1" y="1" width="126" height="126" rx="27" fill="none" stroke="rgb(231 235 243 / 0.28)" stroke-width="2"/>'
    : '';
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" `).replace('</svg>', `${ringRect}</svg>`);
}

/** A tall capture beside a headline, on the paper ground: for captures that are not 16:10. */
function composed(file: string, title: string, sub: string, imageHeight: number): string {
  return page(
    1280,
    800,
    `<div class="wrap">
      <div class="copy"><p class="brand">${mark(40)}<span>InkUp</span></p><h1>${title}</h1><p>${sub}</p></div>
      <img src="${capture(file)}" style="height:${imageHeight}px">
    </div>`,
    `body { background: ${paper2}; }
     .wrap { display: flex; align-items: center; justify-content: center; gap: 88px; height: 100%; padding: 0 96px; }
     .copy { width: 520px; }
     .brand { gap: 12px; font-size: 26px; margin-bottom: 40px; }
     h1 { font-size: 58px; }
     .copy p:last-child { margin-top: 24px; font-size: 25px; }
     img { display: block; border-radius: 14px; border: 1px solid rgb(31 42 68 / 0.16);
       box-shadow: 0 24px 60px -24px rgb(31 42 68 / 0.35); }`,
  );
}

/** A 1440×900 capture scaled to fill the screenshot. */
const scaled = (file: string) =>
  page(1280, 800, `<img src="${capture(file)}" style="display:block;width:1280px;height:800px">`);

function html(asset: StoreAsset): string {
  switch (asset.file) {
    case 'screenshot-3-drafts.png':
      return composed(
        'drafts.png',
        'Every note becomes a draft change while you talk.',
        'Pin the ones you want and discard the rest. Say “scratch that” to drop the last one.',
        700,
      );
    case 'screenshot-5-phone-width.png':
      return composed(
        'stroke-mobile.png',
        'Review a phone layout the same way.',
        'Circle, point and talk through a narrow page just as you would a wide one.',
        700,
      );
    case 'small-promo-440x280.png':
      return page(
        440,
        280,
        `<div class="tile"><p class="brand">${mark(48, true)}<span>InkUp</span></p>
          <h1>Review your site out loud.</h1></div>`,
        `body { background: ${ink}; color: #fff; }
         .tile { padding: 36px 36px 0; }
         .brand { gap: 12px; font-size: 28px; }
         h1 { margin-top: 34px; font-size: 46px; max-width: 8.6ch; }`,
      );
    case 'marquee-promo-1400x560.png':
      return page(
        1400,
        560,
        `<div class="copy"><p class="brand">${mark(56, true)}<span>InkUp</span></p>
          <h1>Review your site out loud.</h1>
          <p>Talk through a web page and draw on it. Get a list of changes for you or your coding agent.</p></div>
         <div class="shot"><img src="${capture('stroke.png')}"></div>`,
        `body { background: ${ink}; color: #fff; position: relative; }
         .copy { position: absolute; left: 80px; top: 72px; width: 560px; }
         .brand { gap: 14px; font-size: 34px; }
         h1 { margin-top: 48px; font-size: 76px; }
         .copy p:last-child { margin-top: 28px; font-size: 25px; color: #c3cadb; }
         .shot { position: absolute; left: 700px; top: 70px; width: 820px; height: 520px; overflow: hidden;
           border-radius: 14px; border: 1px solid rgb(231 235 243 / 0.28); box-shadow: 0 30px 80px -20px rgb(0 0 0 / 0.5); }
         .shot img { display: block; width: 960px; margin: -40px 0 0 -100px; }`,
      );
    case 'icon-128.png':
      // The store asks for 96 px of artwork inside 16 px of transparent padding.
      return page(128, 128, `<div style="padding:16px">${mark(96)}</div>`, 'html, body { background: transparent; }');
    default:
      return scaled(asset.from[0]!);
  }
}

/** Writes every asset and manifest.json into `out`, replacing what was there. */
export async function render(out = OUT): Promise<void> {
  const captures = JSON.parse(readFileSync(join(CAPTURES, 'manifest.json'), 'utf8')) as {
    assets: { file: string; extensionVersion: string }[];
  };
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const asset of ASSETS) {
      const page = await browser.newPage({ viewport: { width: asset.width, height: asset.height } });
      await page.setContent(html(asset), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(out, asset.file), omitBackground: asset.kind === 'icon' });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const versions = new Set(
    ASSETS.flatMap((a) => a.from).map((f) => captures.assets.find((c) => c.file === f)?.extensionVersion),
  );
  const manifest = {
    source: 'scripts/store-assets.ts',
    captures: 'apps/site/src/assets/captures',
    extensionVersion: [...versions].join(', '),
    assets: ASSETS,
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${readdirSync(out).length} files to ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await render();
