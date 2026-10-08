// Options: transcription tiers (PRD P0-7, P0-14, P0-15). Free runs on this device (on-device Web Speech, or local
// Whisper with a model picker and an explicit Download); Better (Deepgram) and Best (ElevenLabs) take the
// reviewer's own key, stored in storage.local only and shown back masked. Test makes a real token-mint call. The
// first time a paid tier is chosen, a notice says audio streams to that vendor while recording.

import { Button, Card, CardContent, cn, Input, Label, RadioGroup, RadioGroupItem, TONE } from '@inkup/ui';
import { useEffect, useState } from 'react';
import { mintDeepgramToken } from '@/adapters/transcription/deepgram';
import { mintScribeToken } from '@/adapters/transcription/elevenlabs';
import { hasWebGpu, loadWhisper, WHISPER_MODELS } from '@/adapters/transcription/whisper-model';
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
      <h2 id="transcription" className="text-lg font-bold tracking-tight">
        Transcription
      </h2>
      <RadioGroup
        asChild
        value={settings.tier}
        onValueChange={(tier) => void update({ tier: tier as TranscriptionTier })}
      >
        <fieldset className="gap-2" data-testid="tier-picker">
          <legend className="mb-1 font-medium">Tier</legend>
          {TIERS.map((t) => (
            <div key={t.id} className="flex items-start gap-3">
              <RadioGroupItem id={`tier-${t.id}`} value={t.id} data-testid={`tier-${t.id}`} className="mt-0.5" />
              <Label htmlFor={`tier-${t.id}`} className="block font-normal leading-snug">
                <span className="font-medium">{t.label}</span> <span className="text-muted-foreground">{t.blurb}</span>
              </Label>
            </div>
          ))}
        </fieldset>
      </RadioGroup>

      {notice && (
        <div
          role="alert"
          data-testid="vendor-notice"
          className={cn('flex flex-col gap-2 rounded-lg border p-4', TONE.noteBorder, TONE.note)}
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
    <Card className="gap-0 py-4 shadow-none">
      <CardContent className="flex flex-col gap-3 px-4">
        <RadioGroup
          asChild
          value={settings.freeEngine}
          onValueChange={(freeEngine) => void update({ freeEngine: freeEngine as TranscriptionSettings['freeEngine'] })}
        >
          <fieldset className="gap-2">
            <legend className="mb-1 font-medium">Engine</legend>
            {webSpeech ? (
              <div className="flex items-start gap-3">
                <RadioGroupItem
                  id="engine-webspeech"
                  value="webspeech"
                  data-testid="engine-webspeech"
                  className="mt-0.5"
                />
                <Label htmlFor="engine-webspeech" className="block font-normal leading-snug">
                  <span className="font-medium">On-device Web Speech</span>{' '}
                  <span className="text-muted-foreground">
                    Chrome&apos;s speech pack. Live captions; times are approximate.
                  </span>
                </Label>
              </div>
            ) : (
              <p className="text-muted-foreground" data-testid="no-webspeech">
                This browser has no built-in speech recognition. Download a Whisper model below for live captions, or
                use Better or Best. Until then, Sessions record audio, Strokes and screenshots without captions.
              </p>
            )}
            <div className="flex items-start gap-3">
              <RadioGroupItem id="engine-whisper" value="whisper" data-testid="engine-whisper" className="mt-0.5" />
              <Label htmlFor="engine-whisper" className="block font-normal leading-snug">
                <span className="font-medium">Local Whisper</span>{' '}
                <span className="text-muted-foreground">
                  Runs on this device with word timings. Captions appear after each pause. Needs a one-time model
                  download.
                </span>
              </Label>
            </div>
          </fieldset>
        </RadioGroup>
        {(settings.freeEngine === 'whisper' || !webSpeech) && (
          <WhisperPicker selected={settings.whisperModel} onSelect={(m) => void update({ whisperModel: m })} />
        )}
      </CardContent>
    </Card>
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
    <RadioGroup asChild value={selected} onValueChange={(m) => onSelect(m as WhisperModelId)}>
      <fieldset className="gap-2" data-testid="whisper-models">
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
              <Label htmlFor={`whisper-pick-${m.id}`} className="gap-2 font-normal">
                <RadioGroupItem id={`whisper-pick-${m.id}`} value={m.id} data-testid={`whisper-pick-${m.id}`} />
                <span className="font-medium">{m.label}</span>
                <span className="text-muted-foreground">
                  {m.size}
                  {m.webgpuOnly ? ', WebGPU' : ''}
                </span>
              </Label>
              {done ? (
                <span className={TONE.okText} data-testid={`whisper-status-${m.id}`}>
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
          <p className={TONE.warnText}>
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
    </RadioGroup>
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
    <Card className="gap-0 py-4 shadow-none">
      <CardContent className="px-4">
        <form onSubmit={save} className="flex flex-col gap-3">
          <Label className="flex-col items-stretch gap-1 leading-snug">
            <span>{name} API key</span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-testid={`${vendor}-key`}
              className="font-mono transition-none"
              placeholder={saved ? `Saved (${mask(saved)}). Paste a new key to replace it.` : `${name} key`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="font-normal text-muted-foreground">
              Stored in this browser only. Never synced, logged or exported.
            </span>
          </Label>
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
          {!saved && <p className={TONE.warnText}>Without a key, Sessions use the Free tier.</p>}
          {status && <p role="status">{status}</p>}
          {test && test !== 'running' && (
            <p data-testid={`test-${vendor}-result`} className={test.ok ? TONE.okText : 'text-destructive'}>
              {test.ok ? 'OK: ' : 'Error: '}
              {test.message}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
