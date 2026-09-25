// Restore from file: reads an export back (the reverse of packages/core/src/export/bundle.ts). Accepts the export zip or a
// bare session.json, upgrades an older schema_version step by step, and validates the result with the same
// SessionDocumentSchema the export was built with. Pure: src/db/session-import.ts writes what this returns.
//
// unzipit reads a zip lazily from a Blob: a stored entry (client-zip stores everything) comes back as a slice of
// the file, so a long video is never copied into memory.
import { unzip } from 'unzipit';
import { type SessionDocument, SessionDocumentSchema } from './session-document.ts';
import { SCHEMA_VERSION } from './timeline.ts';

/** A file that cannot be restored; `message` is written for the reviewer. */
export class SessionFileError extends Error {
  override name = 'SessionFileError';
}

export interface SessionFile {
  doc: SessionDocument;
  /** The zip's other files by their path inside the export folder; empty for a bare session.json. */
  files: Map<string, Blob>;
  source: 'zip' | 'json';
}

type RawDocument = Record<string, unknown> & { events: Record<string, unknown>[] };

/**
 * One step per version: `UPGRADES[v]` turns a version-v document into version v+1. A step fills what the newer
 * schema requires; fields the schema defaults need nothing. A break with no sensible default throws
 * SessionFileError. Adding a version = adding its step here.
 */
export const UPGRADES: Record<number, (doc: RawDocument) => RawDocument> = {
  // v2: Candidate relation `descendant` and `classes` (defaults to []).
  1: (doc) => doc,
  // v3: voice_command gains `t_end` (an instant command ends where it starts); the rest default.
  2: (doc) => ({
    ...doc,
    events: doc.events.map((e) => (e.type === 'voice_command' && e.t_end === undefined ? { ...e, t_end: e.t } : e)),
  }),
  // v4: video media (was always null), review edits as new events, video_off_reason defaults.
  3: (doc) => doc,
  // v5: Draft Items carry a pass, model, intent, transcript and Locations that v4 never recorded.
  4: (doc) => {
    if (doc.events.some((e) => e.type === 'draft_item')) {
      throw new SessionFileError(
        'This export is from schema version 4 and has Draft Items, which that version recorded without the Locations and intent this version needs. It cannot be restored.',
      );
    }
    return {
      ...doc,
      events: doc.events.map((e) =>
        e.type === 'draft_action' && e.source === undefined ? { ...e, source: e.via } : e,
      ),
    };
  },
  // v6: transcript segments gain `run_id` (null: the live run), which defaults.
  5: (doc) => doc,
  // v7: clicked_at, the process_run coverage fields and process_runs all default.
  6: (doc) => doc,
  // v8: `overlay` on session_start and navigation defaults to 'page'; screenshot trigger `shortcut` is new.
  7: (doc) => doc,
  // v9: close reason `inspect_pick` and the `style_edit` event are new; nothing older changes.
  8: (doc) => doc,
  // v10: the `text_comment` event, close reason and screenshot trigger are new; nothing older changes.
  9: (doc) => doc,
  // v11: the `viewport_change` event is new.
  10: (doc) => doc,
  // v12: Candidate `source`, Annotation `crop`, blob kind `screenshot_crop`, the Change Item grounding, page_api
  // Annotations, close reason and screenshot trigger `page_api` and Change Item `source` are new and optional.
  11: (doc) => doc,
  // v13: Inspect became Object Select: close reason `inspect_pick` is now `object_select`; `comment` defaults to null.
  12: (doc) => ({
    ...doc,
    events: doc.events.map((e) =>
      e.type === 'annotation' && e.close_reason === 'inspect_pick' ? { ...e, close_reason: 'object_select' } : e,
    ),
  }),
  // v14: an item_edit `edit` op's `agent_prompt`, `ambiguity` and `origin` are new and optional.
  13: (doc) => doc,
  // v15: the `mic_muted` and `mic_unmuted` events are new.
  14: (doc) => doc,
  // v16: `transcript_segment.target` and `session_start.voice` have defaults (null, true); `voice_on` is new.
  15: (doc) => doc,
  // v17: close reason `cleared` and the `overlay_cleared` event are new.
  16: (doc) => doc,
  // v18: a Stroke's `color` is new and optional.
  17: (doc) => doc,
  // v19: item_edit ops `undo` and `redo` are new.
  18: (doc) => doc,
  // v20: the `session_rename` event is new.
  19: (doc) => doc,
};

/** Brings a parsed session.json of any supported version to SCHEMA_VERSION and validates it. */
export function upgradeSessionDocument(raw: unknown): SessionDocument {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { schema_version?: unknown }).schema_version !== 'number' ||
    !Array.isArray((raw as { events?: unknown }).events)
  ) {
    throw new SessionFileError('This is not a Session export: session.json has no schema_version or events.');
  }
  let doc = raw as RawDocument;
  const from = doc.schema_version as number;
  if (from > SCHEMA_VERSION)
    throw new SessionFileError(
      `This export is from a newer version of the extension (schema version ${from}; this one reads up to ${SCHEMA_VERSION}). Update the extension first.`,
    );
  if (!Number.isInteger(from) || from < 1)
    throw new SessionFileError(`This export has an unknown schema version (${from}).`);
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = UPGRADES[v];
    if (!step) throw new SessionFileError(`Exports from schema version ${v} cannot be upgraded.`);
    doc = { ...step(doc), schema_version: v + 1 };
  }
  const parsed = SessionDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'document'}: ${i.message}`);
    throw new SessionFileError(
      `This session.json does not match schema version ${SCHEMA_VERSION}${from < SCHEMA_VERSION ? ` (upgraded from ${from})` : ''}: ${issues.join('; ')}.`,
    );
  }
  return parsed.data;
}

const isZip = (head: Uint8Array) =>
  head[0] === 0x50 &&
  head[1] === 0x4b &&
  (head[2] === 0x03 || head[2] === 0x05) &&
  (head[3] === 0x04 || head[3] === 0x06);

/** Reads an export zip or a bare session.json. Throws SessionFileError with a message for the reviewer. */
export async function readSessionFile(file: Blob): Promise<SessionFile> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (isZip(head)) return readZip(file);
  return { doc: upgradeSessionDocument(parseJson(await file.text())), files: new Map(), source: 'json' };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SessionFileError('This file is neither an export zip nor a session.json.');
  }
}

async function readZip(file: Blob): Promise<SessionFile> {
  let entries: Record<
    string,
    { blob: (type?: string) => Promise<Blob>; text: () => Promise<string>; isDirectory: boolean }
  >;
  try {
    ({ entries } = await unzip(file));
  } catch (e) {
    throw new SessionFileError(`This zip cannot be read (${e instanceof Error ? e.message : String(e)}).`);
  }
  // The export has session.json at its root; a re-zipped export folder has it one folder down.
  const manifest = Object.keys(entries)
    .filter((name) => name === 'session.json' || name.endsWith('/session.json'))
    .sort((a, b) => a.length - b.length)[0];
  if (!manifest) throw new SessionFileError('This zip has no session.json, so it is not a Session export.');
  const prefix = manifest.slice(0, -'session.json'.length);
  const doc = upgradeSessionDocument(parseJson(await entries[manifest]!.text()));
  const files = new Map<string, Blob>();
  const mimes = new Map(doc.blobs.map((b) => [b.path, b.mime]));
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.isDirectory || !name.startsWith(prefix) || name === manifest) continue;
    const path = name.slice(prefix.length);
    files.set(path, await entry.blob(mimes.get(path) ?? ''));
  }
  return { doc, files, source: 'zip' };
}
