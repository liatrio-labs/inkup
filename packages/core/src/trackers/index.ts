// Tracker push (ADR 0028): send a Change Item to an issue tracker as one issue with its screenshots. The adapters and
// the issue body live here, so the extension and the desktop app send the same issue. The caller stores the link it
// answers as a `tracker_link` event (timeline.ts); status is read live with getStatus and never stored.
import type { TrackerLink } from '../timeline.ts';
import type { ImageUpload, TrackerAdapter, TrackerCredentials } from './adapter.ts';
import { buildIssue, type IssueItem, type IssueSession } from './issue.ts';

export * from './adapter.ts';
export { ASSETS_BRANCH, assetPath, assetUrl, GITHUB_API, githubAdapter } from './github.ts';
export * from './issue.ts';

/** The ids of every image an item shows: its screenshots, then its element crops. */
export const itemImageIds = (item: Pick<IssueItem, 'evidence'>): string[] => [
  ...new Set([...item.evidence.screenshots, ...(item.evidence.crops ?? [])]),
];

export interface PushInput {
  adapter: TrackerAdapter;
  credentials: TrackerCredentials;
  destination: string;
  item: IssueItem;
  session: IssueSession & { id: string };
  /** The item's images that could be read (itemImageIds); one that is missing is left out of the issue. */
  images: readonly ImageUpload[];
  now?: () => Date;
}

/** Uploads the item's images, then creates its issue. Answers the link to record. */
export async function pushItem(input: PushInput): Promise<TrackerLink> {
  const { adapter, credentials, destination, item, session } = input;
  const urls = await adapter.uploadImages(credentials, destination, session.id, input.images);
  const created = await adapter.createIssue(credentials, destination, buildIssue(item, session, urls));
  return { ...created, created_at: (input.now?.() ?? new Date()).toISOString() };
}
