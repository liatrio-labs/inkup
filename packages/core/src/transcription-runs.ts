// Transcription runs (PRD P0-12 "re-transcribe with…", Slice 6).
//
// The live run is the transcript recorded during the Session: its segments have `run_id: null`. A
// re-transcription from the review page runs the stored audio through another engine's batch path and appends
// a new run: a `transcription_run` event plus segments with that `run_id`. The log stays append-only, so every
// run stays in session.json.
//
// Exactly one run is active: the latest `transcription_run` or `transcript_select` wins, and with neither it is
// the live run. The review page, Process, the second pass and review.md read only the active run
// (applyTranscriptEdits in review-edits.ts goes through activeTranscript first).
//
// Edits are scoped to the run they were made on: a `transcript_edit` names a segment_id, and every run has
// its own segment ids. Switching runs shows that run's edits; nothing carries over.
//
// Voice Commands were matched on the live run, and Process strips their phrases by segment_id. A re-run has
// other segment ids, so activeTranscript removes the words spoken inside each Voice Command's span instead.
//
// Speech dictated into a comment box (E11) is live segments with a `target`: it is that comment's text, never the
// Session transcript, so activeTranscript leaves it out; a re-run leaves out what was said inside those spans.
import { type MediaClock, mediaToSession } from './media-time.ts';
import type { EventOf, TimelineEvent } from './timeline.ts';

type Segment = EventOf<'transcript_segment'>;

/** The active run id: null for the live run. */
export function activeRunId(events: readonly TimelineEvent[]): string | null {
  let active: string | null = null;
  for (const e of events) {
    if (e.type === 'transcription_run') active = e.run_id;
    else if (e.type === 'transcript_select') active = e.run_id;
  }
  return active;
}

export interface RunSummary {
  run_id: string | null;
  engine: string;
  model: string | null;
  local: boolean | null;
  timestamp_quality: Segment['timestamp_quality'] | null;
  segment_count: number;
  created_at: string | null;
}

/** The live run and every re-transcription, in the order they were made. */
export function transcriptionRuns(events: readonly TimelineEvent[]): RunSummary[] {
  const live = events.filter((e): e is Segment => e.type === 'transcript_segment' && e.run_id === null);
  const first = live[0];
  const runs: RunSummary[] = [
    {
      run_id: null,
      engine: first?.engine ?? 'live',
      model: null,
      local: first?.local ?? null,
      timestamp_quality: first?.timestamp_quality ?? null,
      segment_count: live.length,
      created_at: null,
    },
  ];
  for (const e of events) {
    if (e.type !== 'transcription_run') continue;
    runs.push({
      run_id: e.run_id,
      engine: e.engine,
      model: e.model,
      local: e.local,
      timestamp_quality: e.timestamp_quality,
      segment_count: e.segment_count,
      created_at: e.created_at,
    });
  }
  return runs;
}

/** How far around a Voice Command's VAD span its words are cut from a re-run (VAD edges pad speech). */
export const COMMAND_CUT_PAD_MS = 250;

/**
 * The timeline with only the active run's segments. For a re-run, the words inside each Voice Command's span
 * are removed (segments left empty are dropped), so commands never reach Process as review content.
 */
export function activeTranscript<E extends TimelineEvent>(events: readonly E[]): E[] {
  const run = activeRunId(events);
  const commands =
    run === null
      ? []
      : events.filter((e): e is E & EventOf<'voice_command'> => e.type === 'voice_command' && e.segment_id !== null);
  const dictated =
    run === null
      ? []
      : events.filter((e): e is E & Segment => e.type === 'transcript_segment' && e.run_id === null && !!e.target);
  const mid = (x: { t: number; t_end: number }) => (x.t + x.t_end) / 2;
  const inDictation = (x: { t: number; t_end: number }) => dictated.some((d) => mid(x) >= d.t && mid(x) <= d.t_end);
  const out: E[] = [];
  for (const e of events) {
    if (e.type !== 'transcript_segment') {
      out.push(e);
      continue;
    }
    if ((e.run_id ?? null) !== run || e.target) continue;
    // A re-run without word timings: a segment whose middle lies in a dictated span goes as a whole.
    if (!e.words) {
      if (!inDictation(e)) out.push(e);
      continue;
    }
    if (commands.length === 0 && dictated.length === 0) {
      out.push(e);
      continue;
    }
    const inCommand = (w: { t: number; t_end: number }) =>
      commands.some((c) => mid(w) >= c.t - COMMAND_CUT_PAD_MS && mid(w) <= c.t_end + COMMAND_CUT_PAD_MS);
    const words = e.words.filter((w) => !inCommand(w) && !inDictation(w));
    if (words.length === e.words.length) out.push(e);
    else if (words.length > 0)
      out.push({
        ...e,
        words,
        text: joinWords(words.map((w) => w.text)),
        t: words[0]!.t,
        t_end: words.at(-1)!.t_end,
      } as E);
  }
  return out;
}

/** A word from a batch engine, in media time (ms into the audio file). */
export interface MediaWord {
  text: string;
  start_ms: number;
  end_ms: number;
}

/**
 * Joins word tokens into text: punctuation tokens attach to the word before them. Whitespace is collapsed first, so
 * the punctuation patterns match one space and stay linear however many a token holds.
 */
export function joinWords(words: readonly string[]): string {
  return words
    .map((w) => w.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.!?;:%)\]])/g, '$1')
    .replace(/([([]) /g, '$1');
}

/** A new sentence starts after a word ending in . ! or ?; a pause this long also splits. */
export const SEGMENT_GAP_MS = 800;
/** Segments are split at this length even mid-sentence, so captions and pairing stay local. */
export const SEGMENT_MAX_MS = 15_000;

/**
 * Groups batch words into segments the way the live engines finalize them: at a sentence end, at a pause of
 * SEGMENT_GAP_MS or more, or when a segment reaches SEGMENT_MAX_MS. Engines that return their own utterances
 * (Deepgram's `utterances`) pass them as groups instead.
 */
export function groupWords(words: readonly MediaWord[], gapMs = SEGMENT_GAP_MS, maxMs = SEGMENT_MAX_MS): MediaWord[][] {
  const groups: MediaWord[][] = [];
  let cur: MediaWord[] = [];
  for (const w of words) {
    if (!w.text.trim()) continue;
    const prev = cur.at(-1);
    if (
      prev &&
      (w.start_ms - prev.end_ms >= gapMs ||
        /[.!?]["')\]]?$/.test(prev.text.trim()) ||
        w.end_ms - cur[0]!.start_ms > maxMs)
    ) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export interface RunInput {
  run_id: string;
  engine: string;
  model: string;
  local: boolean;
  /** Word groups in media time (see groupWords). */
  groups: readonly MediaWord[][];
  /** The audio recording's clock: its start offset and the Session's pause gaps (media-time.ts). */
  clock: MediaClock;
  /** Session duration: stamps the run event, like the review edits. */
  duration_ms: number;
  created_at: string;
  /** New segment ids (injectable for tests). */
  newId?: () => string;
}

type NewSegment = Omit<Segment, 'id'>;
type NewRun = Omit<EventOf<'transcription_run'>, 'id'>;

/**
 * The events of a re-transcription: its segments on the Session clock, then the run event. Media time maps
 * to Session time through the pause gaps (mediaToSession), the same mapping the review player uses, so a word
 * lands where the live capture heard it. Words stay monotonic: a word never starts before the one before it.
 */
export function buildRunEvents(input: RunInput): { segments: NewSegment[]; run: NewRun } {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const toSession = (ms: number) => Math.round(mediaToSession(Math.max(0, ms), input.clock));
  let last = 0;
  const segments: NewSegment[] = [];
  for (const group of input.groups) {
    const words = group
      .filter((w) => w.text.trim())
      .map((w) => {
        const t = Math.max(last, toSession(w.start_ms));
        // An end inside a pause maps to the pause start: never before the word's own start.
        const t_end = Math.max(t, toSession(w.end_ms));
        last = t;
        return { text: w.text.trim(), t, t_end };
      });
    if (words.length === 0) continue;
    segments.push({
      type: 'transcript_segment',
      segment_id: newId(),
      t: words[0]!.t,
      t_end: Math.max(...words.map((w) => w.t_end)),
      text: joinWords(words.map((w) => w.text)),
      engine: input.engine,
      local: input.local,
      timestamp_quality: 'word',
      words,
      confidence: null,
      run_id: input.run_id,
      target: null,
    });
  }
  return {
    segments,
    run: {
      type: 'transcription_run',
      t: input.duration_ms,
      run_id: input.run_id,
      engine: input.engine,
      local: input.local,
      timestamp_quality: 'word',
      model: input.model,
      segment_count: segments.length,
      created_at: input.created_at,
    },
  };
}
