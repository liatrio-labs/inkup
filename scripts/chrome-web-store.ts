// `node scripts/chrome-web-store.ts <zip> <version>`: uploads the extension zip to the Chrome Web Store and submits it
// for review, through the Chrome Web Store API v2 (https://developer.chrome.com/docs/webstore/using-api), unless the
// store says not to (see `decide`): at most one review is in flight, and a version the store already has is not sent
// again. release.yml runs it on each release, and chrome-web-store-sync.yml daily with the newest release's zip, both
// with an access token from keyless GitHub OIDC (docs/releasing.md, "One-time Chrome Web Store setup"). Environment:
// CHROME_ACCESS_TOKEN, CHROME_PUBLISHER_ID, CHROME_EXTENSION_ID, and CHROME_SKIP_SUBMIT_REVIEW=true to upload only.

import { readFileSync } from 'node:fs';

const API = 'https://chromewebstore.googleapis.com';

export interface StoreOptions {
  token: string;
  publisherId: string;
  itemId: string;
  zip: Uint8Array<ArrayBuffer>;
  /** The zip's manifest version, compared with what the store has. */
  version: string;
  skipSubmit: boolean;
  /** The API origin; tests point it at a local server. */
  api?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  pollIntervalMs?: number;
  pollAttempts?: number;
}

/** What the store answered: the item's state after publishing, or `null` when the submit or the upload was skipped. */
export interface StoreResult {
  crxVersion: string | undefined;
  state: string | null;
  /** Why nothing was uploaded, when `decide` said to skip. */
  skipped?: string;
}

/** The parts of fetchStatus `decide` reads. The `state` values are ItemState's:
 * https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus
 * https://developer.chrome.com/docs/webstore/api/reference/rest/v2/ItemState */
export interface ItemStatus {
  publishedItemRevisionStatus?: RevisionStatus;
  submittedItemRevisionStatus?: RevisionStatus;
  lastAsyncUploadState?: string;
}
interface RevisionStatus {
  state?: string;
  distributionChannels?: { crxVersion?: string; deployPercentage?: number }[];
}

export type Decision = { upload: true } | { upload: false; level: 'notice' | 'warning'; message: string };

/**
 * Whether to upload `version`, given the item's fetchStatus. Uploading while a submission is in review fails (HTTP 400
 * "You may not edit or publish an item that is in review"), and cancelling that submission to make room would put the
 * item back at the end of the review queue, so a release waits for the review instead; chrome-web-store-sync.yml
 * retries the newest release daily.
 *
 * - A submission in review (PENDING_REVIEW): skip.
 * - The published revision (PUBLISHED or PUBLISHED_TO_TESTERS) is this version or newer: skip.
 * - The submitted revision is this version or newer: skip. STAGED (approved, waiting for someone to publish it in the
 *   dashboard) is left to that person. REJECTED is a warning: sending the same version again would be rejected again,
 *   so the fix ships as a newer release. CANCELLED was someone's call, which a daily resubmit would undo.
 * - Otherwise upload and submit. A staged, rejected or cancelled submission of an older version is replaced by this one.
 */
export function decide(status: ItemStatus, version: string): Decision {
  const submitted = status.submittedItemRevisionStatus;
  const submittedVersion = newest(submitted);
  if (submitted?.state === 'PENDING_REVIEW')
    return {
      upload: false,
      level: 'notice',
      message:
        `v${submittedVersion ?? '?'} is in Chrome Web Store review, so v${version} is not uploaded. ` +
        'The daily Chrome Web Store sync submits the newest release once the review clears.',
    };
  const publishedVersion = newest(status.publishedItemRevisionStatus);
  if (publishedVersion && compareVersions(publishedVersion, version) >= 0)
    return {
      upload: false,
      level: 'notice',
      message: `The Chrome Web Store has v${publishedVersion} published, so v${version} is not uploaded.`,
    };
  if (submittedVersion && compareVersions(submittedVersion, version) >= 0) {
    const state = submitted?.state ?? 'unknown';
    const why =
      state === 'STAGED'
        ? ' It is approved: publish it from the developer dashboard.'
        : state === 'REJECTED'
          ? ' Fix what the review found and release a newer version.'
          : '';
    return {
      upload: false,
      level: state === 'REJECTED' ? 'warning' : 'notice',
      message: `The Chrome Web Store's submission of v${submittedVersion} is ${state}, so v${version} is not uploaded.${why}`,
    };
  }
  return { upload: true };
}

/** The highest crxVersion across a revision's distribution channels. */
function newest(revision: RevisionStatus | undefined): string | undefined {
  const versions = (revision?.distributionChannels ?? []).flatMap((c) => (c.crxVersion ? [c.crxVersion] : []));
  return versions.sort(compareVersions).at(-1);
}

/** Compares Chrome manifest versions (one to four dot-separated integers), a missing part counting as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Checks the store with `decide`, then uploads the zip, waits out an asynchronous upload, and submits the item for
 * review unless `skipSubmit`. */
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

  // https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus
  const fetchStatus = (step: string) => call(step, `${api}/v2/${name}:fetchStatus`, { method: 'GET' });

  const decision = decide((await fetchStatus('status')) as ItemStatus, opts.version);
  if (!decision.upload) {
    log(`::${decision.level}::${decision.message}`);
    return { crxVersion: undefined, state: null, skipped: decision.message };
  }

  // https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload
  const upload = await call('upload', `${api}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: opts.zip,
  });
  let uploadState = upload.uploadState as string | undefined;
  log(`upload: ${uploadState ?? 'no uploadState'}`);

  for (let i = 0; uploadState === 'IN_PROGRESS'; i++) {
    if (i >= attempts) throw new Error(`upload still IN_PROGRESS after ${attempts} status checks`);
    await sleep(interval);
    const status = await fetchStatus('upload status');
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
  const [zipPath, version] = process.argv.slice(2);
  const { CHROME_ACCESS_TOKEN, CHROME_PUBLISHER_ID, CHROME_EXTENSION_ID, CHROME_SKIP_SUBMIT_REVIEW } = process.env;
  if (!zipPath || !version || !CHROME_ACCESS_TOKEN || !CHROME_PUBLISHER_ID || !CHROME_EXTENSION_ID) {
    console.error(
      'usage: CHROME_ACCESS_TOKEN=… CHROME_PUBLISHER_ID=… CHROME_EXTENSION_ID=… node scripts/chrome-web-store.ts <zip> <version>',
    );
    process.exit(2);
  }
  try {
    await uploadAndSubmit({
      token: CHROME_ACCESS_TOKEN,
      publisherId: CHROME_PUBLISHER_ID,
      itemId: CHROME_EXTENSION_ID,
      zip: new Uint8Array(readFileSync(zipPath)),
      version,
      skipSubmit: CHROME_SKIP_SUBMIT_REVIEW === 'true',
    });
  } catch (err) {
    console.log(`::error::Chrome Web Store ${(err as Error).message}`);
    process.exit(1);
  }
}
