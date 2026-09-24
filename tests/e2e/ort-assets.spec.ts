// Build integrity for the locally bundled ORT and Silero assets (docs/spikes/README.md d1–d3), run through the
// real offscreen document's on-demand self-test. Slice 3 (vad-web) and Slice 6 (Whisper) depend on these.
import type { Worker } from '@playwright/test';
import { expect, grantMic, test } from './fixtures';

async function selfTest(sw: Worker, check: 'vad' | 'transformers') {
  return sw.evaluate(async (c) => {
    const url = chrome.runtime.getURL('offscreen.html');
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'test',
      });
    }
    // @webext-core/messaging wire format: { id, type, data, timestamp } → { res } | { err }.
    const reply = await chrome.runtime.sendMessage({ id: 1, type: 'ortSelfTest', data: c, timestamp: Date.now() });
    if (reply?.err) throw new Error(JSON.stringify(reply.err));
    return reply.res;
  }, check);
}

const local = (extensionId: string) => (url: string) => url.startsWith(`chrome-extension://${extensionId}/`);

test('vad-web loads Silero v5 from bundled files and finds the fixture phrases', async ({
  serviceWorker,
  openExtensionPage,
  extensionId,
}) => {
  await grantMic(openExtensionPage);
  const res = await selfTest(serviceWorker, 'vad');
  // review-scratch-that.wav: three phrases split by ~1.5 s silences.
  expect(res.edges.filter((e: { type: string }) => e.type === 'speech-end').length).toBeGreaterThanOrEqual(3);
  expect(res.cspViolations).toEqual([]);
  expect(res.fetched.every(local(extensionId))).toBe(true);
  expect(res.fetched.some((u: string) => u.endsWith('/vad/silero_vad_v5.onnx'))).toBe(true);
  // One ONNX Runtime wasm ships: the VAD runs on the build Whisper uses (wxt.config.ts `vadUsesTransformersOrt`).
  expect(res.fetched.filter((u: string) => u.endsWith('.wasm'))).toEqual([
    `chrome-extension://${extensionId}/ort/ort-wasm-simd-threaded.asyncify.wasm`,
  ]);
});

test('transformers.js initializes ORT from bundled files, then coexists with vad-web', async ({
  serviceWorker,
  openExtensionPage,
  extensionId,
}) => {
  await grantMic(openExtensionPage);
  const tf = await selfTest(serviceWorker, 'transformers');
  expect(tf.matmul).toEqual([19, 22, 43, 50]);
  const vad = await selfTest(serviceWorker, 'vad');
  expect(vad.edges.length).toBeGreaterThan(0);
  const again = await selfTest(serviceWorker, 'transformers');
  expect(again.matmul).toEqual([19, 22, 43, 50]);
  expect(again.cspViolations).toEqual([]);
  expect(again.fetched.every(local(extensionId))).toBe(true);
});
