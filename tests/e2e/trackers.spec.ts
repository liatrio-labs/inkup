// Tracker push, GitHub (spec 01 Unit 1, ADR 0028): the options page's Trackers section and the review page's Send to
// GitHub, against a local stand-in for the GitHub API (tests/support/github-stub.ts) through the dev-only
// `githubBaseUrl` override. A processed Session is seeded straight into IndexedDB, with two screenshots and an element
// crop, so no recording or model is involved.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { type GithubStub, startGithubStub } from '../support/github-stub';
import { expect, test } from './fixtures';
import { exportAndUnzip } from './helpers/export';
import { storeRows } from './helpers/seed';

const SESSION_ID = 'track-1';
const RUN_ID = 'run-track-1';
const TOKEN = 'github_pat_E2E_0123456789abcdef';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const page = {
  url: 'http://localhost:4401/pricing.html',
  scroll: { x: 0, y: 0 },
  viewport: { width: 1280, height: 720 },
  dpr: 1,
};
const shot = (id: string, t: number) => ({
  id: `ev-${id}`,
  type: 'screenshot',
  t,
  screenshot_id: id,
  path: `screenshots/${id}.png`,
  mime: 'image/png',
  trigger: 'panel',
  annotation_id: null,
  ...page,
});

const item = (n: number, screenshots: string[], crops: string[] = []) => ({
  id: `item_000${n}`,
  title: n === 1 ? 'Make the Get started button larger' : 'Tighten the pricing table',
  category: 'style',
  intent: n === 1 ? 'The primary call to action is too small to notice.' : 'The rows are too far apart.',
  locations: [
    {
      role: 'subject',
      selector: n === 1 ? 'button.cta' : 'table.pricing',
      element: n === 1 ? "button 'Get started'" : 'pricing table',
      url: '/pricing.html',
      screenshot: screenshots[0] ?? null,
      annotation: null,
    },
  ],
  evidence: { video: null, screenshots, ...(crops.length ? { crops } : {}) },
  transcript: n === 1 ? 'this button is way too small' : 'these rows are too far apart',
  confidence: 0.9,
  ...(n === 1 ? { ambiguity: 'How much larger is not said.' } : {}),
  agent_prompt: `Fix it. ${screenshots.map((s) => `See screenshots/${s}.png.`).join(' ')}`,
  pinned: false,
});

/** A processed, ended Session "Pricing page review" with two items, two screenshots and one element crop. */
async function seedProcessed(p: Page): Promise<void> {
  await expect
    .poll(() => p.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  const rows = {
    session: {
      id: SESSION_ID,
      tab_id: 1,
      t0: 1_790_000_000_000,
      started_at: '2026-10-07T10:00:00.000Z',
      ended_at: '2026-10-07T10:00:05.000Z',
      duration_ms: 5000,
      start_url: page.url,
      start_title: 'Pricing page review',
      status: 'ended',
      transcription: null,
      video_off_reason: null,
      media_deleted_at: null,
      audio: null,
      video: null,
    },
    events: [
      {
        id: 'ev-start',
        type: 'session_start',
        t: 0,
        tab_id: 1,
        url: page.url,
        title: 'Pricing page review',
        t0: 1_790_000_000_000,
        clicked_at: null,
        overlay: 'page',
        voice: true,
      },
      shot('s-abc', 1000),
      shot('s-def', 2000),
      { id: 'ev-end', type: 'session_end', t: 5000, reason: 'stop', duration_ms: 5000 },
    ],
    run: {
      id: RUN_ID,
      session_id: SESSION_ID,
      created_at: 1,
      finished_at: 2,
      status: 'done',
      model: 'seeded',
      estimate: null,
      items: [item(1, ['s-abc', 's-def'], ['s-abc.crop']), item(2, ['s-def'])],
      calls: [],
      second_pass: [],
      error: null,
      error_code: null,
    },
    blobs: [
      ['s-abc', 'screenshot'],
      ['s-def', 'screenshot'],
      ['s-abc.crop', 'screenshot_crop'],
    ],
  };
  await p.evaluate(
    async ({ rows, png }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const tx = idb.transaction(['sessions', 'events', 'blobs', 'processRuns'], 'readwrite');
      tx.objectStore('sessions').put(rows.session);
      for (const e of rows.events) tx.objectStore('events').add({ ...e, session_id: rows.session.id });
      tx.objectStore('processRuns').put(rows.run);
      for (const [id, kind] of rows.blobs)
        tx.objectStore('blobs').put({
          id,
          session_id: rows.session.id,
          kind,
          mime: 'image/png',
          size: bytes.length,
          t: 0,
          seq: 0,
          blob: new Blob([bytes], { type: 'image/png' }),
        });
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      idb.close();
    },
    { rows, png: PNG_1X1 },
  );
}

/** Points the extension at the stub; with `saveToken`, also saves the token and acme/web as the default repo. */
async function configureGithub(sw: Worker, stub: GithubStub, saveToken = true) {
  await sw.evaluate(
    async ({ base, token }) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        devOverrides: { ...(devOverrides ?? {}), githubBaseUrl: base },
        ...(token
          ? { githubToken: token, githubNoticeShown: true, trackerSettings: { github: { repo: 'acme/web' } } }
          : {}),
      });
    },
    { base: stub.baseURL, token: saveToken ? TOKEN : null },
  );
}

async function downloadSessionJson(review: Page, sw: Worker) {
  await review.evaluate(() => delete document.body.dataset.downloadId);
  await review.getByTestId('download-session').click();
  await expect.poll(() => review.evaluate(() => document.body.dataset.downloadId ?? null)).not.toBeNull();
  const id = Number(await review.evaluate(() => document.body.dataset.downloadId));
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  const file = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const card = (review: Page, id: string) => review.locator(`[data-testid="change-item"][data-item-id="${id}"]`);
const issueCreates = (stub: GithubStub) => stub.calls('POST', /^\/repos\/acme\/web\/issues$/);

async function openReview(openExtensionPage: (path: string) => Promise<Page>): Promise<Page> {
  const list = await openExtensionPage('sessions.html');
  await seedProcessed(list);
  await list.close();
  const review = await openExtensionPage(`review.html?session=${SESSION_ID}`);
  await expect(review.getByTestId('change-item')).toHaveCount(2);
  return review;
}

test('without a tracker each card links to Trackers settings; saving a token shows the notice once, masks it, lists repos, and Test names the missing permission', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const stub = await startGithubStub({
    token: TOKEN,
    repos: [{ full_name: 'acme/web', contents_write: false }, { full_name: 'acme/api' }],
  });
  try {
    await configureGithub(serviceWorker, stub, false);
    const review = await openReview(openExtensionPage);
    await expect(review.getByTestId('tracker-settings-link')).toHaveCount(2);
    await expect(review.getByTestId('tracker-settings-link').first()).toHaveAttribute('href', '/options.html#trackers');
    await expect(review.getByTestId('send-to-github')).toHaveCount(0);
    expect(stub.requests).toHaveLength(0);

    const options = await openExtensionPage('options.html');
    await options.getByTestId('github-token').fill(TOKEN);
    await options.getByTestId('save-github-token').click();
    const notice = options.getByTestId('github-notice');
    await expect(notice).toContainText('What goes to GitHub');
    await expect(notice).toContainText('inkup-assets');
    await expect(notice).toContainText('Anyone who can read the repo can see those screenshots');
    await notice.getByRole('button', { name: 'Got it' }).click();
    await expect(notice).toHaveCount(0);
    await expect(options.getByTestId('github-token')).toHaveValue('');
    await expect(options.getByTestId('github-token-saved')).toHaveText('Saved: github_…cdef');
    expect(await options.locator('body').innerText()).not.toContain(TOKEN);

    // The default repo is picked from what the token can see.
    const repo = options.getByTestId('github-repo');
    await expect(repo.locator('option')).toHaveText(['Pick a repo', 'acme/web', 'acme/api']);
    await repo.selectOption('acme/web');
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () => (await chrome.storage.local.get('trackerSettings')).trackerSettings),
      )
      .toEqual({ github: { repo: 'acme/web' } });

    await options.getByTestId('test-github').click();
    const result = options.getByTestId('github-test-result');
    await expect(result.locator('[data-check="token"]')).toContainText('The token works');
    await expect(result.locator('[data-check="repo"]')).toHaveText('OK: acme/web is reachable.');
    await expect(result.locator('[data-check="issues"]')).toHaveText('OK: Issues are enabled.');
    await expect(result.locator('[data-check="contents"]')).toHaveText(
      "Problem: This token can't write to acme/web. Give it Contents: read and write.",
    );

    // A second token later: no notice again.
    await options.getByTestId('github-token').fill(`${TOKEN}-2`);
    await options.getByTestId('save-github-token').click();
    await expect(options.locator('#trackers').getByRole('status')).toHaveText('GitHub token saved.');
    await expect(options.getByTestId('github-notice')).toHaveCount(0);

    // The review page now offers Send to GitHub.
    await review.reload();
    await expect(review.getByTestId('send-to-github')).toHaveCount(2);
  } finally {
    await stub.close();
  }
});

test('Send to GitHub commits the screenshots, creates the issue, keeps the link through Undo, reload and export, and shows live status', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const stub = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web' }] });
  try {
    await configureGithub(serviceWorker, stub);
    const review = await openReview(openExtensionPage);
    const first = card(review, 'item_0001');

    // Two edits first, to undo after the send.
    await first.getByTestId('edit-item').click();
    await first.getByTestId('edit-title').fill('Make Get started bigger');
    await first.getByTestId('save-item').click();
    await expect(first.getByTestId('item-title')).toHaveText('Make Get started bigger');
    await first.getByTestId('edit-item').click();
    await first.getByTestId('edit-intent').fill('Nobody notices the call to action.');
    await first.getByTestId('save-item').click();
    await expect(first.getByTestId('item-intent')).toHaveText('Nobody notices the call to action.');

    // A token without Issues write: the error in plain words, and Retry.
    stub.fail((req) =>
      req.method === 'POST' && req.path === '/repos/acme/web/issues'
        ? { status: 403, body: { message: 'Resource not accessible by personal access token' } }
        : undefined,
    );
    await first.getByTestId('send-to-github').click();
    await expect(first.getByTestId('tracker-error')).toHaveText(
      "This token can't create issues in acme/web. Give it Issues: read and write.",
    );
    await expect(first.getByTestId('tracker-retry')).toBeVisible();
    const linkEvents = async () =>
      (await storeRows<{ type: string }>(review, 'events')).filter((e) => e.type === 'tracker_link');
    expect(await linkEvents()).toHaveLength(0);

    // The first attempt already made the branch: blobs, a tree, a commit with no parent, then the ref, in order.
    const git = stub.requests
      .filter((r) => r.path.includes('/git/'))
      .map((r) => `${r.method} ${r.path.replace('/repos/acme/web', '')}`);
    expect(git.slice(0, 7)).toEqual([
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/blobs',
      'GET /git/ref/heads/inkup-assets',
      'POST /git/trees',
      'POST /git/commits',
      'POST /git/refs',
    ]);
    expect(stub.calls('POST', /\/git\/commits$/)[0]!.body.parents).toEqual([]);
    expect(stub.calls('POST', /\/git\/refs$/)[0]!.body.ref).toBe('refs/heads/inkup-assets');
    expect(stub.calls('POST', /\/git\/trees$/)[0]!.body.tree.map((e: { path: string }) => e.path)).toEqual([
      `inkup/${SESSION_ID}/s-abc.png`,
      `inkup/${SESSION_ID}/s-def.png`,
      `inkup/${SESSION_ID}/s-abc.crop.png`,
    ]);

    stub.fail(null);
    await first.getByTestId('tracker-retry').click();
    await expect(first.getByTestId('tracker-link')).toHaveText('GitHub #1');
    await expect(first.getByTestId('tracker-link')).toHaveAttribute('href', 'https://github.com/acme/web/issues/1');
    await expect(first.getByTestId('tracker-status')).toHaveText('open');
    await expect(first.getByTestId('send-to-github')).toHaveCount(0);
    const repo = stub.repo('acme/web');
    expect(repo.issues).toHaveLength(1);
    expect(repo.issues[0]!.title).toBe('Make Get started bigger');
    const body = repo.issues[0]!.body;
    for (const id of ['s-abc', 's-def', 's-abc.crop'])
      expect(body).toContain(`https://github.com/acme/web/blob/inkup-assets/inkup/${SESSION_ID}/${id}.png?raw=true`);
    expect(body).toContain('Sent from InkUp · Pricing page review · item_0001');
    // The retry added one commit on top of the orphan commit the failed attempt made.
    const [orphanSha] = repo.commits.keys();
    expect(repo.commits.get(orphanSha!)!.parents).toEqual([]);
    expect(repo.commits.get(repo.refs.get('heads/inkup-assets')!)!.parents).toEqual([orphanSha]);
    expect(await linkEvents()).toHaveLength(1);

    // Undo twice (both edits) and Redo once (the title): the link stays.
    await review.getByTestId('undo-items').click();
    await expect(first.getByTestId('item-intent')).toHaveText('The primary call to action is too small to notice.');
    await review.getByTestId('undo-items').click();
    await expect(first.getByTestId('item-title')).toHaveText('Make the Get started button larger');
    await review.getByTestId('redo-items').click();
    await expect(first.getByTestId('item-title')).toHaveText('Make Get started bigger');
    await expect(first.getByTestId('tracker-link')).toHaveText('GitHub #1');
    expect(await linkEvents()).toHaveLength(1);

    // After a reload: "GitHub #1 · open".
    await review.reload();
    await expect(card(review, 'item_0001').getByTestId('tracker-line')).toHaveText('GitHub #1 · open');

    // session.json and the zip carry the link, and no status.
    const expected = {
      tracker: 'github',
      destination: 'acme/web',
      key: '#1',
      url: 'https://github.com/acme/web/issues/1',
      created_at: expect.any(String),
    };
    const doc = await downloadSessionJson(review, serviceWorker);
    const exported = doc.change_items.find((i: { id: string }) => i.id === 'item_0001');
    expect(exported.tracker_links).toEqual([expected]);
    expect(Object.keys(exported.tracker_links[0]).sort()).toEqual([
      'created_at',
      'destination',
      'key',
      'tracker',
      'url',
    ]);
    expect(doc.change_items.find((i: { id: string }) => i.id === 'item_0002').tracker_links).toBeUndefined();
    expect(JSON.stringify(doc)).not.toMatch(/"(state|state_reason|status_label)"/);
    const { dir } = await exportAndUnzip(review, serviceWorker);
    const zipped = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    expect(zipped.change_items.find((i: { id: string }) => i.id === 'item_0001').tracker_links).toEqual([expected]);

    // The second item: issue 2.
    await card(review, 'item_0002').getByTestId('send-to-github').click();
    await expect(card(review, 'item_0002').getByTestId('tracker-link')).toHaveText('GitHub #2');
    await expect(card(review, 'item_0002').getByTestId('tracker-status')).toHaveText('open');

    // Live status: closed as completed, closed as not planned, and a failed read that blocks nothing.
    Object.assign(repo.issues[0]!, { state: 'closed', state_reason: 'completed' });
    await review.reload();
    await expect(card(review, 'item_0001').getByTestId('tracker-status')).toHaveText('closed (completed)');
    Object.assign(repo.issues[0]!, { state: 'closed', state_reason: 'not_planned' });
    await review.reload();
    await expect(card(review, 'item_0001').getByTestId('tracker-status')).toHaveText('closed (not planned)');
    stub.fail((req) =>
      req.method === 'GET' && req.path === '/repos/acme/web/issues/1'
        ? { status: 500, body: { message: 'boom' } }
        : undefined,
    );
    await review.reload();
    await expect(card(review, 'item_0001').getByTestId('tracker-status')).toHaveText('status unavailable');
    await expect(card(review, 'item_0002').getByTestId('tracker-status')).toHaveText('open');
    await card(review, 'item_0001').getByTestId('edit-item').click();
    await expect(card(review, 'item_0001').getByTestId('edit-title')).toBeVisible();
    stub.fail(null);
  } finally {
    await stub.close();
  }
});

test('sending a linked item again is in the menu, behind a confirm', async ({ serviceWorker, openExtensionPage }) => {
  const stub = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web' }] });
  try {
    await configureGithub(serviceWorker, stub);
    const review = await openReview(openExtensionPage);
    const first = card(review, 'item_0001');
    await first.getByTestId('send-to-github').click();
    await expect(first.getByTestId('tracker-link')).toHaveText('GitHub #1');
    expect(issueCreates(stub)).toHaveLength(1);

    // No primary send button once linked; Send again sits in the menu.
    await expect(first.getByTestId('send-to-github')).toHaveCount(0);
    await first.getByTestId('tracker-menu').click();
    await expect(first.getByRole('menuitem', { name: 'Send again' })).toBeVisible();
    await first.getByTestId('tracker-send-again').click();
    const confirm = review.getByTestId('tracker-confirm');
    await expect(confirm).toContainText('It is already GitHub #1 in acme/web');
    await review.getByTestId('tracker-confirm-cancel').click();
    await expect(confirm).toHaveCount(0);
    expect(issueCreates(stub)).toHaveLength(1);

    await first.getByTestId('tracker-menu').click();
    await first.getByTestId('tracker-send-again').click();
    await review.getByTestId('tracker-confirm-send').click();
    await expect(first.getByTestId('tracker-link')).toHaveText('GitHub #2');
    expect(stub.repo('acme/web').issues).toHaveLength(2);
  } finally {
    await stub.close();
  }
});
