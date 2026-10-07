// Tracker push from the extension's pages (ADR 0028): the GitHub adapter from packages/core, given this page's fetch
// and GitHub's API (or, in a development build, the `githubBaseUrl` override), and the send itself: read the item's
// images from IndexedDB, push, and record the link. The token is read from its own storage key at the moment of use
// and is never logged, stored elsewhere or passed to the Host.
import type { ChangeItem } from '@inkup/core/process/change-item';
import { githubAdapter, itemImageIds, pushItem, type TrackerAdapter, type TrackerLink } from '@inkup/core/trackers';
import { db } from '@/db';
import { appendTrackerLink } from '@/db/review';
import { devOverrides, githubApiBase, githubToken, trackerSettings } from '@/settings';

/** The GitHub adapter for this build: GitHub's API, or the dev override outside a release build. */
export async function githubHere(): Promise<TrackerAdapter> {
  const baseUrl = githubApiBase(await devOverrides.getValue());
  return githubAdapter({ fetch: (input, init) => fetch(input, init), baseUrl });
}

/** The saved GitHub token and default repo; null when either is missing. */
export async function githubSetup(): Promise<{ token: string; repo: string } | null> {
  const token = (await githubToken.getValue()).trim();
  const repo = (await trackerSettings.getValue()).github.repo.trim();
  return token && repo ? { token, repo } : null;
}

export interface SendInput {
  sessionId: string;
  sessionName: string;
  runId: string;
  item: ChangeItem;
}

/** Sends one Change Item to GitHub's default repo as an issue with its images, and records the link. */
export async function sendToGithub({ sessionId, sessionName, runId, item }: SendInput): Promise<TrackerLink> {
  const setup = await githubSetup();
  if (!setup) throw new Error('Save a GitHub token and pick a repo in Trackers settings first.');
  const images = [];
  for (const id of itemImageIds(item)) {
    const row = await db.blobs.get(id);
    if (row?.blob) images.push({ id, bytes: new Uint8Array(await row.blob.arrayBuffer()) });
  }
  const link = await pushItem({
    adapter: await githubHere(),
    credentials: { token: setup.token },
    destination: setup.repo,
    item,
    session: { id: sessionId, name: sessionName },
    images,
  });
  await appendTrackerLink(sessionId, runId, item.id, link);
  return link;
}
