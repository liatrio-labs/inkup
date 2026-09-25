// `node scripts/chrome-web-store.ts <zip>`: uploads the extension zip to the Chrome Web Store and submits it for review,
// through the Chrome Web Store API v2 (https://developer.chrome.com/docs/webstore/using-api). release.yml runs it with
// an access token from keyless GitHub OIDC (docs/releasing.md, "One-time Chrome Web Store setup"). Environment:
// CHROME_ACCESS_TOKEN, CHROME_PUBLISHER_ID, CHROME_EXTENSION_ID, and CHROME_SKIP_SUBMIT_REVIEW=true to upload only.

import { readFileSync } from 'node:fs';

const API = 'https://chromewebstore.googleapis.com';

export interface StoreOptions {
  token: string;
  publisherId: string;
  itemId: string;
  zip: Uint8Array<ArrayBuffer>;
  skipSubmit: boolean;
  /** The API origin; tests point it at a local server. */
  api?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  pollIntervalMs?: number;
  pollAttempts?: number;
}

/** What the store answered: the item's state after publishing, or `null` when the submit was skipped. */
export interface StoreResult {
  crxVersion: string | undefined;
  state: string | null;
}

/** Uploads the zip, waits out an asynchronous upload, then submits the item for review unless `skipSubmit`. */
export async function uploadAndSubmit(opts: StoreOptions): Promise<StoreResult> {
  const api = opts.api ?? API;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line) => console.log(line));
  const interval = opts.pollIntervalMs ?? 5_000;
  const attempts = opts.pollAttempts ?? 60;
  const name = `publishers/${encodeURIComponent(opts.publisherId)}/items/${encodeURIComponent(opts.itemId)}`;
  const auth = { Authorization: `Bearer ${opts.token}` };

  const call = async (step: string, url: string, init: RequestInit) => {
    const res = await fetch(url, { ...init, headers: { ...auth, ...init.headers } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${step} failed: HTTP ${res.status} ${errorMessage(text)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  // https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload
  const upload = await call('upload', `${api}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: opts.zip,
  });
  let uploadState = upload.uploadState as string | undefined;
  log(`upload: ${uploadState ?? 'no uploadState'}`);

  // https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus
  for (let i = 0; uploadState === 'IN_PROGRESS'; i++) {
    if (i >= attempts) throw new Error(`upload still IN_PROGRESS after ${attempts} status checks`);
    await sleep(interval);
    const status = await call('upload status', `${api}/v2/${name}:fetchStatus`, { method: 'GET' });
    uploadState = status.lastAsyncUploadState as string | undefined;
    log(`upload status: ${uploadState ?? 'no lastAsyncUploadState'}`);
  }
  if (uploadState !== 'SUCCEEDED') throw new Error(`upload ended in state ${uploadState ?? 'unknown'}`);

  const crxVersion = upload.crxVersion as string | undefined;
  if (opts.skipSubmit) {
    log('CHROME_SKIP_SUBMIT_REVIEW=true: uploaded, not submitted for review.');
    return { crxVersion, state: null };
  }

  // https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
  const published = await call('publish', `${api}/v2/${name}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const state = (published.state as string | undefined) ?? 'unknown';
  log(`publish: ${state}`);
  return { crxVersion, state };
}

/** The message of a Google API error body (`{"error": {"message": ...}}`), or the body itself, trimmed. */
function errorMessage(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    if (message) return message;
  } catch {}
  return text.slice(0, 500);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const zipPath = process.argv[2];
  const { CHROME_ACCESS_TOKEN, CHROME_PUBLISHER_ID, CHROME_EXTENSION_ID, CHROME_SKIP_SUBMIT_REVIEW } = process.env;
  if (!zipPath || !CHROME_ACCESS_TOKEN || !CHROME_PUBLISHER_ID || !CHROME_EXTENSION_ID) {
    console.error(
      'usage: CHROME_ACCESS_TOKEN=… CHROME_PUBLISHER_ID=… CHROME_EXTENSION_ID=… node scripts/chrome-web-store.ts <zip>',
    );
    process.exit(2);
  }
  try {
    await uploadAndSubmit({
      token: CHROME_ACCESS_TOKEN,
      publisherId: CHROME_PUBLISHER_ID,
      itemId: CHROME_EXTENSION_ID,
      zip: new Uint8Array(readFileSync(zipPath)),
      skipSubmit: CHROME_SKIP_SUBMIT_REVIEW === 'true',
    });
  } catch (err) {
    console.log(`::error::Chrome Web Store ${(err as Error).message}`);
    process.exit(1);
  }
}
