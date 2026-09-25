// @vitest-environment node
// The Chrome Web Store upload and submit (scripts/chrome-web-store.ts), as release.yml runs it, against a local server
// that answers like the v2 API.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadAndSubmit } from '../../scripts/chrome-web-store.ts';

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

const base = {
  token: 'tok',
  publisherId: 'pub-1',
  itemId: 'abcdef',
  zip: new TextEncoder().encode('PK zip bytes'),
  skipSubmit: false,
  sleep: async () => {},
  log: () => {},
};

describe('chrome-web-store', () => {
  it('uploads the zip, then submits the item for review', async () => {
    const { api, seen } = await store({
      ':upload': [[200, { uploadState: 'SUCCEEDED', crxVersion: '0.2.0' }]],
      ':publish': [[200, { state: 'PENDING_REVIEW' }]],
    });
    expect(await uploadAndSubmit({ ...base, api })).toEqual({ crxVersion: '0.2.0', state: 'PENDING_REVIEW' });
    expect(seen).toEqual([
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
        [200, { lastAsyncUploadState: 'IN_PROGRESS' }],
        [200, { lastAsyncUploadState: 'SUCCEEDED' }],
      ],
      ':publish': [[200, { state: 'PENDING_REVIEW' }]],
    });
    await uploadAndSubmit({ ...base, api });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /upload/v2/publishers/pub-1/items/abcdef:upload',
      'GET /v2/publishers/pub-1/items/abcdef:fetchStatus',
      'GET /v2/publishers/pub-1/items/abcdef:fetchStatus',
      'POST /v2/publishers/pub-1/items/abcdef:publish',
    ]);
  });

  it('uploads only when skipSubmit is set', async () => {
    const { api, seen } = await store({ ':upload': [[200, { uploadState: 'SUCCEEDED' }]] });
    expect(await uploadAndSubmit({ ...base, api, skipSubmit: true })).toEqual({ crxVersion: undefined, state: null });
    expect(seen).toHaveLength(1);
  });

  it('fails with the API error message on a non-success response, without the token', async () => {
    const { api } = await store({
      ':upload': [[400, { error: { code: 400, message: 'Version must be greater', status: 'INVALID_ARGUMENT' } }]],
    });
    const err = await uploadAndSubmit({ ...base, api }).catch((e: Error) => e);
    expect((err as Error).message).toBe('upload failed: HTTP 400 Version must be greater');
    expect((err as Error).message).not.toContain('tok');
  });

  it('fails when the asynchronous upload fails, and does not publish', async () => {
    const { api, seen } = await store({
      ':upload': [[200, { uploadState: 'IN_PROGRESS' }]],
      ':fetchStatus': [[200, { lastAsyncUploadState: 'FAILED' }]],
    });
    await expect(uploadAndSubmit({ ...base, api })).rejects.toThrow('upload ended in state FAILED');
    expect(seen.some((s) => s.url.endsWith(':publish'))).toBe(false);
  });

  it('gives up after the last status check', async () => {
    const { api } = await store({
      ':upload': [[200, { uploadState: 'IN_PROGRESS' }]],
      ':fetchStatus': [
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
      ':upload': [[200, { uploadState: 'SUCCEEDED' }]],
      ':publish': [[403, { error: { code: 403, message: 'The caller does not have permission' } }]],
    });
    await expect(uploadAndSubmit({ ...base, api })).rejects.toThrow(
      'publish failed: HTTP 403 The caller does not have permission',
    );
  });
});
