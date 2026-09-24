// Which transcription engine a Session starts with (PRD P0-7, P0-14), from the tier settings. The offscreen
// document only has chrome.runtime, so the vendor key travels in the offscreenStart message; it is never logged,
// stored in the Session or exported. A paid tier without a key starts on the free default and logs why.
import type { AdapterConfig, Fallback } from '@/adapters/transcription';
import { platform } from '@/platform';
import {
  allowServerSpeech,
  deepgramKey,
  devOverrides,
  elevenlabsKey,
  transcriptionSettings,
  type WhisperModelId,
  whisperDownloads,
} from '@/settings';

export interface StartTranscription {
  config: AdapterConfig;
  /** Logged at Start when the chosen engine could not be used at all (e.g. a paid tier with no key). */
  notice: Omit<Fallback, 'info'> | null;
}

export async function transcriptionForStart(): Promise<StartTranscription> {
  const dev = await devOverrides.getValue();
  if (dev?.transcription === 'scripted' && dev.script)
    return { config: { adapter: 'scripted', script: dev.script }, notice: null };
  const settings = await transcriptionSettings.getValue();
  const fallback = { allow_server: await allowServerSpeech.getValue() };
  const free: AdapterConfig = { adapter: 'webspeech', allow_server: fallback.allow_server };
  const retry_base_ms = dev?.sttRetryBaseMs ?? null;
  if (settings.tier === 'better') {
    const key = (await deepgramKey.getValue()).trim();
    if (!key) return { config: free, notice: { from: 'deepgram', to: 'webspeech', reason: 'no_key' } };
    return {
      config: { adapter: 'deepgram', key, base_url: dev?.deepgramBaseUrl ?? null, retry_base_ms, fallback },
      notice: null,
    };
  }
  if (settings.tier === 'best') {
    const key = (await elevenlabsKey.getValue()).trim();
    if (!key) return { config: free, notice: { from: 'elevenlabs', to: 'webspeech', reason: 'no_key' } };
    return {
      config: { adapter: 'elevenlabs', key, base_url: dev?.elevenlabsBaseUrl ?? null, retry_base_ms, fallback },
      notice: null,
    };
  }
  const whisper = (model: WhisperModelId): StartTranscription => ({
    config: { adapter: 'whisper', model, ort_base: chrome.runtime.getURL('/ort/'), fallback },
    notice: null,
  });
  const downloads = await whisperDownloads.getValue();
  if (settings.freeEngine === 'whisper') {
    if (!downloads[settings.whisperModel])
      return { config: free, notice: { from: 'whisper', to: 'webspeech', reason: 'whisper_model_missing' } };
    return whisper(settings.whisperModel);
  }
  // No Web Speech in this browser (Firefox): a downloaded Whisper model is the free engine with captions.
  if (!platform.capabilities().speechRecognition) {
    const model = downloads[settings.whisperModel]
      ? settings.whisperModel
      : (Object.keys(downloads) as WhisperModelId[]).find((m) => downloads[m]);
    if (model) return whisper(model);
  }
  return { config: free, notice: null };
}
