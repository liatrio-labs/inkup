// A local stand-in for Linear's GraphQL API, as much of it as tracker push uses (ADR 0028): the signed-in viewer, the
// teams, `fileUpload` with a signed upload URL on this same server, `issueCreate` (identifiers count up per team, as
// WEB-1) and an issue's workflow state. It checks the API key the way Linear does: `Authorization: <key>`, no Bearer.
// Tests inspect every request in `requests`, read what was created through `issues` and `uploads`, and move an
// issue's workflow state with `setState`.
//
// Used by the adapter unit tests (packages/core/tests/trackers/linear.test.ts) and by tests/e2e/trackers.spec.ts,
// where the extension points at it through the dev-only `linearBaseUrl` override.
//
// `fail` answers chosen requests with an error instead, until it is cleared. `issueCreateDelayMs` holds each
// issueCreate open, so a test can see whether two overlapped (`maxInFlight`).
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export type LinearOperation = 'viewer' | 'teams' | 'team' | 'fileUpload' | 'issueCreate' | 'issue' | 'put' | 'other';

export interface LinearStubRequest {
  method: string;
  /** Path and query: /graphql, or /upload/<id>. */
  path: string;
  headers: IncomingHttpHeaders;
  /** Which GraphQL operation a /graphql POST asks for; `put` for an upload. */
  operation: LinearOperation;
  // biome-ignore lint/suspicious/noExplicitAny: whatever the client sent; tests assert on it by operation
  variables: Record<string, any>;
  /** The upload's bytes (a PUT); empty otherwise. */
  bytes: Buffer;
}

export interface StubTeam {
  id: string;
  key: string;
  name: string;
}

export interface StubWorkflowState {
  name: string;
  type: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';
}

export interface StubLinearIssue {
  id: string;
  identifier: string;
  teamId: string;
  title: string;
  description: string;
  url: string;
  state: StubWorkflowState;
}

export interface StubUpload {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** The bytes PUT to the signed URL; null until they arrive. */
  bytes: Buffer | null;
  /** The headers the PUT came with. */
  putHeaders: IncomingHttpHeaders | null;
  assetUrl: string;
}

export type StubReply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface LinearStubOptions {
  /** The API key the stub accepts; any other gets 401. Default: any key. */
  key?: string;
  name?: string;
  teams?: StubTeam[];
  /** Milliseconds each issueCreate takes, so overlapping ones can be seen. Default 0. */
  issueCreateDelayMs?: number;
  port?: number;
}

export interface LinearStub {
  baseURL: string;
  requests: LinearStubRequest[];
  issues: StubLinearIssue[];
  uploads: StubUpload[];
  /** The most requests that were being answered at once. */
  readonly maxInFlight: number;
  /** Moves an issue to a workflow state. */
  setState(identifier: string, state: StubWorkflowState): void;
  /** Answers the requests it matches with its reply instead; null clears it. */
  fail(rule: ((req: LinearStubRequest) => StubReply | undefined) | null): void;
  /** Requests of one operation, in order. */
  calls(operation: LinearOperation): LinearStubRequest[];
  close(): Promise<void>;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
};

const operationOf = (method: string, path: string, query: string): LinearOperation => {
  if (method === 'PUT' && path.startsWith('/upload/')) return 'put';
  if (path !== '/graphql') return 'other';
  if (/\bfileUpload\s*\(/.test(query)) return 'fileUpload';
  if (/\bissueCreate\s*\(/.test(query)) return 'issueCreate';
  if (/\bissue\s*\(/.test(query)) return 'issue';
  if (/\bteams\s*\(/.test(query)) return 'teams';
  if (/\bteam\s*\(/.test(query)) return 'team';
  if (/\bviewer\b/.test(query)) return 'viewer';
  return 'other';
};

const gqlError = (status: number, code: string, message: string): StubReply => ({
  status,
  body: { errors: [{ message, extensions: { code, userPresentableMessage: message } }] },
});

export async function startLinearStub(options: LinearStubOptions = {}): Promise<LinearStub> {
  const teams = options.teams ?? [{ id: 'team-web', key: 'WEB', name: 'Web' }];
  const requests: LinearStubRequest[] = [];
  const issues: StubLinearIssue[] = [];
  const uploads: StubUpload[] = [];
  let rule: ((req: LinearStubRequest) => StubReply | undefined) | null = null;
  let inFlight = 0;
  let maxInFlight = 0;
  let baseURL = '';

  const ok = (data: unknown): StubReply => ({ status: 200, body: { data } });

  function route(req: LinearStubRequest): StubReply {
    if (req.operation === 'put') {
      const upload = uploads.find((u) => req.path === `/upload/${u.id}`);
      if (!upload) return { status: 404 };
      if (req.headers['content-type'] !== upload.contentType) return { status: 403 };
      upload.bytes = req.bytes;
      upload.putHeaders = req.headers;
      return { status: 200 };
    }
    const auth = String(req.headers.authorization ?? '');
    if (!auth || /^Bearer /i.test(auth) || (options.key && auth !== options.key))
      return gqlError(401, 'AUTHENTICATION_ERROR', 'Authentication required, not authenticated');
    const v = req.variables;
    switch (req.operation) {
      case 'viewer':
        return ok({ viewer: { id: 'user-1', name: options.name ?? 'Reviewer' } });
      case 'teams':
        return ok({ teams: { nodes: teams, pageInfo: { hasNextPage: false, endCursor: null } } });
      case 'team': {
        const team = teams.find((t) => t.id === v.id || t.key === v.id);
        return team ? ok({ team }) : gqlError(400, 'INVALID_INPUT', 'Entity not found: Team');
      }
      case 'fileUpload': {
        const id = `up-${uploads.length + 1}`;
        const upload: StubUpload = {
          id,
          filename: String(v.filename),
          contentType: String(v.contentType),
          size: Number(v.size),
          bytes: null,
          putHeaders: null,
          assetUrl: `https://uploads.linear.app/stub/${id}/${v.filename}`,
        };
        uploads.push(upload);
        return ok({
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: `${baseURL}/upload/${id}`,
              assetUrl: upload.assetUrl,
              headers: [{ key: 'x-goog-signature', value: `sig-${id}` }],
            },
          },
        });
      }
      case 'issueCreate': {
        const input = v.input ?? {};
        const team = teams.find((t) => t.id === input.teamId);
        if (!team) return gqlError(400, 'INVALID_INPUT', 'Entity not found: Team');
        const n = issues.filter((i) => i.teamId === team.id).length + 1;
        const identifier = `${team.key}-${n}`;
        const issue: StubLinearIssue = {
          id: `issue-${issues.length + 1}`,
          identifier,
          teamId: team.id,
          title: String(input.title ?? ''),
          description: String(input.description ?? ''),
          url: `https://linear.app/acme/issue/${identifier}/stub`,
          state: { name: 'Todo', type: 'unstarted' },
        };
        issues.push(issue);
        return ok({ issueCreate: { success: true, issue: { id: issue.id, identifier, url: issue.url } } });
      }
      case 'issue': {
        const issue = issues.find((i) => i.identifier === v.id || i.id === v.id);
        return issue
          ? ok({ issue: { state: issue.state } })
          : gqlError(400, 'INVALID_INPUT', 'Entity not found: Issue');
      }
      default:
        return gqlError(400, 'GRAPHQL_VALIDATION_FAILED', 'Unknown operation');
    }
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS).end();
        return;
      }
      const raw = Buffer.concat(chunks);
      const path = req.url ?? '/';
      let query = '';
      let variables: Record<string, unknown> = {};
      if (req.method === 'POST') {
        try {
          const json = JSON.parse(raw.toString('utf8'));
          query = String(json.query ?? '');
          variables = json.variables ?? {};
        } catch {
          // not JSON: the route answers 400
        }
      }
      const entry: LinearStubRequest = {
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        operation: operationOf(req.method ?? 'GET', path, query),
        variables,
        bytes: req.method === 'PUT' ? raw : Buffer.alloc(0),
      };
      requests.push(entry);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (entry.operation === 'issueCreate' && options.issueCreateDelayMs)
          await new Promise((r) => setTimeout(r, options.issueCreateDelayMs));
        const reply = rule?.(entry) ?? route(entry);
        res
          .writeHead(reply.status, { 'content-type': 'application/json', ...CORS, ...(reply.headers ?? {}) })
          .end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      } finally {
        inFlight--;
      }
    });
  });
  await new Promise<void>((r) => server.listen(options.port ?? 0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseURL,
    requests,
    issues,
    uploads,
    get maxInFlight() {
      return maxInFlight;
    },
    setState(identifier, state) {
      const issue = issues.find((i) => i.identifier === identifier);
      if (!issue) throw new Error(`stub has no issue ${identifier}`);
      issue.state = state;
    },
    fail(next) {
      rule = next;
    },
    calls: (operation) => requests.filter((r) => r.operation === operation),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
