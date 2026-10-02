// @vitest-environment node
// The Chrome Web Store listing images (scripts/store-assets.ts, committed in extensions/web/store/chrome) are the sizes
// the store accepts (https://developer.chrome.com/docs/webstore/images) and match their manifest.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSETS, OUT, type StoreAsset } from '../../scripts/store-assets.ts';

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { assets: StoreAsset[] };

/** A PNG's size from its IHDR chunk. */
function pngSize(file: string) {
  const png = readFileSync(join(OUT, file));
  expect(png.toString('latin1', 1, 4)).toBe('PNG');
  expect(png.toString('latin1', 12, 16)).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('Chrome Web Store listing assets', () => {
  it('the committed manifest is what the script writes now', () => {
    expect(manifest.assets).toEqual(ASSETS);
  });

  it('the folder holds exactly the manifest and its images', () => {
    expect(readdirSync(OUT).sort()).toEqual(['manifest.json', ...manifest.assets.map((a) => a.file)].sort());
  });

  it.each(manifest.assets)('$file is $width×$height', (asset) => {
    expect(pngSize(asset.file)).toEqual({ width: asset.width, height: asset.height });
  });

  it('has the sizes and counts the store takes', () => {
    const of = (kind: StoreAsset['kind']) => manifest.assets.filter((a) => a.kind === kind);
    const screenshots = of('screenshot');
    expect(screenshots.length).toBeGreaterThanOrEqual(1);
    expect(screenshots.length).toBeLessThanOrEqual(5);
    for (const s of screenshots) expect([s.width, s.height]).toEqual([1280, 800]);
    expect(of('small-promo').map((a) => [a.width, a.height])).toEqual([[440, 280]]);
    expect(of('marquee-promo').map((a) => [a.width, a.height])).toEqual([[1400, 560]]);
    expect(of('icon').map((a) => [a.width, a.height])).toEqual([[128, 128]]);
  });
});
