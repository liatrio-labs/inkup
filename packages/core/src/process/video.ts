// Video-grounded Process: when the Process model takes video, the recorded tab video and the microphone audio go
// with each call as files. The model sees the page, the ink as it is drawn and the clicks, and hears the reviewer,
// so it can check the script against them. This module writes what the model needs to map what it sees and hears
// onto the script's timestamps: each file's start on the Session clock and the pauses the files have no gap for
// (../media-time.ts).
import { type MediaClock, mediaToSession, type PauseGap, pauseGaps, sessionToMedia } from '../media-time.ts';
import type { TimelineEvent } from '../timeline.ts';
import { stamp } from './script.ts';

/** One recording sent with a call. */
export interface MediaTrack {
  kind: 'video' | 'audio';
  /** The file part's name, e.g. video.webm. */
  filename: string;
  /** Recorder start, ms since t0. */
  start_offset_ms: number;
  /** Length of the file in ms, when known. */
  duration_ms: number | null;
}

/** The pieces of one file that play without a pause: file time [from, to) ↔ Session time from `session`. */
export function mediaPieces(
  track: Pick<MediaTrack, 'start_offset_ms' | 'duration_ms'>,
  gaps: readonly PauseGap[],
): { from: number; to: number | null; session: number }[] {
  const clock: MediaClock = { start_offset_ms: track.start_offset_ms, gaps };
  // File time where each pause cuts the file, in order.
  const cuts = [
    ...new Set(
      gaps
        .filter((g) => g.end !== Infinity && g.end > track.start_offset_ms)
        .map((g) => sessionToMedia(Math.max(g.start, track.start_offset_ms), clock)),
    ),
  ]
    .filter((m) => m > 0 && (track.duration_ms === null || m < track.duration_ms))
    .sort((a, b) => a - b);
  const starts = [0, ...cuts];
  return starts.map((from, i) => ({ from, to: cuts[i] ?? track.duration_ms, session: mediaToSession(from, clock) }));
}

/**
 * The prompt block that ties the attached files to the script: for each file, where it starts on the Session clock,
 * the pauses, and the file-time → Session-time pieces.
 */
export function mediaTimingBlock(tracks: readonly MediaTrack[], events: readonly TimelineEvent[]): string {
  const gaps = pauseGaps(events).filter((g) => g.end !== Infinity);
  const lines = ['MEDIA: the recording of this Session is attached as files.'];
  for (const t of tracks) {
    const what =
      t.kind === 'video'
        ? 'the reviewed browser tab, video only (no sound): the page, the pointer, and the red ink Strokes as they are drawn'
        : "the reviewer's microphone, audio only";
    lines.push(
      `- ${t.filename}: ${what}. It starts at Session time [${stamp(t.start_offset_ms)}] (start_offset_ms ${t.start_offset_ms})${t.duration_ms !== null ? ` and runs ${stamp(t.duration_ms)}` : ''}.`,
    );
    const pieces = mediaPieces(t, gaps);
    if (pieces.length > 1)
      for (const p of pieces)
        lines.push(
          `    file ${stamp(p.from)}–${p.to === null ? 'end' : stamp(p.to)} ↔ Session [${stamp(p.session)}]${p.to === null ? ' onward' : `–[${stamp(p.session + (p.to - p.from))}]`}`,
        );
  }
  lines.push(
    gaps.length
      ? `PAUSES (Session time): ${gaps.map((g) => `[${stamp(g.start)}]–[${stamp(g.end)}]`).join(', ')}. The files have no gap for a pause: they skip straight over it.`
      : 'PAUSES: none.',
    "RULE: media time t_m (seconds into a file) corresponds to Session time = the file's start + t_m + every pause that ended before that point in the file. Before the first pause that is simply start + t_m. Script timestamps and evidence.video are Session time.",
  );
  return lines.join('\n');
}

/** The system prompt's extra section when the recording is attached. */
export function videoSystemSection(): string {
  return `## Recording (attached)
The Session's recording is attached: the tab video and, when there is one, the microphone audio. The MEDIA block says where each file starts on the Session clock and how file time maps to Session time.
- Watch and listen. When the recording and the script disagree (a speech time, which element a Stroke circles, what a click opened, what the reviewer said), trust what you see and hear.
- The ink Strokes are visible in the video while they are drawn and stay until the page is cleared: use them to see exactly what each Annotation marks.
- Set evidence.video {start, end} from the footage, in seconds of Session time (convert file time with the MEDIA rule): when the reviewer starts talking about the item or starts drawing for it, to when they finish.
- Selectors still come from the script's Candidates: the video shows which element is meant, the script says how to select it.`;
}
