// Tracker push (spec 01, ADR 0028): the options page's Trackers section and the review page's Send to GitHub (Unit 1)
// and to Linear, in bulk and to a chosen team (Unit 2), against local stand-ins for the trackers' APIs
// (tests/support/github-stub.ts, linear-stub.ts) through the dev-only `githubBaseUrl` and `linearBaseUrl` overrides. A processed Session is seeded straight into IndexedDB, with two screenshots and an element
// crop, so no recording or model is involved.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { type GithubStub, startGithubStub } from '../support/github-stub';
import { type LinearStub, startLinearStub } from '../support/linear-stub';
import { expect, test } from './fixtures';
import { exportAndUnzip } from './helpers/export';
import { storeRows } from './helpers/seed';

const SESSION_ID = 'track-1';
const RUN_ID = 'run-track-1';
const TOKEN = 'github_pat_E2E_0123456789abcdef';
const LINEAR_KEY = 'lin_api_E2E_key';
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

const TITLES = [
  'Make the Get started button larger',
  'Tighten the pricing table',
  'Align the footer links',
  'Rename the Pricing tab',
];

const item = (n: number, screenshots: string[], crops: string[] = []) => ({
  id: `item_000${n}`,
  title: TITLES[n - 1] ?? `Item ${n}`,
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

/** A processed, ended Session "Pricing page review" with `count` items, two screenshots and one element crop. */
async function seedProcessed(p: Page, count = 2): Promise<void> {
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
      items: [
        item(1, ['s-abc', 's-def'], ['s-abc.crop']),
        ...Array.from({ length: count - 1 }, (_, i) => item(i + 2, ['s-def'])),
      ],
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

async function openReview(openExtensionPage: (path: string) => Promise<Page>, count = 2): Promise<Page> {
  const list = await openExtensionPage('sessions.html');
  await seedProcessed(list, count);
  await list.close();
  const review = await openExtensionPage(`review.html?session=${SESSION_ID}`);
  await expect(review.getByTestId('change-item')).toHaveCount(count);
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
    const repo = options.getByTestId('github-destination');
    await expect(repo.locator('option')).toHaveText(['Pick one', 'acme/web', 'acme/api']);
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
    await expect(confirm).toContainText('It is already GitHub #1');
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

// ---- Linear, bulk send and the per-send destination picker (spec 01 Unit 2) ----

const TEAMS = [
  { id: 'team-web', key: 'WEB', name: 'Web' },
  { id: 'team-ops', key: 'OPS', name: 'Operations' },
];

/** Points the extension at the stubs; each tracker given is also set up (key, notice seen, default destination). */
async function configureTrackers(sw: Worker, set: { github?: GithubStub; linear?: LinearStub; team?: string }) {
  await sw.evaluate(
    async ({ github, linear, team, token, key }) => {
      const stored = await chrome.storage.local.get(['devOverrides']);
      await chrome.storage.local.set({
        devOverrides: {
          ...(stored.devOverrides ?? {}),
          ...(github ? { githubBaseUrl: github } : {}),
          ...(linear ? { linearBaseUrl: linear } : {}),
        },
        ...(github ? { githubToken: token, githubNoticeShown: true } : {}),
        ...(linear ? { linearToken: key, linearNoticeShown: true } : {}),
        trackerSettings: {
          github: { repo: github ? 'acme/web' : '' },
          ...(linear ? { linear: { team } } : {}),
        },
      });
    },
    {
      github: set.github?.baseURL ?? null,
      linear: set.linear?.baseURL ?? null,
      team: set.team ?? 'team-web',
      token: TOKEN,
      key: LINEAR_KEY,
    },
  );
}

/** The part of a card that sends to one tracker. */
const row = (review: Page, itemId: string, tracker: string) =>
  card(review, itemId).locator(`[data-testid="send-to-tracker"][data-tracker="${tracker}"]`);

/** Records every progress text the bulk bar shows, in order, in `window.__progress`. */
async function recordProgress(review: Page) {
  await review.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __progress: string[] }).__progress = seen;
    new MutationObserver(() => {
      const text = document.querySelector('[data-testid="bulk-progress"]')?.textContent?.trim();
      if (text && seen.at(-1) !== text) seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const progressSeen = (review: Page) =>
  review.evaluate(() => (window as unknown as { __progress: string[] }).__progress);

test('Linear settings: a masked key, a one-time notice, the teams the key sees, and a Test that says a rejected key does not work', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const stub = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS });
  try {
    await serviceWorker.evaluate(
      (base) => chrome.storage.local.set({ devOverrides: { linearBaseUrl: base } }),
      stub.baseURL,
    );
    const options = await openExtensionPage('options.html');
    await options.getByTestId('linear-token').fill(LINEAR_KEY);
    await options.getByTestId('save-linear-token').click();
    const notice = options.getByTestId('linear-notice');
    await expect(notice).toContainText('What goes to Linear');
    await notice.getByRole('button', { name: 'Got it' }).click();
    await expect(notice).toHaveCount(0);
    await expect(options.getByTestId('linear-token')).toHaveValue('');
    await expect(options.getByTestId('linear-token-saved')).toHaveText('Saved: lin_api…_key');
    expect(await options.locator('body').innerText()).not.toContain(LINEAR_KEY);

    // The default team is picked from what the key sees.
    const team = options.getByTestId('linear-destination');
    await expect(team.locator('option')).toHaveText(['Pick one', 'Web (WEB)', 'Operations (OPS)']);
    await team.selectOption('team-web');
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () => (await chrome.storage.local.get('trackerSettings')).trackerSettings),
      )
      .toEqual({ github: { repo: '' }, linear: { team: 'team-web' } });
    await options.getByTestId('test-linear').click();
    const result = options.getByTestId('linear-test-result');
    await expect(result.locator('[data-check="token"]')).toContainText('The key works');
    await expect(result.locator('[data-check="team"]')).toHaveText('OK: Web is reachable.');
    await expect(result.locator('[data-check="uploads"]')).toHaveText('OK: The key can store screenshots.');

    // A key the stub rejects: plain words, and how to make a new one. The notice does not come back.
    await options.getByTestId('linear-token').fill('lin_api_WRONG');
    await options.getByTestId('save-linear-token').click();
    await expect(options.locator('#trackers').getByRole('status')).toHaveText('Linear API key saved.');
    await expect(options.getByTestId('linear-notice')).toHaveCount(0);
    await options.getByTestId('test-linear').click();
    await expect(options.getByTestId('linear-test-result')).toContainText("Linear didn't accept this key");
    await expect(options.getByTestId('linear-test-result')).toContainText('Make a new personal API key');
    // The GitHub block is unchanged beside it.
    await expect(options.getByTestId('github-token')).toBeVisible();
  } finally {
    await stub.close();
  }
});

test('Send to Linear uploads each screenshot, then creates the issue in the team with the asset URLs, and shows its workflow state', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const stub = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS });
  try {
    await configureTrackers(serviceWorker, { linear: stub });
    const review = await openReview(openExtensionPage);
    const first = card(review, 'item_0001');
    await expect(first.getByTestId('send-to-linear')).toHaveText('Send to Linear');
    await first.getByTestId('send-to-linear').click();
    await expect(first.getByTestId('tracker-link')).toHaveText('Linear WEB-1');
    await expect(first.getByTestId('tracker-link')).toHaveAttribute('href', 'https://linear.app/acme/issue/WEB-1/stub');
    await expect(first.getByTestId('tracker-status')).toHaveText('Todo');

    // Three images (two screenshots and a crop): every fileUpload, then every PUT, then issueCreate.
    expect(stub.requests.map((r) => r.operation).slice(0, 7)).toEqual([
      'fileUpload',
      'fileUpload',
      'fileUpload',
      'put',
      'put',
      'put',
      'issueCreate',
    ]);
    for (const r of stub.requests.filter((x) => x.operation !== 'put'))
      expect(r.headers.authorization, r.operation).toBe(LINEAR_KEY);
    for (const r of stub.requests.filter((x) => x.operation === 'put'))
      expect(r.headers.authorization, 'PUT to the signed URL').toBeUndefined();
    expect(stub.uploads.map((u) => u.filename)).toEqual(['s-abc.png', 's-def.png', 's-abc.crop.png']);
    expect(stub.uploads.every((u) => u.bytes && u.bytes.length === u.size)).toBe(true);
    const input = stub.calls('issueCreate')[0]!.variables.input;
    expect(input.teamId).toBe('team-web');
    expect(input.title).toBe('Make the Get started button larger');
    for (const u of stub.uploads) expect(input.description).toContain(u.assetUrl);
    expect(input.description).toContain('Sent from InkUp · Pricing page review · item_0001');

    // The workflow state's name is the badge.
    for (const [state, badge] of [
      [{ name: 'In Progress', type: 'started' }, 'In Progress'],
      [{ name: 'Done', type: 'completed' }, 'Done'],
      [{ name: 'Canceled', type: 'canceled' }, 'Canceled'],
      [{ name: 'Todo', type: 'unstarted' }, 'Todo'],
    ] as const) {
      stub.setState('WEB-1', state);
      await review.reload();
      await expect(card(review, 'item_0001').getByTestId('tracker-line')).toHaveText(`Linear WEB-1 · ${badge}`);
    }
  } finally {
    await stub.close();
  }
});

test('each configured tracker gets its own send button and link, and the export lists one tracker_link per tracker', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const github = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web' }] });
  const linear = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS });
  try {
    await configureTrackers(serviceWorker, { github, linear });
    const review = await openReview(openExtensionPage);
    const first = card(review, 'item_0001');
    await expect(first.getByTestId('send-to-github')).toHaveText('Send to GitHub');
    await expect(first.getByTestId('send-to-linear')).toHaveText('Send to Linear');

    await first.getByTestId('send-to-github').click();
    await expect(row(review, 'item_0001', 'github').getByTestId('tracker-link')).toHaveText('GitHub #1');
    await expect(first.getByTestId('send-to-linear')).toBeVisible();
    await first.getByTestId('send-to-linear').click();
    await expect(row(review, 'item_0001', 'linear').getByTestId('tracker-link')).toHaveText('Linear WEB-1');
    await expect(row(review, 'item_0001', 'github').getByTestId('tracker-link')).toHaveText('GitHub #1');
    await expect(first.getByTestId('send-to-github')).toHaveCount(0);
    await expect(first.getByTestId('send-to-linear')).toHaveCount(0);
    // The other item has no link yet, and still offers both.
    await expect(card(review, 'item_0002').getByTestId('send-to-linear')).toBeVisible();

    const doc = await downloadSessionJson(review, serviceWorker);
    const links = doc.change_items.find((i: { id: string }) => i.id === 'item_0001').tracker_links;
    expect(links.map((l: { tracker: string }) => l.tracker).sort()).toEqual(['github', 'linear']);
    expect(links.find((l: { tracker: string }) => l.tracker === 'linear')).toMatchObject({
      destination: 'team-web',
      key: 'WEB-1',
      url: 'https://linear.app/acme/issue/WEB-1/stub',
    });
  } finally {
    await github.close();
    await linear.close();
  }
});

test('the destination picker defaults to the saved team, lists the others, and applies to that send only', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const stub = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS });
  try {
    await configureTrackers(serviceWorker, { linear: stub, team: 'team-web' });
    const review = await openReview(openExtensionPage);
    const first = card(review, 'item_0001');
    await first.getByTestId('tracker-destination-toggle').click();
    const picker = first.getByTestId('tracker-destination');
    await expect(picker).toHaveValue('team-web');
    await expect(picker.locator('option')).toHaveText(['Web (WEB)', 'Operations (OPS)']);
    await picker.selectOption('team-ops');
    await first.getByTestId('send-to-linear').click();
    await expect(first.getByTestId('tracker-link')).toHaveText('Linear OPS-1');
    expect(stub.calls('issueCreate')).toHaveLength(1);
    expect(stub.calls('issueCreate')[0]!.variables.input.teamId).toBe('team-ops');

    // The saved default is untouched, and the next item's picker opens on it.
    const saved = await serviceWorker.evaluate(
      async () => (await chrome.storage.local.get('trackerSettings')).trackerSettings,
    );
    expect(saved).toEqual({ github: { repo: '' }, linear: { team: 'team-web' } });
    const second = card(review, 'item_0002');
    await second.getByTestId('tracker-destination-toggle').click();
    await expect(second.getByTestId('tracker-destination')).toHaveValue('team-web');
    await second.getByTestId('send-to-linear').click();
    await expect(second.getByTestId('tracker-link')).toHaveText('Linear WEB-1');
    expect(stub.calls('issueCreate')[1]!.variables.input.teamId).toBe('team-web');
  } finally {
    await stub.close();
  }
});

test('bulk send keeps going after a failure, never overlaps, and Retry sends the failed item', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const stub = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS, issueCreateDelayMs: 300 });
  try {
    await configureTrackers(serviceWorker, { linear: stub });
    const review = await openReview(openExtensionPage, 3);
    stub.fail((req) =>
      req.operation === 'issueCreate' && req.variables.input?.title === 'Tighten the pricing table'
        ? { status: 400, body: { errors: [{ message: 'Boom', extensions: { code: 'INTERNAL' } }] } }
        : undefined,
    );
    await recordProgress(review);

    await review.getByTestId('bulk-send-linear').click();
    const failed = review.getByTestId('bulk-failed');
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(review.getByTestId('bulk-progress')).toHaveText('Sent 2 of 3 to Linear. 1 failed.');
    expect((await progressSeen(review)).filter((t) => t.startsWith('Sending'))).toEqual([
      'Sending 1 of 3',
      'Sending 2 of 3',
      'Sending 3 of 3',
    ]);
    expect(stub.maxInFlightOf('issueCreate')).toBe(1);
    expect(stub.issues.map((i) => i.title)).toEqual(['Make the Get started button larger', 'Align the footer links']);
    await expect(card(review, 'item_0001').getByTestId('tracker-link')).toHaveText('Linear WEB-1');
    await expect(card(review, 'item_0003').getByTestId('tracker-link')).toHaveText('Linear WEB-2');
    await expect(failed.locator('li')).toHaveCount(1);
    await expect(failed.locator('li[data-item-id="item_0002"]')).toContainText('Tighten the pricing table');
    await expect(failed.getByTestId('bulk-retry')).toBeVisible();
    await expect(card(review, 'item_0002').getByTestId('tracker-link')).toHaveCount(0);

    stub.fail(null);
    await failed.getByTestId('bulk-retry').click();
    await expect(card(review, 'item_0002').getByTestId('tracker-link')).toHaveText('Linear WEB-3');
    await expect(review.getByTestId('bulk-failed')).toHaveCount(0);
    expect(stub.issues).toHaveLength(3);
  } finally {
    await stub.close();
  }
});

test('bulk send skips deleted items and items already in that tracker, and counts only what it sends', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const github = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web' }] });
  const linear = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS, issueCreateDelayMs: 300 });
  try {
    await configureTrackers(serviceWorker, { github, linear });
    const review = await openReview(openExtensionPage, 4);
    // item_0001 is in Linear, item_0002 only in GitHub, item_0003 is deleted, item_0004 is unsent.
    await card(review, 'item_0001').getByTestId('send-to-linear').click();
    await expect(row(review, 'item_0001', 'linear').getByTestId('tracker-link')).toHaveText('Linear WEB-1');
    await card(review, 'item_0002').getByTestId('send-to-github').click();
    await expect(row(review, 'item_0002', 'github').getByTestId('tracker-link')).toHaveText('GitHub #1');
    await card(review, 'item_0003').getByTestId('delete-item').click();
    await expect(review.getByTestId('change-item')).toHaveCount(3);

    await recordProgress(review);
    await review.getByTestId('bulk-send-linear').click();
    await expect(review.getByTestId('bulk-progress')).toHaveText('Sent 2 of 2 to Linear', { timeout: 30_000 });
    expect((await progressSeen(review)).filter((t) => t.startsWith('Sending'))).toEqual([
      'Sending 1 of 2',
      'Sending 2 of 2',
    ]);
    expect(linear.issues.map((i) => i.title)).toEqual([
      'Make the Get started button larger',
      'Tighten the pricing table',
      'Rename the Pricing tab',
    ]);
    // item_0001 keeps its one Linear link, and item_0002 keeps its GitHub one beside the new Linear one.
    await expect(row(review, 'item_0002', 'github').getByTestId('tracker-link')).toHaveText('GitHub #1');
    await expect(row(review, 'item_0002', 'linear').getByTestId('tracker-link')).toHaveText('Linear WEB-2');
    await expect(card(review, 'item_0001').getByTestId('tracker-link')).toHaveCount(1);
    expect(github.repo('acme/web').issues).toHaveLength(1);
    // Nothing is left unsent for Linear, so its bulk button is gone.
    await expect(review.getByTestId('bulk-send-linear')).toHaveCount(0);
  } finally {
    await github.close();
    await linear.close();
  }
});

test('a rate-limited bulk send waits for retry-after and carries on, with no item failed', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const stub = await startLinearStub({ key: LINEAR_KEY, teams: TEAMS });
  try {
    await configureTrackers(serviceWorker, { linear: stub });
    const review = await openReview(openExtensionPage, 3);
    let creates = 0;
    stub.fail((req) =>
      req.operation === 'issueCreate' && ++creates === 2
        ? { status: 429, body: {}, headers: { 'retry-after': '2' } }
        : undefined,
    );
    await review.getByTestId('bulk-send-linear').click();
    await expect(review.getByTestId('bulk-progress')).toContainText('asked to wait', { timeout: 30_000 });
    await expect(review.getByTestId('bulk-progress')).toHaveText('Sent 3 of 3 to Linear', { timeout: 30_000 });
    await expect(review.getByTestId('bulk-failed')).toHaveCount(0);
    expect(stub.issues).toHaveLength(3);
    // The second item was refused at the 429 and tried again about two seconds later.
    const [, limited, retried] = stub.calls('issueCreate');
    expect(retried!.at - limited!.at).toBeGreaterThanOrEqual(1800);
    for (const id of ['item_0001', 'item_0002', 'item_0003'])
      await expect(card(review, id).getByTestId('tracker-link')).toHaveCount(1);
  } finally {
    await stub.close();
  }
});
