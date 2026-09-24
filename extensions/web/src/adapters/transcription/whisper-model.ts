// Local Whisper through @huggingface/transformers 4.x (PRD P0-7 Free alternate, P0-14 model picker).
//
// - Models are the onnx-community `_timestamped` exports, which carry the cross-attention outputs that
//   `return_timestamps: 'word'` needs. base and small run on WASM (q8) or WebGPU; large-v3-turbo runs only on
//   WebGPU (q4) and the options page hides it without WebGPU.
// - Weights download from huggingface.co only on the reviewer's explicit Download click in the options page,
//   into transformers.js's Cache Storage ("transformers-cache", shared by every page of the extension origin).
//   Everywhere else `allowRemoteModels` is false: a Session or a re-transcription never downloads (P0-15), and
//   reads the weights from the cache only (see loadTransformers).
// - ONNX Runtime comes from the bundled /ort/ files: `wasmPaths` must be set before the first inference, or
//   transformers.js fetches it from jsDelivr (docs/spikes/README.md d2). The WebGPU entry of onnxruntime-web
//   1.31 (what transformers.js imports) uses the same asyncify .mjs/.wasm pair, so no other file is needed.
import type { AutomaticSpeechRecognitionPipeline, ProgressInfo } from '@huggingface/transformers';
import type { MediaWord } from '@inkup/core/transcription-runs';
import type { WhisperModelId } from '@/settings';

export interface WhisperModel {
  id: WhisperModelId;
  repo: string;
  label: string;
  /** Approximate download, for the picker. */
  size: string;
  webgpuOnly: boolean;
  dtype: 'q8' | 'q4' | Record<string, 'q8' | 'q4' | 'fp16' | 'fp32'>;
}

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModel> = {
  base: {
    id: 'base',
    repo: 'onnx-community/whisper-base_timestamped',
    label: 'Whisper base',
    size: '~80 MB',
    webgpuOnly: false,
    dtype: 'q8',
  },
  small: {
    id: 'small',
    repo: 'onnx-community/whisper-small_timestamped',
    label: 'Whisper small',
    size: '~250 MB',
    webgpuOnly: false,
    dtype: 'q8',
  },
  turbo: {
    id: 'turbo',
    repo: 'onnx-community/whisper-large-v3-turbo_timestamped',
    label: 'Whisper large-v3 turbo',
    size: '~800 MB',
    webgpuOnly: true,
    dtype: 'q4',
  },
};

export const WHISPER_ENGINE = 'whisper';

type Transformers = typeof import('@huggingface/transformers');

let tfPromise: Promise<Transformers> | null = null;

/** Loads transformers.js with the bundled ORT files. `ortBase` is the extension URL of /ort/ (chrome.runtime.getURL). */
export function loadTransformers(ortBase: string): Promise<Transformers> {
  tfPromise ??= import('@huggingface/transformers').then((tf) => {
    tf.env.useBrowserCache = true;
    tf.env.allowRemoteModels = false;
    // transformers.js refuses to look anything up with both local and remote models off, even in the cache
    // ("Invalid configuration detected"). "Local" here is an extension path that does not exist, so a cache
    // miss ends in a 404 on chrome-extension:// and never reaches the network.
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = new URL('../models/', ortBase).href;
    const onnx = tf.env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
    if (onnx.wasm)
      onnx.wasm.wasmPaths = {
        mjs: `${ortBase}ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `${ortBase}ort-wasm-simd-threaded.asyncify.wasm`,
      };
    return tf;
  });
  return tfPromise;
}

/** true when this context has a WebGPU adapter (the turbo model needs one). */
export async function hasWebGpu(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function deviceFor(model: WhisperModel): Promise<'webgpu' | 'wasm'> {
  if (model.webgpuOnly) return 'webgpu';
  return 'wasm';
}

/** Which of a model's pipeline files are missing from the cache (empty: ready to load offline). */
export async function missingWhisperFiles(ortBase: string, id: WhisperModelId): Promise<string[]> {
  const tf = await loadTransformers(ortBase);
  const m = WHISPER_MODELS[id];
  try {
    const r = await tf.ModelRegistry.is_pipeline_cached_files('automatic-speech-recognition', m.repo, {
      dtype: m.dtype,
      device: await deviceFor(m),
    });
    return r.files.filter((f) => !f.cached).map((f) => f.file);
  } catch (e) {
    return [`(cache check failed: ${e instanceof Error ? e.message : String(e)})`];
  }
}

export async function isWhisperCached(ortBase: string, id: WhisperModelId): Promise<boolean> {
  return (await missingWhisperFiles(ortBase, id)).length === 0;
}

const pipelines = new Map<WhisperModelId, Promise<AutomaticSpeechRecognitionPipeline>>();

/**
 * The ASR pipeline for a model. `download: true` only from the options page's Download button: it is the one
 * path that lets transformers.js reach huggingface.co.
 */
export function loadWhisper(
  ortBase: string,
  id: WhisperModelId,
  opts: { download?: boolean; onProgress?: (p: ProgressInfo) => void } = {},
): Promise<AutomaticSpeechRecognitionPipeline> {
  const cached = pipelines.get(id);
  if (cached && !opts.download) return cached;
  const p = (async () => {
    const tf = await loadTransformers(ortBase);
    const m = WHISPER_MODELS[id];
    tf.env.allowRemoteModels = !!opts.download;
    try {
      return (await tf.pipeline('automatic-speech-recognition', m.repo, {
        dtype: m.dtype,
        device: await deviceFor(m),
        ...(opts.onProgress ? { progress_callback: opts.onProgress } : {}),
      })) as AutomaticSpeechRecognitionPipeline;
    } finally {
      tf.env.allowRemoteModels = false;
    }
  })();
  pipelines.set(id, p);
  p.catch(() => pipelines.delete(id));
  return p;
}

interface WordChunk {
  text: string;
  timestamp: [number, number | null];
}

/**
 * Word timings for 16 kHz mono audio, in ms from its start. Longer audio is read in 30 s windows with a 5 s
 * stride (transformers.js merges the overlaps).
 */
export async function transcribeWords(
  asr: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
  lang: string,
): Promise<MediaWord[]> {
  const language = lang.split('-')[0]?.toLowerCase() || 'en';
  const out = (await asr(audio, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
    language,
    task: 'transcribe',
  })) as { text: string; chunks?: WordChunk[] };
  const words: MediaWord[] = [];
  for (const c of out.chunks ?? []) {
    const text = c.text.trim();
    if (!text) continue;
    const [s, e] = c.timestamp;
    words.push({ text, start_ms: Math.round(s * 1000), end_ms: Math.round((e ?? s) * 1000) });
  }
  return words;
}
