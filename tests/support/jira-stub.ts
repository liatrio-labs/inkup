// A local stand-in for Jira Cloud's REST v3, as much of it as tracker push uses (ADR 0028): the signed-in account, the
// projects it sees and their issue types, the permission check, issue create and update, attachment upload (which, as in
// Jira, is refused without `X-Atlassian-Token: no-check`) and an issue's status. Issues are numbered from 1 per project
// (ABC-1), start in "To Do" (category "new"), and keep what was created, updated and attached, so a test can read the
// description Jira would show. Tests inspect every request in `requests`.
//
// Used by the adapter unit tests (packages/core/tests/trackers/jira.test.ts) and by tests/e2e/trackers.spec.ts and
// privacy.spec.ts, where the extension points at it through the dev-only `jiraBaseUrl` override.
//
// Each project says which issue types it offers and what the account may do there (`can_create`, `can_attach`).
// `fail` answers chosen requests with an error instead, until it is cleared.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface JiraStubRequest {
  method: string;
  /** Path and query, e.g. /rest/api/3/issue/ABC-1/attachments. */
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON the client sent; for an upload, the raw multipart text. */
  // biome-ignore lint/suspicious/noExplicitAny: whatever the client sent; tests assert on it by path
  body: any;
}

export interface StubProjectOptions {
  key: string;
  name?: string;
  /** Default Task, Bug, Story. */
  issueTypes?: string[];
  /** Default true. False: the permission check says no, and issue creation answers 403. */
  can_create?: boolean;
  /** Default true. False: attachment upload answers 403. */
  can_attach?: boolean;
}

export interface StubAttachment {
  id: string;
  filename: string;
  size: number;
}

export interface StubJiraIssue {
  key: string;
  project: string;
  summary: string;
  issuetype: string;
  /** The ADF document, as last created or updated. */
  // biome-ignore lint/suspicious/noExplicitAny: ADF
  description: any;
  attachments: StubAttachment[];
  status: { name: string; category: 'new' | 'indeterminate' | 'done' };
}

export type StubReply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface JiraStubOptions {
  /** The account's email and API token the stub accepts; any other gets 401. Default: any Basic credentials. */
  email?: string;
  token?: string;
  displayName?: string;
  projects?: StubProjectOptions[];
  port?: number;
}

export interface JiraStub {
  baseURL: string;
  requests: JiraStubRequest[];
  issues: StubJiraIssue[];
  /** Answers the requests it matches with its reply instead; null clears it. */
  fail(rule: ((req: JiraStubRequest) => StubReply | undefined) | null): void;
  /** Requests whose method and path (without query) match, e.g. ('POST', /\/issue$/). */
  calls(method: string, path: RegExp): JiraStubRequest[];
  /** The requests as `METHOD /path` without the /rest/api/3 prefix or query, in order. */
  sequence(): string[];
  close(): Promise<void>;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept, x-atlassian-token',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
};

export async function startJiraStub(options: JiraStubOptions = {}): Promise<JiraStub> {
  const projects = new Map<string, Required<StubProjectOptions>>();
  for (const p of options.projects ?? [{ key: 'ABC', name: 'Alpha' }])
    projects.set(p.key, {
      name: p.key,
      issueTypes: ['Task', 'Bug', 'Story'],
      can_create: true,
      can_attach: true,
      ...p,
    });
  const requests: JiraStubRequest[] = [];
  const issues: StubJiraIssue[] = [];
  let rule: ((req: JiraStubRequest) => StubReply | undefined) | null = null;
  let baseURL = '';
  let attachmentIds = 10_000;

  const json = (status: number, body?: unknown): StubReply => ({ status, body });
  const notFound = () =>
    json(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
  const forbidden = () => json(403, { errorMessages: ['You do not have permission to complete this action.'] });
  const projectBody = (p: Required<StubProjectOptions>) => ({
    key: p.key,
    name: p.name,
    issueTypes: p.issueTypes
      .map((name, i) => ({ id: String(10_000 + i), name, subtask: false }))
      .concat([{ id: '99999', name: 'Sub-task', subtask: true }]),
  });

  function route(req: JiraStubRequest): StubReply {
    const auth = String(req.headers.authorization ?? '');
    const m64 = /^Basic (\S+)$/.exec(auth);
    if (!m64) return json(401, { message: 'Client must be authenticated to access this resource.' });
    if (options.email || options.token) {
      const want = Buffer.from(`${options.email ?? ''}:${options.token ?? ''}`).toString('base64');
      if (m64[1] !== want) return json(401, { message: 'Client must be authenticated to access this resource.' });
    }
    const url = new URL(req.path, 'http://stub');
    const p = url.pathname.replace(/^\/rest\/api\/3/, '');
    if (!url.pathname.startsWith('/rest/api/3/')) return notFound();

    if (req.method === 'GET' && p === '/myself')
      return json(200, {
        accountId: 'acct-1',
        displayName: options.displayName ?? 'Reviewer',
        emailAddress: options.email,
      });
    if (req.method === 'GET' && p === '/project/search') {
      const all = [...projects.values()].map((x) => ({ key: x.key, name: x.name }));
      const start = Number(url.searchParams.get('startAt') ?? 0);
      return json(200, { values: all.slice(start, start + 50), isLast: start + 50 >= all.length, startAt: start });
    }
    let g = /^\/project\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && g) {
      const project = projects.get(g[1]!);
      return project ? json(200, projectBody(project)) : json(404, { errorMessages: ['No project could be found.'] });
    }
    if (req.method === 'GET' && p === '/mypermissions') {
      const project = projects.get(url.searchParams.get('projectKey') ?? '');
      const names = (url.searchParams.get('permissions') ?? '').split(',').filter(Boolean);
      const allowed = (name: string) => (name === 'CREATE_ISSUES' ? project?.can_create : project?.can_attach) === true;
      return json(200, {
        permissions: Object.fromEntries(names.map((n) => [n, { key: n, havePermission: allowed(n) }])),
      });
    }

    if (req.method === 'POST' && p === '/issue') {
      const f = req.body?.fields ?? {};
      const project = projects.get(f.project?.key);
      if (!project) return json(400, { errors: { project: 'valid project is required' } });
      if (!project.can_create) return forbidden();
      if (!project.issueTypes.includes(f.issuetype?.name))
        return json(400, { errors: { issuetype: 'valid issue type is required' } });
      if (typeof f.summary !== 'string' || !f.summary || f.summary.length > 255)
        return json(400, { errors: { summary: 'Summary is required (255 characters at most).' } });
      if (f.description?.type !== 'doc' || f.description?.version !== 1)
        return json(400, { errors: { description: 'Operation value must be an Atlassian Document' } });
      const key = `${project.key}-${issues.filter((i) => i.project === project.key).length + 1}`;
      issues.push({
        key,
        project: project.key,
        summary: f.summary,
        issuetype: f.issuetype.name,
        description: f.description,
        attachments: [],
        status: { name: 'To Do', category: 'new' },
      });
      return json(201, { id: String(10_000 + issues.length), key, self: `${baseURL}/rest/api/3/issue/${key}` });
    }
    g = /^\/issue\/([^/]+)\/attachments$/.exec(p);
    if (req.method === 'POST' && g) {
      const issue = issues.find((i) => i.key === g![1]);
      if (!issue) return notFound();
      if (req.headers['x-atlassian-token'] !== 'no-check') return json(403, { message: 'XSRF check failed' });
      if (!projects.get(issue.project)!.can_attach) return forbidden();
      const filename = /filename="([^"]+)"/.exec(String(req.body))?.[1] ?? 'file';
      const attachment: StubAttachment = { id: String(++attachmentIds), filename, size: String(req.body).length };
      issue.attachments.push(attachment);
      return json(200, [
        {
          id: attachment.id,
          filename,
          mimeType: 'image/png',
          size: attachment.size,
          content: `${baseURL}/rest/api/3/attachment/content/${attachment.id}`,
        },
      ]);
    }
    g = /^\/issue\/([^/]+)$/.exec(p);
    if (g) {
      const issue = issues.find((i) => i.key === g![1]);
      if (!issue) return notFound();
      if (req.method === 'PUT') {
        const description = req.body?.fields?.description;
        if (description?.type !== 'doc')
          return json(400, { errors: { description: 'Operation value must be an Atlassian Document' } });
        issue.description = description;
        return { status: 204 };
      }
      if (req.method === 'GET')
        return json(200, {
          key: issue.key,
          fields: { status: { name: issue.status.name, statusCategory: { key: issue.status.category } } },
        });
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
      const entry: JiraStubRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      requests.push(entry);
      const reply = rule?.(entry) ?? route(entry);
      res
        .writeHead(reply.status, { 'content-type': 'application/json', ...CORS, ...(reply.headers ?? {}) })
        .end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(options.port ?? 0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseURL,
    requests,
    issues,
    fail(next) {
      rule = next;
    },
    calls: (method, path) =>
      requests.filter((r) => r.method === method && path.test(new URL(r.path, 'http://stub').pathname)),
    sequence: () =>
      requests.map((r) => `${r.method} ${new URL(r.path, 'http://stub').pathname.replace('/rest/api/3', '')}`),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
