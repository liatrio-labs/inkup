// Slice 3 proof (docs/PLAN.md): Voice Commands through the real offscreen VAD. The fake mic plays
// fixtures/audio/voice-session.wav, and the scripted transcript replays its clips (voice-session.timing.json)
// the way Web Speech would: each as its own result, arriving shortly after the speech ends. The silences the
// VAD measures are therefore real.
//
//   [2.0]  "this button"          (the reviewer circles the CTA meanwhile)
//   [4.2]  "scratch that"         between silences: discards that Annotation
//   [7.0]  "the video should" "pause" "here when it loads"
//                                 continuous speech, split into three results: "pause" must NOT pause
//   [10.8] "pause"                between silences: pauses; the toast's Undo resumes
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { buildProcessPrompt } from '../../packages/core/src/process/script.ts';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import { AUDIO_DIR, expect, grantMic, test, useScript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'voice-session.wav' });

/** Web Speech-like arrival: a result lands ~0.6 s after its speech ends, stamped from its first interim (~0.3 s in). */
const ARRIVAL_MS = 600;
const clips = JSON.parse(readFileSync(join(AUDIO_DIR, 'voice-session.timing.json'), 'utf8')) as {
  start: number;
  end: number;
  text: string;
}[];
const script = {
  timestamp_quality: 'approximate' as const,
  cues: clips.map((c) => ({
    at_ms: Math.round(c.end * 1000) + ARRIVAL_MS,
    duration_ms: Math.round((c.end - c.start) * 1000) + ARRIVAL_MS - 300,
    text: c.text,
  })),
};

test('scratch that discards the Annotation; "pause" inside speech does not pause; "pause" between silences does, and Undo resumes', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  await useScript(serviceWorker, script);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.setViewportSize({ width: 1280, height: 720 });
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');

  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const sessionId = (await activeSessionId(serviceWorker))!;

  // The note that "scratch that" takes back. Drawn straight away: the audio runs on the Session clock, and
  // "scratch that" lands at about 4.8 s whatever the test is doing. On a 2-CPU runner the watcher took 2.6 s to
  // load and the circle 2.3 s, so drawing after the watcher was ready put the command inside the Stroke.
  await panel.getByTestId('draw-toggle').click();
  await pricing.bringToFront();
  await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
  await expect(panel.getByTestId('voice-commands')).toContainText('say "scratch that"', { timeout: 10_000 });
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  // scratch that: the count drops back to 0 and the voice_command names that Annotation.
  await expect(panel.getByTestId('annotation-count')).toHaveText('0', { timeout: 15_000 });
  // No key, so the panel lists Annotation cards: the scratched one stays, dimmed (PRD P0-10).
  await expect(panel.getByTestId('annotation-card')).toHaveAttribute('data-discarded', 'true');

  // The isolated "pause" pauses the Session and offers Undo for 2 s.
  await expect(panel.getByTestId('status')).toHaveText('Paused', { timeout: 15_000 });
  const undo = panel.getByRole('button', { name: 'Undo' });
  await expect(panel.getByText('Paused by voice')).toBeVisible();
  await undo.click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');

  const events = await sessionEvents(panel, sessionId);
  const segments = ofType(events, 'transcript_segment');
  const commands = ofType(events, 'voice_command');
  const [annotation] = ofType(events, 'annotation');
  const segmentOf = (id: string | null) => segments.find((s) => s.segment_id === id)?.text;
  expect(commands.map((c) => [c.command, segmentOf(c.segment_id)])).toEqual([
    ['scratch_that', 'scratch that'],
    ['pause', 'pause'],
  ]);
  expect(commands[0]!.target).toEqual({ kind: 'annotation', id: annotation!.annotation_id });
  // The mid-sentence "pause" was transcribed like any other result, and ignored.
  const midSentence = segments.filter((s) => s.text === 'pause')[0]!;
  expect(commands[1]!.segment_id).not.toBe(midSentence.segment_id);
  // Each command's speech island is the clip's, measured by the VAD: silence on both sides. All four clips,
  // including "this button", which ends before the VAD has loaded on a slow runner: it hears the PCM from Start.
  const activity = ofType(events, 'speech_activity');
  expect(activity.length).toBeGreaterThanOrEqual(4);
  const pause = ofType(events, 'session_pause');
  const resume = ofType(events, 'session_resume');
  expect(pause).toEqual([expect.objectContaining({ via: 'voice' })]);
  expect(resume).toEqual([expect.objectContaining({ via: 'button' })]);
  expect(resume[0]!.gap_ms).toBeGreaterThan(0);
  expect(resume[0]!.gap_ms).toBeLessThan(2500);
  await test.info().attach('events.json', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });

  // Stop, then the Process script: the command phrases are gone from the speech and the Annotation is marked.
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await expect(review.getByTestId('annotation')).toHaveAttribute('data-discarded', 'true');
  const doc = SessionDocumentSchema.parse(await downloadDoc(review, serviceWorker, sessionId));
  const { script: text } = buildProcessPrompt(doc);
  expect(text).toMatch(/ANNOTATION #1 .* DISCARDED by the reviewer/);
  expect(text).toMatch(/VOICE COMMAND scratch that → discarded Annotation #1/);
  expect(text).not.toMatch(/SPEECH "scratch that"/);
  expect(text).toContain('SPEECH "pause"'); // the mid-sentence one stays content
  expect(text.match(/SPEECH "pause"/g)).toHaveLength(1);
  expect(text).toMatch(/\] PAUSE\n.*\] RESUME/);
});

/** session.json as the review page builds it (the same code as "Download session.json"). */
async function downloadDoc(review: Page, sw: Worker, sessionId: string): Promise<unknown> {
  await review.getByTestId('download-session').click();
  const id = Number(
    await review.evaluate(async () => {
      for (let i = 0; i < 50 && !document.body.dataset.downloadId; i++) await new Promise((r) => setTimeout(r, 100));
      return document.body.dataset.downloadId;
    }),
  );
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  const file = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  expect(doc.session.id).toBe(sessionId);
  return doc;
}
