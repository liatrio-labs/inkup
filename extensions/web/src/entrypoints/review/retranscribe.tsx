// Transcript runs on the review page (PRD P0-12 "re-transcribe with…", Slice 6): pick which run the transcript
// shows (and Process reads), and re-transcribe the stored audio through any engine that is set up: a paid tier
// with a saved key, or a downloaded Whisper model. A re-run is appended as a new run and becomes the active one;
// the live run and earlier re-runs stay in the log. Without audio (never recorded, or deleted after an export)
// re-transcription is off.

import { pauseGaps } from '@inkup/core/media-time';
import type { TimelineEvent } from '@inkup/core/timeline';
import type { RunSummary } from '@inkup/core/transcription-runs';
import { useState } from 'react';
import { type BatchEngine, transcribeFile } from '@/adapters/transcription/batch';
import { WHISPER_MODELS } from '@/adapters/transcription/whisper-model';
import { Button } from '@/components/ui/button';
import { db, type SessionRow } from '@/db';
import { appendTranscriptionRun, selectTranscriptRun } from '@/db/review';
import { useStorageItem } from '@/lib/use-storage-item';
import { deepgramKey, devOverrides, elevenlabsKey, type WhisperModelId, whisperDownloads } from '@/settings';

const ENGINE_LABEL: Record<string, string> = {
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  whisper: 'Whisper',
  webspeech: 'Web Speech',
  scripted: 'Scripted',
};

export function runLabel(r: RunSummary): string {
  if (r.run_id === null) return `Live (${ENGINE_LABEL[r.engine] ?? r.engine}, ${r.segment_count} segments)`;
  const when = r.created_at ? new Date(r.created_at).toLocaleString() : '';
  return `${ENGINE_LABEL[r.engine] ?? r.engine} ${r.model ?? ''} · ${when} (${r.segment_count} segments)`.replace(
    /\s+/g,
    ' ',
  );
}

interface Choice {
  value: string;
  label: string;
  engine: () => Promise<BatchEngine>;
}

function useChoices(): Choice[] {
  const dg = useStorageItem(deepgramKey);
  const el = useStorageItem(elevenlabsKey);
  const downloads = useStorageItem(whisperDownloads);
  const base = async (k: 'deepgramBaseUrl' | 'elevenlabsBaseUrl') => (await devOverrides.getValue())?.[k] ?? null;
  const out: Choice[] = [];
  if (dg)
    out.push({
      value: 'deepgram',
      label: 'Deepgram Nova-3 (Better)',
      engine: async () => ({ engine: 'deepgram', key: dg, base_url: await base('deepgramBaseUrl') }),
    });
  if (el)
    out.push({
      value: 'elevenlabs',
      label: 'ElevenLabs Scribe (Best)',
      engine: async () => ({ engine: 'elevenlabs', key: el, base_url: await base('elevenlabsBaseUrl') }),
    });
  for (const id of Object.keys(downloads ?? {}) as WhisperModelId[]) {
    out.push({
      value: `whisper-${id}`,
      label: `${WHISPER_MODELS[id].label} (on this device)`,
      engine: async () => ({ engine: 'whisper', model: id, ort_base: chrome.runtime.getURL('/ort/') }),
    });
  }
  return out;
}

export function TranscriptRuns({
  session,
  events,
  runs,
  activeRun,
}: {
  session: SessionRow;
  events: readonly TimelineEvent[];
  runs: RunSummary[];
  activeRun: string | null;
}) {
  const choices = useChoices();
  const [pick, setPick] = useState('');
  const [status, setStatus] = useState<{ busy: boolean; text: string; error?: boolean } | null>(null);
  const choice = choices.find((c) => c.value === pick) ?? choices[0];
  const audio = session.audio;
  const offReason = session.media_deleted_at
    ? 'The audio was deleted after an export, so it cannot be re-transcribed.'
    : !audio
      ? 'This Session has no audio to re-transcribe.'
      : null;

  async function run() {
    if (!choice || !audio) return;
    setStatus({ busy: true, text: `Re-transcribing with ${choice.label}…` });
    try {
      const blob = (await db.blobs.get(audio.blob_id))?.blob;
      if (!blob) throw new Error('The audio file is missing.');
      const result = await transcribeFile(blob, await choice.engine(), navigator.language || 'en-US');
      const ev = await appendTranscriptionRun(session.id, {
        ...result,
        clock: { start_offset_ms: audio.start_offset_ms, gaps: pauseGaps(events) },
      });
      setStatus({
        busy: false,
        text: `New transcript from ${choice.label}: ${ev.segment_count} segments. It is now the active transcript.`,
      });
    } catch (e) {
      setStatus({
        busy: false,
        text: `Re-transcription failed: ${e instanceof Error ? e.message : String(e)}`,
        error: true,
      });
    }
  }

  async function select(value: string) {
    try {
      await selectTranscriptRun(session.id, value === 'live' ? null : value);
    } catch (e) {
      setStatus({ busy: false, text: `Could not switch: ${e instanceof Error ? e.message : String(e)}`, error: true });
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="transcript-run" data-run-id={activeRun ?? 'live'}>
      {runs.length > 1 && (
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Showing</span>
          <select
            className="rounded-md border px-2 py-1"
            data-testid="transcript-run-select"
            value={activeRun ?? 'live'}
            onChange={(e) => void select(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.run_id ?? 'live'} value={r.run_id ?? 'live'}>
                {runLabel(r)}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">
            Process uses the transcript shown. Edits belong to the transcript they were made on.
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {choices.length === 0 ? (
          <span className="text-muted-foreground" data-testid="retranscribe-none">
            To re-transcribe, save a Deepgram or ElevenLabs key or download a Whisper model in Settings.
          </span>
        ) : (
          <>
            <span className="font-medium">Re-transcribe with</span>
            <select
              className="rounded-md border px-2 py-1"
              data-testid="retranscribe-engine"
              value={choice?.value}
              onChange={(e) => setPick(e.target.value)}
              disabled={!!offReason}
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={run}
              disabled={!!offReason || !!status?.busy}
              data-testid="retranscribe"
            >
              {status?.busy ? 'Working…' : 'Re-transcribe'}
            </Button>
          </>
        )}
        {offReason && (
          <span className="text-muted-foreground" data-testid="retranscribe-off">
            {offReason}
          </span>
        )}
      </div>
      {status && (
        <p
          role={status.error ? 'alert' : 'status'}
          data-testid="retranscribe-status"
          className={status.error ? 'text-destructive' : ''}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}
