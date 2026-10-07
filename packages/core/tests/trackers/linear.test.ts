// The Linear adapter against tests/support/linear-stub.ts, over real HTTP with Node's fetch: the order of a push
// (every fileUpload, then every signed PUT, then issueCreate), the key sent as is, the workflow state read as a badge,
// Test's checks, and the errors in plain words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type LinearStub, startLinearStub } from '../../../../tests/support/linear-stub';
import {
  type IssueItem,
  linearAdapter,
  pushItem,
  retryAfterMs,
  statusLabel,
  type TrackerAdapter,
} from '../../src/trackers';

const KEY = 'lin_api_TEST_unit';
const creds = { token: KEY };
const SESSION = { id: 'sess-1', name: 'Pricing page review' };
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n + 1, n + 2]);

const item = (screenshots: string[]): IssueItem => ({
  id: 'item_0001',
  title: 'Make the Get started button larger',
  category: 'visual',
  intent: 'Too small.',
  locations: [{ role: 'subject', element: "button 'Get started'", url: '/pricing.html' }],
  transcript: 'make it bigger',
  agent_prompt: `Enlarge it. ${screenshots.map((s) => `screenshots/${s}.png`).join(' ')}`,
  evidence: { screenshots },
});

const TEAMS = [
  { id: 'team-web', key: 'WEB', name: 'Web' },
  { id: 'team-ops', key: 'OPS', name: 'Operations' },
];

let stub: LinearStub;
let linear: TrackerAdapter;
beforeEach(async () => {
  stub = await startLinearStub({ key: KEY, teams: TEAMS });
  linear = linearAdapter({ fetch, baseUrl: stub.baseURL });
});
afterEach(() => stub.close());

describe('linearAdapter', () => {
  it('asks for every upload, PUTs each to its signed URL, then creates the issue with the asset URLs embedded', async () => {
    const link = await pushItem({
      adapter: linear,
      credentials: creds,
      destination: 'team-web',
      item: item(['s1', 's2']),
      session: SESSION,
      images: [
        { id: 's1', bytes: png(1) },
        { id: 's2', bytes: png(2) },
      ],
      now: () => new Date('2026-10-07T10:00:00.000Z'),
    });
    expect(stub.requests.map((r) => r.operation)).toEqual(['fileUpload', 'fileUpload', 'put', 'put', 'issueCreate']);
    // The key goes to the API as it is, not as a Bearer token, and never to the signed upload URL.
    for (const r of stub.requests)
      expect(r.headers.authorization, r.operation).toBe(r.operation === 'put' ? undefined : KEY);
    expect(stub.calls('fileUpload').map((r) => r.variables)).toEqual([
      { contentType: 'image/png', filename: 's1.png', size: 7 },
      { contentType: 'image/png', filename: 's2.png', size: 7 },
    ]);
    // Each PUT carries the headers Linear asked for, and the image's bytes.
    expect(stub.uploads.map((u) => u.bytes && [...u.bytes])).toEqual([[...png(1)], [...png(2)]]);
    for (const u of stub.uploads) expect(u.putHeaders?.['x-goog-signature']).toBe(`sig-${u.id}`);

    const input = stub.calls('issueCreate')[0]!.variables.input;
    expect(input.teamId).toBe('team-web');
    expect(input.title).toBe('Make the Get started button larger');
    for (const u of stub.uploads) expect(input.description).toContain(u.assetUrl);
    expect(input.description).not.toContain('screenshots/s1.png');
    expect(link).toEqual({
      tracker: 'linear',
      destination: 'team-web',
      key: 'WEB-1',
      url: 'https://linear.app/acme/issue/WEB-1/stub',
      created_at: '2026-10-07T10:00:00.000Z',
    });
  });

  it('creates in the team it is given, and numbers issues per team', async () => {
    const a = await linear.createIssue(creds, 'team-web', { title: 'A', body: 'a' });
    const b = await linear.createIssue(creds, 'team-ops', { title: 'B', body: 'b' });
    const c = await linear.createIssue(creds, 'team-web', { title: 'C', body: 'c' });
    expect([a.key, b.key, c.key]).toEqual(['WEB-1', 'OPS-1', 'WEB-2']);
    expect(b.destination).toBe('team-ops');
  });

  it('uploads nothing for an item without images', async () => {
    expect((await linear.uploadImages(creds, 'team-web', 's', [])).size).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('reads the workflow state: its name is the badge, its type says open or closed', async () => {
    const link = await linear.createIssue(creds, 'team-web', { title: 'T', body: 'B' });
    const rows = [
      [{ name: 'Todo', type: 'unstarted' }, { state: 'open', name: 'Todo' }, 'Todo'],
      [{ name: 'In Progress', type: 'started' }, { state: 'open', name: 'In Progress' }, 'In Progress'],
      [{ name: 'Done', type: 'completed' }, { state: 'closed', reason: 'completed', name: 'Done' }, 'Done'],
      [
        { name: 'Canceled', type: 'canceled' },
        { state: 'closed', reason: 'not_planned', name: 'Canceled' },
        'Canceled',
      ],
    ] as const;
    for (const [state, status, badge] of rows) {
      stub.setState('WEB-1', state);
      const read = await linear.getStatus(creds, link);
      expect(read).toEqual(status);
      expect(statusLabel(read)).toBe(badge);
    }
  });

  it('lists the teams the key sees, by id', async () => {
    expect(await linear.listDestinations(creds)).toEqual([
      { id: 'team-web', name: 'Web (WEB)' },
      { id: 'team-ops', name: 'Operations (OPS)' },
    ]);
  });

  it('Test passes every check for a key that works in the team', async () => {
    const result = await linear.test(creds, 'team-web');
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual(['token', 'team', 'uploads']);
  });

  it('Test says in plain words that a rejected key does not work and how to make a new one', async () => {
    const result = await linear.test({ token: 'wrong' }, 'team-web');
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: 'token', ok: false });
    expect(result.checks[0]!.message).toContain("Linear didn't accept this key");
    expect(result.checks[0]!.message).toContain('Make a new personal API key');
  });

  it('Test names a team the key cannot find, and asks for a team when none is saved', async () => {
    const missing = await linear.test(creds, 'team-nope');
    expect(missing.checks.map((c) => [c.id, c.ok])).toEqual([
      ['token', true],
      ['team', false],
    ]);
    expect(missing.checks[1]!.message).toContain('Pick a team in Trackers settings');
    expect((await linear.test(creds, '')).checks[1]).toMatchObject({ id: 'team', ok: false });
  });

  it('reports a rate limit as such, with how long Linear asked to wait', async () => {
    stub.fail((req) =>
      req.operation === 'issueCreate' ? { status: 429, body: {}, headers: { 'retry-after': '2' } } : undefined,
    );
    await expect(linear.createIssue(creds, 'team-web', { title: 'T', body: 'B' })).rejects.toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 2000,
    });
    stub.fail(() => ({
      status: 400,
      body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      headers: { 'x-ratelimit-requests-reset': String(Date.now() + 5000) },
    }));
    const err = await linear.createIssue(creds, 'team-web', { title: 'T', body: 'B' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limit' });
    expect(err.retryAfterMs).toBeGreaterThan(3000);
  });

  it('says what to do when a screenshot upload is refused, or the team is gone', async () => {
    stub.fail((req) => (req.operation === 'put' ? { status: 403 } : undefined));
    await expect(linear.uploadImages(creds, 'team-web', 's', [{ id: 'x', bytes: png(1) }])).rejects.toMatchObject({
      kind: 'other',
      message: expect.stringContaining("Linear didn't accept a screenshot"),
    });
    stub.fail(null);
    await expect(linear.createIssue(creds, 'team-nope', { title: 'T', body: 'B' })).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('Pick a team in Trackers settings'),
    });
  });

  it('says an issue is gone when its status cannot be found', async () => {
    await expect(linear.getStatus(creds, { destination: 'team-web', key: 'WEB-99' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('says it could not reach Linear when the request fails', async () => {
    const down = linearAdapter({ fetch: () => Promise.reject(new TypeError('offline')), baseUrl: stub.baseURL });
    await expect(down.listDestinations(creds)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('retryAfterMs', () => {
  it('reads seconds or an HTTP date, and nothing else', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs('Wed, 07 Oct 2026 10:00:30 GMT', () => Date.parse('2026-10-07T10:00:00Z'))).toBe(30_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});
