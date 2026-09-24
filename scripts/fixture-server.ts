// Static server for fixtures/site on two origins, so pages can embed and link cross-origin.
// HTML files get {{PRIMARY_ORIGIN}} and {{SECOND_ORIGIN}} replaced at serve time.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'site');
export const DEFAULT_PRIMARY_PORT = 4401;
export const DEFAULT_SECOND_PORT = 4402;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Pages served with extra headers. no-frame.html refuses framing, as many real sites do (E6's frame host). */
const HEADERS: Record<string, Record<string, string>> = {
  '/no-frame.html': { 'x-frame-options': 'DENY' },
};

export interface FixtureServers {
  primaryOrigin: string;
  secondOrigin: string;
  close(): Promise<void>;
}

function serve(port: number, host: string, origins: { primary: string; second: string }): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const rel = normalize(path === '/' ? '/index.html' : path);
    const file = join(SITE_ROOT, rel);
    if (!file.startsWith(SITE_ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body: Buffer | string = await readFile(file);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      if (extname(file) === '.html') {
        body = body
          .toString('utf8')
          .replaceAll('{{PRIMARY_ORIGIN}}', origins.primary)
          .replaceAll('{{SECOND_ORIGIN}}', origins.second);
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...HEADERS[rel] }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return listenWithRetry(server, port, host);
}

/**
 * Playwright starts a new worker (same parallelIndex, so the same ports) when a spec file's `test.use` differs,
 * and the previous worker may still be closing its servers. Retry EADDRINUSE for a few seconds instead of failing
 * the first test of the new worker.
 */
async function listenWithRetry(
  server: Server,
  port: number,
  host: string,
  deadline = Date.now() + 10_000,
): Promise<Server> {
  for (;;) {
    try {
      return await new Promise<Server>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server);
        });
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Primary origin on localhost, second origin on 127.0.0.1 (different host and port: cross-origin and cross-site). */
export async function startFixtureServers(
  primaryPort = DEFAULT_PRIMARY_PORT,
  secondPort = DEFAULT_SECOND_PORT,
): Promise<FixtureServers> {
  const origins = { primary: `http://localhost:${primaryPort}`, second: `http://127.0.0.1:${secondPort}` };
  const a = await serve(primaryPort, 'localhost', origins);
  const b = await serve(secondPort, '127.0.0.1', origins);
  return {
    primaryOrigin: origins.primary,
    secondOrigin: origins.second,
    close: () =>
      // closeAllConnections: Chromium keeps sockets alive, and close() alone waits for them to time out.
      Promise.all(
        [a, b].map(
          (s) =>
            new Promise<void>((r) => {
              s.close(() => r());
              s.closeAllConnections();
            }),
        ),
      ).then(() => undefined),
  };
}
