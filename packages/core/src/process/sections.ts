// Budgeted sections (feedback batch 1, U4): Process cuts a Session into chunks at natural boundaries and sizes each
// chunk so its answer fits well inside the model's output cap. Pure, unit-tested in tests/unit/core/sections.test.ts.
//
// - Natural cuts: navigation, tab switch, pause and resume, the `next` Voice Command, an Annotation closing, and the
//   middle of a silence of at least SILENCE_MS between speech.
// - A cut never separates an Annotation from speech inside its pairing window (./pairing.ts): each Annotation and
//   the segments that could pair with it form a cluster, and a cut inside a cluster moves to the cluster's end. A cut
//   never falls inside a transcript segment either.
// - Sections (the spans between cuts) are packed into chunks. A Session up to SINGLE_WINDOW_MAX_MS whose estimated
//   answer fits the budget is one chunk. Otherwise the chunk count is the larger of round(length / TARGET_CHUNK_MS)
//   and ceil(estimate / budget), and each chunk boundary is the section boundary nearest an equal split. A chunk
//   still over the budget is split again at the boundary that best halves its estimate.
// - Budget: half the model's output cap (BUDGET_SHARE), so thinking and a pessimistic estimate still fit.
// - Chunks are ProcessWindows (./windows.ts): the overlap, ownership, prompt, coverage and merge rules stay the same.
import type { EventOf, TimelineEvent } from '../timeline.ts';
import { estimateOutputTokens } from './cost.ts';
import { gapMs, PAIRING_WINDOW_MS, segmentQuality } from './pairing.ts';
import { liveAnnotations, OVERLAP_MS, type ProcessWindow, SINGLE_WINDOW_MAX_MS } from './windows.ts';

/** A pause in speech this long is a natural place to cut. */
export const SILENCE_MS = 8_000;
/** Chunks aim for about this length, so a long Session streams in parts and runs two at a time. */
export const TARGET_CHUNK_MS = 10 * 60_000;
/** Share of the model's output cap a chunk's estimated answer may use. */
export const BUDGET_SHARE = 0.5;

export interface ChunkOptions {
  /** The model's output cap (max_tokens). */
  outputCap: number;
  overlapMs?: number;
  targetMs?: number;
  singleMaxMs?: number;
  silenceMs?: number;
}

export interface Section {
  start: number;
  /** Exclusive; the last section ends at the Session length. */
  end: number;
  annotations: number;
  segments: number;
}

const segmentsOf = (events: readonly TimelineEvent[]) =>
  events.filter((e): e is EventOf<'transcript_segment'> => e.type === 'transcript_segment');

interface Span {
  t: number;
  t_end: number;
}

/** Spans a cut must not fall strictly inside: each Annotation with its pairable speech, and each segment. */
function blockedSpans(events: readonly TimelineEvent[]): Span[] {
  const segments = segmentsOf(events);
  const spans: Span[] = segments.map((s) => ({ t: s.t, t_end: s.t_end }));
  for (const a of events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation')) {
    const paired = segments.filter((s) => gapMs(s, a) <= PAIRING_WINDOW_MS[segmentQuality(s)]);
    spans.push({
      t: Math.min(a.t, ...paired.map((s) => s.t)),
      t_end: Math.max(a.t_end, ...paired.map((s) => s.t_end)),
    });
  }
  // Merge overlapping spans into clusters, so moving a cut to a cluster's end lands on free time.
  spans.sort((x, y) => x.t - y.t);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s.t < last.t_end) last.t_end = Math.max(last.t_end, s.t_end);
    else merged.push({ ...s });
  }
  return merged;
}

/** Midpoints of silences of at least `silenceMs` between speech, with their length. */
function silences(events: readonly TimelineEvent[], silenceMs: number): { at: number; gap: number }[] {
  const speech = segmentsOf(events)
    .map((s) => ({ t: s.t, t_end: s.t_end }))
    .sort((a, b) => a.t - b.t);
  const out: { at: number; gap: number }[] = [];
  let end = -Infinity;
  for (const s of speech) {
    if (Number.isFinite(end) && s.t - end >= silenceMs)
      out.push({ at: Math.round(end + (s.t - end) / 2), gap: s.t - end });
    end = Math.max(end, s.t_end);
  }
  return out;
}

/** Moves a cut out of any blocked cluster to that cluster's end; null when that lands outside (0, length). */
function settle(at: number, blocked: readonly Span[], lengthMs: number): number | null {
  const inside = blocked.find((b) => at > b.t && at < b.t_end);
  const t = inside ? inside.t_end : at;
  return t > 0 && t < lengthMs ? t : null;
}

/** The natural cut times of a Session, sorted, unique, none inside an Annotation's pairing cluster or a segment. */
export function naturalCuts(events: readonly TimelineEvent[], lengthMs: number, silenceMs = SILENCE_MS): number[] {
  const blocked = blockedSpans(events);
  const raw: number[] = [];
  for (const e of events) {
    if (e.type === 'navigation' || e.type === 'tab_switch' || e.type === 'session_pause' || e.type === 'session_resume')
      raw.push(e.t);
    else if (e.type === 'voice_command' && e.command === 'next') raw.push(e.t);
    else if (e.type === 'annotation') raw.push(e.t_end);
  }
  for (const s of silences(events, silenceMs)) raw.push(s.at);
  const cuts = raw.map((t) => settle(t, blocked, lengthMs)).filter((t): t is number => t !== null);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

function countIn(events: readonly TimelineEvent[], start: number, end: number) {
  const live = liveAnnotations(events);
  return {
    annotations: live.filter((a) => a.t >= start && a.t < end).length,
    segments: segmentsOf(events).filter((s) => s.t >= start && s.t < end).length,
  };
}

export const sectionEstimate = (s: Pick<Section, 'annotations' | 'segments'>) =>
  estimateOutputTokens(s.annotations, s.segments);

/** The Session cut at every natural boundary. */
export function cutSections(events: readonly TimelineEvent[], lengthMs: number, silenceMs = SILENCE_MS): Section[] {
  const bounds = [0, ...naturalCuts(events, lengthMs, silenceMs), Math.max(lengthMs, 1)];
  const out: Section[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [start, end] = [bounds[i]!, bounds[i + 1]!];
    // The last section also owns anything stamped at or after the Session length.
    const s = { start, end, ...countIn(events, start, i + 2 === bounds.length ? Infinity : end) };
    const prev = out.at(-1);
    // A section with nothing in it would be an empty Process call: it joins the one before (or after, if first).
    if (prev && (s.annotations + s.segments === 0 || prev.annotations + prev.segments === 0))
      out[out.length - 1] = {
        start: prev.start,
        end,
        annotations: prev.annotations + s.annotations,
        segments: prev.segments + s.segments,
      };
    else out.push(s);
  }
  return out;
}

/** The chunk as a Process window: its core [start, end) plus the overlap shown for context. */
function toWindows(ranges: readonly { start: number; end: number }[], overlapMs: number): ProcessWindow[] {
  return ranges.map((r, index) => {
    const last = index === ranges.length - 1;
    return {
      index,
      count: ranges.length,
      start: index === 0 ? 0 : r.start,
      end: last ? Infinity : r.end,
      from: index === 0 ? 0 : Math.max(0, r.start - overlapMs),
      to: last ? Infinity : r.end + overlapMs,
    };
  });
}

const merge = (xs: readonly Section[]): Section => ({
  start: xs[0]!.start,
  end: xs.at(-1)!.end,
  annotations: xs.reduce((n, s) => n + s.annotations, 0),
  segments: xs.reduce((n, s) => n + s.segments, 0),
});

/** Index i such that splitting before sections[i] best halves the estimate; null for a single section. */
function halvingIndex(sections: readonly Section[]): number | null {
  if (sections.length < 2) return null;
  const total = sectionEstimate(merge(sections));
  let best = 1;
  let bestScore = Infinity;
  for (let i = 1; i < sections.length; i++) {
    const score =
      Math.abs(sectionEstimate(merge(sections.slice(0, i))) - total / 2) +
      Math.abs(sectionEstimate(merge(sections.slice(i))) - total / 2);
    if (score < bestScore) [best, bestScore] = [i, score];
  }
  return best;
}

/** A section cut at its largest internal silence (any length) that is a valid cut; null when there is none. */
function splitAtSilence(
  events: readonly TimelineEvent[],
  section: Section,
  lengthMs: number,
): [Section, Section] | null {
  const blocked = blockedSpans(events);
  const cuts = silences(events, 1)
    .map((x) => ({ ...x, at: settle(x.at, blocked, lengthMs) }))
    .filter((x): x is { at: number; gap: number } => x.at !== null && x.at > section.start && x.at < section.end)
    .sort((a, b) => b.gap - a.gap);
  const at = cuts[0]?.at;
  if (at === undefined) return null;
  return [
    { start: section.start, end: at, ...countIn(events, section.start, at) },
    { start: at, end: section.end, ...countIn(events, at, section.end) },
  ];
}

/** Splits a group of sections until each part's estimate fits the budget, or cannot be cut further. */
function fitBudget(
  events: readonly TimelineEvent[],
  group: readonly Section[],
  budget: number,
  lengthMs: number,
): Section[][] {
  if (sectionEstimate(merge(group)) <= budget) return [[...group]];
  const i = halvingIndex(group);
  if (i !== null)
    return [
      ...fitBudget(events, group.slice(0, i), budget, lengthMs),
      ...fitBudget(events, group.slice(i), budget, lengthMs),
    ];
  const halves = splitAtSilence(events, group[0]!, lengthMs);
  if (!halves) return [[...group]];
  return [...fitBudget(events, [halves[0]], budget, lengthMs), ...fitBudget(events, [halves[1]], budget, lengthMs)];
}

/**
 * Plans the Process chunks of a Session. Each chunk's estimated answer stays within BUDGET_SHARE of the output cap
 * unless a single section alone is larger (only the model's real answer can tell; see splitWindow).
 */
export function planChunks(events: readonly TimelineEvent[], lengthMs: number, opts: ChunkOptions): ProcessWindow[] {
  const overlapMs = opts.overlapMs ?? OVERLAP_MS;
  const targetMs = opts.targetMs ?? TARGET_CHUNK_MS;
  const singleMax = opts.singleMaxMs ?? SINGLE_WINDOW_MAX_MS;
  const budget = Math.floor(opts.outputCap * BUDGET_SHARE);
  const sections = cutSections(events, lengthMs, opts.silenceMs);
  const total = sectionEstimate(merge(sections));
  const length = Math.max(0, lengthMs);
  const byTime = length <= singleMax ? 1 : Math.max(2, Math.round(length / targetMs));
  const count = Math.max(byTime, Math.ceil(total / budget));
  // The section boundary nearest each equal split, in order; two splits may pick the same boundary (fewer chunks).
  const groups: Section[][] = [];
  let from = 0;
  for (let k = 1; k < count; k++) {
    const ideal = (k * length) / count;
    let best = -1;
    for (let i = Math.max(from + 1, 1); i < sections.length; i++) {
      if (best === -1 || Math.abs(sections[i]!.start - ideal) < Math.abs(sections[best]!.start - ideal)) best = i;
    }
    if (best === -1) break;
    groups.push(sections.slice(from, best));
    from = best;
  }
  groups.push(sections.slice(from));
  const fitted = groups.filter((g) => g.length > 0).flatMap((g) => fitBudget(events, g, budget, length));
  return toWindows(fitted.map(merge), overlapMs);
}

/**
 * A chunk that ran out of output tokens, cut in two at the natural boundary that best halves its estimate. Null when
 * the chunk has no natural boundary inside it. Indexes are placeholders; the caller renumbers every window.
 */
export function splitWindow(
  events: readonly TimelineEvent[],
  w: ProcessWindow,
  lengthMs: number,
  opts: Pick<ChunkOptions, 'overlapMs' | 'silenceMs'> = {},
): [ProcessWindow, ProcessWindow] | null {
  const overlapMs = opts.overlapMs ?? OVERLAP_MS;
  const end = w.end === Infinity ? Math.max(lengthMs, w.start + 1) : w.end;
  const inside = cutSections(events, lengthMs, opts.silenceMs)
    .filter((s) => s.start >= w.start && s.start < end)
    .map((s) => ({ ...s, end: Math.min(s.end, end) }));
  if (inside.length) inside[0] = { ...inside[0]!, start: w.start };
  const halves = halvingIndex(inside);
  let cut: number;
  if (halves !== null) cut = inside[halves]!.start;
  else {
    const byTime = inside.length === 1 ? splitAtSilence(events, inside[0]!, lengthMs) : null;
    if (!byTime) return null;
    cut = byTime[1].start;
  }
  const a: ProcessWindow = { ...w, count: Math.max(2, w.count), end: cut, to: cut + overlapMs };
  const b: ProcessWindow = { ...w, count: Math.max(2, w.count), start: cut, from: Math.max(0, cut - overlapMs) };
  return [a, b];
}

/** Numbers windows 0…n-1 in time order and sets their count. */
export function renumberWindows(ws: readonly ProcessWindow[]): ProcessWindow[] {
  const sorted = [...ws].sort((x, y) => x.start - y.start);
  return sorted.map((w, index) => ({ ...w, index, count: sorted.length }));
}
