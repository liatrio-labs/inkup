// Jira Cloud (ADR 0028), through REST v3 with Basic auth: the Atlassian account's email and an API token, against the
// site the reviewer enters (https://<site>.atlassian.net). The account needs to be able to create issues, and add
// attachments, in the project.
//
// Images: Jira takes an attachment only once the issue exists, so a send is create, then attach, then update. The issue
// is created with its whole description (as Atlassian Document Format, ./adf.ts) minus the screenshot links; each
// screenshot is then uploaded to the issue's attachments (`X-Atlassian-Token: no-check`, which the endpoint requires),
// and the description is updated to link every attachment, with the agent prompt's `screenshots/<id>.png` citations
// pointing at them. An item with no images is created once, with nothing to attach.
//
// Jira sends no CORS headers for token auth, so this runs where the caller has host permission for the site (the
// extension's pages, the desktop app's tauri-plugin-http).
import {
  type AdapterOptions,
  type Destination,
  type ImageUpload,
  type IssueStatus,
  retryAfterMs,
  type TestCheck,
  type TrackerAdapter,
  type TrackerCredentials,
  TrackerError,
} from './adapter.ts';
import { buildIssueAdf, cutChars } from './adf.ts';
import { toBase64 } from './github.ts';

/** Jira's limit on an issue summary. */
export const JIRA_MAX_SUMMARY = 255;

export interface JiraOptions extends AdapterOptions {
  /** The Atlassian account's email; the token is the credentials' `token`. */
  email: string;
  /** The issue type the reviewer picked; unset follows the item (Bug for a bug when the project has it, else Task). */
  issueType?: string | null;
  /** The site the issue links are built on, when `baseUrl` is not it (a test stub); default `baseUrl`. */
  siteUrl?: string;
}

export interface JiraAdapter extends TrackerAdapter {
  /** The names of the issue types the project offers (not sub-tasks). */
  listIssueTypes(credentials: TrackerCredentials, project: string): Promise<string[]>;
}

/**
 * The site as `https://<site>.atlassian.net`, from what the reviewer typed ("acme", "acme.atlassian.net", or the whole
 * URL, with or without a trailing slash); null when it is not an Atlassian Cloud site.
 */
export function parseJiraSite(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    value = `https://${value.includes('.') ? value : `${value}.atlassian.net`}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.pathname.replace(/\/+/g, '') || url.search || url.hash) return null;
  return /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i.test(url.hostname) ? `https://${url.hostname.toLowerCase()}` : null;
}

/** The issue type for an item: the one picked, else Bug for a bug when the project has it, else Task. */
export function chooseIssueType(available: readonly string[], category: string, picked?: string | null): string {
  const find = (name: string) => available.find((t) => t.toLowerCase() === name.toLowerCase());
  const want = picked?.trim();
  if (want) {
    const found = find(want);
    if (!found)
      throw new TrackerError(
        'not_found',
        `This project has no "${want}" issue type. Pick one it has in Trackers settings.`,
      );
    return found;
  }
  const chosen = (category === 'bug' ? find('Bug') : undefined) ?? find('Task') ?? available[0];
  if (!chosen)
    throw new TrackerError('not_found', 'This project offers no issue types InkUp can use. Pick another project.');
  return chosen;
}

interface Reply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: Jira's JSON, read field by field below
  body: any;
}

/** What a failed call is about, so its message can say what to do. */
type Area = 'user' | 'project' | 'create' | 'attach' | 'update' | 'status';

const utf8 = new TextEncoder();

export function jiraAdapter({ fetch: doFetch, baseUrl, email, issueType, siteUrl }: JiraOptions): JiraAdapter {
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  let site = siteUrl ?? base;
  while (site.endsWith('/')) site = site.slice(0, -1);

  async function call(
    c: TrackerCredentials,
    method: string,
    path: string,
    body?: { json?: unknown; form?: FormData },
  ): Promise<Reply> {
    let res: Response;
    try {
      res = await doFetch(`${base}/rest/api/3${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Basic ${toBase64(utf8.encode(`${email.trim()}:${c.token.trim()}`))}`,
          ...(body?.json === undefined ? {} : { 'content-type': 'application/json' }),
          // Without this an attachment upload is refused as a possible cross-site request.
          ...(body?.form ? { 'x-atlassian-token': 'no-check' } : {}),
        },
        ...(body?.json === undefined ? {} : { body: JSON.stringify(body.json) }),
        ...(body?.form ? { body: body.form } : {}),
      });
    } catch {
      throw new TrackerError(
        'network',
        "Couldn't reach Jira. Check the site address and your connection, then try again.",
      );
    }
    const raw = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, body: json };
  }

  const ok = (r: Reply) => r.status >= 200 && r.status < 300;

  /** What Jira said was wrong: its error messages and field errors, joined. */
  function said(r: Reply): string {
    const messages: string[] = Array.isArray(r.body?.errorMessages) ? r.body.errorMessages.map(String) : [];
    const fields = r.body?.errors && typeof r.body.errors === 'object' ? Object.values(r.body.errors).map(String) : [];
    return [...messages, ...fields].filter(Boolean).join(' ');
  }

  function failure(r: Reply, area: Area, project = ''): TrackerError {
    if (r.status === 401)
      return new TrackerError(
        'auth',
        "Jira didn't accept this email and API token. The token may have expired or been revoked. Enter a new one in Trackers settings.",
        401,
      );
    if (r.status === 429)
      return new TrackerError(
        'rate_limit',
        'Jira is limiting requests from this account. Wait a minute, then try again.',
        429,
        retryAfterMs(r.headers.get('retry-after')),
      );
    if (area === 'create' && (r.status === 403 || r.status === 404))
      return new TrackerError(
        'permission',
        `This account can't create issues in "${project}". Ask a Jira admin for the Create Issues permission there, or pick another project.`,
        r.status,
      );
    if (area === 'attach' && (r.status === 403 || r.status === 404))
      return new TrackerError(
        'permission',
        `This account can't add attachments in "${project}". Ask a Jira admin for the Create Attachments permission there.`,
        r.status,
      );
    if (area === 'update' && (r.status === 403 || r.status === 404))
      return new TrackerError(
        'permission',
        `This account can't edit issues in "${project}". Ask a Jira admin for the Edit Issues permission there.`,
        r.status,
      );
    if (r.status === 403)
      return new TrackerError(
        'permission',
        "Jira won't let this account do that. Check its permissions, then try again.",
        403,
      );
    if (r.status === 404)
      return area === 'status'
        ? new TrackerError('not_found', 'This issue is no longer in Jira. It may have been deleted or moved.', 404)
        : new TrackerError(
            'not_found',
            `Jira can't find ${project ? `the project "${project}"` : 'that'}, or this account can't see it. Check the site address and the project key.`,
            404,
          );
    const why = said(r);
    if (area === 'create' && r.status === 400)
      return new TrackerError(
        'other',
        `Jira refused the issue${why ? `: ${why}` : ''}. If the project requires a field InkUp doesn't fill, make it optional or pick another project.`,
        400,
      );
    return new TrackerError(
      'other',
      `Jira answered ${r.status}${why ? `: ${why}` : ''}. Try again; if it keeps failing, check the site and token in Trackers settings.`,
      r.status,
    );
  }

  async function issueTypes(c: TrackerCredentials, project: string): Promise<string[]> {
    const r = await call(c, 'GET', `/project/${encodeURIComponent(project)}`);
    if (!ok(r)) throw failure(r, 'project', project);
    const types: { name?: unknown; subtask?: unknown }[] = Array.isArray(r.body?.issueTypes) ? r.body.issueTypes : [];
    return types.filter((t) => typeof t?.name === 'string' && !t.subtask).map((t) => String(t.name));
  }

  const parseProject = (destination: string) => {
    const key = destination.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key))
      throw new TrackerError(
        'not_found',
        `"${destination}" is not a Jira project key. Pick a project in Trackers settings.`,
      );
    return key.toUpperCase();
  };

  return {
    tracker: 'jira',
    label: 'Jira',

    async listDestinations(c): Promise<Destination[]> {
      const out: Destination[] = [];
      for (let start = 0; start < 1000; ) {
        const r = await call(c, 'GET', `/project/search?startAt=${start}&maxResults=50&orderBy=name`);
        if (!ok(r)) throw failure(r, 'user');
        const values: { key?: unknown; name?: unknown }[] = Array.isArray(r.body?.values) ? r.body.values : [];
        for (const p of values)
          if (typeof p?.key === 'string') out.push({ id: p.key, name: `${String(p.name ?? p.key)} (${p.key})` });
        start += values.length;
        if (r.body?.isLast !== false || !values.length) break;
      }
      return out;
    },

    listIssueTypes: issueTypes,

    async test(c, destination) {
      const checks: TestCheck[] = [];
      const done = () => ({ ok: checks.every((x) => x.ok), checks });
      const me = await call(c, 'GET', '/myself');
      if (!ok(me)) {
        checks.push({ id: 'token', ok: false, message: failure(me, 'user').message });
        return done();
      }
      checks.push({
        id: 'token',
        ok: true,
        message: `The token works (signed in as ${me.body?.displayName ?? me.body?.emailAddress ?? 'unknown'}).`,
      });
      let project: string;
      try {
        project = parseProject(destination);
      } catch (e) {
        checks.push({ id: 'project', ok: false, message: (e as Error).message });
        return done();
      }
      const info = await call(c, 'GET', `/project/${encodeURIComponent(project)}`);
      if (!ok(info)) {
        checks.push({ id: 'project', ok: false, message: failure(info, 'project', project).message });
        return done();
      }
      checks.push({ id: 'project', ok: true, message: `${project} is reachable.` });
      const perms = await call(
        c,
        'GET',
        `/mypermissions?projectKey=${encodeURIComponent(project)}&permissions=CREATE_ISSUES,CREATE_ATTACHMENTS`,
      );
      const has = (name: string) => ok(perms) && perms.body?.permissions?.[name]?.havePermission === true;
      checks.push(
        has('CREATE_ISSUES')
          ? { id: 'create', ok: true, message: `This account can create issues in "${project}".` }
          : {
              id: 'create',
              ok: false,
              message: failure({ status: 403, headers: new Headers(), body: null }, 'create', project).message,
            },
      );
      checks.push(
        has('CREATE_ATTACHMENTS')
          ? { id: 'attach', ok: true, message: `This account can attach screenshots in "${project}".` }
          : {
              id: 'attach',
              ok: false,
              message: failure({ status: 403, headers: new Headers(), body: null }, 'attach', project).message,
            },
      );
      return done();
    },

    // Jira takes images only once the issue exists: sendItem is create, attach, update.
    async uploadImages() {
      throw new TrackerError('other', 'Jira takes screenshots after the issue exists. Use sendItem.');
    },

    async createIssue(c, destination, issue) {
      // A plain-text description: the full Atlassian Document Format body is built by sendItem, from the item.
      const project = parseProject(destination);
      const types = await issueTypes(c, project);
      const r = await call(c, 'POST', '/issue', {
        json: {
          fields: {
            project: { key: project },
            summary: cutChars(issue.title, JIRA_MAX_SUMMARY),
            issuetype: { name: chooseIssueType(types, '', issueType) },
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: issue.body || '-' }] }],
            },
          },
        },
      });
      if (!ok(r)) throw failure(r, 'create', project);
      const key = String(r.body?.key);
      return { tracker: 'jira', destination: project, key, url: `${site}/browse/${key}` };
    },

    async sendItem(c, destination, { item, session, images }) {
      const project = parseProject(destination);
      const types = await issueTypes(c, project);
      const type = chooseIssueType(types, item.category, issueType);
      const withoutImages = buildIssueAdf(item, session, new Map());
      const created = await call(c, 'POST', '/issue', {
        json: {
          fields: {
            project: { key: project },
            summary: cutChars(item.title.trim(), JIRA_MAX_SUMMARY),
            issuetype: { name: type },
            description: withoutImages,
          },
        },
      });
      if (!ok(created)) throw failure(created, 'create', project);
      const key = String(created.body?.key);
      const link = { tracker: 'jira' as const, destination: project, key, url: `${site}/browse/${key}` };
      if (!images.length) return link;

      const urls = new Map<string, string>();
      try {
        for (const image of images as readonly ImageUpload[]) {
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(image.bytes)], { type: 'image/png' }), `${image.id}.png`);
          const r = await call(c, 'POST', `/issue/${encodeURIComponent(key)}/attachments`, { form });
          if (!ok(r)) throw failure(r, 'attach', project);
          const content = Array.isArray(r.body) ? r.body[0]?.content : null;
          if (typeof content === 'string') urls.set(image.id, content);
        }
        if (urls.size) {
          const updated = await call(c, 'PUT', `/issue/${encodeURIComponent(key)}`, {
            json: { fields: { description: buildIssueAdf(item, session, urls) } },
          });
          if (!ok(updated)) throw failure(updated, 'update', project);
        }
      } catch (e) {
        // The issue exists, so a second send would make a duplicate: say so, with where it is, and hand the caller the
        // link to record. No retry-after, even on a 429: waiting and sending again would make a second issue.
        if (e instanceof TrackerError)
          throw new TrackerError(
            e.kind,
            `${key} was created in Jira, but its screenshots didn't all go on: ${e.message} Open ${link.url} to add them; sending again would make a second issue.`,
            e.status,
            null,
            link,
          );
        throw e;
      }
      return link;
    },

    async getStatus(c, link): Promise<IssueStatus> {
      const key = link.key.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key))
        throw new TrackerError('not_found', `"${link.key}" is not a Jira issue key.`);
      const r = await call(c, 'GET', `/issue/${encodeURIComponent(key)}?fields=status`);
      if (!ok(r)) throw failure(r, 'status', link.destination);
      const status = r.body?.fields?.status;
      const name = typeof status?.name === 'string' && status.name ? status.name : undefined;
      const k = status?.statusCategory?.key;
      const category = k === 'new' || k === 'indeterminate' || k === 'done' ? k : undefined;
      const extra = { ...(name ? { name } : {}), ...(category ? { category } : {}) };
      return category === 'done' ? { state: 'closed', reason: null, ...extra } : { state: 'open', ...extra };
    },
  };
}
