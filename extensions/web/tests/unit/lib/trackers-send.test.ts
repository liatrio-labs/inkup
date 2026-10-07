// sendToTracker never makes a duplicate by accident (ADR 0028): an item sent by hand is skipped by a bulk send, two
// sends of the same item at once make one issue, a Retry after the link couldn't be saved saves it without sending
// again, and an issue a Jira send made before a screenshot failed is recorded, answers its url, and is skipped later.
// The tracker itself (pushItem) and IndexedDB are stood in for; the saved setup is real extension storage.
import type { ChangeItem } from '@inkup/core/process/change-item';
import type { TrackerLink } from '@inkup/core/trackers';
import { TrackerError } from '@inkup/core/trackers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

/** The `tracker_link` events "stored" so far, as the db hands them back. */
const events: Record<string, unknown>[] = [];
let failAppend = 0;

vi.mock('@/db', () => ({
  db: {
    eventsOfType: (sessionId: string, type: string) => ({
      toArray: async () => events.filter((e) => e.session_id === sessionId && e.type === type),
    }),
    blobs: { get: async () => undefined },
  },
}));
vi.mock('@/db/review', () => ({
  appendTrackerLink: vi.fn(async (sessionId: string, runId: string, itemId: string, link: TrackerLink) => {
    if (failAppend > 0) {
      failAppend--;
      throw new Error('Only a finished Session can be sent to a tracker.');
    }
    events.push({ ...link, type: 'tracker_link', session_id: sessionId, run_id: runId, item_id: itemId });
  }),
}));
vi.mock('@inkup/core/trackers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inkup/core/trackers')>()),
  pushItem: vi.fn(),
}));

const { pushItem } = await import('@inkup/core/trackers');
const { appendTrackerLink } = await import('@/db/review');
const { IssueMadeError, sendKey, sendToTracker, unrecorded } = await import('@/lib/trackers');
const { jiraEmail, jiraSite, jiraToken, linearToken, trackerSettings } = await import('@/settings');
const push = vi.mocked(pushItem);

const item = (id: string): ChangeItem => ({ id, title: `Fix ${id}`, evidence: { screenshots: [] } }) as never;
const input = (id: string) => ({ sessionId: 'sess-1', sessionName: 'Review', runId: 'run-1', item: item(id) });
let issues = 0;
const linkFor = (tracker: 'linear' | 'jira' = 'linear'): TrackerLink => {
  issues++;
  return {
    tracker,
    destination: 'team-1',
    key: `ENG-${issues}`,
    url: `https://linear.app/acme/issue/ENG-${issues}`,
    created_at: '2026-10-07T10:00:00.000Z',
  };
};
/** A promise the test settles when it likes. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  fakeBrowser.reset();
  events.length = 0;
  failAppend = 0;
  issues = 0;
  unrecorded.clear();
  push.mockReset();
  push.mockImplementation(async () => linkFor());
  vi.mocked(appendTrackerLink).mockClear();
  await linearToken.setValue('lin_api_test');
  await jiraSite.setValue('https://acme.atlassian.net');
  await jiraEmail.setValue('me@example.com');
  await jiraToken.setValue('jira-test');
  await trackerSettings.setValue({
    github: { repo: '' },
    linear: { team: 'team-1' },
    jira: { project: 'ABC', issueType: '' },
  });
});

describe('sendToTracker', () => {
  it('skips, in a bulk send, an item already sent by hand', async () => {
    const sent = await sendToTracker('linear', input('item_0001'));
    expect(sent?.key).toBe('ENG-1');
    expect(await sendToTracker('linear', input('item_0001'), { unlessSent: true })).toBeNull();
    // An item not yet linked is sent, and one linked to Linear is still unsent for Jira.
    expect(await sendToTracker('linear', input('item_0002'), { unlessSent: true })).toMatchObject({ key: 'ENG-2' });
    expect(await sendToTracker('jira', input('item_0001'), { unlessSent: true })).not.toBeNull();
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('makes one issue when the same item is sent twice at once', async () => {
    const gate = later<void>();
    push.mockImplementation(async () => {
      await gate.promise;
      return linkFor();
    });
    const first = sendToTracker('linear', input('item_0001'));
    await expect(sendToTracker('linear', input('item_0001'))).rejects.toThrow(
      'This item is already being sent to Linear. Wait for that send to finish.',
    );
    await expect(sendToTracker('linear', input('item_0001'), { unlessSent: true })).resolves.toBeNull();
    // Another tracker, or another item, is not held up.
    const other = sendToTracker('linear', input('item_0002'));
    gate.resolve();
    expect((await first)?.key).toBeDefined();
    await other;
    expect(push).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.item_id === 'item_0001')).toHaveLength(1);
    // Once it is done the item can be sent again on purpose (the card asks first).
    await sendToTracker('linear', input('item_0001'));
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('saves the link on Retry, without making another issue, when saving it failed', async () => {
    failAppend = 1;
    const err = (await sendToTracker('linear', input('item_0001')).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('The Linear issue was made (https://linear.app/acme/issue/ENG-1)');
    expect(err.message).toContain("couldn't save its link here");
    expect(err.message).toContain('Retry saves the link without making another issue.');
    expect(unrecorded.has(sendKey('run-1', 'item_0001', 'linear'))).toBe(true);

    const retried = await sendToTracker('linear', input('item_0001'));
    expect(retried?.key).toBe('ENG-1');
    expect(push).toHaveBeenCalledTimes(1);
    expect(appendTrackerLink).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(unrecorded.size).toBe(0);
  });

  it('records a Jira issue made before a screenshot failed, answers its url, and a bulk send skips it', async () => {
    const made = {
      tracker: 'jira' as const,
      destination: 'ABC',
      key: 'ABC-1',
      url: 'https://acme.atlassian.net/browse/ABC-1',
    };
    push.mockRejectedValueOnce(
      new TrackerError(
        'permission',
        `ABC-1 was created in Jira, but its screenshots didn't all go on: no. Open ${made.url} to add them; sending again would make a second issue.`,
        403,
        null,
        made,
      ),
    );
    const err = await sendToTracker('jira', input('item_0001')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssueMadeError);
    expect((err as InstanceType<typeof IssueMadeError>).url).toBe(made.url);
    expect((err as Error).message).toContain('ABC-1 was created in Jira');
    expect(events).toEqual([expect.objectContaining({ ...made, item_id: 'item_0001', run_id: 'run-1' })]);

    expect(await sendToTracker('jira', input('item_0001'), { unlessSent: true })).toBeNull();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('passes a failure that made no issue on as it is', async () => {
    push.mockRejectedValueOnce(new TrackerError('auth', 'Linear rejected the token. Enter a new one.', 401));
    await expect(sendToTracker('linear', input('item_0001'))).rejects.toMatchObject({ name: 'TrackerError' });
    expect(events).toHaveLength(0);
    // Nothing is left in flight.
    expect((await sendToTracker('linear', input('item_0001')))?.key).toBe('ENG-1');
  });
});
