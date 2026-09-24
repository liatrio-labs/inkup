// Build-integrity self-test for the locally bundled ORT and Silero assets (scripts/copy-wasm-assets.mjs).
// Loaded only on demand by tests/e2e/ort-assets.spec.ts; not reachable from any UI. It keeps the Slice 0 spike
// d1–d3 guarantees green until Slice 3 (vad-web) and Slice 6 (Whisper) use these assets for real.
import { getUserMediaWithRetry } from '@/lib/get-user-media';

const fetched: string[] = [];
const cspViolations: { blockedURI: string; directive: string }[] = [];
let instrumented = false;

function instrument() {
  if (instrumented) return;
  instrumented = true;
  // Resource Timing does not list chrome-extension:// loads, so record fetch() URLs and CSP violations.
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  };
  document.addEventListener('securitypolicyviolation', (e) =>
    cspViolations.push({ blockedURI: e.blockedURI, directive: e.effectiveDirective }),
  );
}

async function vad() {
  const { MicVAD } = await import('@ricky0123/vad-web');
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const edges: { t: number; type: string }[] = [];
  const v = await MicVAD.new({
    model: 'v5',
    baseAssetPath: chrome.runtime.getURL('/vad/'),
    onnxWASMBasePath: chrome.runtime.getURL('/ort/'),
    getStream: () => getUserMediaWithRetry({ audio: { channelCount: 1 } }),
    onSpeechStart: () => void edges.push({ t: at(), type: 'speech-start' }),
    onSpeechEnd: () => void edges.push({ t: at(), type: 'speech-end' }),
    startOnLoad: true,
  });
  await new Promise((r) => setTimeout(r, 9000));
  await v.destroy();
  return { edges };
}

async function transformers() {
  const tf = await import('@huggingface/transformers');
  tf.env.allowRemoteModels = false;
  tf.env.useWasmCache = false;
  const onnx = tf.env.backends.onnx as { wasm: { wasmPaths: unknown } };
  onnx.wasm.wasmPaths = {
    mjs: chrome.runtime.getURL('/ort/ort-wasm-simd-threaded.asyncify.mjs'),
    wasm: chrome.runtime.getURL('/ort/ort-wasm-simd-threaded.asyncify.wasm'),
  };
  const a = new tf.Tensor('float32', new Float32Array([1, 2, 3, 4]), [2, 2]);
  const b = new tf.Tensor('float32', new Float32Array([5, 6, 7, 8]), [2, 2]);
  const c = await tf.matmul(a, b);
  return { matmul: Array.from(c.data as Float32Array) };
}

export async function runOrtSelfTest(check: 'vad' | 'transformers') {
  instrument();
  const result = check === 'vad' ? await vad() : await transformers();
  return { ...result, fetched: [...fetched], cspViolations: [...cspViolations] };
}
