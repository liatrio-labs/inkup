// Options: Trackers (ADR 0028). For each tracker defined in core (TRACKERS), the credentials it needs, saved to
// storage.local only and a secret shown back masked; the default destination (a repo, a team) picked from what the
// credentials can see; and a Test that checks them against it, naming what is missing. The first time a tracker's
// credentials are saved, a notice says what goes to it. Self-contained: options/App.tsx mounts it with one line. The
// words and the fields come from core's registry, so a new tracker adds no code here.
import type { Destination, TestResult, TrackerCredentials, TrackerField } from '@inkup/core/trackers';
import { useEffect, useState } from 'react';
import { TONE } from '@/components/tone';
import { Button } from '@/components/ui/button';
import {
  KNOWN_TRACKERS,
  saveDestination,
  type TrackerStore,
  trackerAdapter,
  trackerCredentials,
  watchTracker,
} from '@/lib/trackers';
import { useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { devOverrides, trackerSettings } from '@/settings';
import { JiraIssueType } from './jira-issue-type';

const mask = (secret: string) => (secret.length > 12 ? `${secret.slice(0, 7)}…${secret.slice(-4)}` : 'saved');

/** The destination list: loaded, failed (type it instead), or not asked for (nothing saved yet). */
type Destinations = Destination[] | 'loading' | { error: string } | null;
type Test = TestResult | 'running' | { error: string } | null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Known = (typeof KNOWN_TRACKERS)[number];

export function TrackersSection() {
  return (
    <section aria-labelledby="trackers-heading" id="trackers" className="flex scroll-mt-4 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 id="trackers-heading" className="text-base font-semibold">
          Trackers
        </h2>
        <p className="text-muted-foreground">
          Send a Change Item from the review page to your team's tracker as one issue, with its screenshots. What you
          enter stays in this browser.
        </p>
      </div>
      {KNOWN_TRACKERS.map((known) => (
        <TrackerBlock key={known.def.tracker} known={known} />
      ))}
      <JiraIssueType />
    </section>
  );
}

/** The credentials saved for a tracker: `undefined` until read, null while a field is missing. */
function useCredentials(tracker: Known['def']['tracker']): TrackerCredentials | null | undefined {
  const [credentials, setCredentials] = useState<TrackerCredentials | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const read = () => void trackerCredentials(tracker).then((c) => alive && setCredentials(c));
    read();
    const stop = watchTracker(tracker, read);
    return () => {
      alive = false;
      stop();
    };
  }, [tracker]);
  return credentials;
}

function TrackerBlock({ known: { def, store } }: { known: Known }) {
  const id = def.tracker;
  const settings = useStorageItem(trackerSettings);
  const credentials = useCredentials(id);
  const [notice, setNotice] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Destinations>(null);
  const [test, setTest] = useState<Test>(null);
  const destination = settings ? store.destination.get(settings) : '';
  // The list is asked for again when the credentials change, not on every render.
  const credentialKey = credentials ? JSON.stringify(credentials) : '';

  // biome-ignore lint/correctness/useExhaustiveDependencies: credentialKey stands for the credentials
  useEffect(() => {
    if (!credentials) {
      setDestinations(null);
      return;
    }
    let alive = true;
    setDestinations('loading');
    void trackerAdapter(id)
      .then((adapter) => adapter.listDestinations(credentials))
      .then(
        (list) => alive && setDestinations(list),
        (e: unknown) => alive && setDestinations({ error: errorText(e) }),
      );
    return () => {
      alive = false;
    };
  }, [id, credentialKey]);

  async function runTest() {
    if (!credentials) return;
    setTest('running');
    try {
      setTest(await (await trackerAdapter(id)).test(credentials, destination));
    } catch (e) {
      setTest({ error: errorText(e) });
    }
  }

  async function pick(next: string) {
    await saveDestination(id, next);
    setTest(null);
  }

  const listed = Array.isArray(destinations) ? destinations : null;
  const inputId = `${id}-destination`;
  return (
    <div className="flex flex-col gap-3" data-testid={`tracker-${id}`}>
      <h3 className="font-medium">{def.label}</h3>
      <p className="text-muted-foreground">{def.help}</p>

      {notice && (
        <div
          role="alert"
          data-testid={`${id}-notice`}
          className={cn('flex flex-col gap-2 rounded-lg border p-4', TONE.noteBorder, TONE.note)}
        >
          <p className="font-medium">{def.notice.title}</p>
          <p>{def.notice.body}</p>
          <div>
            <Button variant="outline" size="sm" onClick={() => setNotice(false)}>
              Got it
            </Button>
          </div>
        </div>
      )}

      {def.fields.map((field) => (
        <FieldForm
          key={field.id}
          tracker={id}
          field={field}
          store={store}
          onSaved={async () => {
            if (!(await store.noticeShown.getValue())) {
              setNotice(true);
              await store.noticeShown.setValue(true);
            }
            setTest(null);
            setStatus(`${field.label} saved.`);
          }}
          onRemoved={() => {
            setTest(null);
            setStatus(`${field.label} removed.`);
          }}
        />
      ))}

      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="font-medium">
          {def.destinationLabel}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {listed ? (
            <select
              id={inputId}
              data-testid={inputId}
              className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
              value={destination}
              onChange={(e) => void pick(e.target.value)}
            >
              <option value="">Pick one</option>
              {destination && !listed.some((d) => d.id === destination) && (
                <option value={destination}>{destination}</option>
              )}
              {listed.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={inputId}
              data-testid={inputId}
              className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
              placeholder={def.destinationPlaceholder}
              disabled={!credentials}
              defaultValue={destination}
              key={destination}
              onBlur={(e) => void pick(e.target.value)}
            />
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!credentials || test === 'running'}
            onClick={runTest}
            data-testid={`test-${id}`}
            title={`Checks what you saved against ${def.label}`}
          >
            {test === 'running' ? 'Testing…' : 'Test'}
          </Button>
        </div>
        <span className="text-muted-foreground">
          {!credentials
            ? `Save your ${def.label} details to pick from what they can see.`
            : destinations === 'loading'
              ? `Loading what these ${def.label} details can see…`
              : destinations && !Array.isArray(destinations)
                ? `Couldn't load the list: ${destinations.error} You can type it instead.`
                : 'Change Items you send go here, unless you pick another place when you send.'}
        </span>
        {test && test !== 'running' && <TestLines tracker={id} test={test} />}
      </div>
      {status && <p role="status">{status}</p>}
    </div>
  );
}

/** One thing to enter: saved on its own, a secret shown back masked. */
function FieldForm({
  tracker,
  field,
  store,
  onSaved,
  onRemoved,
}: {
  tracker: string;
  field: TrackerField;
  store: TrackerStore;
  onSaved: () => Promise<void>;
  onRemoved: () => void;
}) {
  const item = store.fields[field.id]!;
  const saved = (useStorageItem(item) ?? '').trim();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = `${tracker}-${field.id}-input`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    if (!next) return;
    // Some fields are checked first (Jira's site) and saved in their tidied form.
    const prepared = store.prepare ? store.prepare(field.id, next, await devOverrides.getValue()) : { value: next };
    if ('error' in prepared) {
      setProblem(prepared.error);
      return;
    }
    setProblem(null);
    await item.setValue(prepared.value);
    setDraft('');
    await onSaved();
  }

  async function remove() {
    await item.setValue('');
    onRemoved();
  }

  const shown = field.secret ? mask(saved) : saved;
  return (
    <form onSubmit={save} className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-medium">
        {field.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          data-testid={`${tracker}-${field.id}`}
          className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
          placeholder={saved ? `Saved (${shown}). Enter a new one to replace it.` : (field.placeholder ?? '')}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" disabled={!draft.trim()} data-testid={`save-${tracker}-${field.id}`}>
          Save
        </Button>
        {saved && (
          <Button type="button" variant="ghost" onClick={remove} data-testid={`remove-${tracker}-${field.id}`}>
            Remove
          </Button>
        )}
      </div>
      {problem && (
        <span role="alert" className="text-destructive" data-testid={`${tracker}-${field.id}-error`}>
          {problem}
        </span>
      )}
      {saved && (
        <span className="text-muted-foreground" data-testid={`${tracker}-${field.id}-saved`}>
          Saved: {shown}
        </span>
      )}
    </form>
  );
}

function TestLines({ tracker, test }: { tracker: string; test: TestResult | { error: string } }) {
  if ('error' in test)
    return (
      <p className="text-destructive" data-testid={`${tracker}-test-result`}>
        {test.error}
      </p>
    );
  return (
    <ul className="flex flex-col gap-0.5" data-testid={`${tracker}-test-result`} data-ok={test.ok}>
      {test.checks.map((c) => (
        <li key={c.id} data-check={c.id} data-ok={c.ok} className={c.ok ? TONE.okText : 'text-destructive'}>
          {c.ok ? 'OK: ' : 'Problem: '}
          {c.message}
        </li>
      ))}
    </ul>
  );
}
