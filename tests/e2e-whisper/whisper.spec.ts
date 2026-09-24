// Opt-in Slice 6 proof (`pnpm test:e2e:whisper`): local Whisper for real. The options page downloads
// whisper-base (the one step that reaches huggingface.co), then:
// 1. a Session on the Free tier with Local Whisper transcribes the fake mic (fixtures/audio/drafts-session.wav)
//    per VAD speech span, in the offscreen document, with word timestamps on the Session clock;
// 2. re-transcribing that Session's audio with Whisper base from the review page makes a new run.
// Both must reach WER ≤ MAX_WER against the fixture script, and each spoken clip's first word must start near
// where drafts-session.timing.json puts it.
import type { Page } from '@playwright/test';
import type { EventOf } from '../../packages/core/src/timeline.ts';
import { expect, grantMic, test } from '../e2e/fixtures';
import { activeSessionId, ofType, sessionEvents } from '../e2e/helpers/session';
import { fixtureReference, fixtureTiming, wordErrorRate } from '../support/wer';

test.use({ fakeAudio: 'drafts-session.wav' });

const MAX_WER = 0.2;
const TIMING_TOLERANCE_MS = 1000;
const REFERENCE = fixtureReference('drafts-session');
const CLIPS = fixtureTiming('drafts-session')!;

function checkRun(segs: EventOf<'transcript_segment'>[], offsetMs: number, label: string) {
  expect(segs.length, label).toBeGreaterThan(0);
  for (const s of segs) expect(s).toMatchObject({ engine: 'whisper', local: true, timestamp_quality: 'word' });
  const words = segs.flatMap((s) => s.words ?? []);
  const text = segs.map((s) => s.text).join(' ');
  const wer = wordErrorRate(REFERENCE, text);
  test.info().annotations.push({ type: label, description: `WER ${wer.toFixed(2)}: ${text}` });
  console.log(`[whisper-base ${label}] WER ${wer.toFixed(2)} over ${words.length} words: ${text}`);
  expect(wer, `${label}: ${text}`).toBeLessThanOrEqual(MAX_WER);
  const starts = words.map((w) => w.t);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  // Timing, independent of what was recognized: a word starts near each spoken clip, and every word starts
  // inside one. Ends are not checked: Whisper stretches a span's last word into the silence after it.
  for (const clip of CLIPS) {
    const start = offsetMs + clip.start * 1000;
    const nearest = Math.min(...words.map((w) => Math.abs(w.t - start)));
    expect(nearest, `"${clip.text}" at ${clip.start}s`).toBeLessThanOrEqual(TIMING_TOLERANCE_MS);
  }
  for (const w of words) {
    const inClip = CLIPS.some(
      (c) =>
        w.t >= offsetMs + c.start * 1000 - TIMING_TOLERANCE_MS && w.t <= offsetMs + c.end * 1000 + TIMING_TOLERANCE_MS,
    );
    expect(inClip, `"${w.text}" at ${w.t} ms starts outside every spoken clip`).toBe(true);
  }
}

test('whisper-base: download from the options page, live per-span transcription, and a re-transcription', async ({
  context,
  site,
  openExtensionPage,
  serviceWorker,
}) => {
  const options = await openExtensionPage('options.html');
  await options.getByTestId('engine-whisper').click();
  await expect(options.getByTestId('engine-whisper')).toBeChecked();
  await options.getByTestId('whisper-download-base').click();
  await expect(options.getByTestId('whisper-status-base').locator('progress')).toBeVisible({ timeout: 30_000 });
  await expect(options.getByTestId('whisper-base')).toHaveAttribute('data-downloaded', 'true', { timeout: 300_000 });
  await options.close();

  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel: Page = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const live = (await activeSessionId(serviceWorker))!;
  await panel.waitForTimeout(3000);
  expect(ofType(await sessionEvents(panel, live), 'transcription_fallback'), 'no fallback from Whisper').toEqual([]);
  await expect(panel.getByTestId('active-engine')).toHaveAttribute('data-engine', 'whisper', { timeout: 30_000 });
  // The clips end by ~20 s; Whisper captions follow each pause.
  await expect(panel.getByTestId('captions')).toContainText(/taller/i, { timeout: 45_000 });
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  const sessionId = new URL(review.url()).searchParams.get('session')!;

  const offset = await review.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>(
      (res) => (indexedDB.open('inkup').onsuccess = (e) => res((e.target as IDBOpenDBRequest).result)),
    );
    const row = await new Promise<{ audio: { start_offset_ms: number } }>(
      (res) =>
        (idb.transaction('sessions').objectStore('sessions').get(id).onsuccess = (e) =>
          res((e.target as IDBRequest).result)),
    );
    return row.audio.start_offset_ms;
  }, sessionId);
  let events = await sessionEvents(review, sessionId);
  expect(ofType(events, 'transcription_fallback')).toEqual([]);
  checkRun(ofType(events, 'transcript_segment'), offset, 'live');

  await review.getByTestId('retranscribe-engine').selectOption('whisper-base');
  await review.getByTestId('retranscribe').click();
  await expect(review.getByTestId('retranscribe-status')).toContainText('New transcript', { timeout: 180_000 });
  events = await sessionEvents(review, sessionId);
  const run = ofType(events, 'transcription_run')[0]!;
  expect(run).toMatchObject({ engine: 'whisper', model: 'onnx-community/whisper-base_timestamped', local: true });
  // Stop came right after the last clip, inside the fixture's first pass (39 s).
  const firstPass = ofType(events, 'transcript_segment').filter(
    (s) => s.run_id === run.run_id && s.t < offset + 30_000,
  );
  checkRun(firstPass, offset, 're-run');
  await expect(review.getByTestId('transcript-run')).toHaveAttribute('data-run-id', run.run_id);
});
