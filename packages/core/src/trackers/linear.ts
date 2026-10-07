// Linear (ADR 0028), through its GraphQL API with the reviewer's personal API key, sent as `Authorization: <key>` (no
// "Bearer": that is for OAuth tokens).
//
// Images: Linear has an upload flow of its own. The `fileUpload` mutation answers a signed `uploadUrl`, the headers to
// PUT with, and the `assetUrl` the issue embeds. A send asks for every image's upload first, then PUTs the bytes, then
// the caller creates the issue. The PUT goes to the signed URL and never carries the API key.
//
// Destinations are teams. A team's id is what `issueCreate` needs, so a link records it as `destination`; the issue's
// identifier ("WEB-12") is its `key`, and its status is read from its workflow state: the state's `name` is what the
// badge shows, its `type` says whether it is closed (completed, or canceled).
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

export const LINEAR_API = 'https://api.linear.app';

/** What a failed call is about, so its message can say what to do. */
type Area = 'viewer' | 'team' | 'upload' | 'issue' | 'status';

interface GraphqlError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

interface Reply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: Linear's JSON, read field by field below
  data: any;
  errors: GraphqlError[];
}

const TEAMS_PAGE = 100;

export function linearAdapter({ fetch: doFetch, baseUrl }: AdapterOptions): TrackerAdapter {
  // Trailing slashes off, without a regex (`/\/+$/` backtracks on a long run of slashes).
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);

  async function graphql(
    c: TrackerCredentials,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Reply> {
    let res: Response;
    try {
      res = await doFetch(`${base}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: c.token.trim() },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new TrackerError('network', "Couldn't reach Linear. Check your connection, then try again.");
    }
    const text = await res.text().catch(() => '');
    let json: { data?: unknown; errors?: GraphqlError[] } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: res.status,
      headers: res.headers,
      data: json?.data ?? null,
      errors: Array.isArray(json?.errors) ? json.errors : [],
    };
  }

  const succeeded = (r: Reply) => r.status >= 200 && r.status < 300 && r.errors.length === 0;

  /** How long Linear asked to wait: `retry-after`, else when its request limit resets. */
  function waitFor(r: Reply): number | null {
    const after = retryAfterMs(r.headers.get('retry-after'));
    if (after !== null) return after;
    const reset = Number(r.headers.get('x-ratelimit-requests-reset'));
    return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - Date.now()) : null;
  }

  /** The reviewer-facing error for a failed reply. */
  function failure(r: Reply, area: Area): TrackerError {
    const first = r.errors[0];
    const code = `${first?.extensions?.code ?? ''} ${first?.extensions?.type ?? ''}`.toLowerCase();
    const said = first?.extensions?.userPresentableMessage ?? first?.message ?? '';
    if (r.status === 401 || /authentication/.test(code))
      return new TrackerError(
        'auth',
        "Linear didn't accept this key. It may have been revoked. Make a new personal API key in Linear (Settings, Security & access) and paste it in Trackers settings.",
        401,
      );
    if (r.status === 429 || /ratelimit/.test(code))
      return new TrackerError(
        'rate_limit',
        'Linear is limiting requests from this key. Wait a minute, then try again.',
        r.status,
        waitFor(r),
      );
    if (r.status === 403 || /forbidden/.test(code))
      return new TrackerError(
        'permission',
        area === 'status'
          ? "This key can't read this issue. Use a key that can see the team."
          : "This key can't create issues in that team. Make a personal API key with full access and paste it in Trackers settings.",
        r.status || 403,
      );
    if (area === 'status' && (/not.?found/i.test(said) || /not.?found/.test(code) || r.status === 404))
      return new TrackerError('not_found', 'This issue is no longer in Linear. It may have been deleted.', 404);
    if (area === 'issue' || area === 'team')
      if (/team|not.?found|invalid/i.test(`${said} ${code}`))
        return new TrackerError(
          'not_found',
          "Linear can't find that team, or this key can't see it. Pick a team in Trackers settings.",
          r.status || null,
        );
    return new TrackerError(
      'other',
      `Linear answered ${r.status || 'with an error'}${said ? `: ${said}` : ''}. Try again; if it keeps failing, check the key in Trackers settings.`,
      r.status || null,
    );
  }

  interface Upload {
    id: string;
    uploadUrl: string;
    assetUrl: string;
    headers: { key: string; value: string }[];
  }

  async function requestUpload(c: TrackerCredentials, image: ImageUpload): Promise<Upload> {
    const r = await graphql(
      c,
      `mutation InkupUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success
          uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { contentType: 'image/png', filename: `${image.id}.png`, size: image.bytes.length },
    );
    const file = r.data?.fileUpload?.uploadFile;
    if (!succeeded(r) || !r.data?.fileUpload?.success || !file?.uploadUrl || !file?.assetUrl)
      throw failure(r, 'upload');
    return {
      id: image.id,
      uploadUrl: String(file.uploadUrl),
      assetUrl: String(file.assetUrl),
      headers: Array.isArray(file.headers) ? file.headers : [],
    };
  }

  async function putImage(upload: Upload, bytes: Uint8Array): Promise<void> {
    let url: URL;
    try {
      url = new URL(upload.uploadUrl);
    } catch {
      throw new TrackerError('other', 'Linear gave an upload address InkUp could not use. Try again.');
    }
    if (url.protocol !== 'https:' && url.protocol !== new URL(base).protocol)
      throw new TrackerError('other', 'Linear gave an upload address InkUp could not use. Try again.');
    // The signed URL carries its own permission: the API key stays off this request.
    const headers: Record<string, string> = {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000',
    };
    for (const h of upload.headers) if (h?.key) headers[String(h.key).toLowerCase()] = String(h.value);
    let res: Response;
    try {
      res = await doFetch(url.toString(), { method: 'PUT', headers, body: new Uint8Array(bytes) });
    } catch {
      throw new TrackerError(
        'network',
        "Couldn't reach Linear to upload a screenshot. Check your connection, then try again.",
      );
    }
    if (res.status < 200 || res.status >= 300)
      throw new TrackerError(
        res.status === 429 ? 'rate_limit' : 'other',
        `Linear didn't accept a screenshot (answered ${res.status}). Try again.`,
        res.status,
        res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null,
      );
  }

  return {
    tracker: 'linear',
    label: 'Linear',

    async listDestinations(c): Promise<Destination[]> {
      const out: Destination[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r: Reply = await graphql(
          c,
          `query InkupTeams($first: Int!, $after: String) {
            teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } }
          }`,
          { first: TEAMS_PAGE, after },
        );
        if (!succeeded(r)) throw failure(r, 'viewer');
        const teams = r.data?.teams;
        for (const t of Array.isArray(teams?.nodes) ? teams.nodes : [])
          if (typeof t?.id === 'string')
            out.push({ id: t.id, name: t.key ? `${t.name ?? t.key} (${t.key})` : String(t.name ?? t.id) });
        if (!teams?.pageInfo?.hasNextPage || !teams.pageInfo.endCursor) break;
        after = String(teams.pageInfo.endCursor);
      }
      return out;
    },

    async test(c, destination) {
      const checks: TestCheck[] = [];
      const done = () => ({ ok: checks.every((x) => x.ok), checks });
      const who = await graphql(c, 'query InkupViewer { viewer { id name } }');
      if (!succeeded(who) || !who.data?.viewer) {
        checks.push({ id: 'token', ok: false, message: failure(who, 'viewer').message });
        return done();
      }
      checks.push({
        id: 'token',
        ok: true,
        message: `The key works (signed in as ${who.data.viewer.name ?? 'unknown'}).`,
      });
      const team = destination.trim();
      if (!team) {
        checks.push({ id: 'team', ok: false, message: 'Pick a default team in Trackers settings.' });
        return done();
      }
      const found = await graphql(c, 'query InkupTeam($id: String!) { team(id: $id) { id key name } }', { id: team });
      if (!succeeded(found) || !found.data?.team) {
        checks.push({ id: 'team', ok: false, message: failure(found, 'team').message });
        return done();
      }
      checks.push({ id: 'team', ok: true, message: `${found.data.team.name ?? found.data.team.key} is reachable.` });
      // Asking for an upload proves screenshots can be stored without putting anything there.
      try {
        await requestUpload(c, { id: 'inkup-permission-check', bytes: new Uint8Array(1) });
        checks.push({ id: 'uploads', ok: true, message: 'The key can store screenshots.' });
      } catch (e) {
        checks.push({ id: 'uploads', ok: false, message: (e as Error).message });
      }
      return done();
    },

    async uploadImages(c, _destination, _sessionId, images: readonly ImageUpload[]) {
      const urls = new Map<string, string>();
      // Every upload is asked for first, then the bytes go up.
      const uploads: Upload[] = [];
      for (const image of images) uploads.push(await requestUpload(c, image));
      for (const [i, upload] of uploads.entries()) {
        await putImage(upload, images[i]!.bytes);
        urls.set(upload.id, upload.assetUrl);
      }
      return urls;
    },

    async createIssue(c, destination, issue) {
      const team = destination.trim();
      if (!team) throw new TrackerError('not_found', 'Pick a team in Trackers settings, then send again.');
      const r = await graphql(
        c,
        `mutation InkupIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier url } }
        }`,
        { input: { teamId: team, title: issue.title, description: issue.body } },
      );
      const created = r.data?.issueCreate?.issue;
      if (!succeeded(r) || !r.data?.issueCreate?.success || !created?.identifier) throw failure(r, 'issue');
      return { tracker: 'linear', destination: team, key: String(created.identifier), url: String(created.url) };
    },

    async getStatus(c, link): Promise<IssueStatus> {
      const r = await graphql(c, 'query InkupStatus($id: String!) { issue(id: $id) { state { name type } } }', {
        id: link.key.trim(),
      });
      const state = r.data?.issue?.state;
      if (!succeeded(r) || !state) throw failure(r, 'status');
      const name = typeof state.name === 'string' && state.name ? state.name : undefined;
      if (state.type === 'completed') return { state: 'closed', reason: 'completed', ...(name ? { name } : {}) };
      if (state.type === 'canceled') return { state: 'closed', reason: 'not_planned', ...(name ? { name } : {}) };
      return { state: 'open', ...(name ? { name } : {}) };
    },
  };
}
