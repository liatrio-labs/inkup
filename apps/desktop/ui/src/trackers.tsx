// Trackers (ADR 0028): where the desktop app sends Change Items. One card per tracker in the packages/core registry
// (TRACKERS), so a tracker added there shows here with no change to this file. Each card has the tracker's fields,
// its default destination (picked from those the token can see), Save, Remove and a Test that says what is
// missing. The first save of a tracker shows a notice of what goes to it.
//
// Where things are kept:
// - Secret fields (tokens) go to the OS keychain through the app's commands (src-tauri/src/keychain.rs) and are read
//   back from it at the moment they are used. They are never in localStorage, and never go to the host.
// - The rest (the destination, a Jira site or email) is in localStorage under `inkup.trackers`.
//
// The adapters run here, on tauri-plugin-http's fetch (capabilities/default.json allows the trackers' hosts only).
// Self-contained: App.tsx mounts it with one line.
import {
  type Destination,
  prepareField,
  type TestResult,
  TRACKERS,
  type TrackerAdapter,
  type TrackerCredentials,
  type TrackerDefinition,
  type TrackerName,
  type TrackerValues,
} from '@inkup/core/trackers';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@inkup/ui';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { setTrackerSecret, trackerSecret } from './host';

const SETTINGS_KEY = 'inkup.trackers';
const NOTICE_KEY = (tracker: TrackerName) => `inkup.trackers.notice.${tracker}`;

/** A tracker as the window knows it without its secrets: which are saved (masked), and the plain settings. */
export interface TrackerSetup {
  definition: TrackerDefinition;
  /** Plain settings: the destination and any field that is not secret. */
  plain: TrackerValues;
  /** Each secret field: its masked value when saved, else null. */
  secrets: Record<string, string | null>;
  /** Every field and a destination are set: items can be sent. */
  ready: boolean;
}

export const mask = (secret: string) => (secret.length > 12 ? `${secret.slice(0, 7)}…${secret.slice(-4)}` : 'saved');

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readPlain(): Partial<Record<TrackerName, TrackerValues>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<TrackerName, TrackerValues>>) : {};
  } catch {
    return {};
  }
}

/** Keeps a tracker's plain settings; a secret field is never written here, whatever `values` holds. */
function writePlain(definition: TrackerDefinition, values: TrackerValues) {
  const secret = new Set(definition.fields.filter((f) => f.secret).map((f) => f.id));
  const kept: TrackerValues = {};
  for (const [key, value] of Object.entries(values)) if (!secret.has(key) && key !== 'baseUrl') kept[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readPlain(), [definition.tracker]: kept }));
}

// The setups, shared by this view and the Items view's send controls.
let setups: TrackerSetup[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reads every tracker's setup again: its plain settings and which secrets the keychain holds. */
export async function reloadTrackers(): Promise<void> {
  const plain = readPlain();
  setups = await Promise.all(
    TRACKERS.map(async (definition) => {
      const values = plain[definition.tracker] ?? {};
      const secrets: Record<string, string | null> = {};
      for (const field of definition.fields.filter((f) => f.secret)) {
        const saved = await trackerSecret(definition.tracker, field.id).catch(() => null);
        secrets[field.id] = saved ? mask(saved) : null;
      }
      const ready =
        !!values.destination?.trim() &&
        definition.fields.every((f) => (f.secret ? secrets[f.id] !== null : !!values[f.id]?.trim()));
      return { definition, plain: values, secrets, ready };
    }),
  );
  for (const listener of listeners) listener();
}

/** Forgets the setups read: a new window reads them again (tests render one per case). */
export function resetTrackerSetups() {
  setups = null;
}

/** Every tracker's setup, read once and again after a save; null until the first read. */
export function useTrackerSetups(): TrackerSetup[] | null {
  const current = useSyncExternalStore(subscribe, () => setups);
  useEffect(() => {
    if (setups === null) void reloadTrackers();
  }, []);
  return current;
}

/** Every value a tracker's adapter takes, its secrets read from the keychain now. */
export async function trackerValues(definition: TrackerDefinition): Promise<TrackerValues> {
  const values: TrackerValues = { ...(readPlain()[definition.tracker] ?? {}) };
  for (const field of definition.fields.filter((f) => f.secret)) {
    values[field.id] = (await trackerSecret(definition.tracker, field.id)) ?? '';
  }
  return values;
}

/** The tracker's adapter on tauri-plugin-http's fetch, and the credentials for it. */
export function trackerClient(
  definition: TrackerDefinition,
  values: TrackerValues,
): { adapter: TrackerAdapter; credentials: TrackerCredentials } {
  return {
    adapter: definition.adapter((input, init) => tauriFetch(input, init), values),
    credentials: definition.credentials(values),
  };
}

export function TrackersView() {
  const all = useTrackerSetups();
  if (!all) return <p className="text-muted-foreground text-sm">Reading the trackers' settings…</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="trackers-view">
      <p className="text-muted-foreground text-sm">
        Send Change Items from Items to an issue tracker, one issue per item with its screenshots. Tokens are kept in
        this computer's keychain and are never sent to the InkUp host.
      </p>
      {all.map((setup) => (
        <TrackerCard key={setup.definition.tracker} setup={setup} />
      ))}
    </div>
  );
}

/** The destination list: loaded, failed (type it instead), or not asked for (no token yet). */
type Destinations = Destination[] | 'loading' | { error: string } | null;
type Test = TestResult | 'running' | { error: string } | null;

function TrackerCard({ setup }: { setup: TrackerSetup }) {
  const { definition, plain, secrets } = setup;
  const id = definition.tracker;
  const [draft, setDraft] = useState<TrackerValues>({});
  const [destination, setDestination] = useState(plain.destination ?? '');
  const [notice, setNotice] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Destinations>(null);
  const [test, setTest] = useState<Test>(null);
  const [busy, setBusy] = useState(false);
  const secretsSaved = definition.fields.every((f) => !f.secret || secrets[f.id] !== null);
  const savedKey = definition.fields.map((f) => secrets[f.id] ?? plain[f.id] ?? '').join('|');

  // Saved credentials list the destinations they can see; new ones ask again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `savedKey` stands for the saved credentials
  useEffect(() => {
    if (!secretsSaved) {
      setDestinations(null);
      return;
    }
    let alive = true;
    setDestinations('loading');
    (async () => {
      const values = await trackerValues(definition);
      const { adapter, credentials } = trackerClient(definition, values);
      return adapter.listDestinations(credentials);
    })().then(
      (list) => alive && setDestinations(list),
      (e: unknown) => alive && setDestinations({ error: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [savedKey, secretsSaved, definition]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Every typed field is checked before anything is saved (Jira's site must be Atlassian Cloud), so a bad
      // field saves nothing.
      const prepared: TrackerValues = {};
      for (const field of definition.fields) {
        const typed = draft[field.id];
        if (typed === undefined || (field.secret && !typed.trim())) continue;
        const result = prepareField(definition, field.id, typed);
        if ('error' in result) {
          setStatus(result.error);
          return;
        }
        prepared[field.id] = result.value;
      }
      for (const field of definition.fields.filter((f) => f.secret)) {
        const value = prepared[field.id];
        if (value) await setTrackerSecret(id, field.id, value);
      }
      const nextPlain: TrackerValues = { ...plain, destination: destination.trim() };
      for (const field of definition.fields.filter((f) => !f.secret)) {
        const value = prepared[field.id];
        if (value !== undefined) nextPlain[field.id] = value;
      }
      writePlain(definition, nextPlain);
      const savedSecret = definition.fields.some((f) => f.secret && draft[f.id]?.trim());
      if (savedSecret && !localStorage.getItem(NOTICE_KEY(id))) {
        localStorage.setItem(NOTICE_KEY(id), '1');
        setNotice(true);
      }
      setDraft({});
      setTest(null);
      setStatus(`${definition.label} settings saved.`);
      await reloadTrackers();
    } catch (error) {
      setStatus(`Couldn't save the ${definition.label} settings: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      for (const field of definition.fields.filter((f) => f.secret)) await setTrackerSecret(id, field.id, '');
      setTest(null);
      setStatus(`${definition.label} token removed.`);
      await reloadTrackers();
    } catch (error) {
      setStatus(`Couldn't remove the ${definition.label} token: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTest('running');
    try {
      const values = { ...(await trackerValues(definition)), destination: destination.trim() };
      const { adapter, credentials } = trackerClient(definition, values);
      setTest(await adapter.test(credentials, values.destination));
    } catch (error) {
      setTest({ error: errorText(error) });
    }
  }

  const listed = Array.isArray(destinations) ? destinations : null;
  const listId = `${id}-destinations`;
  const dirty =
    Object.values(draft).some((v) => v.trim() !== '') || destination.trim() !== (plain.destination ?? '').trim();
  return (
    <Card data-testid={`tracker-${id}`}>
      <CardHeader>
        <CardTitle>{definition.label}</CardTitle>
        <CardDescription>{definition.help}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-3">
          {notice && (
            <Alert data-testid={`${id}-notice`}>
              <AlertTitle>{definition.notice.title}</AlertTitle>
              <AlertDescription>
                <p>{definition.notice.body}</p>
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setNotice(false)}>
                  Got it
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {definition.fields.map((field) => {
            const inputId = `${id}-${field.id}`;
            const saved = field.secret ? secrets[field.id] : null;
            return (
              <div key={field.id} className="flex flex-col gap-1.5">
                <Label htmlFor={inputId}>{field.label}</Label>
                <Input
                  id={inputId}
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder={saved ? `Saved (${saved}). Paste a new one to replace it.` : field.placeholder}
                  value={draft[field.id] ?? (field.secret ? '' : (plain[field.id] ?? ''))}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.id]: e.target.value }))}
                />
                {saved && <span className="text-muted-foreground text-xs">Saved in the keychain: {saved}</span>}
              </div>
            );
          })}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-destination`}>{definition.destinationLabel}</Label>
            <Input
              id={`${id}-destination`}
              list={listed ? listId : undefined}
              className="font-mono"
              placeholder={definition.destinationPlaceholder}
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                setTest(null);
              }}
            />
            {listed && (
              <datalist id={listId}>
                {listed.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </datalist>
            )}
            <span className="text-muted-foreground text-xs">
              {!secretsSaved
                ? 'Save a token to pick from the ones it can see.'
                : destinations === 'loading'
                  ? 'Loading the ones this token can see…'
                  : destinations && !Array.isArray(destinations)
                    ? `Couldn't list them: ${destinations.error} Type it instead.`
                    : 'Change Items you send go here.'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !dirty}>
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!secretsSaved || !destination.trim() || test === 'running'}
              onClick={runTest}
              data-testid={`test-${id}`}
            >
              {test === 'running' ? 'Testing…' : 'Test'}
            </Button>
            {definition.fields.some((f) => f.secret && secrets[f.id] !== null) && (
              <Button type="button" variant="ghost" disabled={busy} onClick={remove}>
                Remove token
              </Button>
            )}
          </div>
          {test && test !== 'running' && <TestLines tracker={id} test={test} />}
          {status && (
            <p role="status" className="text-sm">
              {status}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function TestLines({ tracker, test }: { tracker: TrackerName; test: TestResult | { error: string } }) {
  if ('error' in test)
    return (
      <p className="text-destructive text-sm" data-testid={`${tracker}-test-result`}>
        {test.error}
      </p>
    );
  return (
    <ul className="flex flex-col gap-0.5 text-sm" data-testid={`${tracker}-test-result`} data-ok={test.ok}>
      {test.checks.map((c) => (
        <li key={c.id} data-check={c.id} className={c.ok ? undefined : 'text-destructive'}>
          {c.ok ? 'OK: ' : 'Problem: '}
          {c.message}
        </li>
      ))}
    </ul>
  );
}
