// Options (PRD P0-14 transcription and processing settings, P0-15 vendor and Anthropic notices). The key lives in storage.local only and is
// never shown back in full, logged or exported.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStorageItem } from '@/lib/use-storage-item';
import { sendMessage } from '@/messaging';
import {
  anthropicKey,
  anthropicNoticeShown,
  DEFAULT_DRAFT_MODEL,
  DEFAULT_MERGE_MODEL,
  DEFAULT_PROCESS_MODEL,
  processingSettings,
} from '@/settings';
import { DictationSection } from './dictation';
import { HostSection } from './host';
import { TranscriptionSection } from './transcription';

const mask = (key: string) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : 'saved');

export function App() {
  const savedKey = useStorageItem(anthropicKey);
  const settings = useStorageItem(processingSettings);
  const [keyDraft, setKeyDraft] = useState('');
  const [processModel, setProcessModel] = useState(DEFAULT_PROCESS_MODEL);
  const [draftModel, setDraftModel] = useState(DEFAULT_DRAFT_MODEL);
  const [mergeModel, setMergeModel] = useState(DEFAULT_MERGE_MODEL);
  const [notice, setNotice] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'running' | null>(null);

  useEffect(() => {
    if (settings) {
      setProcessModel(settings.processModel);
      setDraftModel(settings.draftModel);
      setMergeModel(settings.mergeModel ?? DEFAULT_MERGE_MODEL);
    }
  }, [settings]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const key = keyDraft.trim();
    if (key) {
      await anthropicKey.setValue(key);
      if (!(await anthropicNoticeShown.getValue())) {
        setNotice(true);
        await anthropicNoticeShown.setValue(true);
      }
    }
    await processingSettings.setValue({
      processModel: processModel.trim() || DEFAULT_PROCESS_MODEL,
      draftModel: draftModel.trim() || DEFAULT_DRAFT_MODEL,
      mergeModel: mergeModel.trim() || DEFAULT_MERGE_MODEL,
    });
    setKeyDraft('');
    setTest(null);
    setStatus('Saved.');
  }

  async function removeKey() {
    await anthropicKey.setValue('');
    setTest(null);
    setStatus('Key removed.');
  }

  async function runTest() {
    setTest('running');
    try {
      setTest(await sendMessage('testAnthropic', undefined));
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-sm">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <a className="text-primary underline" href="/sessions.html" data-testid="open-sessions">
          Stored Sessions
        </a>
      </header>

      <TranscriptionSection />
      <DictationSection />

      <section aria-labelledby="processing" className="flex flex-col gap-4">
        <h2 id="processing" className="text-base font-semibold">
          Processing (Anthropic)
        </h2>
        <p className="text-muted-foreground">
          With a key, Draft Items appear in the side panel while you review, and Process turns a finished Session into
          Change Items, using your own Anthropic account. The key stays in this browser.
        </p>

        {notice && (
          <div
            role="alert"
            data-testid="anthropic-notice"
            className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950"
          >
            <p className="font-medium">What goes to Anthropic</p>
            <p>
              With a key saved, the transcript and short descriptions of the page elements you mark are sent to
              Anthropic during every Session, every few seconds, to make live Draft Items, and again when you press
              Process. Screenshots are never sent for Draft Items. Screenshots are sent only for Change Items the model
              is unsure about. Nothing is sent until you start a Session or press Process. Remove the key to stop Draft
              Items.
            </p>
            <div>
              <Button variant="outline" size="sm" onClick={() => setNotice(false)}>
                Got it
              </Button>
            </div>
          </div>
        )}

        <form onSubmit={save} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Anthropic API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-testid="anthropic-key"
              className="rounded-md border px-3 py-2 font-mono"
              placeholder={savedKey ? `Saved (${mask(savedKey)}). Paste a new key to replace it.` : 'sk-ant-…'}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Process model</span>
            <input
              data-testid="process-model"
              className="rounded-md border px-3 py-2 font-mono"
              value={processModel}
              onChange={(e) => setProcessModel(e.target.value)}
            />
            <span className="text-muted-foreground">Any model ID. Default {DEFAULT_PROCESS_MODEL}.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Draft model</span>
            <input
              data-testid="draft-model"
              className="rounded-md border px-3 py-2 font-mono"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
            />
            <span className="text-muted-foreground">
              Used for live Draft Items during a Session. Default {DEFAULT_DRAFT_MODEL}.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Merge model</span>
            <input
              data-testid="merge-model"
              className="rounded-md border px-3 py-2 font-mono"
              value={mergeModel}
              onChange={(e) => setMergeModel(e.target.value)}
            />
            <span className="text-muted-foreground">
              Rewrites two merged Change Items as one on the review page. Default {DEFAULT_MERGE_MODEL}.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" data-testid="save-processing">
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!savedKey || test === 'running'}
              onClick={runTest}
              data-testid="test-anthropic"
            >
              {test === 'running' ? 'Testing…' : 'Test'}
            </Button>
            {savedKey && (
              <Button type="button" variant="ghost" onClick={removeKey} data-testid="remove-key">
                Remove key
              </Button>
            )}
          </div>
        </form>
        {status && <p role="status">{status}</p>}
        {test && test !== 'running' && (
          <p data-testid="test-result" className={test.ok ? 'text-green-700' : 'text-destructive'}>
            {test.ok ? 'OK: ' : 'Error: '}
            {test.message}
          </p>
        )}
      </section>

      <HostSection />
    </main>
  );
}
