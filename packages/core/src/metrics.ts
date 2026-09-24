// PRD §8 success metrics, computed from session.json files alone (`pnpm metrics <dir>`). Pure.
//
// - Item acceptance rate: Change Items exported without an edit ÷ items generated, over the latest successful
//   Process of each Session (process_run.acceptance).
// - Draft Item discard rate: discarded ÷ Draft Items shown (packages/core/src/drafts.ts).
// - Sessions per week, over the span the files cover.
// - Voice Commands: how many, by command, and per 10 minutes of recording. The false-trigger rate needs labels, so it
//   is not computed here.
// - Processing failure rate: failed ÷ finished Process runs (process_runs, schema v7).
// - Free-tier share: Sessions whose audio never left the machine (no cloud engine live or in a re-transcription) and that used no Anthropic call (no Draft Items and no
//   Process run). A Session recorded with a key but never processed and without drafts counts as free: session.json
//   cannot tell a saved key that was never used from no key.
// - Start→recording latency: from the Start click (session_start.clicked_at, schema v7) to the audio recorder's
//   start, which includes the screen picker.

import { type DraftStats, draftStats } from './drafts.ts';
import type { SessionDocument } from './session-document.ts';
import type { EventOf } from './timeline.ts';

export interface SessionMetrics {
  session_id: string;
  started_at: string;
  duration_ms: number | null;
  free_tier: boolean;
  start_latency_ms: number | null;
  voice_commands: Record<string, number>;
  drafts: DraftStats;
  acceptance: { generated: number; unedited: number } | null;
  process_runs: { done: number; failed: number };
}

export function sessionMetrics(doc: SessionDocument): SessionMetrics {
  const start = doc.events.find((e): e is EventOf<'session_start'> => e.type === 'session_start');
  const audio = doc.media.audio;
  const start_latency_ms =
    start?.clicked_at != null && audio ? Math.max(0, doc.session.t0 + audio.start_offset_ms - start.clicked_at) : null;
  const voice_commands: Record<string, number> = {};
  for (const e of doc.events)
    if (e.type === 'voice_command') voice_commands[e.command] = (voice_commands[e.command] ?? 0) + 1;
  const drafts = draftStats(doc.events);
  const runs = doc.process_runs ?? [];
  const process_runs = {
    done: runs.filter((r) => r.status === 'done').length,
    failed: runs.filter((r) => r.status === 'failed').length,
  };
  // A v6 file has no process_runs: a processed one still shows its latest successful run.
  if (runs.length === 0 && doc.process_run) process_runs.done = 1;
  const remoteAudio =
    doc.session.transcription?.local === false ||
    doc.events.some((e) => (e.type === 'transcript_segment' || e.type === 'transcription_run') && e.local === false);
  const usedAnthropic = drafts.drafts > 0 || process_runs.done + process_runs.failed > 0;
  return {
    session_id: doc.session.id,
    started_at: doc.session.started_at,
    duration_ms: doc.session.duration_ms,
    free_tier: !remoteAudio && !usedAnthropic,
    start_latency_ms,
    voice_commands,
    drafts,
    acceptance: doc.process_run
      ? { generated: doc.process_run.acceptance.generated, unedited: doc.process_run.acceptance.unedited }
      : null,
    process_runs,
  };
}

export interface MetricsReport {
  sessions: number;
  /** Sessions ÷ weeks from the first to the last Session's start (at least one week). */
  sessions_per_week: number | null;
  recorded_ms: number;
  item_acceptance: { generated: number; unedited: number; rate: number | null };
  draft_discard: { drafts: number; discarded: number; rate: number | null };
  voice_commands: { total: number; by_command: Record<string, number>; per_10_min: number | null };
  processing_failures: { runs: number; failed: number; rate: number | null };
  free_tier: { sessions: number; share: number | null };
  start_latency_ms: { n: number; median: number | null; p90: number | null; under_5s: number | null };
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

export function aggregateMetrics(list: readonly SessionMetrics[]): MetricsReport {
  const sum = (f: (m: SessionMetrics) => number) => list.reduce((n, m) => n + f(m), 0);
  const generated = sum((m) => m.acceptance?.generated ?? 0);
  const unedited = sum((m) => m.acceptance?.unedited ?? 0);
  const drafts = sum((m) => m.drafts.drafts);
  const discarded = sum((m) => m.drafts.discarded);
  const by_command: Record<string, number> = {};
  for (const m of list) for (const [k, v] of Object.entries(m.voice_commands)) by_command[k] = (by_command[k] ?? 0) + v;
  const total = Object.values(by_command).reduce((a, b) => a + b, 0);
  const recorded = sum((m) => m.duration_ms ?? 0);
  const runs = sum((m) => m.process_runs.done + m.process_runs.failed);
  const failed = sum((m) => m.process_runs.failed);
  const free = list.filter((m) => m.free_tier).length;
  const latencies = list
    .flatMap((m) => (m.start_latency_ms === null ? [] : [m.start_latency_ms]))
    .sort((a, b) => a - b);
  const starts = list.map((m) => Date.parse(m.started_at)).sort((a, b) => a - b);
  const weeks = starts.length ? Math.max(1, (starts.at(-1)! - starts[0]!) / (7 * 86_400_000)) : 0;
  return {
    sessions: list.length,
    sessions_per_week: weeks ? list.length / weeks : null,
    recorded_ms: recorded,
    item_acceptance: { generated, unedited, rate: ratio(unedited, generated) },
    draft_discard: { drafts, discarded, rate: ratio(discarded, drafts) },
    voice_commands: { total, by_command, per_10_min: recorded > 0 ? total / (recorded / 600_000) : null },
    processing_failures: { runs, failed, rate: ratio(failed, runs) },
    free_tier: { sessions: free, share: ratio(free, list.length) },
    start_latency_ms: {
      n: latencies.length,
      median: quantile(latencies, 0.5),
      p90: quantile(latencies, 0.9),
      under_5s: ratio(latencies.filter((l) => l < 5000).length, latencies.length),
    },
  };
}

const pct = (r: number | null) => (r === null ? 'n/a' : `${Math.round(r * 1000) / 10}%`);

/** The report as text, with the PRD §8 targets next to each number. */
export function formatMetrics(r: MetricsReport): string[] {
  const secs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
  const byCmd = Object.entries(r.voice_commands.by_command)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`)
    .join(', ');
  return [
    `Sessions ${r.sessions} · ${r.sessions_per_week === null ? 'n/a' : r.sessions_per_week.toFixed(1)} per week (target ≥ 3) · recorded ${Math.round(r.recorded_ms / 60_000)} min`,
    `Item acceptance rate ${pct(r.item_acceptance.rate)} (${r.item_acceptance.unedited}/${r.item_acceptance.generated} exported without edit; target ≥ 80%)`,
    `Draft Item discard rate ${pct(r.draft_discard.rate)} (${r.draft_discard.discarded}/${r.draft_discard.drafts}; target < 25%)`,
    `Voice Commands ${r.voice_commands.total}${byCmd ? ` (${byCmd})` : ''} · ${r.voice_commands.per_10_min === null ? 'n/a' : r.voice_commands.per_10_min.toFixed(2)} per 10 min`,
    `Processing failure rate ${pct(r.processing_failures.rate)} (${r.processing_failures.failed}/${r.processing_failures.runs} runs; target < 5%)`,
    `Free-tier share ${pct(r.free_tier.share)} (${r.free_tier.sessions}/${r.sessions} Sessions with no paid key used)`,
    `Start→recording median ${secs(r.start_latency_ms.median)}, p90 ${secs(r.start_latency_ms.p90)}, under 5 s ${pct(r.start_latency_ms.under_5s)} (${r.start_latency_ms.n} Sessions with a Start click recorded; target median < 5 s)`,
  ];
}
