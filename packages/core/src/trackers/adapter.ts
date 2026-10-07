// What every issue tracker adapter does (ADR 0028). An adapter runs in the Client that sends (the extension's pages,
// later the desktop app's webview), with the reviewer's own token. It is given its `fetch` and the tracker's API base,
// so tests point it at a stub (tests/support/github-stub.ts) and the desktop app at tauri-plugin-http's fetch.
//
// Errors are TrackerError, with a message written for the reviewer: what went wrong in plain words, then what to do.
import type { TrackerLink, TrackerName } from '../timeline.ts';
import type { IssueItem, IssueSession } from './issue.ts';

export type { TrackerLink, TrackerName } from '../timeline.ts';

/** The reviewer's own token for a tracker. Never logged, stored or exported outside its own storage key. */
export interface TrackerCredentials {
  token: string;
}

/** Somewhere an issue can be created: a GitHub repo (`owner/repo`), a Linear team. */
export interface Destination {
  /** What a TrackerLink records as `destination`: `owner/repo` on GitHub, the team's id on Linear. */
  id: string;
  /** What the reviewer sees in a list. */
  name: string;
}

/** An issue as built by buildIssue (./issue.ts). */
export interface IssueDraft {
  title: string;
  /** Markdown. */
  body: string;
}

/** An image to upload before the issue is created: a screenshot or an element crop of the item. */
export interface ImageUpload {
  /** The screenshot (or crop) id, as cited by the agent prompt: `screenshots/<id>.png`. */
  id: string;
  /** PNG bytes. */
  bytes: Uint8Array;
}

/**
 * The issue's state as the tracker reports it now. Read live, never stored (ADR 0028). `name` is the tracker's own
 * word for it ("In Progress"), shown on the badge in place of "open" or "closed" when the tracker has one. `category`
 * is Jira's status category, which colours the badge.
 */
export type IssueStatus = ({ state: 'open' } | { state: 'closed'; reason: 'completed' | 'not_planned' | null }) & {
  name?: string;
  category?: 'new' | 'indeterminate' | 'done';
};

/** One line of a Test: what was checked, and whether it passed. A failed line says what to do. */
export interface TestCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface TestResult {
  ok: boolean;
  checks: TestCheck[];
}

export interface TrackerAdapter {
  readonly tracker: TrackerName;
  /** The tracker's name as the reviewer reads it: "GitHub". */
  readonly label: string;
  /** Whether the token works and can create issues, with their images, in the destination. */
  test(credentials: TrackerCredentials, destination: string): Promise<TestResult>;
  /** The destinations the token can see. */
  listDestinations(credentials: TrackerCredentials): Promise<Destination[]>;
  /**
   * The spec's `uploadImage`, batched: uploads the item's images and answers each one's URL to embed, by id. GitHub
   * commits them all in one commit.
   */
  uploadImages(
    credentials: TrackerCredentials,
    destination: string,
    sessionId: string,
    images: readonly ImageUpload[],
  ): Promise<Map<string, string>>;
  createIssue(
    credentials: TrackerCredentials,
    destination: string,
    issue: IssueDraft,
  ): Promise<Omit<TrackerLink, 'created_at'>>;
  getStatus(credentials: TrackerCredentials, link: Pick<TrackerLink, 'destination' | 'key'>): Promise<IssueStatus>;
  /**
   * For a tracker that can only take images once the issue exists (Jira: create, attach, then update the description)
   * and writes its own body format: sends the whole item and answers its link. pushItem uses it instead of
   * uploadImages then createIssue.
   */
  sendItem?(
    credentials: TrackerCredentials,
    destination: string,
    input: { item: IssueItem; session: IssueSession & { id: string }; images: readonly ImageUpload[] },
  ): Promise<Omit<TrackerLink, 'created_at'>>;
}

export interface AdapterOptions {
  fetch: typeof fetch;
  /** The tracker's API base, without a trailing slash: https://api.github.com. */
  baseUrl: string;
}

/** Why a tracker call failed, in a kind a caller can branch on. */
export type TrackerErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'disabled'
  | 'rate_limit'
  | 'conflict'
  | 'empty_repo'
  | 'network'
  | 'other';

/** A tracker call failed. `message` is for the reviewer and says what to do next. */
export class TrackerError extends Error {
  override name = 'TrackerError';
  constructor(
    readonly kind: TrackerErrorKind,
    message: string,
    readonly status: number | null = null,
    /** For a rate limit: how long the tracker asked to wait (its `retry-after`), in milliseconds. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** How a `retry-after` header reads in milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, now: () => number = Date.now): number | null {
  const value = header?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds < 0 ? null : Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now());
}

/** How a status reads on a badge: the tracker's own name for it, else "open", "closed (completed)", "closed (not planned)". */
export function statusLabel(status: IssueStatus): string {
  if (status.name) return status.name;
  if (status.state === 'open') return 'open';
  if (status.reason === 'completed') return 'closed (completed)';
  if (status.reason === 'not_planned') return 'closed (not planned)';
  return 'closed';
}
