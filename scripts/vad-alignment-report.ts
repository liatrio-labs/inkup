// `node scripts/vad-alignment-report.ts [file…]`: how VAD alignment (packages/core/src/process/align.ts) moves each
// approximate transcript segment of a Session, and which Annotations its demonstratives pair with before and after.
// Reads session.json exports or the trimmed fixtures in fixtures/vad-alignment (both have `events`); with no file, the
// fixtures. Prints a Markdown table per Session.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignSegments, type ProcessSegment } from '../packages/core/src/process/align.ts';
import { nearAny, pairSegment, referredBack, segmentQuality } from '../packages/core/src/process/pairing.ts';
import type { TimelineEvent } from '../packages/core/src/timeline.ts';

export const VAD_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vad-alignment');

export interface AlignmentRow {
  text: string;
  arrived: [number, number];
  /** Null: no VAD speech explains it; it keeps its times. */
  aligned: [number, number] | null;
  /** Each anchor (a demonstrative, or the whole segment) with the Annotations near it, nearest first. */
  before: string;
  after: string;
}

type Annotation = { index: number; t: number; t_end: number };

/** Each segment's pairing hints, as the script gives them: a word that refers back ("that", "it") with no mark near
 * names what the speech before it pointed at. */
function pairLabels(segments: readonly ProcessSegment[], annotations: readonly Annotation[]): string[] {
  let previous: number[] = [];
  return segments.map((seg) => {
    const pairs = pairSegment(seg, annotations, segmentQuality(seg));
    const label = pairs
      .map((p) => {
        const back = referredBack(p, previous);
        const near = p.annotations.map((i) => `#${i}`).join(' ') || '–';
        return `${p.anchor.word ? `"${p.anchor.word}" ` : ''}${near}${back ? ` (refers back: ${back.map((i) => `#${i}`).join(' ')})` : ''}`;
      })
      .join('; ');
    const near = nearAny(pairs);
    if (near.length) previous = near;
    return label;
  });
}

export function alignmentRows(events: readonly TimelineEvent[]): AlignmentRow[] {
  const annotations = events.filter((e) => e.type === 'annotation') as unknown as Annotation[];
  const raw = events.filter((e): e is ProcessSegment => e.type === 'transcript_segment');
  const aligned = alignSegments(events).filter((e): e is ProcessSegment => e.type === 'transcript_segment');
  const before = pairLabels(raw, annotations);
  const after = pairLabels(aligned, annotations);
  return raw.map((seg, i) => ({
    text: seg.text,
    arrived: [seg.t, seg.t_end],
    aligned: aligned[i]!.vad ? [aligned[i]!.t, aligned[i]!.t_end] : null,
    before: before[i]!,
    after: after[i]!,
  }));
}

const secs = ([a, b]: [number, number]) => `${(a / 1000).toFixed(1)}–${(b / 1000).toFixed(1)}`;

export function alignmentTable(rows: readonly AlignmentRow[]): string {
  const cut = (s: string) => (s.length > 48 ? `${s.slice(0, 47)}…` : s);
  return [
    '| # | speech | stamped (s) | VAD-aligned (s) | pairs before | pairs after |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${cut(r.text)} | ${secs(r.arrived)} | ${r.aligned ? secs(r.aligned) : 'unchanged'} | ${r.before} | ${r.after}${r.after === r.before ? '' : ' ◀'} |`,
    ),
  ].join('\n');
}

export const loadEvents = (file: string): TimelineEvent[] =>
  (JSON.parse(readFileSync(file, 'utf8')) as { events: TimelineEvent[] }).events;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : readdirSync(VAD_FIXTURES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(VAD_FIXTURES_DIR, f));
  for (const file of files) {
    const rows = alignmentRows(loadEvents(file));
    const moved = rows.filter((r) => r.aligned);
    const lead = moved.map((r) => r.arrived[0] - r.aligned![0]).sort((a, b) => a - b);
    console.log(`\n### ${file.split('/').pop()}\n`);
    console.log(
      `${moved.length} of ${rows.length} segments aligned; start moved earlier by ${lead.length ? `${lead[0]}–${lead.at(-1)} ms (median ${lead[Math.floor(lead.length / 2)]})` : '–'}; pairing changed for ${rows.filter((r) => r.before !== r.after).length}.\n`,
    );
    console.log(alignmentTable(rows));
  }
}
