// The GitHub adapter against tests/support/github-stub.ts, over real HTTP with Node's fetch: the request sequence of
// a push (blobs, tree, commit, ref, issue), the orphan branch, a second push on top, a refused ref update tried again,
// Test's checks, status reads, and the errors in plain words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type GithubStub, startGithubStub } from '../../../../tests/support/github-stub';
import {
  ASSETS_BRANCH,
  assetUrl,
  githubAdapter,
  type IssueItem,
  pushItem,
  type TrackerAdapter,
  TrackerError,
} from '../../src/trackers';

const TOKEN = 'github_pat_TEST_0123456789';
const creds = { token: TOKEN };
const SESSION = { id: 'sess-1', name: 'Pricing page review' };
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n + 1, n + 2]);

const item = (screenshots: string[], crops: string[] = []): IssueItem => ({
  id: 'item_0001',
  title: 'Make the Get started button larger',
  category: 'visual',
  intent: 'Too small.',
  locations: [{ role: 'subject', element: "button 'Get started'", url: '/pricing.html' }],
  transcript: 'make it bigger',
  agent_prompt: `Enlarge it. ${screenshots.map((s) => `screenshots/${s}.png`).join(' ')}`,
  evidence: { screenshots, crops },
});

let stub: GithubStub;
let github: TrackerAdapter;
beforeEach(async () => {
  stub = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web' }, { full_name: 'acme/api' }] });
  github = githubAdapter({ fetch, baseUrl: stub.baseURL });
});
afterEach(() => stub.close());

/** The requests as `METHOD path`, without the repo prefix. */
const sequence = () => stub.requests.map((r) => `${r.method} ${r.path.replace('/repos/acme/web', '')}`);

describe('githubAdapter', () => {
  it('creates an issue through the fetch and base URL it is given, and reads its status', async () => {
    const link = await github.createIssue(creds, 'acme/web', { title: 'T', body: 'B' });
    expect(stub.calls('POST', /^\/repos\/acme\/web\/issues$/)).toHaveLength(1);
    expect(stub.requests[0]!.body).toEqual({ title: 'T', body: 'B' });
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(link).toEqual({
      tracker: 'github',
      destination: 'acme/web',
      key: '#1',
      url: 'https://github.com/acme/web/issues/1',
    });
    expect(await github.getStatus(creds, link)).toEqual({ state: 'open' });
    Object.assign(stub.repo('acme/web').issues[0]!, { state: 'closed', state_reason: 'not_planned' });
    expect(await github.getStatus(creds, link)).toEqual({ state: 'closed', reason: 'not_planned' });
  });

  it('commits the first push to a new orphan inkup-assets branch: blobs, tree, commit, ref, then the issue', async () => {
    const link = await pushItem({
      adapter: github,
      credentials: creds,
      destination: 'acme/web',
      item: item(['s1', 's2'], ['s1.crop']),
      session: SESSION,
      images: [
        { id: 's1', bytes: png(1) },
        { id: 's2', bytes: png(2) },
        { id: 's1.crop', bytes: png(3) },
      ],
      now: () => new Date('2026-10-07T10:00:00.000Z'),
    });
    expect(sequence()).toEqual([
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/blobs',
      `GET /git/ref/heads/${ASSETS_BRANCH}`,
      'POST /git/trees',
      'POST /git/commits',
      'POST /git/refs',
      'POST /issues',
    ]);
    const [blob] = stub.calls('POST', /git\/blobs$/);
    expect(blob!.body).toEqual({ content: Buffer.from(png(1)).toString('base64'), encoding: 'base64' });
    const tree = stub.calls('POST', /git\/trees$/)[0]!.body;
    expect(tree.base_tree).toBeUndefined();
    expect(tree.tree.map((e: { path: string }) => e.path)).toEqual([
      'inkup/sess-1/s1.png',
      'inkup/sess-1/s2.png',
      'inkup/sess-1/s1.crop.png',
    ]);
    expect(stub.calls('POST', /git\/commits$/)[0]!.body.parents).toEqual([]);
    expect(stub.calls('POST', /git\/refs$/)[0]!.body.ref).toBe('refs/heads/inkup-assets');
    const repo = stub.repo('acme/web');
    expect(repo.refs.get('heads/inkup-assets')).toBe(stub.calls('POST', /git\/refs$/)[0]!.body.sha);

    const body: string = stub.calls('POST', /\/issues$/)[0]!.body.body;
    for (const id of ['s1', 's2', 's1.crop'])
      expect(body).toContain(`https://github.com/acme/web/blob/inkup-assets/inkup/sess-1/${id}.png?raw=true`);
    expect(body).not.toContain('screenshots/s1.png');
    expect(link).toEqual({
      tracker: 'github',
      destination: 'acme/web',
      key: '#1',
      url: 'https://github.com/acme/web/issues/1',
      created_at: '2026-10-07T10:00:00.000Z',
    });
  });

  it('adds a later push as one commit on top of the branch tip, keeping the earlier files', async () => {
    await github.uploadImages(creds, 'acme/web', 'sess-1', [{ id: 's1', bytes: png(1) }]);
    const repo = stub.repo('acme/web');
    const first = repo.refs.get('heads/inkup-assets')!;
    stub.requests.length = 0;
    const urls = await github.uploadImages(creds, 'acme/web', 'sess-2', [
      { id: 'a', bytes: png(4) },
      { id: 'b', bytes: png(5) },
      { id: 'c', bytes: png(6) },
    ]);
    expect(sequence()).toEqual([
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/blobs',
      'GET /git/ref/heads/inkup-assets',
      `GET /git/commits/${first}`,
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/inkup-assets',
    ]);
    const commit = stub.calls('POST', /git\/commits$/)[0]!.body;
    expect(commit.parents).toEqual([first]);
    const tip = repo.refs.get('heads/inkup-assets')!;
    expect(repo.commits.get(tip)!.parents).toEqual([first]);
    expect([...repo.trees.get(repo.commits.get(tip)!.tree)!.keys()].sort()).toEqual([
      'inkup/sess-1/s1.png',
      'inkup/sess-2/a.png',
      'inkup/sess-2/b.png',
      'inkup/sess-2/c.png',
    ]);
    expect(urls.get('b')).toBe(assetUrl('acme/web', 'inkup/sess-2/b.png'));
    expect(urls.get('b')).toBe('https://github.com/acme/web/blob/inkup-assets/inkup/sess-2/b.png?raw=true');
  });

  it('makes the commit again on the new tip when the ref update is refused', async () => {
    await github.uploadImages(creds, 'acme/web', 'sess-1', [{ id: 's1', bytes: png(1) }]);
    // Another send moves the tip between this push's read of it and its ref update, once.
    let raced = false;
    stub.fail((req) => {
      if (raced || req.method !== 'PATCH') return undefined;
      raced = true;
      return { status: 422, body: { message: 'Update is not a fast forward' } };
    });
    stub.requests.length = 0;
    await github.uploadImages(creds, 'acme/web', 'sess-2', [{ id: 'x', bytes: png(7) }]);
    expect(stub.calls('PATCH', /git\/refs/)).toHaveLength(2);
    expect(stub.calls('POST', /git\/commits$/)).toHaveLength(2);
    expect(stub.calls('POST', /git\/blobs$/)).toHaveLength(1);
  });

  it('gives up with a plain message when the ref keeps moving', async () => {
    stub.fail((req) =>
      req.method === 'POST' && req.path.endsWith('/git/refs')
        ? { status: 422, body: { message: 'Reference already exists' } }
        : undefined,
    );
    await expect(github.uploadImages(creds, 'acme/web', 's', [{ id: 'x', bytes: png(1) }])).rejects.toMatchObject({
      kind: 'conflict',
      message: expect.stringContaining('Try again in a moment'),
    });
  });

  it('uploads nothing for an item without images', async () => {
    expect((await github.uploadImages(creds, 'acme/web', 's', [])).size).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('lists the repos the token sees', async () => {
    expect(await github.listDestinations(creds)).toEqual([
      { id: 'acme/web', name: 'acme/web' },
      { id: 'acme/api', name: 'acme/api' },
    ]);
  });

  it('Test passes every check for a token that can do everything', async () => {
    const result = await github.test(creds, 'acme/web');
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual(['token', 'repo', 'issues', 'contents']);
  });

  it('Test names the missing Contents permission, and says what works', async () => {
    await stub.close();
    stub = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web', contents_write: false }] });
    github = githubAdapter({ fetch, baseUrl: stub.baseURL });
    const result = await github.test(creds, 'acme/web');
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { id: 'token', ok: true, message: expect.stringContaining('The token works') },
      { id: 'repo', ok: true, message: 'acme/web is reachable.' },
      { id: 'issues', ok: true, message: 'Issues are enabled.' },
      { id: 'contents', ok: false, message: "This token can't write to acme/web. Give it Contents: read and write." },
    ]);
  });

  it('Test says when issues are off, the repo is unknown, or the token is refused', async () => {
    await stub.close();
    stub = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web', has_issues: false }] });
    github = githubAdapter({ fetch, baseUrl: stub.baseURL });
    expect((await github.test(creds, 'acme/web')).checks.find((c) => c.id === 'issues')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Issues are turned off for acme/web'),
    });
    expect((await github.test(creds, 'acme/nope')).checks.at(-1)).toMatchObject({
      id: 'repo',
      ok: false,
      message: expect.stringContaining("GitHub can't find acme/nope"),
    });
    expect(await github.test({ token: 'wrong' }, 'acme/web')).toEqual({
      ok: false,
      checks: [{ id: 'token', ok: false, message: expect.stringContaining("GitHub didn't accept this token") }],
    });
  });

  it('says which permission to give when an issue cannot be created', async () => {
    await stub.close();
    stub = await startGithubStub({ token: TOKEN, repos: [{ full_name: 'acme/web', issues_write: false }] });
    github = githubAdapter({ fetch, baseUrl: stub.baseURL });
    const err = await github.createIssue(creds, 'acme/web', { title: 'T', body: 'B' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect((err as TrackerError).message).toBe(
      "This token can't create issues in acme/web. Give it Issues: read and write.",
    );
  });

  it('reports a rate limit, an unreachable GitHub and a failed status read in plain words', async () => {
    stub.fail(() => ({
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0' },
    }));
    await expect(github.createIssue(creds, 'acme/web', { title: 'T', body: 'B' })).rejects.toMatchObject({
      kind: 'rate_limit',
    });
    stub.fail(() => ({ status: 500, body: { message: 'boom' } }));
    await expect(github.getStatus(creds, { destination: 'acme/web', key: '#1' })).rejects.toMatchObject({
      kind: 'other',
      status: 500,
    });
    const offline = githubAdapter({ fetch: () => Promise.reject(new TypeError('fetch failed')), baseUrl: 'http://x' });
    await expect(offline.listDestinations(creds)).rejects.toMatchObject({
      kind: 'network',
      message: "Couldn't reach GitHub. Check your connection, then try again.",
    });
  });

  it('never puts the token anywhere but the Authorization header', async () => {
    await pushItem({
      adapter: github,
      credentials: creds,
      destination: 'acme/web',
      item: item(['s1']),
      session: SESSION,
      images: [{ id: 's1', bytes: png(1) }],
    });
    for (const r of stub.requests) {
      expect(r.path).not.toContain(TOKEN);
      expect(JSON.stringify(r.body ?? '')).not.toContain(TOKEN);
    }
  });
});
