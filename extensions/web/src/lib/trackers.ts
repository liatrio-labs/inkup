// Tracker push from the extension's pages (ADR 0028). The trackers themselves are data in packages/core
// (TRACKERS: what each asks for, its words, its adapter); this file says where this Client keeps what the reviewer
// entered (STORES, all in storage.local, a secret only in its own key), builds the adapter with this page's fetch and
// the tracker's API (or, in a development build, the dev override), and does the send itself: read the item's images
// from IndexedDB, push, and record the link. A credential is read at the moment of use and is never logged, stored
// elsewhere or passed to the Host.
//
// Nothing here or in the UI that reads it names a tracker: a new tracker is an entry in core's TRACKERS and one in
// STORES.
import type { ChangeItem } from '@inkup/core/process/change-item';
import {
  type Destination,
  itemImageIds,
  parseJiraSite,
  pushItem,
  TRACKERS,
  type TrackerAdapter,
  type TrackerCredentials,
  type TrackerDefinition,
  type TrackerLink,
  type TrackerName,
  type TrackerValues,
  trackerDefinition,
} from '@inkup/core/trackers';
import type { WxtStorageItem } from '@wxt-dev/storage';
import { useEffect, useState } from 'react';
import { db } from '@/db';
import { appendTrackerLink } from '@/db/review';
import {
  type DevOverrides,
  devOverrides,
  githubApiBase,
  githubNoticeShown,
  githubToken,
  jiraApiBase,
  jiraEmail,
  jiraNoticeShown,
  jiraSite,
  jiraToken,
  linearApiBase,
  linearNoticeShown,
  linearToken,
  type TrackerSettings,
  trackerSettings,
} from '@/settings';

type Item<T> = WxtStorageItem<T, Record<string, unknown>>;

/** Where this Client keeps one tracker's entries. */
export interface TrackerStore {
  /** Field id → its storage item. */
  fields: Record<string, Item<string>>;
  /** Whether the one-time "what goes to the tracker" notice was shown. */
  noticeShown: Item<boolean>;
  /** The default destination inside trackerSettings. Writing keeps the other trackers' entries. */
  destination: {
    get(settings: TrackerSettings): string;
    set(settings: TrackerSettings, destination: string): TrackerSettings;
  };
  /** The tracker's API base: its own API, or the dev override outside a release build. */
  apiBase(dev: DevOverrides | null): string;
  /** Values beyond the fields and the destination that the adapter reads (Jira's issue type). */
  values?(settings: TrackerSettings): Record<string, string>;
  /**
   * Checks and tidies a field before it is saved: the value to store, or what to tell the reviewer is wrong with it.
   * Jira's site must be an Atlassian Cloud site unless a development build points at a stub.
   */
  prepare?(fieldId: string, value: string, dev: DevOverrides | null): { value: string } | { error: string };
}

export const STORES: Partial<Record<TrackerName, TrackerStore>> = {
  github: {
    fields: { token: githubToken },
    noticeShown: githubNoticeShown,
    destination: {
      get: (s) => s.github.repo,
      set: (s, repo) => ({ ...s, github: { repo } }),
    },
    apiBase: (dev) => githubApiBase(dev),
  },
  linear: {
    fields: { token: linearToken },
    noticeShown: linearNoticeShown,
    destination: {
      get: (s) => s.linear?.team ?? '',
      set: (s, team) => ({ ...s, linear: { team } }),
    },
    apiBase: (dev) => linearApiBase(dev),
  },
  jira: {
    fields: { site: jiraSite, email: jiraEmail, token: jiraToken },
    noticeShown: jiraNoticeShown,
    destination: {
      get: (s) => s.jira?.project ?? '',
      // A new project has its own issue types, so the type picked for the old one is dropped.
      set: (s, project) => ({
        ...s,
        jira: { project, issueType: s.jira?.project === project ? (s.jira?.issueType ?? '') : '' },
      }),
    },
    // '' here means the saved site is used; a development build points at a stub instead.
    apiBase: (dev) => jiraApiBase(dev),
    values: (s) => ({ issueType: s.jira?.issueType ?? '' }),
    prepare(fieldId, value, dev) {
      if (fieldId !== 'site') return { value };
      const site = parseJiraSite(value);
      if (site) return { value: site };
      // A development build with a stub set does not check the site (the stub stands in for it).
      if (jiraApiBase(dev)) return { value: value.trim() };
      return {
        error: 'The site must look like https://<your-team>.atlassian.net. Check the address in your Jira URL.',
      };
    },
  },
};

/** The trackers this Client can send to: defined in core, and stored here. */
export const KNOWN_TRACKERS: { def: TrackerDefinition; store: TrackerStore }[] = TRACKERS.flatMap((def) => {
  const store = STORES[def.tracker];
  return store ? [{ def, store }] : [];
});

function known(tracker: TrackerName): { def: TrackerDefinition; store: TrackerStore } {
  const found = KNOWN_TRACKERS.find((t) => t.def.tracker === tracker);
  if (!found) throw new Error(`InkUp can't send to ${trackerDefinition(tracker)?.label ?? tracker} from here.`);
  return found;
}

/** The adapter for a tracker in this build, with this page's fetch. */
export async function trackerAdapter(tracker: TrackerName): Promise<TrackerAdapter> {
  const { def, store } = known(tracker);
  const baseUrl = store.apiBase(await devOverrides.getValue());
  return def.adapter((input, init) => fetch(input, init), { ...(await trackerValues(tracker)), baseUrl });
}

/** What the reviewer entered for a tracker, trimmed; a field not saved is an empty string. */
export async function trackerValues(tracker: TrackerName): Promise<TrackerValues> {
  const { store } = known(tracker);
  const values: TrackerValues = {};
  for (const [id, item] of Object.entries(store.fields)) values[id] = ((await item.getValue()) ?? '').trim();
  const settings = await trackerSettings.getValue();
  values.destination = store.destination.get(settings).trim();
  Object.assign(values, store.values?.(settings));
  return values;
}

/** The credentials for a tracker, or null when a field is not saved yet. Enough to read a status. */
export async function trackerCredentials(tracker: TrackerName): Promise<TrackerCredentials | null> {
  const { def } = known(tracker);
  const values = await trackerValues(tracker);
  return def.fields.every((f) => values[f.id]) ? def.credentials(values) : null;
}

/** A tracker the reviewer has set up to send to: its credentials, and the destination they saved. */
export interface TrackerSetup {
  credentials: TrackerCredentials;
  destination: string;
}

/** The saved credentials and default destination; null when either is missing. */
export async function trackerSetup(tracker: TrackerName): Promise<TrackerSetup | null> {
  const credentials = await trackerCredentials(tracker);
  const destination = (await trackerValues(tracker)).destination;
  return credentials && destination ? { credentials, destination } : null;
}

/** Saves a tracker's default destination, keeping the other trackers' entries. */
export async function saveDestination(tracker: TrackerName, destination: string): Promise<void> {
  const { store } = known(tracker);
  await trackerSettings.setValue(store.destination.set(await trackerSettings.getValue(), destination.trim()));
}

/** Calls back when anything a tracker's setup reads changes. Answers the stop function. */
export function watchTracker(tracker: TrackerName, onChange: () => void): () => void {
  const { store } = known(tracker);
  const stops = [...Object.values(store.fields), trackerSettings].map((item) => item.watch(() => onChange()));
  return () => {
    for (const stop of stops) stop();
  };
}

/** Each tracker that is set up to send, by name; `undefined` until first read. Kept live across contexts. */
export function useTrackerSetups(): ReadonlyMap<TrackerName, TrackerSetup> | undefined {
  const [setups, setSetups] = useState<ReadonlyMap<TrackerName, TrackerSetup> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    async function read() {
      const mine = ++generation;
      const entries = await Promise.all(
        KNOWN_TRACKERS.map(async ({ def }) => [def.tracker, await trackerSetup(def.tracker)] as const),
      );
      if (!alive || mine !== generation) return;
      setSetups(new Map(entries.flatMap(([name, setup]) => (setup ? [[name, setup] as const] : []))));
    }
    void read();
    const stops = KNOWN_TRACKERS.map(({ def }) => watchTracker(def.tracker, () => void read()));
    return () => {
      alive = false;
      for (const stop of stops) stop();
    };
  }, []);
  return setups;
}

/** The destinations a tracker's credentials can see, asked once per page load (a failure is asked again). */
const destinationLists = new Map<TrackerName, Promise<Destination[]>>();
export function destinationsFor(tracker: TrackerName, credentials: TrackerCredentials): Promise<Destination[]> {
  let list = destinationLists.get(tracker);
  if (!list) {
    list = trackerAdapter(tracker).then((adapter) => adapter.listDestinations(credentials));
    destinationLists.set(tracker, list);
    list.catch(() => destinationLists.delete(tracker));
  }
  return list;
}

export interface SendInput {
  sessionId: string;
  sessionName: string;
  runId: string;
  item: ChangeItem;
}

/**
 * Sends one Change Item to a tracker as an issue with its images, and records the link. It goes to `destination`
 * when given (a choice for this send only), else to the saved default.
 */
export async function sendToTracker(
  tracker: TrackerName,
  { sessionId, sessionName, runId, item }: SendInput,
  destination?: string,
): Promise<TrackerLink> {
  const { def } = known(tracker);
  const setup = await trackerSetup(tracker);
  const target = destination?.trim() || setup?.destination;
  const credentials = setup?.credentials ?? (await trackerCredentials(tracker));
  if (!credentials || !target)
    throw new Error(`Save your ${def.label} details and pick where to send in Trackers settings first.`);
  const images = [];
  for (const id of itemImageIds(item)) {
    const row = await db.blobs.get(id);
    if (row?.blob) images.push({ id, bytes: new Uint8Array(await row.blob.arrayBuffer()) });
  }
  const link = await pushItem({
    adapter: await trackerAdapter(tracker),
    credentials,
    destination: target,
    item,
    session: { id: sessionId, name: sessionName },
    images,
  });
  await appendTrackerLink(sessionId, runId, item.id, link);
  return link;
}
