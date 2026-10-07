// A local stand-in for the GitHub REST API, as much of it as tracker push uses (ADR 0028): the signed-in user, the
// repos the token sees, a repo's settings, the Git Data API (blobs, trees, commits, refs) and issues. It keeps state
// like the real one, so a second send builds on the first: a ref update that is not a fast-forward is refused (422),
// a tree on a `base_tree` keeps that tree's files, and issues are numbered from 1 per repo. Tests inspect every
// request in `requests` and read what was committed through `repo(name)`.
//
// Used by the adapter unit tests (packages/core/tests/trackers/github.test.ts) and by tests/e2e/trackers.spec.ts and
// privacy.spec.ts, where the extension points at it through the dev-only `githubBaseUrl` override.
//
// Each repo says what the token may do there (`contents_write`, `issues_write`) and whether issues are on. `fail`
// answers chosen requests with an error instead, until it is cleared.
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GithubStubRequest {
  method: string;
  /** Path and query, e.g. /repos/acme/web/git/blobs. */
  path: string;
  headers: IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: whatever JSON the client sent; tests assert on it by path
  body: any;
}

export interface StubRepoOptions {
  full_name: string;
  has_issues?: boolean;
  /** Default true. False: Git Data writes answer 403, as for a token without Contents: read and write. */
  contents_write?: boolean;
  /** Default true. False: issue creation answers 403. */
  issues_write?: boolean;
}

export interface StubCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

export interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: 'completed' | 'not_planned' | 'reopened' | null;
  html_url: string;
}

export interface StubRepo {
  options: Required<StubRepoOptions>;
  /** ref name (heads/inkup-assets) → commit sha. */
  refs: Map<string, string>;
  commits: Map<string, StubCommit>;
  /** tree sha → path → blob sha. */
  trees: Map<string, Map<string, string>>;
  /** blob sha → base64 content. */
  blobs: Map<string, string>;
  issues: StubIssue[];
}

export type StubReply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface GithubStubOptions {
  /** The token the stub accepts; any other gets 401. Default: any token. */
  token?: string;
  login?: string;
  repos?: StubRepoOptions[];
  port?: number;
}

export interface GithubStub {
  baseURL: string;
  requests: GithubStubRequest[];
  repo(fullName: string): StubRepo;
  /** Answers the requests it matches with its reply instead; null clears it. */
  fail(rule: ((req: GithubStubRequest) => StubReply | undefined) | null): void;
  /** Requests whose method and path match, e.g. ('POST', /\/issues$/). */
  calls(method: string, path: RegExp): GithubStubRequest[];
  close(): Promise<void>;
}

const sha = (...parts: unknown[]) => createHash('sha1').update(JSON.stringify(parts)).digest('hex');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept, x-github-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
};

export async function startGithubStub(options: GithubStubOptions = {}): Promise<GithubStub> {
  const repos = new Map<string, StubRepo>();
  const addRepo = (o: StubRepoOptions) =>
    repos.set(o.full_name, {
      options: { has_issues: true, contents_write: true, issues_write: true, ...o },
      refs: new Map(),
      commits: new Map(),
      trees: new Map(),
      blobs: new Map(),
      issues: [],
    });
  for (const r of options.repos ?? [{ full_name: 'acme/web' }]) addRepo(r);
  const requests: GithubStubRequest[] = [];
  let rule: ((req: GithubStubRequest) => StubReply | undefined) | null = null;

  const json = (status: number, body: unknown): StubReply => ({ status, body });
  const notFound = () => json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  const forbidden = () => json(403, { message: 'Resource not accessible by personal access token' });

  function route(req: GithubStubRequest): StubReply {
    const auth = String(req.headers.authorization ?? '');
    if (!/^Bearer \S+$/.test(auth) || (options.token && auth !== `Bearer ${options.token}`))
      return json(401, { message: 'Bad credentials' });
    const url = new URL(req.path, 'http://stub');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/user') return json(200, { login: options.login ?? 'reviewer', id: 1 });
    if (req.method === 'GET' && p === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = [...repos.values()].map((r) => ({
        full_name: r.options.full_name,
        has_issues: r.options.has_issues,
        private: true,
      }));
      return json(200, page === 1 ? all : []);
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return notFound();
    const repo = repos.get(m[1]!);
    if (!repo) return notFound();
    const rest = m[2] ?? '';
    const full = repo.options.full_name;
    const write = () => (repo.options.contents_write ? null : forbidden());

    if (req.method === 'GET' && rest === '')
      return json(200, {
        full_name: full,
        has_issues: repo.options.has_issues,
        permissions: { admin: false, push: true, pull: true },
      });

    // Git Data API.
    if (req.method === 'POST' && rest === '/git/blobs') {
      const denied = write();
      if (denied) return denied;
      const content =
        req.body?.encoding === 'base64'
          ? String(req.body.content)
          : Buffer.from(String(req.body?.content)).toString('base64');
      const s = sha('blob', content);
      repo.blobs.set(s, content);
      return json(201, { sha: s, url: `${'https://api.github.com'}/repos/${full}/git/blobs/${s}` });
    }
    let g = /^\/git\/ref\/(.+)$/.exec(rest);
    if (req.method === 'GET' && g) {
      const at = repo.refs.get(g[1]!);
      return at ? json(200, { ref: `refs/${g[1]}`, object: { sha: at, type: 'commit' } }) : notFound();
    }
    g = /^\/git\/commits\/(\w+)$/.exec(rest);
    if (req.method === 'GET' && g) {
      const c = repo.commits.get(g[1]!);
      return c
        ? json(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })) })
        : notFound();
    }
    if (req.method === 'POST' && rest === '/git/trees') {
      const denied = write();
      if (denied) return denied;
      const files = new Map(req.body?.base_tree ? repo.trees.get(req.body.base_tree) : []);
      if (req.body?.base_tree && !repo.trees.has(req.body.base_tree))
        return json(422, { message: 'Invalid base_tree' });
      for (const e of req.body?.tree ?? []) {
        if (!repo.blobs.has(e.sha)) return json(422, { message: `Invalid tree info: ${e.sha} is not a blob` });
        files.set(e.path, e.sha);
      }
      const s = sha('tree', [...files].sort());
      repo.trees.set(s, files);
      return json(201, {
        sha: s,
        tree: [...files].map(([path, b]) => ({ path, sha: b, type: 'blob', mode: '100644' })),
      });
    }
    if (req.method === 'POST' && rest === '/git/commits') {
      const denied = write();
      if (denied) return denied;
      const { tree, parents = [], message = '' } = req.body ?? {};
      if (!repo.trees.has(tree)) return json(422, { message: 'Tree SHA does not exist' });
      const s = sha('commit', tree, parents, message, repo.commits.size);
      repo.commits.set(s, { sha: s, tree, parents, message });
      return json(201, { sha: s, tree: { sha: tree }, parents: parents.map((x: string) => ({ sha: x })) });
    }
    if (req.method === 'POST' && rest === '/git/refs') {
      const denied = write();
      if (denied) return denied;
      const name = String(req.body?.ref ?? '').replace(/^refs\//, '');
      if (repo.refs.has(name)) return json(422, { message: 'Reference already exists' });
      if (!repo.commits.has(req.body?.sha)) return json(422, { message: 'Object does not exist' });
      repo.refs.set(name, req.body.sha);
      return json(201, { ref: `refs/${name}`, object: { sha: req.body.sha, type: 'commit' } });
    }
    g = /^\/git\/refs\/(.+)$/.exec(rest);
    if (req.method === 'PATCH' && g) {
      const denied = write();
      if (denied) return denied;
      const name = g[1]!;
      const at = repo.refs.get(name);
      if (!at) return json(422, { message: 'Reference does not exist' });
      const next = repo.commits.get(req.body?.sha);
      if (!next) return json(422, { message: 'Object does not exist' });
      // A fast-forward only: the new commit must descend from the current tip.
      const descends = (s: string): boolean => s === at || (repo.commits.get(s)?.parents ?? []).some(descends);
      if (!req.body?.force && !descends(next.sha)) return json(422, { message: 'Update is not a fast forward' });
      repo.refs.set(name, next.sha);
      return json(200, { ref: `refs/${name}`, object: { sha: next.sha, type: 'commit' } });
    }

    // Issues.
    if (req.method === 'POST' && rest === '/issues') {
      if (!repo.options.has_issues) return json(410, { message: 'Issues are disabled for this repo' });
      if (!repo.options.issues_write) return forbidden();
      const number = repo.issues.length + 1;
      const issue: StubIssue = {
        number,
        title: String(req.body?.title ?? ''),
        body: String(req.body?.body ?? ''),
        state: 'open',
        state_reason: null,
        html_url: `https://github.com/${full}/issues/${number}`,
      };
      repo.issues.push(issue);
      return json(201, { ...issue, id: 1000 + number });
    }
    g = /^\/issues\/(\d+)$/.exec(rest);
    if (req.method === 'GET' && g) {
      const issue = repo.issues.find((i) => i.number === Number(g![1]));
      return issue ? json(200, issue) : notFound();
    }
    return notFound();
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS).end();
        return;
      }
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const entry: GithubStubRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body,
      };
      requests.push(entry);
      const reply = rule?.(entry) ?? route(entry);
      res
        .writeHead(reply.status, { 'content-type': 'application/json', ...CORS, ...(reply.headers ?? {}) })
        .end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(options.port ?? 0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    repo(name) {
      const r = repos.get(name);
      if (!r) throw new Error(`stub has no repo ${name}`);
      return r;
    },
    fail(next) {
      rule = next;
    },
    calls: (method, path) =>
      requests.filter((r) => r.method === method && path.test(new URL(r.path, 'http://stub').pathname)),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
