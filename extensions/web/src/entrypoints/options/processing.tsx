// Options: processing (PRD P0-14 processing settings, P0-15 notices). Each model role (Process, Draft, Merge) picks
// a provider (Anthropic, or the Vercel AI Gateway's Anthropic-compatible API), a model from that provider's live list
// and an effort. Keys live in storage.local only and are never shown back in full, logged or exported. Each key has
// its own Test button beside it. Without a key, or when the list call fails, the model field is a text input.
import { useEffect, useState } from 'react';
import type { ListedModel } from '@/adapters/llm/models';
import { Button } from '@/components/ui/button';
import { useStorageItem } from '@/lib/use-storage-item';
import { sendMessage } from '@/messaging';
import {
  anthropicKey,
  anthropicNoticeShown,
  DEFAULT_MODELS,
  type Effort,
  gatewayKey,
  gatewayNoticeShown,
  type LlmProvider,
  MODEL_ROLES,
  type ModelRole,
  modelLists,
  normalizeProcessingSettings,
  type ProcessingSettings,
  processingSettings,
  type RoleModel,
  readAutoRunBelowUsd,
} from '@/settings';

const mask = (key: string) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : 'saved');

const PROVIDERS: { id: LlmProvider; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'gateway', label: 'Vercel AI Gateway' },
];

const ROLES: Record<ModelRole, { label: string; help: string }> = {
  process: { label: 'Process', help: 'Turns a finished Session into Change Items.' },
  draft: { label: 'Draft', help: 'Writes live Draft Items during a Session.' },
  merge: { label: 'Merge', help: 'Rewrites two merged Change Items as one on the review page.' },
};

const EFFORT_OPTIONS: { value: Effort | ''; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

type TestState = { ok: boolean; message: string } | 'running' | null;
/** A provider's model list on this page: loaded, failed (text input), or not asked for (no key). */
type ListState = ListedModel[] | 'failed' | null;

export function ProcessingSection() {
  const savedAnthropic = useStorageItem(anthropicKey);
  const savedGateway = useStorageItem(gatewayKey);
  const stored = useStorageItem(processingSettings);
  const cached = useStorageItem(modelLists);
  const [drafts, setDrafts] = useState<Record<LlmProvider, string>>({ anthropic: '', gateway: '' });
  const [roles, setRoles] = useState<ProcessingSettings>(() => normalizeProcessingSettings(undefined));
  /** The auto-run threshold as typed; empty: always ask. */
  const [autoRun, setAutoRun] = useState('');
  const [notices, setNotices] = useState<LlmProvider[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<LlmProvider, TestState>>({ anthropic: null, gateway: null });
  const [lists, setLists] = useState<Record<LlmProvider, ListState>>({ anthropic: null, gateway: null });
  const saved: Record<LlmProvider, string> = { anthropic: savedAnthropic ?? '', gateway: savedGateway ?? '' };

  useEffect(() => {
    if (stored === undefined) return;
    const next = normalizeProcessingSettings(stored);
    setRoles(next);
    setAutoRun(next.autoRunBelowUsd !== undefined ? String(next.autoRunBelowUsd) : '');
  }, [stored]);

  // Each provider with a saved key lists its models; a new or removed key asks again.
  useEffect(() => {
    for (const provider of ['anthropic', 'gateway'] as const) {
      const key = provider === 'anthropic' ? savedAnthropic : savedGateway;
      if (key === undefined) continue;
      if (!key.trim()) {
        setLists((l) => ({ ...l, [provider]: null }));
        continue;
      }
      void sendMessage('listModels', provider)
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
        .then((r) => setLists((l) => ({ ...l, [provider]: r.ok ? r.list.models : 'failed' })));
    }
  }, [savedAnthropic, savedGateway]);

  /** The models to offer for a provider: this page's answer, else the cached list while it loads; null: type an id. */
  function modelsOf(provider: LlmProvider): ListedModel[] | null {
    if (!saved[provider].trim()) return null;
    const l = lists[provider];
    if (l === 'failed') return null;
    return l ?? cached?.[provider]?.models ?? null;
  }

  const setRole = (role: ModelRole, change: Partial<RoleModel>) =>
    setRoles((r) => {
      const next: RoleModel = { ...r[role], ...change };
      if (change.effort === undefined && 'effort' in change) delete next.effort;
      return { ...r, [role]: next };
    });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    for (const provider of ['anthropic', 'gateway'] as const) {
      const key = drafts[provider].trim();
      if (!key) continue;
      await (provider === 'anthropic' ? anthropicKey : gatewayKey).setValue(key);
      const shown = provider === 'anthropic' ? anthropicNoticeShown : gatewayNoticeShown;
      if (!(await shown.getValue())) {
        setNotices((n) => [...n.filter((p) => p !== provider), provider]);
        await shown.setValue(true);
      }
    }
    const trimmed = (r: RoleModel, role: ModelRole): RoleModel => ({
      ...r,
      model: r.model.trim() || DEFAULT_MODELS[r.provider][role],
    });
    const autoRunBelowUsd = readAutoRunBelowUsd(autoRun.trim() ? Number(autoRun) : undefined);
    await processingSettings.setValue({
      process: trimmed(roles.process, 'process'),
      draft: trimmed(roles.draft, 'draft'),
      merge: trimmed(roles.merge, 'merge'),
      ...(autoRunBelowUsd !== undefined ? { autoRunBelowUsd } : {}),
    });
    setDrafts({ anthropic: '', gateway: '' });
    setTests({ anthropic: null, gateway: null });
    setStatus('Saved.');
  }

  async function removeKey(provider: LlmProvider) {
    await (provider === 'anthropic' ? anthropicKey : gatewayKey).setValue('');
    setTests((t) => ({ ...t, [provider]: null }));
    setStatus('Key removed.');
  }

  async function runTest(provider: LlmProvider) {
    setTests((t) => ({ ...t, [provider]: 'running' }));
    const result = await sendMessage('testProvider', provider).catch((e: unknown) => ({
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    }));
    setTests((t) => ({ ...t, [provider]: result }));
  }

  return (
    <section aria-labelledby="processing" className="flex flex-col gap-4">
      <h2 id="processing" className="text-base font-semibold">
        Processing
      </h2>
      <p className="text-muted-foreground">
        With a key, Draft Items appear in the side panel while you review, and Process turns a finished Session into
        Change Items, using your own Anthropic account or Vercel AI Gateway. Each model below uses the provider you pick
        for it. Keys stay in this browser.
      </p>

      {notices.map((p) => (
        <ProviderNotice key={p} provider={p} onClose={() => setNotices((n) => n.filter((x) => x !== p))} />
      ))}

      <form onSubmit={save} className="flex flex-col gap-4">
        <KeyField
          provider="anthropic"
          label="Anthropic API key"
          placeholder="sk-ant-…"
          saved={saved.anthropic}
          draft={drafts.anthropic}
          onDraft={(v) => setDrafts((d) => ({ ...d, anthropic: v }))}
          test={tests.anthropic}
          onTest={() => runTest('anthropic')}
          onRemove={() => removeKey('anthropic')}
          testIds={{ key: 'anthropic-key', test: 'test-anthropic', remove: 'remove-key', result: 'test-result' }}
        />
        <KeyField
          provider="gateway"
          label="Vercel AI Gateway key"
          placeholder="Your AI Gateway API key"
          saved={saved.gateway}
          draft={drafts.gateway}
          onDraft={(v) => setDrafts((d) => ({ ...d, gateway: v }))}
          test={tests.gateway}
          onTest={() => runTest('gateway')}
          onRemove={() => removeKey('gateway')}
          testIds={{
            key: 'gateway-key',
            test: 'test-gateway',
            remove: 'remove-gateway-key',
            result: 'gateway-test-result',
          }}
        />

        {MODEL_ROLES.map((role) => (
          <RoleFields
            key={role}
            role={role}
            value={roles[role]}
            models={modelsOf(roles[role].provider)}
            onChange={(change) => setRole(role, change)}
          />
        ))}

        <div className="flex flex-col gap-1">
          <label htmlFor="auto-run-below" className="flex flex-wrap items-center gap-2 font-medium">
            Run Process without asking when the estimate is under $
            <input
              id="auto-run-below"
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              data-testid="auto-run-below"
              className="w-28 rounded-md border px-3 py-2"
              placeholder="Always ask"
              value={autoRun}
              onChange={(e) => setAutoRun(e.target.value)}
            />
          </label>
          <span className="text-muted-foreground">
            Leave it empty to always see the estimate first. Process still asks when the price is unknown, when a part
            is close to the model's limits, and before it replaces items you already have.
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="save-processing">
            Save
          </Button>
        </div>
      </form>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function ProviderNotice({ provider, onClose }: { provider: LlmProvider; onClose: () => void }) {
  return (
    <div
      role="alert"
      data-testid={provider === 'anthropic' ? 'anthropic-notice' : 'gateway-notice'}
      className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      {provider === 'anthropic' ? (
        <>
          <p className="font-medium">What goes to Anthropic</p>
          <p>
            With a key saved, the transcript and short descriptions of the page elements you mark are sent to Anthropic
            during every Session, every few seconds, to make live Draft Items, and again when you press Process.
            Screenshots are never sent for Draft Items. Screenshots are sent only for Change Items the model is unsure
            about. Nothing is sent until you start a Session or press Process. Only the models set to Anthropic send
            anything there. Remove the key to stop Draft Items.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">What goes to Vercel</p>
          <p>
            The models set to Vercel AI Gateway send the same things to Vercel instead of Anthropic: the transcript and
            short descriptions of the page elements you mark, every few seconds during a Session for Draft Items and
            again when you press Process. Screenshots are sent only for Change Items the model is unsure about. Vercel
            passes each request to the company that makes the model you picked (Anthropic for anthropic/ models).
            Nothing is sent until you start a Session or press Process.
          </p>
        </>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={onClose}>
          Got it
        </Button>
      </div>
    </div>
  );
}

function KeyField(props: {
  provider: LlmProvider;
  label: string;
  placeholder: string;
  saved: string;
  draft: string;
  onDraft: (v: string) => void;
  test: TestState;
  onTest: () => void;
  onRemove: () => void;
  testIds: { key: string; test: string; remove: string; result: string };
}) {
  const { saved, test, testIds } = props;
  const inputId = `${props.provider}-key-input`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-medium">
        {props.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid={testIds.key}
          className="min-w-0 flex-1 rounded-md border px-3 py-2 font-mono"
          placeholder={saved ? `Saved (${mask(saved)}). Paste a new key to replace it.` : props.placeholder}
          value={props.draft}
          onChange={(e) => props.onDraft(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!saved || test === 'running'}
          onClick={props.onTest}
          data-testid={testIds.test}
          title="Checks the saved key with the models set to this provider"
        >
          {test === 'running' ? 'Testing…' : 'Test'}
        </Button>
        {saved && (
          <Button type="button" variant="ghost" onClick={props.onRemove} data-testid={testIds.remove}>
            Remove key
          </Button>
        )}
      </div>
      {test && test !== 'running' && (
        <p data-testid={testIds.result} className={test.ok ? 'text-green-700' : 'text-destructive'}>
          {test.ok ? 'OK: ' : 'Error: '}
          {test.message}
        </p>
      )}
    </div>
  );
}

/** The creator of a Gateway id (`google/…` → google); Anthropic ids have none. */
const creatorOf = (id: string) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '');

function RoleFields({
  role,
  value,
  models,
  onChange,
}: {
  role: ModelRole;
  value: RoleModel;
  models: ListedModel[] | null;
  onChange: (change: Partial<RoleModel>) => void;
}) {
  const { label, help } = ROLES[role];
  const fieldClass = 'rounded-md border px-3 py-2';
  // A saved id the list does not have still shows, first.
  const listed = models && !models.some((m) => m.id === value.model) ? [{ id: value.model, name: null }] : [];
  const groups = new Map<string, { id: string; name: string | null }[]>();
  for (const m of [...listed, ...(models ?? [])]) {
    const g = creatorOf(m.id);
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  const option = (m: { id: string; name: string | null }) => (
    <option key={m.id} value={m.id}>
      {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
    </option>
  );
  return (
    <fieldset className="flex flex-col gap-1" data-testid={`${role}-role`}>
      <legend className="mb-1 font-medium">{label} model</legend>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={`${label} provider`}
          data-testid={`${role}-provider`}
          className={fieldClass}
          value={value.provider}
          onChange={(e) => {
            const provider = e.target.value as LlmProvider;
            onChange({ provider, model: DEFAULT_MODELS[provider][role] });
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {models ? (
          <select
            aria-label={`${label} model`}
            data-testid={`${role}-model`}
            className={`${fieldClass} min-w-0 flex-1 font-mono`}
            value={value.model}
            onChange={(e) => onChange({ model: e.target.value })}
          >
            {groups.size > 1
              ? [...groups].map(([creator, ms]) => (
                  <optgroup key={creator} label={creator || 'Other'}>
                    {ms.map(option)}
                  </optgroup>
                ))
              : [...groups.values()].flat().map(option)}
          </select>
        ) : (
          <input
            aria-label={`${label} model`}
            data-testid={`${role}-model`}
            className={`${fieldClass} min-w-0 flex-1 font-mono`}
            value={value.model}
            onChange={(e) => onChange({ model: e.target.value })}
          />
        )}
        <select
          aria-label={`${label} effort`}
          data-testid={`${role}-effort`}
          className={fieldClass}
          value={value.effort ?? ''}
          onChange={(e) => onChange({ effort: (e.target.value || undefined) as Effort | undefined })}
          title="How much the model thinks and writes. Default leaves it to the model."
        >
          {EFFORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label === 'Default' ? 'Default effort' : `${o.label} effort`}
            </option>
          ))}
        </select>
      </div>
      <span className="text-muted-foreground">
        {help} Default {DEFAULT_MODELS[value.provider][role]}.
        {models ? '' : ' Any model ID; save a key to pick from its list.'}
      </span>
    </fieldset>
  );
}
