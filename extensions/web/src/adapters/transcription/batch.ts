// Batch paths for re-transcription (PRD P0-12 "re-transcribe with…"): the stored Session audio, whole, through
// one engine. Each returns word groups in media time (ms into the file); packages/core/src/transcription-runs.ts maps
// them onto the Session clock around the pauses and appends them as a new run.
//
// - Deepgram: pre-recorded POST /v1/listen with `utterances=true`, through @deepgram/sdk v5
//   (listen.v1.media.transcribeFile). Auth is the key itself (`Authorization: Token`): a one-off REST call from
//   an extension page, with nothing held open. https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
// - ElevenLabs: POST /v1/speech-to-text, multipart (model_id, file, timestamps_granularity=word), with
//   `xi-api-key`. Plain fetch: @elevenlabs/client is the browser realtime client and has no batch call, and the
//   Node SDK is not needed for one multipart request. https://elevenlabs.io/docs/api-reference/speech-to-text/convert
//   The response's `words` include `spacing` and `audio_event` entries, which are dropped.
// - Whisper: the file is decoded and resampled to 16 kHz mono by the browser (OfflineAudioContext), then read
//   in 30 s windows with word timestamps. The model must already be downloaded; nothing is fetched.
import { DeepgramClient } from '@deepgram/sdk';
import { groupWords, type MediaWord } from '@inkup/core/transcription-runs';
import type { WhisperModelId } from '@/settings';
import { DEEPGRAM_ENGINE, DEEPGRAM_MODEL, deepgramEnvironment } from './deepgram';
import { ELEVENLABS_BASE, ELEVENLABS_ENGINE } from './elevenlabs';
import { isWhisperCached, loadWhisper, transcribeWords, WHISPER_ENGINE, WHISPER_MODELS } from './whisper-model';

export const ELEVENLABS_BATCH_MODEL = 'scribe_v2';

export interface BatchResult {
  engine: string;
  model: string;
  local: boolean;
  groups: MediaWord[][];
}

export type BatchEngine =
  | { engine: 'deepgram'; key: string; base_url?: string | null }
  | { engine: 'elevenlabs'; key: string; base_url?: string | null }
  | { engine: 'whisper'; model: WhisperModelId; ort_base: string };

const lang2 = (lang: string) => lang.split('-')[0]?.toLowerCase() || 'en';
const sec = (s: number) => Math.round(s * 1000);

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
}

export async function transcribeDeepgramFile(
  audio: Blob,
  key: string,
  lang: string,
  baseUrl?: string | null,
): Promise<BatchResult> {
  const client = new DeepgramClient({
    apiKey: key,
    environment: deepgramEnvironment(baseUrl ?? undefined),
    maxRetries: 1,
    timeoutInSeconds: 300,
  });
  const res = (await client.listen.v1.media.transcribeFile(audio, {
    model: DEEPGRAM_MODEL,
    language: lang2(lang),
    punctuate: true,
    smart_format: true,
    utterances: true,
  })) as { results?: { utterances?: { words: DgWord[] }[]; channels?: { alternatives?: { words?: DgWord[] }[] }[] } };
  const toWord = (w: DgWord): MediaWord => ({
    text: w.punctuated_word ?? w.word,
    start_ms: sec(w.start),
    end_ms: sec(w.end),
  });
  const utterances = res.results?.utterances;
  const groups = utterances?.length
    ? utterances.map((u) => u.words.map(toWord)).filter((g) => g.length > 0)
    : groupWords((res.results?.channels?.[0]?.alternatives?.[0]?.words ?? []).map(toWord));
  return { engine: DEEPGRAM_ENGINE, model: DEEPGRAM_MODEL, local: false, groups };
}

export async function transcribeElevenLabsFile(
  audio: Blob,
  key: string,
  lang: string,
  baseUrl?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<BatchResult> {
  const form = new FormData();
  form.set('model_id', ELEVENLABS_BATCH_MODEL);
  form.set('file', audio, `session.${audio.type.includes('ogg') ? 'ogg' : 'webm'}`);
  form.set('timestamps_granularity', 'word');
  form.set('language_code', lang2(lang));
  form.set('tag_audio_events', 'false');
  const res = await fetchImpl(`${(baseUrl || ELEVENLABS_BASE).replace(/\/+$/, '')}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!res.ok)
    throw new Error(`ElevenLabs speech-to-text failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  const body = (await res.json()) as { words?: { text: string; start?: number; end?: number; type: string }[] };
  const words = (body.words ?? [])
    .filter((w) => w.type === 'word' && w.start !== undefined)
    .map((w) => ({ text: w.text, start_ms: sec(w.start!), end_ms: sec(w.end ?? w.start!) }));
  return { engine: ELEVENLABS_ENGINE, model: ELEVENLABS_BATCH_MODEL, local: false, groups: groupWords(words) };
}

/** Decodes a recording to 16 kHz mono PCM (the browser resamples to the context's rate while decoding). */
export async function decodeTo16kMono(audio: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await audio.arrayBuffer());
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i]! += d[i]! / buf.numberOfChannels;
  }
  return out;
}

export async function transcribeWhisperFile(
  audio: Blob,
  model: WhisperModelId,
  ortBase: string,
  lang: string,
): Promise<BatchResult> {
  const m = WHISPER_MODELS[model];
  if (!(await isWhisperCached(ortBase, model)))
    throw new Error(`${m.label} is not downloaded. Download it in Settings first.`);
  const asr = await loadWhisper(ortBase, model);
  const words = await transcribeWords(asr, await decodeTo16kMono(audio), lang);
  return { engine: WHISPER_ENGINE, model: m.repo, local: true, groups: groupWords(words) };
}

export function transcribeFile(audio: Blob, engine: BatchEngine, lang: string): Promise<BatchResult> {
  switch (engine.engine) {
    case 'deepgram':
      return transcribeDeepgramFile(audio, engine.key, lang, engine.base_url);
    case 'elevenlabs':
      return transcribeElevenLabsFile(audio, engine.key, lang, engine.base_url);
    case 'whisper':
      return transcribeWhisperFile(audio, engine.model, engine.ort_base, lang);
  }
}
