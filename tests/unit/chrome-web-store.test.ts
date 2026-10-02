// @vitest-environment node
// The Chrome Web Store upload and submit (scripts/chrome-web-store.ts), as release.yml and chrome-web-store-sync.yml
// run it, against a local server that answers like the v2 API, and the decision whether to upload at all.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { compareVersions, decide, type ItemStatus, uploadAndSubmit } from '../../scripts/chrome-web-store.ts';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: string;
}
type Reply = [status: number, body: unknown];

let server: Server | undefined;

afterEach(() => server?.close());

/** Starts a server that records each request and answers with the next reply routed by its path suffix. */
async function store(routes: Record<string, Reply[]>) {
  const seen: Seen[] = [];
  server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: req.headers.authorization,
      type: req.headers['content-type'],
      body: Buffer.concat(chunks).toString(),
    });
    const key = Object.keys(routes).find((k) => req.url?.endsWith(k));
    const [status, body] = (key && routes[key]?.shift()) || [404, { error: { message: 'no route' } }];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, seen };
}

const revision = (state: string, ...versions: string[]) => ({
  state,
  distributionChannels: versions.map((crxVersion) => ({ crxVersion, deployPercentage: 100 })),
});
const published = (version: string): ItemStatus => ({ publishedItemRevisionStatus: revision('PUBLISHED', version) });

const base = {
  token: 'tok',
  publisherId: 'pub-1',
  itemId: 'abcdef',
  zip: new TextEncoder().encode('PK zip bytes'),
  version: '0.2.0',
  skipSubmit: false,
  sleep: async () => {},
  log: () => {},
};

describe('chrome-web-store', () => {
  it('uploads the zip, then submits the item for review', async () => {
    const { api, seen } = await store({
      ':fetchStatus': [[200, published('0.1.1')]],
      ':upload': [[200, { uploadState: 'SUCCEEDED', crxVersion: '0.2.0' }]],
      ':publish': [[200, { state: 'PENDING_REVIEW' }]],
    });
    expect(await uploadAndSubmit({ ...base, api })).toEqual({ crxVersion: '0.2.0', state: 'PENDING_REVIEW' });
    expect(seen).toEqual([
      {
        method: 'GET',
        url: '/v2/publishers/pub-1/items/abcdef:fetchStatus',
        auth: 'Bearer tok',
        type: undefined,
        body: '',
      },
      {
        method: 'POST',
        url: '/upload/v2/publishers/pub-1/items/abcdef:upload',
        auth: 'Bearer tok',
        type: 'application/zip',
        body: 'PK zip bytes',
      },
      {
        method: 'POST',
        url: '/v2/publishers/pub-1/items/abcdef:publish',
        auth: 'Bearer tok',
        type: 'application/json',
        body: '{}',
      },
    ]);
  });

  it('polls fetchStatus while the upload is IN_PROGRESS', async () => {
    const { api, seen } = await store({
      ':upload': [[200, { uploadState: 'IN_PROGRESS' }]],
      ':fetchStatus': [
        [200, published('0.1.1')],
        [200, { lastAsyncUploadState: 'IN_PROGRESS' }],
        [200, { lastAsyncUploadState: 'SUCCEEDED' }],
      ],
      ':publish': [[200, { state: 'PENDING_REVIEW' }]],
    });
    await uploadAndSubmit({ ...base, api });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /v2/publishers/pub-1/items/abcdef:fetchStatus',
      'POST /upload/v2/publishers/pub-1/items/abcdef:upload',
      'GET /v2/publishers/pub-1/items/abcdef:fetchStatus',
      'GET /v2/publishers/pub-1/items/abcdef:fetchStatus',
      'POST /v2/publishers/pub-1/items/abcdef:publish',
    ]);
  });

  it('uploads only when skipSubmit is set', async () => {
    const { api, seen } = await store({
      ':fetchStatus': [[200, {}]],
      ':upload': [[200, { uploadState: 'SUCCEEDED' }]],
    });
    expect(await uploadAndSubmit({ ...base, api, skipSubmit: true })).toEqual({ crxVersion: undefined, state: null });
    expect(seen).toHaveLength(2);
  });

  it('fails with the API error message on a non-success response, without the token', async () => {
    const { api } = await store({
      ':fetchStatus': [[200, {}]],
      ':upload': [[400, { error: { code: 400, message: 'Version must be greater', status: 'INVALID_ARGUMENT' } }]],
    });
    const err = await uploadAndSubmit({ ...base, api }).catch((e: Error) => e);
    expect((err as Error).message).toBe('upload failed: HTTP 400 Version must be greater');
    expect((err as Error).message).not.toContain('tok');
  });

  it('fails when the asynchronous upload fails, and does not publish', async () => {
    const { api, seen } = await store({
      ':upload': [[200, { uploadState: 'IN_PROGRESS' }]],
      ':fetchStatus': [
        [200, {}],
        [200, { lastAsyncUploadState: 'FAILED' }],
      ],
    });
    await expect(uploadAndSubmit({ ...base, api })).rejects.toThrow('upload ended in state FAILED');
    expect(seen.some((s) => s.url.endsWith(':publish'))).toBe(false);
  });

  it('gives up after the last status check', async () => {
    const { api } = await store({
      ':upload': [[200, { uploadState: 'IN_PROGRESS' }]],
      ':fetchStatus': [
        [200, {}],
        [200, { lastAsyncUploadState: 'IN_PROGRESS' }],
        [200, { lastAsyncUploadState: 'IN_PROGRESS' }],
      ],
    });
    await expect(uploadAndSubmit({ ...base, api, pollAttempts: 2 })).rejects.toThrow(
      'upload still IN_PROGRESS after 2 status checks',
    );
  });

  it('fails when publish is rejected', async () => {
    const { api } = await store({
      ':fetchStatus': [[200, {}]],
      ':upload': [[200, { uploadState: 'SUCCEEDED' }]],
      ':publish': [[403, { error: { code: 403, message: 'The caller does not have permission' } }]],
    });
    await expect(uploadAndSubmit({ ...base, api })).rejects.toThrow(
      'publish failed: HTTP 403 The caller does not have permission',
    );
  });

  it('does not upload while a submission is in review, and says the daily sync will submit', async () => {
    const lines: string[] = [];
    const { api, seen } = await store({
      ':fetchStatus': [
        [200, { ...published('0.1.0'), submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.1.1') }],
      ],
    });
    const result = await uploadAndSubmit({ ...base, api, log: (l) => lines.push(l) });
    expect(result.state).toBeNull();
    expect(seen.map((s) => s.url)).toEqual(['/v2/publishers/pub-1/items/abcdef:fetchStatus']);
    expect(lines).toEqual([
      '::notice::v0.1.1 is in Chrome Web Store review, so v0.2.0 is not uploaded. ' +
        'The daily Chrome Web Store sync submits the newest release once the review clears.',
    ]);
  });

  it('does not upload a version the store already has', async () => {
    const lines: string[] = [];
    const { api, seen } = await store({ ':fetchStatus': [[200, published('0.2.0')]] });
    await uploadAndSubmit({ ...base, api, log: (l) => lines.push(l) });
    expect(seen).toHaveLength(1);
    expect(lines).toEqual(['::notice::The Chrome Web Store has v0.2.0 published, so v0.2.0 is not uploaded.']);
  });

  it('fails when the status check fails, and does not upload', async () => {
    const { api, seen } = await store({ ':fetchStatus': [[403, { error: { message: 'Forbidden' } }]] });
    await expect(uploadAndSubmit({ ...base, api })).rejects.toThrow('status failed: HTTP 403 Forbidden');
    expect(seen).toHaveLength(1);
  });
});

describe('decide', () => {
  const skip = (status: ItemStatus, version = '0.2.0') => {
    const d = decide(status, version);
    return d.upload ? 'upload' : `${d.level}: ${d.message}`;
  };

  it('uploads to an item with nothing published or submitted', () => {
    expect(decide({}, '0.2.0')).toEqual({ upload: true });
  });

  it('uploads a version newer than the published one', () => {
    expect(decide(published('0.1.1'), '0.2.0')).toEqual({ upload: true });
  });

  it('skips while any submission is in review, older or newer', () => {
    for (const v of ['0.1.1', '0.2.0', '0.3.0'])
      expect(skip({ submittedItemRevisionStatus: revision('PENDING_REVIEW', v) })).toMatch(
        new RegExp(`^notice: v${v} is in Chrome Web Store review`),
      );
  });

  it('skips a version at or below the published one, across channels and to testers', () => {
    expect(skip(published('0.2.0'))).toMatch(/^notice: The Chrome Web Store has v0.2.0 published/);
    expect(skip({ publishedItemRevisionStatus: revision('PUBLISHED_TO_TESTERS', '0.1.0', '0.3.0') })).toMatch(
      /has v0.3.0 published/,
    );
  });

  it('leaves an approved, staged submission of this version or newer to the dashboard', () => {
    expect(skip({ submittedItemRevisionStatus: revision('STAGED', '0.2.0') })).toBe(
      "notice: The Chrome Web Store's submission of v0.2.0 is STAGED, so v0.2.0 is not uploaded. " +
        'It is approved: publish it from the developer dashboard.',
    );
  });

  it('warns rather than resubmitting a rejected version', () => {
    expect(skip({ submittedItemRevisionStatus: revision('REJECTED', '0.2.0') })).toMatch(
      /^warning: .*v0.2.0 is REJECTED.*release a newer version/,
    );
  });

  it('does not undo a cancelled submission of this version', () => {
    expect(skip({ submittedItemRevisionStatus: revision('CANCELLED', '0.2.0') })).toMatch(/^notice: .*is CANCELLED/);
  });

  it('replaces a staged, rejected or cancelled submission of an older version', () => {
    for (const state of ['STAGED', 'REJECTED', 'CANCELLED'])
      expect(decide({ ...published('0.1.0'), submittedItemRevisionStatus: revision(state, '0.1.1') }, '0.2.0')).toEqual(
        {
          upload: true,
        },
      );
  });

  it('compares versions as numbers, part by part', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.7.0', '0.7.0.1')).toBe(-1);
    expect(skip(published('0.10.0'), '0.9.0')).toMatch(/has v0.10.0 published/);
  });
});
