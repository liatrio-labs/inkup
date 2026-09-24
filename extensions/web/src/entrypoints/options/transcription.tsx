// Options: transcription tiers (PRD P0-7, P0-14, P0-15). Free runs on this device (on-device Web Speech, or local
// Whisper with a model picker and an explicit Download); Better (Deepgram) and Best (ElevenLabs) take the
// reviewer's own key, stored in storage.local only and shown back masked. Test makes a real token-mint call. The
// first time a paid tier is chosen, a notice says audio streams to that vendor while recording.
import { useEffect, useState } from 'react';
import { mintDeepgramToken } from '@/adapters/transcription/deepgram';
import { mintScribeToken } from '@/adapters/transcription/elevenlabs';
import { hasWebGpu, loadWhisper, WHISPER_MODELS } from '@/adapters/transcription/whisper-model';
import { Button } from '@/components/ui/button';
import { useStorageItem } from '@/lib/use-storage-item';
import { platform } from '@/platform';
import {
  deepgramKey,
  devOverrides,
  elevenlabsKey,
  type TranscriptionSettings,
  type TranscriptionTier,
  transcriptionSettings,
  vendorNoticeShown,
  type WhisperModelId,
  whisperDownloads,
} from '@/settings';

const mask = (key: string) => (key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : 'saved');

const TIERS: { id: TranscriptionTier; label: string; blurb: string }[] = [
  { id: 'free', label: 'Free', blurb: 'On this device. No key, no network during Sessions.' },
  {
    id: 'better',
    label: 'Better',
    blurb: 'Deepgram Nova-3, word timings, streams while you record. Your Deepgram key.',
  },
  {
    id: 'best',
    label: 'Best',
    blurb: 'ElevenLabs Scribe v2 Realtime, word timings, streams while you record. Your ElevenLabs key.',
  },
];

const VENDOR = {
  better: { id: 'deepgram', name: 'Deepgram' },
  best: { id: 'elevenlabs', name: 'ElevenLabs' },
} as const;

export function TranscriptionSection() {
  const settings = useStorageItem(transcriptionSettings);
  const [notice, setNotice] = useState<'deepgram' | 'elevenlabs' | null>(null);
  if (!settings) return null;

  async function update(change: Partial<TranscriptionSettings>) {
    const next = { ...(await transcriptionSettings.getValue()), ...change };
    await transcriptionSettings.setValue(next);
    if (change.tier === 'better' || change.tier === 'best') {
      const vendor = VENDOR[change.tier].id;
      const shown = await vendorNoticeShown.getValue();
      if (!shown[vendor]) {
        setNotice(vendor);
        await vendorNoticeShown.setValue({ ...shown, [vendor]: true });
      }
    }
  }

  return (
    <section aria-labelledby="transcription" className="flex flex-col gap-4">
      <h2 id="transcription" className="text-base font-semibold">
        Transcription
      </h2>
      <fieldset className="flex flex-col gap-2" data-testid="tier-picker">
        <legend className="mb-1 font-medium">Tier</legend>
        {TIERS.map((t) => (
          <label key={t.id} className="flex items-start gap-2">
            <input
              type="radio"
              name="tier"
              value={t.id}
              checked={settings.tier === t.id}
              onChange={() => void update({ tier: t.id })}
              data-testid={`tier-${t.id}`}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{t.label}</span> <span className="text-muted-foreground">{t.blurb}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {notice && (
        <div
          role="alert"
          data-testid="vendor-notice"
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950"
        >
          <p className="font-medium">Your audio goes to {notice === 'deepgram' ? 'Deepgram' : 'ElevenLabs'}</p>
          <p>
            With this tier, the microphone audio of every Session streams to{' '}
            {notice === 'deepgram' ? 'Deepgram' : 'ElevenLabs'} while you record, under your own account and key, and
            the transcript comes back. Nothing streams while a Session is paused. If the connection keeps failing, the
            Session switches to the Free tier and says so. Choose Free to keep audio on this device.
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={() => setNotice(null)}>
              Got it
            </Button>
          </div>
        </div>
      )}

      {settings.tier === 'free' && <FreeTier settings={settings} update={update} />}
      {settings.tier === 'better' && <KeyField vendor="deepgram" />}
      {settings.tier === 'best' && <KeyField vendor="elevenlabs" />}
    </section>
  );
}

function FreeTier({
  settings,
  update,
}: {
  settings: TranscriptionSettings;
  update: (c: Partial<TranscriptionSettings>) => Promise<void>;
}) {
  const webSpeech = platform.capabilities().speechRecognition;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">Engine</legend>
        {webSpeech ? (
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="free-engine"
              checked={settings.freeEngine === 'webspeech'}
              onChange={() => void update({ freeEngine: 'webspeech' })}
              data-testid="engine-webspeech"
              className="mt-1"
            />
            <span>
              <span className="font-medium">On-device Web Speech</span>{' '}
              <span className="text-muted-foreground">
                Chrome&apos;s speech pack. Live captions; times are approximate.
              </span>
            </span>
          </label>
        ) : (
          <p className="text-muted-foreground" data-testid="no-webspeech">
            This browser has no built-in speech recognition. Download a Whisper model below for live captions, or use
            Better or Best. Until then, Sessions record audio, Strokes and screenshots without captions.
          </p>
        )}
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="free-engine"
            checked={settings.freeEngine === 'whisper'}
            onChange={() => void update({ freeEngine: 'whisper' })}
            data-testid="engine-whisper"
            className="mt-1"
          />
          <span>
            <span className="font-medium">Local Whisper</span>{' '}
            <span className="text-muted-foreground">
              Runs on this device with word timings. Captions appear after each pause. Needs a one-time model download.
            </span>
          </span>
        </label>
      </fieldset>
      {(settings.freeEngine === 'whisper' || !webSpeech) && (
        <WhisperPicker selected={settings.whisperModel} onSelect={(m) => void update({ whisperModel: m })} />
      )}
    </div>
  );
}

type Download = { model: WhisperModelId; progress: number; loaded: number; total: number } | null;

function WhisperPicker({ selected, onSelect }: { selected: WhisperModelId; onSelect: (m: WhisperModelId) => void }) {
  const downloads = useStorageItem(whisperDownloads) ?? {};
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [active, setActive] = useState<Download>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void hasWebGpu().then(setWebgpu);
  }, []);

  async function download(model: WhisperModelId) {
    setError(null);
    setActive({ model, progress: 0, loaded: 0, total: 0 });
    let total = 0;
    try {
      const asr = await loadWhisper(chrome.runtime.getURL('/ort/'), model, {
        download: true,
        onProgress: (p) => {
          if (p.status === 'progress_total') {
            total = p.total;
            setActive({ model, progress: p.progress, loaded: p.loaded, total: p.total });
          }
        },
      });
      void asr;
      await whisperDownloads.setValue({
        ...(await whisperDownloads.getValue()),
        [model]: { downloaded_at: new Date().toISOString(), bytes: total },
      });
    } catch (e) {
      setError(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActive(null);
    }
  }

  const models = Object.values(WHISPER_MODELS).filter((m) => !m.webgpuOnly || webgpu);
  return (
    <fieldset className="flex flex-col gap-2" data-testid="whisper-models">
      <legend className="mb-1 font-medium">Whisper model</legend>
      <p className="text-muted-foreground">
        Models download from huggingface.co only when you click Download, and stay in this browser.
        {webgpu === false && ' Large-v3 turbo needs WebGPU, which this browser does not offer.'}
      </p>
      {models.map((m) => {
        const done = downloads[m.id];
        const busy = active?.model === m.id;
        return (
          <div
            key={m.id}
            className="flex flex-wrap items-center gap-3"
            data-testid={`whisper-${m.id}`}
            data-downloaded={!!done}
          >
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="whisper-model"
                checked={selected === m.id}
                onChange={() => onSelect(m.id)}
                data-testid={`whisper-pick-${m.id}`}
              />
              <span className="font-medium">{m.label}</span>
              <span className="text-muted-foreground">
                {m.size}
                {m.webgpuOnly ? ', WebGPU' : ''}
              </span>
            </label>
            {done ? (
              <span className="text-green-700" data-testid={`whisper-status-${m.id}`}>
                Downloaded
              </span>
            ) : busy ? (
              <span className="flex items-center gap-2" data-testid={`whisper-status-${m.id}`}>
                <progress max={100} value={active.progress} className="w-40" aria-label={`Downloading ${m.label}`} />
                {Math.round(active.progress)}%{active.total ? ` of ${(active.total / 1e6).toFixed(0)} MB` : ''}
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!!active}
                onClick={() => void download(m.id)}
                data-testid={`whisper-download-${m.id}`}
              >
                Download
              </Button>
            )}
          </div>
        );
      })}
      {selected && !downloads[selected] && !active && (
        <p className="text-amber-800">
          Until this model is downloaded, Sessions{' '}
          {platform.capabilities().speechRecognition ? 'use on-device Web Speech' : 'record without live captions'}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function KeyField({ vendor }: { vendor: 'deepgram' | 'elevenlabs' }) {
  const item = vendor === 'deepgram' ? deepgramKey : elevenlabsKey;
  const name = vendor === 'deepgram' ? 'Deepgram' : 'ElevenLabs';
  const saved = useStorageItem(item);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'running' | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    await item.setValue(draft.trim());
    setDraft('');
    setTest(null);
    setStatus('Key saved.');
  }

  async function runTest() {
    setTest('running');
    const key = await item.getValue();
    const dev = await devOverrides.getValue();
    try {
      if (vendor === 'deepgram') {
        const cred = await mintDeepgramToken(key, dev?.deepgramBaseUrl);
        setTest({
          ok: true,
          message:
            cred.kind === 'bearer'
              ? 'Deepgram issued a short-lived token.'
              : 'The key works, but cannot mint tokens (403). Sessions will use the key itself.',
        });
      } else {
        await mintScribeToken(key, dev?.elevenlabsBaseUrl);
        setTest({ ok: true, message: 'ElevenLabs issued a single-use Scribe token.' });
      }
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border p-4">
      <label className="flex flex-col gap-1">
        <span className="font-medium">{name} API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid={`${vendor}-key`}
          className="rounded-md border px-3 py-2 font-mono"
          placeholder={saved ? `Saved (${mask(saved)}). Paste a new key to replace it.` : `${name} key`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="text-muted-foreground">Stored in this browser only. Never synced, logged or exported.</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" data-testid={`save-${vendor}`}>
          Save key
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!saved || test === 'running'}
          onClick={() => void runTest()}
          data-testid={`test-${vendor}`}
        >
          {test === 'running' ? 'Testing…' : 'Test'}
        </Button>
        {saved && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void item.setValue('');
              setTest(null);
              setStatus('Key removed. Sessions use the Free tier until a key is saved.');
            }}
            data-testid={`remove-${vendor}`}
          >
            Remove key
          </Button>
        )}
      </div>
      {!saved && <p className="text-amber-800">Without a key, Sessions use the Free tier.</p>}
      {status && <p role="status">{status}</p>}
      {test && test !== 'running' && (
        <p data-testid={`test-${vendor}-result`} className={test.ok ? 'text-green-700' : 'text-destructive'}>
          {test.ok ? 'OK: ' : 'Error: '}
          {test.message}
        </p>
      )}
    </form>
  );
}
