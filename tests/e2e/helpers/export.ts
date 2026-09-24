// The review page's Export, as a reviewer runs it: click, wait for chrome.downloads, unzip into a fresh directory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, type Worker } from '@playwright/test';

export async function exportAndUnzip(review: Page, sw: Worker): Promise<{ dir: string; files: string[]; zip: string }> {
  await review.evaluate(() => delete document.body.dataset.exportDownloadId);
  await review.getByTestId('export-zip').click();
  await expect(review.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const id = Number(await review.evaluate(() => document.body.dataset.exportDownloadId));
  const item = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!, id);
  expect(item.state).toBe('complete');
  const dir = mkdtempSync(join(tmpdir(), 'var-export-'));
  execFileSync('unzip', ['-q', item.filename, '-d', dir]);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
    .sort();
  return { dir, files, zip: item.filename };
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
