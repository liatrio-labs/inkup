// Slice 7: PRD §8 metrics from session.json files (packages/core/src/metrics.ts, `pnpm metrics`).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLongSession } from '../../../scripts/gen-long-session.ts';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { loadMetrics } from '../../../scripts/metrics.ts';
import { aggregateMetrics, formatMetrics, sessionMetrics } from '../src/metrics';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { TimelineEvent } from '../src/timeline';

const fixture = (name: string, quality: 'word' | 'approximate' = 'word'): SessionDocument =>
  SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile(name, quality), 'utf8')));

function withStart(doc: SessionDocument, latencyMs: number): SessionDocument {
  // The Process fixtures carry no media; give them an audio recording that started 150 ms after t0.
  const audio = doc.media.audio ?? {
    blob_id: `${doc.session.id}:audio`,
    mime: 'audio/webm;codecs=opus',
    start_offset_ms: 150,
    duration_ms: 10_000,
    chunk_count: 1,
    path: 'audio.webm',
  };
  const events = doc.events.map((e) =>
    e.type === 'session_start' ? { ...e, clicked_at: doc.session.t0 + audio.start_offset_ms - latencyMs } : e,
  );
  const blobs = doc.blobs.some((b) => b.id === audio.blob_id)
    ? doc.blobs
    : [...doc.blobs, { id: audio.blob_id, kind: 'audio' as const, mime: audio.mime, size: 1000, path: audio.path }];
  return { ...doc, media: { ...doc.media, audio }, blobs, events };
}

function processed(
  doc: SessionDocument,
  generated: number,
  unedited: number,
  runs: ('done' | 'failed')[],
): SessionDocument {
  return {
    ...doc,
    process_run: {
      id: 'r1',
      model: 'claude-sonnet-5',
      generated_items: [],
      acceptance: { generated, unedited, rate: unedited / generated },
      windows: 1,
      dropped_annotations: [],
      unaccounted_annotations: [],
    },
    process_runs: runs.map((status, i) => ({
      id: `r${i}`,
      status,
      model: 'claude-sonnet-5',
      created_at: '2026-09-01T10:00:00.000Z',
      error_code: status === 'failed' ? 'timeout' : null,
      windows: 1,
    })),
  };
}

describe('sessionMetrics', () => {
  it('a Session recorded on the local engine with no drafts or Process is free tier; latency comes from the Start click', () => {
    const doc = fixture('a-move-here');
    const m = sessionMetrics(doc);
    expect(m.free_tier).toBe(doc.session.transcription?.local !== false);
    expect(m.start_latency_ms).toBeNull(); // a v6-era fixture has no clicked_at
    expect(sessionMetrics(withStart(doc, 1800)).start_latency_ms).toBe(1800);
  });

  it('counts Voice Commands by command and Draft Items shown and discarded (the synthetic 40-minute Session)', () => {
    const { doc } = buildLongSession();
    const m = sessionMetrics(doc);
    const scratches = doc.events.filter((e) => e.type === 'voice_command' && e.command === 'scratch_that').length;
    expect(scratches).toBeGreaterThan(0);
    expect(m.voice_commands.scratch_that).toBe(scratches);
    expect(m.drafts).toMatchObject({ drafts: 3, pinned: 2, discarded: 1 });
    expect(m.free_tier).toBe(false); // Draft Items are Anthropic calls
  });

  it('a Session with a cloud re-transcription or a Process run is not free tier', () => {
    const doc = fixture('a-move-here');
    const run: TimelineEvent = {
      id: 'ev-run',
      type: 'transcription_run',
      t: 0,
      run_id: 'dg1',
      engine: 'deepgram',
      local: false,
      timestamp_quality: 'word',
      model: 'nova-3',
      segment_count: 0,
      created_at: '2026-09-01T10:00:00.000Z',
    };
    expect(sessionMetrics({ ...doc, events: [...doc.events, run] }).free_tier).toBe(false);
    const p = sessionMetrics(processed(doc, 4, 3, ['failed', 'done']));
    expect(p.free_tier).toBe(false);
    expect(p.process_runs).toEqual({ done: 1, failed: 1 });
    expect(p.acceptance).toEqual({ generated: 4, unedited: 3 });
  });
});

describe('aggregateMetrics', () => {
  it('rates over all Sessions, with n/a when there is nothing to rate', () => {
    const a = fixture('a-move-here');
    const b = fixture('b-same-height');
    const c = fixture('c-arrow-connector');
    const list = [
      sessionMetrics(withStart(processed(a, 4, 3, ['done']), 1200)),
      sessionMetrics(withStart(processed(b, 6, 6, ['failed', 'failed', 'done']), 7000)),
      sessionMetrics(withStart(c, 3000)),
      sessionMetrics(buildLongSession().doc),
    ];
    const r = aggregateMetrics(list);
    expect(r.sessions).toBe(4);
    expect(r.sessions_per_week).toBe(4); // all within a week
    expect(r.item_acceptance).toEqual({ generated: 10, unedited: 9, rate: 0.9 });
    expect(r.draft_discard).toEqual({ drafts: 3, discarded: 1, rate: 1 / 3 });
    expect(r.processing_failures).toEqual({ runs: 4, failed: 2, rate: 0.5 });
    expect(r.free_tier.sessions).toBe(list.filter((m) => m.free_tier).length);
    expect(r.free_tier.share).toBe(r.free_tier.sessions / 4);
    expect(r.start_latency_ms).toEqual({ n: 3, median: 3000, p90: 7000, under_5s: 2 / 3 });
    expect(r.voice_commands.total).toBeGreaterThan(0);
    expect(r.voice_commands.per_10_min).toBeCloseTo(r.voice_commands.total / (r.recorded_ms / 600_000));
    const text = formatMetrics(r).join('\n');
    expect(text).toContain('Item acceptance rate 90% (9/10');
    expect(text).toContain('Processing failure rate 50% (2/4 runs');
    expect(text).toContain('Start→recording median 3.0 s, p90 7.0 s');

    const empty = aggregateMetrics([]);
    expect(empty.item_acceptance.rate).toBeNull();
    expect(formatMetrics(empty).join('\n')).toContain('Item acceptance rate n/a');
  });
});

describe('pnpm metrics', () => {
  it('reads every session.json under a directory, skips other JSON, and counts a Session exported twice once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-'));
    const a = withStart(processed(fixture('a-move-here'), 4, 3, ['done']), 1200);
    writeFileSync(join(dir, 'one.session.json'), JSON.stringify(a));
    writeFileSync(join(dir, 'again.session.json'), JSON.stringify(a));
    const b = fixture('b-same-height', 'approximate'); // the fixtures share their captured Session's id
    writeFileSync(
      join(dir, 'two.session.json'),
      JSON.stringify({ ...b, session: { ...b.session, id: 'another-session' } }),
    );
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'broken.session.json'), JSON.stringify({ schema_version: 7, events: [{ type: 'nope' }] }));
    const { metrics, skipped } = loadMetrics([dir]);
    expect(metrics).toHaveLength(2);
    expect(skipped.map((s) => s.file)).toEqual([join(dir, 'broken.session.json')]);
    expect(aggregateMetrics(metrics).item_acceptance.generated).toBe(4);
  });
});
