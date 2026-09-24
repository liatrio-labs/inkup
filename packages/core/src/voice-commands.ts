// Voice Commands (PRD P0-8): spoken phrases, surrounded by silence, that the live transcript watcher acts on
// instead of treating as review content.
//
// Matching, per transcript segment:
// 1. Normalize: words lower-cased, punctuation dropped, numerals spelled out (compromise), fillers ("um",
//    "okay") skipped.
// 2. Slide a window of the phrase's length over the words; score each window with fuzzball's token_set_ratio.
//    Below the threshold, a double-metaphone fallback accepts windows whose words all sound like the phrase's
//    ("paws" for "pause").
// 3. Silence gate: the phrase counts only when the voice activity detector shows silence of at least
//    MIN_SILENCE_MS right before and right after it. The phrase's audio is the "island" of speech the VAD saw:
//    speech spans joined across gaps shorter than MIN_SILENCE_MS.
//    - Word-level engines: the island must start and end within EDGE_TOLERANCE_MS of the phrase's words.
//    - Approximate engines (Web Speech): there are no word times. The phrase must be the whole segment (Web
//      Speech ends a result at a pause, so a command said between silences arrives as its own result), the
//      island must be the one that ended just before the segment arrived, and it must be short enough for the
//      phrase.
//    The decision waits until MIN_SILENCE_MS of silence has passed after the island (or speech resumes, which
//    rejects it), so a command takes effect about a second after it is spoken.

import nlp from 'compromise';
import { doubleMetaphone } from 'double-metaphone';
import { token_set_ratio } from 'fuzzball';
import type { TimestampQuality } from './timeline.ts';

export type VoiceCommand = 'scratch_that' | 'next' | 'pin_that' | 'snap' | 'pause' | 'resume';

export const COMMAND_PHRASES: Record<VoiceCommand, readonly string[]> = {
  scratch_that: ['scratch that'],
  next: ['next', 'new note'],
  pin_that: ['pin that'],
  snap: ['snap'],
  pause: ['pause'],
  resume: ['resume'],
};

/** Silence required on both sides (the PRD's "~1s"; 800 ms tolerates VAD edge padding). */
export const MIN_SILENCE_MS = 800;
export const FUZZY_THRESHOLD = 85;
/** Word-level: how far the VAD island may extend past the phrase's words. */
export const EDGE_TOLERANCE_MS = 350;
/** Approximate: the island must end no earlier than this before the segment's first interim result. */
export const ARRIVAL_LEAD_MS = 1500;
/** VAD edges arrive a little after the audio; the decision waits this much longer. */
export const DECISION_MARGIN_MS = 250;
/** A pending phrase that is still undecided after this long is dropped. */
export const PENDING_TIMEOUT_MS = 8000;
const FILLERS = new Set(['um', 'uh', 'umm', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'okay', 'ok', 'please']);

/** Longest island a phrase of `words` words may take (a short command said slowly). */
export const maxPhraseMs = (words: number) => 700 + 600 * words;

export interface Token {
  /** Normalized word. */
  norm: string;
  /** Character range in the original text. */
  start: number;
  end: number;
  /** Index of the source word (the words array for word-level segments). */
  word: number;
}

function spellNumber(word: string): string[] {
  if (!/\d/.test(word)) return [word];
  const doc = nlp(word);
  doc.numbers().toText();
  return doc
    .text()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Normalized tokens with their source positions. Fillers are dropped. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let word = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)) {
    const base = m[0].toLowerCase().replace(/’/g, "'");
    for (const norm of spellNumber(base))
      if (!FILLERS.has(norm)) out.push({ norm, start: m.index, end: m.index + m[0].length, word });
    word++;
  }
  return out;
}

const PHRASES = (Object.entries(COMMAND_PHRASES) as [VoiceCommand, readonly string[]][]).flatMap(([command, ps]) =>
  ps.map((p) => ({ command, phrase: p, tokens: p.split(' ') })),
);

const codes = (w: string) => new Set(doubleMetaphone(w).filter(Boolean));
const soundsLike = (a: string, b: string) => {
  if (a.length < 2 || b.length < 2) return a === b;
  const cb = codes(b);
  return [...codes(a)].some((c) => cb.has(c));
};

export interface CommandMatch {
  command: VoiceCommand;
  /** The phrase as it appears in the text (for stripping it from the transcript). */
  phrase: string;
  /** Token range [first, last] in tokenize(text). */
  first: number;
  last: number;
  score: number;
  via: 'fuzzy' | 'phonetic';
  /** The window is every non-filler word of the text. */
  whole: boolean;
}

function scoreWindow(
  win: readonly Token[],
  p: (typeof PHRASES)[number],
): { score: number; via: CommandMatch['via'] } | null {
  const score = token_set_ratio(win.map((t) => t.norm).join(' '), p.phrase);
  if (score >= FUZZY_THRESHOLD) return { score, via: 'fuzzy' };
  if (win.every((t, j) => soundsLike(t.norm, p.tokens[j]!))) return { score: FUZZY_THRESHOLD - 5, via: 'phonetic' };
  return null;
}

/**
 * Every command phrase in `text` (overlaps resolved by score, then by the longer phrase), in text order.
 * Silence is checked separately.
 */
export function findCommands(text: string, tokens: readonly Token[] = tokenize(text)): CommandMatch[] {
  const all: CommandMatch[] = [];
  for (const p of PHRASES) {
    const k = p.tokens.length;
    for (let i = 0; i + k <= tokens.length; i++) {
      const win = tokens.slice(i, i + k);
      const s = scoreWindow(win, p);
      if (s)
        all.push({
          command: p.command,
          phrase: text.slice(win[0]!.start, win[k - 1]!.end),
          first: i,
          last: i + k - 1,
          ...s,
          whole: k === tokens.length,
        });
    }
  }
  all.sort((a, b) => b.score - a.score || b.last - b.first - (a.last - a.first) || a.first - b.first);
  const kept: CommandMatch[] = [];
  for (const m of all) if (!kept.some((k) => m.first <= k.last && k.first <= m.last)) kept.push(m);
  return kept.sort((a, b) => a.first - b.first);
}

/** Best command phrase in `text`, or null. */
export function matchCommand(text: string): CommandMatch | null {
  return findCommands(text).reduce<CommandMatch | null>((best, m) => (!best || m.score > best.score ? m : best), null);
}

/** Tokens of a word-level segment, keyed to its words (index = position in `words`). */
export function tokenizeWords(words: readonly { text: string }[]): { text: string; tokens: Token[] } {
  let text = '';
  const tokens: Token[] = [];
  words.forEach((w, i) => {
    if (text) text += ' ';
    for (const t of tokenize(w.text))
      tokens.push({ ...t, start: t.start + text.length, end: t.end + text.length, word: i });
    text += w.text;
  });
  return { text, tokens };
}

// ---- The silence gate -------------------------------------------------------------------------------------

export interface Span {
  t: number;
  t_end: number;
}

export interface WatchedSegment {
  segment_id: string | null;
  text: string;
  t: number;
  t_end: number;
  timestamp_quality: TimestampQuality;
  words: { text: string; t: number; t_end: number }[] | null;
}

export interface CommandHit {
  command: VoiceCommand;
  phrase: string;
  segment_id: string | null;
  /** The island of speech that carried the phrase. */
  t: number;
  t_end: number;
  via: CommandMatch['via'];
  score: number;
}

export type ActivityInput =
  | { type: 'ready'; t: number }
  | { type: 'speech_start'; t: number }
  | { type: 'speech_end'; t: number; start: number };

export interface CommandWatcher {
  /** VAD output: `ready` when frames start arriving, then speech edges. */
  activity(edge: ActivityInput): void;
  /** A final transcript segment. Returns the match when it is now waiting on the silence gate. */
  segment(seg: WatchedSegment): CommandMatch | null;
  /** Decides pending phrases at Session time `now`. */
  tick(now: number): { confirmed: CommandHit[]; rejected: { phrase: string; reason: string }[] };
  readonly pending: number;
}

interface Pending {
  seg: WatchedSegment;
  match: CommandMatch;
  /** Word-level phrase span; null for approximate segments. */
  words: Span | null;
  since: number;
}

export function createCommandWatcher({ minSilenceMs = MIN_SILENCE_MS } = {}): CommandWatcher {
  let readyAt: number | null = null;
  const spans: Span[] = [];
  let speakingSince: number | null = null;
  let pending: Pending[] = [];

  /** Speech spans so far, the open one ending at `now`. */
  const allSpans = (now: number): Span[] =>
    speakingSince === null ? spans : [...spans, { t: speakingSince, t_end: Math.max(now, speakingSince) }];

  /** Islands: spans joined across gaps shorter than minSilenceMs. */
  function islands(now: number): (Span & { open: boolean })[] {
    const out: (Span & { open: boolean })[] = [];
    for (const s of allSpans(now)) {
      const last = out.at(-1);
      const open = speakingSince !== null && s.t === speakingSince;
      if (last && s.t - last.t_end < minSilenceMs) {
        last.t_end = Math.max(last.t_end, s.t_end);
        last.open ||= open;
      } else out.push({ ...s, open });
    }
    return out;
  }

  function evaluate(p: Pending, now: number): 'wait' | { reject: string } | { confirm: Span } {
    if (readyAt === null) return { reject: 'no voice activity data' };
    const isl = islands(now);
    let island: (Span & { open: boolean }) | undefined;
    if (p.words) {
      island = isl.find((i) => i.t <= p.words!.t_end + EDGE_TOLERANCE_MS && i.t_end >= p.words!.t - EDGE_TOLERANCE_MS);
      if (!island) return now - p.since > 1500 ? { reject: 'no speech under the phrase' } : 'wait';
      if (island.t < p.words.t - EDGE_TOLERANCE_MS) return { reject: 'speech right before the phrase' };
      if (!island.open && island.t_end > p.words.t_end + EDGE_TOLERANCE_MS)
        return { reject: 'speech right after the phrase' };
    } else {
      // Approximate timing: the island that ended last before the segment arrived.
      const cands = isl.filter((i) => i.t <= p.seg.t_end && i.t_end >= p.seg.t - ARRIVAL_LEAD_MS);
      island = cands.at(-1);
      if (!island) return { reject: 'no speech before the segment' };
      if (island.t_end - island.t > maxPhraseMs(p.match.last - p.match.first + 1))
        return { reject: 'speech too long for the phrase' };
    }
    if (island.t - readyAt < minSilenceMs) return { reject: 'no silence observed before the phrase' };
    if (island.open) return now - p.since > PENDING_TIMEOUT_MS ? { reject: 'speech did not stop' } : 'wait';
    // Silence after: no later island may start within minSilenceMs (islands are already that far apart, so any
    // later island qualifies); wait until that much silence has passed.
    if (now < island.t_end + minSilenceMs + DECISION_MARGIN_MS) return 'wait';
    return { confirm: { t: island.t, t_end: island.t_end } };
  }

  return {
    get pending() {
      return pending.length;
    },
    activity(edge) {
      if (edge.type === 'ready') readyAt ??= edge.t;
      else if (edge.type === 'speech_start') speakingSince = edge.t;
      else {
        speakingSince = null;
        spans.push({ t: edge.start, t_end: edge.t });
        // Keep a minute of history.
        while (spans.length > 0 && spans[0]!.t_end < edge.t - 60_000) spans.shift();
      }
    },
    segment(seg) {
      if (seg.words && seg.words.length > 0) {
        const { text, tokens } = tokenizeWords(seg.words);
        const matches = findCommands(text, tokens);
        for (const match of matches) {
          const words = {
            t: seg.words[tokens[match.first]!.word]!.t,
            t_end: seg.words[tokens[match.last]!.word]!.t_end,
          };
          pending.push({ seg, match, words, since: seg.t_end });
        }
        return matches[0] ?? null;
      }
      // Without word times the phrase must be the whole segment.
      const match = findCommands(seg.text).find((m) => m.whole) ?? null;
      if (match) pending.push({ seg, match, words: null, since: seg.t_end });
      return match;
    },
    tick(now) {
      const confirmed: CommandHit[] = [];
      const rejected: { phrase: string; reason: string }[] = [];
      pending = pending.filter((p) => {
        const r = evaluate(p, now);
        if (r === 'wait') return true;
        if ('reject' in r) rejected.push({ phrase: p.match.phrase, reason: r.reject });
        else
          confirmed.push({
            command: p.match.command,
            phrase: p.match.phrase,
            segment_id: p.seg.segment_id,
            ...r.confirm,
            via: p.match.via,
            score: p.match.score,
          });
        return false;
      });
      return { confirmed, rejected };
    },
  };
}
