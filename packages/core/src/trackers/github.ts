// GitHub Issues (ADR 0028), through the REST API with a fine-grained personal access token. It needs Issues (read and
// write), Contents (read and write) and Metadata (read) on the repo.
//
// Images: GitHub has no API to attach an image to an issue, so they are committed to the repo itself, on a branch of
// their own, `inkup-assets`, at `inkup/<session_id>/<screenshot_id>.png`, through the Git Data API: one blob per
// image, one tree on top of the branch tip, one commit, then the ref moves to it. A repo without the branch gets it as
// an orphan (a commit with no parent), so it shares no history with the code. Another send can move the ref first: the
// update is then refused as not a fast-forward, and the tree and commit are made again on the new tip. The issue
// embeds each image as https://github.com/<owner>/<repo>/blob/inkup-assets/<path>?raw=true, which GitHub renders for
// anyone who can read the repo.
import {
  type AdapterOptions,
  type Destination,
  type ImageUpload,
  type IssueStatus,
  type TestCheck,
  type TrackerAdapter,
  type TrackerCredentials,
  TrackerError,
} from './adapter.ts';

export const GITHUB_API = 'https://api.github.com';
export const ASSETS_BRANCH = 'inkup-assets';
const ASSETS_REF = `heads/${ASSETS_BRANCH}`;
/** How many times a refused ref update is tried again on the new tip. */
const REF_ATTEMPTS = 4;

/** Where an image goes in the repo. */
export const assetPath = (sessionId: string, imageId: string) => `inkup/${sessionId}/${imageId}.png`;
/** The URL an issue embeds for an image on the assets branch. */
export const assetUrl = (repo: string, path: string) =>
  `https://github.com/${repo}/blob/${ASSETS_BRANCH}/${path}?raw=true`;

/** `owner/repo`, checked. */
function parseRepo(destination: string): string {
  const repo = destination.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new TrackerError('not_found', `"${destination}" is not a GitHub repo. Pick one written as owner/repo.`);
  return repo;
}

/** Base64 of the bytes, without btoa's string round trip limits. */
export function toBase64(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += abc[n >> 18]! + abc[(n >> 12) & 63]! + abc[(n >> 6) & 63]! + abc[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${abc[n >> 18]!}${abc[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${abc[n >> 18]!}${abc[(n >> 12) & 63]!}${abc[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** What a failed call is about, so its message can say which permission to give. */
type Area = 'user' | 'repo' | 'contents' | 'issues' | 'status';

interface Reply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: GitHub's JSON, read field by field below
  body: any;
}

export function githubAdapter({ fetch: doFetch, baseUrl }: AdapterOptions): TrackerAdapter {
  // Trailing slashes off, without a regex (`/\/+$/` backtracks on a long run of slashes).
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);

  async function call(credentials: TrackerCredentials, method: string, path: string, body?: unknown): Promise<Reply> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${credentials.token.trim()}`,
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TrackerError('network', "Couldn't reach GitHub. Check your connection, then try again.");
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, body: json };
  }

  /** The reviewer-facing error for a failed reply. */
  function failure(r: Reply, area: Area, repo = ''): TrackerError {
    const said = typeof r.body?.message === 'string' ? (r.body.message as string) : '';
    if (r.status === 401)
      return new TrackerError(
        'auth',
        "GitHub didn't accept this token. It may have expired or been revoked. Paste a new one in Trackers settings.",
        401,
      );
    if (
      r.status === 429 ||
      (r.status === 403 && (r.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(said)))
    )
      return new TrackerError(
        'rate_limit',
        'GitHub is limiting requests from this token. Wait a minute, then try again.',
        r.status,
      );
    if (r.status === 409 && /empty/i.test(said))
      return new TrackerError(
        'empty_repo',
        `${repo} has no commits yet, so InkUp can't store screenshots there. Push a first commit, then try again.`,
        409,
      );
    if (r.status === 410 && area === 'issues')
      return new TrackerError(
        'disabled',
        `Issues are turned off for ${repo}. Turn them on in the repo's settings, or pick another repo.`,
        410,
      );
    if (r.status === 403 || (r.status === 404 && (area === 'contents' || area === 'issues'))) {
      if (area === 'contents')
        return new TrackerError(
          'permission',
          `This token can't write to ${repo}. Give it Contents: read and write.`,
          r.status,
        );
      if (area === 'issues' || area === 'status')
        return new TrackerError(
          'permission',
          `This token can't ${area === 'issues' ? 'create' : 'read'} issues in ${repo}. Give it Issues: read and write.`,
          r.status,
        );
    }
    if (r.status === 404)
      return area === 'status'
        ? new TrackerError('not_found', `This issue is no longer in ${repo}. It may have been deleted or moved.`, 404)
        : new TrackerError(
            'not_found',
            `GitHub can't find ${repo}, or this token can't see it. Check the repo name and the token's repository access.`,
            404,
          );
    return new TrackerError(
      'other',
      `GitHub answered ${r.status}${said ? `: ${said}` : ''}. Try again; if it keeps failing, check the token in Trackers settings.`,
      r.status,
    );
  }

  const ok = (r: Reply) => r.status >= 200 && r.status < 300;

  /** The assets branch tip, or null when the repo has no such branch. */
  async function assetsTip(c: TrackerCredentials, repo: string): Promise<string | null> {
    const r = await call(c, 'GET', `/repos/${repo}/git/ref/${ASSETS_REF}`);
    if (r.status === 404) return null;
    if (!ok(r)) throw failure(r, 'contents', repo);
    return String(r.body?.object?.sha);
  }

  async function makeCommit(
    c: TrackerCredentials,
    repo: string,
    tip: string | null,
    entries: { path: string; sha: string }[],
    sessionId: string,
  ): Promise<string> {
    let baseTree: string | null = null;
    if (tip) {
      const parent = await call(c, 'GET', `/repos/${repo}/git/commits/${tip}`);
      if (!ok(parent)) throw failure(parent, 'contents', repo);
      baseTree = String(parent.body?.tree?.sha);
    }
    const tree = await call(c, 'POST', `/repos/${repo}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
    });
    if (!ok(tree)) throw failure(tree, 'contents', repo);
    const commit = await call(c, 'POST', `/repos/${repo}/git/commits`, {
      message: `InkUp: ${entries.length} screenshot${entries.length === 1 ? '' : 's'} from Session ${sessionId}`,
      tree: String(tree.body?.sha),
      parents: tip ? [tip] : [],
    });
    if (!ok(commit)) throw failure(commit, 'contents', repo);
    return String(commit.body?.sha);
  }

  return {
    tracker: 'github',
    label: 'GitHub',

    async listDestinations(c): Promise<Destination[]> {
      const out: Destination[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await call(c, 'GET', `/user/repos?per_page=100&sort=pushed&page=${page}`);
        if (!ok(r)) throw failure(r, 'user');
        const repos = Array.isArray(r.body) ? r.body : [];
        for (const repo of repos)
          if (typeof repo?.full_name === 'string') out.push({ id: repo.full_name, name: repo.full_name });
        if (repos.length < 100) break;
      }
      return out;
    },

    async test(c, destination) {
      const checks: TestCheck[] = [];
      const done = () => ({ ok: checks.every((x) => x.ok), checks });
      const user = await call(c, 'GET', '/user');
      if (!ok(user)) {
        checks.push({ id: 'token', ok: false, message: failure(user, 'user').message });
        return done();
      }
      checks.push({
        id: 'token',
        ok: true,
        message: `The token works (signed in as ${user.body?.login ?? 'unknown'}).`,
      });
      let repo: string;
      try {
        repo = parseRepo(destination);
      } catch (e) {
        checks.push({ id: 'repo', ok: false, message: (e as Error).message });
        return done();
      }
      const info = await call(c, 'GET', `/repos/${repo}`);
      if (!ok(info)) {
        checks.push({ id: 'repo', ok: false, message: failure(info, 'repo', repo).message });
        return done();
      }
      checks.push({ id: 'repo', ok: true, message: `${repo} is reachable.` });
      checks.push(
        info.body?.has_issues === false
          ? {
              id: 'issues',
              ok: false,
              message: `Issues are turned off for ${repo}. Turn them on in the repo's settings, or pick another repo.`,
            }
          : { id: 'issues', ok: true, message: 'Issues are enabled.' },
      );
      // Writing a blob proves Contents write without changing anything: an unreferenced blob is never shown.
      const blob = await call(c, 'POST', `/repos/${repo}/git/blobs`, {
        content: 'InkUp permission check\n',
        encoding: 'utf-8',
      });
      checks.push(
        ok(blob)
          ? { id: 'contents', ok: true, message: `The token can store screenshots in ${repo}.` }
          : { id: 'contents', ok: false, message: failure(blob, 'contents', repo).message },
      );
      return done();
    },

    async uploadImages(c, destination, sessionId, images: readonly ImageUpload[]) {
      const repo = parseRepo(destination);
      const urls = new Map<string, string>();
      if (!images.length) return urls;
      const entries: { id: string; path: string; sha: string }[] = [];
      for (const image of images) {
        const blob = await call(c, 'POST', `/repos/${repo}/git/blobs`, {
          content: toBase64(image.bytes),
          encoding: 'base64',
        });
        if (!ok(blob)) throw failure(blob, 'contents', repo);
        entries.push({ id: image.id, path: assetPath(sessionId, image.id), sha: String(blob.body?.sha) });
      }
      for (let attempt = 1; ; attempt++) {
        const tip = await assetsTip(c, repo);
        const commit = await makeCommit(c, repo, tip, entries, sessionId);
        const moved = tip
          ? await call(c, 'PATCH', `/repos/${repo}/git/refs/${ASSETS_REF}`, { sha: commit, force: false })
          : await call(c, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/${ASSETS_REF}`, sha: commit });
        if (ok(moved)) break;
        // 422: not a fast-forward (another send moved the tip), or the branch was just created by another send.
        if (moved.status !== 422 && moved.status !== 409) throw failure(moved, 'contents', repo);
        if (attempt >= REF_ATTEMPTS)
          throw new TrackerError(
            'conflict',
            `Another send kept changing the ${ASSETS_BRANCH} branch of ${repo}. Try again in a moment.`,
            moved.status,
          );
      }
      for (const e of entries) urls.set(e.id, assetUrl(repo, e.path));
      return urls;
    },

    async createIssue(c, destination, issue) {
      const repo = parseRepo(destination);
      const r = await call(c, 'POST', `/repos/${repo}/issues`, { title: issue.title, body: issue.body });
      if (!ok(r)) throw failure(r, 'issues', repo);
      return { tracker: 'github', destination: repo, key: `#${r.body?.number}`, url: String(r.body?.html_url) };
    },

    async getStatus(c, link): Promise<IssueStatus> {
      const repo = parseRepo(link.destination);
      const number = /^#?(\d+)$/.exec(link.key.trim())?.[1];
      if (!number) throw new TrackerError('not_found', `"${link.key}" is not a GitHub issue number.`);
      const r = await call(c, 'GET', `/repos/${repo}/issues/${number}`);
      if (!ok(r)) throw failure(r, 'status', repo);
      if (r.body?.state !== 'closed') return { state: 'open' };
      const reason = r.body?.state_reason;
      return { state: 'closed', reason: reason === 'completed' || reason === 'not_planned' ? reason : null };
    },
  };
}
