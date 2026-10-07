// Options: the issue type Jira issues are created as (ADR 0028), under the Jira block of the Trackers section. It lists
// the issue types of the default project, so it shows once Jira's details and a project are saved. "Task" is the
// default: a Change Item whose category is bug is created as a Bug instead when the project has that type. Picking a
// type uses it for every item. Self-contained: options/trackers.tsx mounts it with one line.
import type { JiraAdapter } from '@inkup/core/trackers';
import { useEffect, useState } from 'react';
import { trackerAdapter, trackerCredentials, watchTracker } from '@/lib/trackers';
import { useStorageItem } from '@/lib/use-storage-item';
import { trackerSettings } from '@/settings';

type Types = string[] | 'loading' | { error: string };

export function JiraIssueType() {
  const settings = useStorageItem(trackerSettings);
  const project = settings?.jira?.project ?? '';
  const picked = settings?.jira?.issueType ?? '';
  const [ready, setReady] = useState(false);
  const [types, setTypes] = useState<Types>('loading');

  // Whether Jira's details are all saved; asked again when any of them changes.
  useEffect(() => {
    let alive = true;
    const read = () => void trackerCredentials('jira').then((c) => alive && setReady(!!c));
    read();
    const stop = watchTracker('jira', read);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  useEffect(() => {
    if (!ready || !project) return;
    let alive = true;
    setTypes('loading');
    void (async () => {
      const credentials = await trackerCredentials('jira');
      if (!credentials) throw new Error('Save your Jira details first.');
      return ((await trackerAdapter('jira')) as JiraAdapter).listIssueTypes(credentials, project);
    })().then(
      (list) => alive && setTypes(list),
      (e: unknown) => alive && setTypes({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [ready, project]);

  if (!ready || !project || !settings) return null;
  async function pick(issueType: string) {
    await trackerSettings.setValue({ ...settings!, jira: { project, issueType } });
  }
  const listed = Array.isArray(types) ? types : null;
  return (
    <div className="flex flex-col gap-1" data-testid="jira-issue-type-block">
      <label htmlFor="jira-issue-type" className="font-medium">
        Jira issue type
      </label>
      {listed ? (
        <select
          id="jira-issue-type"
          data-testid="jira-issue-type"
          className="min-w-0 rounded-md border px-3 py-2 font-mono"
          value={picked}
          onChange={(e) => void pick(e.target.value)}
        >
          <option value="">Task (Bug for a bug)</option>
          {picked && !listed.includes(picked) && <option value={picked}>{picked}</option>}
          {listed
            .filter((t) => t.toLowerCase() !== 'task')
            .map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
        </select>
      ) : (
        <span className="text-muted-foreground">
          {typeof types === 'object' && 'error' in types
            ? `Couldn't load the issue types: ${types.error} InkUp will use Task.`
            : `Loading the issue types of ${project}…`}
        </span>
      )}
      <span className="text-muted-foreground">
        A Change Item that is a bug goes in as a Bug when {project} has that type. Pick a type to use it for every item.
      </span>
    </div>
  );
}
