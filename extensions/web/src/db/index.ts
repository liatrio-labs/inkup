// IndexedDB via Dexie (docs/PLAN.md). One database on the chrome-extension:// origin, shared by the service
// worker, offscreen document, side panel and extension pages. Blobs never travel over messages: the offscreen
// document writes audio here and the service worker writes screenshots; pages read them back.

import type { ChangeItem } from '@inkup/core/process/change-item';
import type { CostEstimate } from '@inkup/core/process/cost';
import type { AudioMediaSchema, BlobKind, SessionInfo, VideoMediaSchema } from '@inkup/core/session-document';
import type { EventType, TimelineEvent } from '@inkup/core/timeline';
import Dexie, { type EntityTable } from 'dexie';
import type { z } from 'zod';
import type { CallRecord, ChunkProgress, ProcessErrorCode } from '@/adapters/llm/types';

export type AudioMedia = z.infer<typeof AudioMediaSchema>;
export type VideoMedia = z.infer<typeof VideoMediaSchema>;

export interface SessionRow extends SessionInfo {
  audio: AudioMedia | null;
  /** Absent on Sessions recorded before Slice 4. */
  video?: VideoMedia | null;
}

/** A timeline event as stored: `seq` is the append order, `session_id` the owning Session. */
export type EventRow = TimelineEvent & { seq?: number; session_id: string };

export interface BlobRow {
  id: string;
  session_id: string;
  kind: BlobKind;
  mime: string;
  size: number;
  /** ms since t0 when written. */
  t: number;
  /** Order of audio/video chunks. */
  seq: number;
  blob: Blob;
}

/**
 * One Process run (P0-11). Change Items are derived output that can be regenerated, not timeline facts, so
 * they live in their own table rather than in `events`. The review page shows the latest `done` run; a failed
 * run leaves earlier runs, the transcript and the Annotations untouched.
 */
export interface ProcessRunRow {
  id: string;
  session_id: string;
  /** Epoch ms. */
  created_at: number;
  finished_at: number | null;
  status: 'running' | 'done' | 'failed';
  model: string;
  estimate: CostEstimate | null;
  items: ChangeItem[] | null;
  calls: CallRecord[];
  second_pass: string[];
  /** Pinned Draft Items the model left out, added in code; absent before Slice 5. */
  pins_converted?: string[];
  /** Model items dropped as rewrites of a pinned Draft Item. */
  pins_dropped?: string[];
  /** Long Sessions (Slice 7): how many windows Process ran in; absent before Slice 7. */
  windows?: number;
  /** Items merged away as duplicates from a window's overlap. */
  duplicates_merged?: { kept: string; dropped: { window: number; id: string } }[];
  /** Annotations the model said no item comes from, with its reason. */
  dropped_annotations?: { annotation: number; reason: string }[];
  /** Live Annotations no item uses and the model did not list as dropped. */
  unaccounted_annotations?: number[];
  /** The recording went with the calls (video-grounded Process); absent before it existed. */
  video?: boolean;
  /** What the reviewer should know about how the run went, e.g. the recording was too large to send. */
  notes?: string[];
  error: string | null;
  /** `interrupted`: the service worker restarted while the run was going (swept on startup). */
  error_code: ProcessErrorCode | 'no_key' | 'busy' | 'interrupted' | null;
}

/**
 * One chunk of a running Process (feedback batch 1, U4): written as its items stream in, read by the review page's
 * in-progress cards, deleted when the run finishes. Scratch state, never exported.
 */
export interface ProcessProgressRow extends ChunkProgress {
  run_id: string;
  session_id: string;
  /** Epoch ms of the last write. */
  updated_at: number;
}

/**
 * Something the paired Host has not acknowledged yet (ADR 0004): an event (by its `events` seq), a blob (by id), or
 * a Session's Change Items (sent as they are when the row goes out: its latest run with the review edits applied).
 * Rows are written only while paired, in the same transaction as the event, and sent in `seq` order. The data
 * itself stays in `events`, `blobs` and `processRuns`; a row whose data was deleted meanwhile is skipped. A `discard`
 * row asks the Host to delete a Session the reviewer cancelled (E10); the Session's other rows are gone by then. A
 * `screenshot_discard` row asks it to delete a screenshot no Annotation uses (#22), which may have reached it already.
 */
export type OutboxRow = { seq?: number; session_id: string; created_at: number } & (
  | { kind: 'event'; event_seq: number }
  | { kind: 'blob'; blob_id: string }
  | { kind: 'items' }
  | { kind: 'discard' }
  | { kind: 'screenshot_discard'; blob_id: string }
);

/** What an agent (or the Host's user) did with a Change Item, pushed by the paired Host (ADR 0004). */
export interface ResolutionRow {
  /** The Host's resolution id. */
  id: string;
  session_id: string;
  run_id: string;
  item_id: string;
  /** `in_progress`: an agent started on it (MCP `start_item`) and has not resolved it yet. */
  status: 'in_progress' | 'resolved' | 'wont_fix' | 'needs_info';
  note: string;
  /** `mcp` (an agent) or `host` (the Host's user). */
  source: string;
  /** The agent's MCP client name, when an agent sent it. */
  agent?: string;
  /** Epoch ms. */
  created_at: number;
}

export class ReviewDatabase extends Dexie {
  sessions!: EntityTable<SessionRow, 'id'>;
  events!: EntityTable<EventRow, 'seq'>;
  blobs!: EntityTable<BlobRow, 'id'>;
  processRuns!: EntityTable<ProcessRunRow, 'id'>;
  processProgress!: Dexie.Table<ProcessProgressRow, [string, number]>;
  outbox!: EntityTable<OutboxRow, 'seq'>;
  resolutions!: EntityTable<ResolutionRow, 'id'>;

  constructor(name = 'inkup') {
    super(name);
    this.version(1).stores({
      sessions: 'id, started_at',
      events: '++seq, session_id, [session_id+type], [session_id+t]',
      blobs: 'id, session_id, [session_id+kind]',
    });
    this.version(2).stores({ processRuns: 'id, session_id, [session_id+created_at]' });
    this.version(3).stores({ processProgress: '[run_id+chunk], run_id' });
    this.version(4).stores({ outbox: '++seq, session_id' });
    this.version(5).stores({ resolutions: 'id, session_id, run_id' });
  }

  /** Latest run for a Session, optionally only with a given status. */
  async latestRun(sessionId: string, status?: ProcessRunRow['status']): Promise<ProcessRunRow | undefined> {
    const runs = await this.processRuns
      .where('[session_id+created_at]')
      .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
      .reverse()
      .toArray();
    return status ? runs.find((r) => r.status === status) : runs[0];
  }

  eventsOfType<T extends EventType>(sessionId: string, type: T) {
    return this.events.where('[session_id+type]').equals([sessionId, type]) as unknown as Dexie.Collection<
      Extract<EventRow, { type: T }>,
      number
    >;
  }
}

export const db = new ReviewDatabase();
