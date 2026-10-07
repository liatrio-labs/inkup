// Options: Trackers (ADR 0028). A GitHub fine-grained token, saved to storage.local only and shown back masked; the
// default repo Change Items are sent to, picked from the repos the token sees; and a Test that checks the token, the
// repo, its issues and that the token can store screenshots there, naming any permission it lacks. The first time a
// token is saved, a notice says what goes to GitHub. Self-contained: options/App.tsx mounts it with one line.
import type { Destination, TestResult } from '@inkup/core/trackers';
import { useEffect, useState } from 'react';
import { TONE } from '@/components/tone';
import { Button } from '@/components/ui/button';
import { githubHere } from '@/lib/trackers';
import { useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { githubNoticeShown, githubToken, trackerSettings } from '@/settings';

const mask = (token: string) => (token.length > 12 ? `${token.slice(0, 7)}…${token.slice(-4)}` : 'saved');

/** The repo list: loaded, failed (type the repo instead), or not asked for (no token). */
type Repos = Destination[] | 'loading' | { error: string } | null;
type Test = TestResult | 'running' | { error: string } | null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function TrackersSection() {
  const saved = useStorageItem(githubToken);
  const settings = useStorageItem(trackerSettings);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repos>(null);
  const [test, setTest] = useState<Test>(null);
  const token = saved?.trim() ?? '';
  const repo = settings?.github.repo ?? '';

  // A saved token lists the repos it can see; a new or removed token asks again.
  useEffect(() => {
    if (!token) {
      setRepos(null);
      return;
    }
    let alive = true;
    setRepos('loading');
    void githubHere()
      .then((github) => github.listDestinations({ token }))
      .then(
        (list) => alive && setRepos(list),
        (e: unknown) => alive && setRepos({ error: errorText(e) }),
      );
    return () => {
      alive = false;
    };
  }, [token]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    if (!next) return;
    await githubToken.setValue(next);
    if (!(await githubNoticeShown.getValue())) {
      setNotice(true);
      await githubNoticeShown.setValue(true);
    }
    setDraft('');
    setTest(null);
    setStatus('GitHub token saved.');
  }

  async function remove() {
    await githubToken.setValue('');
    setTest(null);
    setStatus('GitHub token removed.');
  }

  async function pickRepo(next: string) {
    await trackerSettings.setValue({ ...(settings ?? { github: { repo: '' } }), github: { repo: next.trim() } });
    setTest(null);
  }

  async function runTest() {
    setTest('running');
    try {
      setTest(await (await githubHere()).test({ token }, repo));
    } catch (e) {
      setTest({ error: errorText(e) });
    }
  }

  const listed = Array.isArray(repos) ? repos : null;
  return (
    <section aria-labelledby="trackers-heading" id="trackers" className="flex scroll-mt-4 flex-col gap-4">
      <h2 id="trackers-heading" className="text-base font-semibold">
        Trackers
      </h2>
      <p className="text-muted-foreground">
        Send a Change Item from the review page to GitHub Issues as one issue, with its screenshots. Use a fine-grained
        personal access token with Issues (read and write), Contents (read and write) and Metadata (read) on the repos
        you send to. It stays in this browser.
      </p>

      {notice && <GithubNotice onClose={() => setNotice(false)} />}

      <form onSubmit={save} className="flex flex-col gap-1">
        <label htmlFor="github-token-input" className="font-medium">
          GitHub token
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="github-token-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-testid="github-token"
            className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
            placeholder={token ? `Saved (${mask(token)}). Paste a new token to replace it.` : 'github_pat_…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={!draft.trim()} data-testid="save-github-token">
            Save
          </Button>
          {token && (
            <Button type="button" variant="ghost" onClick={remove} data-testid="remove-github-token">
              Remove token
            </Button>
          )}
        </div>
        {token && (
          <span className="text-muted-foreground" data-testid="github-token-saved">
            Saved: {mask(token)}
          </span>
        )}
      </form>

      <div className="flex flex-col gap-1">
        <label htmlFor="github-repo" className="font-medium">
          Default repo
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {listed ? (
            <select
              id="github-repo"
              data-testid="github-repo"
              className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
              value={repo}
              onChange={(e) => void pickRepo(e.target.value)}
            >
              <option value="">Pick a repo</option>
              {repo && !listed.some((d) => d.id === repo) && <option value={repo}>{repo}</option>}
              {listed.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="github-repo"
              data-testid="github-repo"
              className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
              placeholder="owner/repo"
              disabled={!token}
              defaultValue={repo}
              key={repo}
              onBlur={(e) => void pickRepo(e.target.value)}
            />
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!token || !repo || test === 'running'}
            onClick={runTest}
            data-testid="test-github"
            title="Checks the saved token against the default repo"
          >
            {test === 'running' ? 'Testing…' : 'Test'}
          </Button>
        </div>
        <span className="text-muted-foreground">
          {!token
            ? 'Save a token to pick from the repos it can see.'
            : repos === 'loading'
              ? 'Loading the repos this token can see…'
              : repos && !Array.isArray(repos)
                ? `Couldn't list the repos: ${repos.error} Type the repo as owner/repo instead.`
                : 'Change Items you send go here. Screenshots are stored on its inkup-assets branch.'}
        </span>
        {test && test !== 'running' && <TestLines test={test} />}
      </div>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function TestLines({ test }: { test: TestResult | { error: string } }) {
  if ('error' in test)
    return (
      <p className="text-destructive" data-testid="github-test-result">
        {test.error}
      </p>
    );
  return (
    <ul className="flex flex-col gap-0.5" data-testid="github-test-result" data-ok={test.ok}>
      {test.checks.map((c) => (
        <li key={c.id} data-check={c.id} data-ok={c.ok} className={c.ok ? TONE.okText : 'text-destructive'}>
          {c.ok ? 'OK: ' : 'Problem: '}
          {c.message}
        </li>
      ))}
    </ul>
  );
}

function GithubNotice({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="alert"
      data-testid="github-notice"
      className={cn('flex flex-col gap-2 rounded-lg border p-4', TONE.noteBorder, TONE.note)}
    >
      <p className="font-medium">What goes to GitHub</p>
      <p>
        Nothing is sent until you press Send on a Change Item. Then its text (title, intent, where it is, what you said,
        the agent prompt) goes to GitHub as a new issue in the repo you picked, and its screenshots and element
        close-ups are committed to that repo's inkup-assets branch. Anyone who can read the repo can see those
        screenshots, so pick a private repo for anything private.
      </p>
      <div>
        <Button variant="outline" size="sm" onClick={onClose}>
          Got it
        </Button>
      </div>
    </div>
  );
}
