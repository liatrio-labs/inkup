// session.json: the self-contained export of one Session (PRD P0-13), validated with Zod on build and in tests.
// Media and screenshots are referenced by blob id and by their path inside an export folder; the bytes live in
// the extension's IndexedDB `blobs` table (src/db) and the export zip (packages/core/src/export) carries them.
import { z } from 'zod';
import { type ChangeItem, ChangeItemSchema } from './process/change-item.ts';
import { acceptanceRate, applyItemEdits, itemEditsFor } from './review-edits.ts';
import {
  SCHEMA_VERSION,
  sortTimeline,
  type TimelineEvent,
  TimelineEventSchema,
  TranscriptionInfoSchema,
} from './timeline.ts';

export const BlobKind = z.enum(['screenshot', 'screenshot_crop', 'audio_chunk', 'audio', 'video_chunk', 'video']);
export type BlobKind = z.infer<typeof BlobKind>;

export const BlobRefSchema = z.object({
  id: z.string().min(1),
  kind: BlobKind,
  mime: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string().describe('path inside an export folder'),
});

export const AudioMediaSchema = z.object({
  blob_id: z.string().describe('the finalized, duration-fixed WebM/Opus recording'),
  mime: z.string(),
  start_offset_ms: z.number().int().nonnegative().describe('recorder start, ms since t0'),
  duration_ms: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative().describe('30s chunks persisted while recording'),
  path: z.string(),
});

export const VideoMediaSchema = z.object({
  blob_id: z.string().describe('the finalized WebM/VP8 or VP9 recording, made seekable (duration and cues)'),
  mime: z.string(),
  start_offset_ms: z
    .number()
    .int()
    .nonnegative()
    .describe('recorder start, ms since t0; pauses leave no gap in the file (packages/core/src/media-time.ts)'),
  duration_ms: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative().describe('chunks persisted while recording'),
  seekable: z.boolean().describe('true when ts-ebml wrote the duration and cues'),
  label: z.string().describe('what the reviewer picked in the screen picker, e.g. the tab title'),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  path: z.string(),
});

export const SessionInfoSchema = z.object({
  id: z.string().min(1),
  tab_id: z.number().int(),
  t0: z.number().int().nonnegative(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  start_url: z.string(),
  start_title: z.string(),
  status: z.enum(['recording', 'ended']),
  transcription: TranscriptionInfoSchema.nullable(),
  video_off_reason: z
    .enum(['picker_cancelled', 'unavailable', 'failed'])
    .nullable()
    .default(null)
    .describe(
      'why the Session has no video: the picker was cancelled, getDisplayMedia is missing, or recording failed',
    ),
  media_deleted_at: z.iso
    .datetime()
    .nullable()
    .default(null)
    .describe('set when the reviewer deleted the audio and video after an export'),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/** One Process run as session.json lists it (PRD §8: processing failure rate). */
export const ProcessRunSummarySchema = z.object({
  id: z.string().min(1),
  status: z.enum(['running', 'done', 'failed']),
  model: z.string(),
  created_at: z.iso.datetime(),
  error_code: z.string().nullable(),
  windows: z.number().int().positive().nullable(),
});

export const SessionDocumentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    generated_at: z.iso.datetime(),
    session: SessionInfoSchema,
    media: z.object({ audio: AudioMediaSchema.nullable(), video: VideoMediaSchema.nullable() }),
    blobs: z.array(BlobRefSchema),
    events: z.array(TimelineEventSchema),
    change_items: z
      .array(ChangeItemSchema)
      .optional()
      .describe(
        'the Change Items as reviewed: the latest successful Process with the review edits (item_edit events) applied, in review order; absent until Process ran',
      ),
    process_run: z
      .object({
        id: z.string().min(1),
        model: z.string(),
        generated_items: z.array(ChangeItemSchema).describe('what Process produced, before any review edit'),
        acceptance: z.object({
          generated: z.number().int().nonnegative(),
          unedited: z.number().int().nonnegative(),
          rate: z.number().min(0).max(1).nullable(),
        }),
        windows: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe('Process windows: 1 up to 12 minutes, then ~10-minute windows with overlap'),
        dropped_annotations: z
          .array(z.object({ annotation: z.number().int().positive(), reason: z.string() }))
          .default([])
          .describe('Annotations the model said no Change Item comes from, with its reason'),
        unaccounted_annotations: z
          .array(z.number().int().positive())
          .default([])
          .describe('live Annotations no item uses and the model did not list as dropped'),
      })
      .optional()
      .describe('the run change_items came from, for the acceptance rate (PRD §8)'),
    process_runs: z
      .array(ProcessRunSummarySchema)
      .default([])
      .describe(
        'every Process run of this Session, oldest first, failed ones included (PRD §8 processing failure rate)',
      ),
  })
  .superRefine((doc, ctx) => {
    // Referential integrity: what an Annotation or screenshot points at must exist in the document.
    const blobIds = new Set(doc.blobs.map((b) => b.id));
    const shots = new Set<string>();
    const strokes = new Set<string>();
    let lastT = -1;
    doc.events.forEach((e, i) => {
      if (e.t < lastT)
        ctx.addIssue({ code: 'custom', path: ['events', i, 't'], message: 'events must be sorted by t' });
      lastT = e.t;
      if (e.type === 'screenshot') {
        shots.add(e.screenshot_id);
        if (!blobIds.has(e.screenshot_id))
          ctx.addIssue({ code: 'custom', path: ['events', i, 'screenshot_id'], message: 'screenshot blob missing' });
      }
      if (e.type === 'stroke') strokes.add(e.stroke_id);
    });
    const segments = new Set(doc.events.flatMap((e) => (e.type === 'transcript_segment' ? [e.segment_id] : [])));
    // Re-transcribed segments belong to a recorded run; a selection names a run that exists (or the live one).
    const runs = new Set(doc.events.flatMap((e) => (e.type === 'transcription_run' ? [e.run_id] : [])));
    doc.events.forEach((e, i) => {
      if (e.type === 'transcript_segment' && e.run_id !== null && !runs.has(e.run_id))
        ctx.addIssue({ code: 'custom', path: ['events', i, 'run_id'], message: `segment of unknown run ${e.run_id}` });
      if (e.type === 'transcript_select' && e.run_id !== null && !runs.has(e.run_id))
        ctx.addIssue({ code: 'custom', path: ['events', i, 'run_id'], message: `selects unknown run ${e.run_id}` });
    });
    doc.events.forEach((e, i) => {
      if (e.type === 'transcript_edit' && !segments.has(e.segment_id))
        ctx.addIssue({ code: 'custom', path: ['events', i, 'segment_id'], message: 'edit of an unknown segment' });
    });
    // Draft Items cover known Annotations; actions name a draft written before them.
    const annotationIds = new Set(doc.events.flatMap((e) => (e.type === 'annotation' ? [e.annotation_id] : [])));
    const drafts = new Set<string>();
    doc.events.forEach((e, i) => {
      if (e.type === 'draft_item') {
        if (drafts.has(e.draft_id))
          ctx.addIssue({ code: 'custom', path: ['events', i, 'draft_id'], message: `duplicate draft ${e.draft_id}` });
        drafts.add(e.draft_id);
        for (const a of e.annotation_ids)
          if (!annotationIds.has(a))
            ctx.addIssue({ code: 'custom', path: ['events', i, 'annotation_ids'], message: `unknown annotation ${a}` });
      }
      if (e.type === 'style_edit' && !annotationIds.has(e.annotation_id))
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'annotation_id'],
          message: `style edit of unknown annotation ${e.annotation_id}`,
        });
      if (e.type === 'draft_action' && !drafts.has(e.draft_id))
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'draft_id'],
          message: `action on unknown draft ${e.draft_id}`,
        });
    });
    doc.events.forEach((e, i) => {
      if (e.type !== 'annotation') return;
      if (e.screenshot_id && !shots.has(e.screenshot_id))
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'screenshot_id'],
          message: 'no screenshot event with this id',
        });
      if (e.crop && !blobIds.has(e.crop.blob_id))
        ctx.addIssue({ code: 'custom', path: ['events', i, 'crop', 'blob_id'], message: 'crop blob missing' });
      for (const s of e.stroke_ids)
        if (!strokes.has(s))
          ctx.addIssue({ code: 'custom', path: ['events', i, 'stroke_ids'], message: `unknown stroke ${s}` });
      if (e.stroke_ids.length === 0 && e.close_reason !== 'object_select' && e.source !== 'page_api')
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'stroke_ids'],
          message: 'only an Object Select pick or a page_api Annotation has no Strokes',
        });
      if (e.pick !== null && e.pick >= e.candidates.length)
        ctx.addIssue({ code: 'custom', path: ['events', i, 'pick'], message: 'pick out of range' });
      if (e.resolution === 'region' && e.pick !== null)
        ctx.addIssue({ code: 'custom', path: ['events', i, 'pick'], message: 'region Annotations have no pick' });
    });
    doc.events.forEach((e, i) => {
      if (e.type === 'text_comment' && e.screenshot_id && !shots.has(e.screenshot_id))
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'screenshot_id'],
          message: 'no screenshot event with this id',
        });
    });
    doc.change_items?.forEach((item, i) => {
      for (const id of item.evidence.screenshots) {
        if (!shots.has(id))
          ctx.addIssue({
            code: 'custom',
            path: ['change_items', i, 'evidence', 'screenshots'],
            message: `no screenshot event with id ${id}`,
          });
      }
    });
    if (doc.media.audio && !blobIds.has(doc.media.audio.blob_id))
      ctx.addIssue({ code: 'custom', path: ['media', 'audio', 'blob_id'], message: 'audio blob missing' });
    if (doc.media.video && !blobIds.has(doc.media.video.blob_id))
      ctx.addIssue({ code: 'custom', path: ['media', 'video', 'blob_id'], message: 'video blob missing' });
  });

export type SessionDocument = z.infer<typeof SessionDocumentSchema>;

export const screenshotPath = (screenshotId: string) => `screenshots/${screenshotId}.png`;
export const AUDIO_PATH = 'audio.webm';
export const VIDEO_PATH = 'recording.webm';

export interface BuildSessionDocumentInput {
  session: SessionInfo;
  events: readonly (TimelineEvent & { seq?: number })[];
  blobs: readonly z.infer<typeof BlobRefSchema>[];
  audio: z.infer<typeof AudioMediaSchema> | null;
  video?: z.infer<typeof VideoMediaSchema> | null;
  now: Date;
  /** The latest successful Process run, if any. Its item_edit events are applied to give `change_items`. */
  process_run?: ProcessRunInput | null;
  /** Every run, for the processing failure rate. */
  process_runs?: readonly z.input<typeof ProcessRunSummarySchema>[];
}

export interface ProcessRunInput {
  id: string;
  model: string;
  items: readonly ChangeItem[];
  windows?: number;
  dropped_annotations?: readonly { annotation: number; reason: string }[];
  unaccounted_annotations?: readonly number[];
}

/** Assemble and validate session.json. Throws a ZodError when the stored Session is inconsistent. */
export function buildSessionDocument(input: BuildSessionDocumentInput): SessionDocument {
  const events = sortTimeline(input.events).map((e) => {
    const { seq: _seq, ...rest } = e as TimelineEvent & { seq?: number; session_id?: string };
    delete (rest as { session_id?: string }).session_id;
    return rest as TimelineEvent;
  });
  const run = input.process_run;
  const edits = run ? itemEditsFor(events, run.id) : [];
  return SessionDocumentSchema.parse({
    schema_version: SCHEMA_VERSION,
    generated_at: input.now.toISOString(),
    session: input.session,
    media: { audio: input.audio, video: input.video ?? null },
    blobs: [...input.blobs],
    events,
    ...(run
      ? {
          change_items: applyItemEdits(run.items, edits).items,
          process_run: {
            id: run.id,
            model: run.model,
            generated_items: [...run.items],
            acceptance: acceptanceRate(run.items, edits),
            windows: run.windows ?? 1,
            dropped_annotations: [...(run.dropped_annotations ?? [])],
            unaccounted_annotations: [...(run.unaccounted_annotations ?? [])],
          },
        }
      : {}),
    process_runs: [...(input.process_runs ?? [])],
  });
}

/** JSON Schema for session.json, generated from the Zod schema (refinements are not representable). */
export function sessionJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SessionDocumentSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  return {
    $schema: schema.$schema,
    $id: `urn:inkup:session:v${SCHEMA_VERSION}`,
    title: `InkUp session.json (schema_version ${SCHEMA_VERSION})`,
    description:
      'One recorded review Session: the full event timeline on one clock (t = ms since t0), plus references to screenshots and media. Generated from packages/core/src/session-document.ts by `pnpm schema`; do not edit by hand.',
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')),
  };
}
