// `pnpm validate:session <session.json>`: validates a downloaded session.json against the schema and prints a
// short summary. Used by the manual checks (docs/manual-checks.md).
import { readFileSync } from 'node:fs';
import { draftStats, draftViews } from '../packages/core/src/drafts.ts';
import { SessionDocumentSchema } from '../packages/core/src/session-document.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: pnpm validate:session <path/to/session.json>');
  process.exit(2);
}
const result = SessionDocumentSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
if (!result.success) {
  console.error(`INVALID ${file}`);
  for (const issue of result.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const doc = result.data;
const count = (type: string) => doc.events.filter((e) => e.type === type).length;
console.log(`VALID ${file}`);
console.log(`  duration ${doc.session.duration_ms} ms · transcription ${JSON.stringify(doc.session.transcription)}`);
console.log(
  `  strokes ${count('stroke')} · annotations ${count('annotation')} · screenshots ${count('screenshot')} · transcript segments ${count('transcript_segment')}`,
);
console.log(`  change items ${doc.change_items ? doc.change_items.length : 'none (not processed)'}`);
console.log(
  `  audio ${doc.media.audio ? `${doc.media.audio.duration_ms} ms in ${doc.media.audio.chunk_count} chunks` : 'none'}`,
);
const v = doc.media.video;
console.log(
  `  video ${v ? `${v.duration_ms} ms in ${v.chunk_count} chunks, ${v.width}x${v.height}, starts ${v.start_offset_ms} ms after t0, ${v.seekable ? 'seekable' : 'NOT seekable'}` : `none${doc.session.video_off_reason ? ` (${doc.session.video_off_reason})` : ''}`}${doc.session.media_deleted_at ? ' · media deleted after export' : ''}`,
);
if (doc.process_run) {
  const a = doc.process_run.acceptance;
  console.log(
    `  acceptance ${a.unedited}/${a.generated}${a.rate !== null ? ` (${Math.round(a.rate * 100)}%)` : ''} · item edits ${count('item_edit')} · transcript edits ${count('transcript_edit')}`,
  );
}
for (const e of doc.events) {
  if (e.type !== 'annotation') continue;
  const pick = e.pick !== null ? e.candidates[e.pick] : undefined;
  console.log(
    `  #${e.index} t=${e.t}ms ${e.resolution} pick=${pick ? `${pick.selector} "${pick.name}"` : '—'} screenshot=${e.screenshot_id ? 'yes' : 'no'} closed by ${e.close_reason}`,
  );
  if (e.connector) {
    const end = (x: typeof e.connector.tail) => (x.pick !== null ? x.candidates[x.pick]?.selector : null) ?? 'a region';
    console.log(`     connector ${end(e.connector.tail)} -> ${end(e.connector.head)}`);
  }
}
console.log(
  `  navigation ${count('navigation')} · click ${count('click')} · tab_switch ${count('tab_switch')} · pause ${count('session_pause')} · resume ${count('session_resume')} · speech_activity ${count('speech_activity')}`,
);
const triggers = doc.events.flatMap((e) => (e.type === 'screenshot' ? [e.trigger] : []));
console.log(`  screenshot triggers ${triggers.join(', ') || 'none'}`);
// PRD §8: Draft Item discard rate (target under 25%).
const drafts = draftStats(doc.events);
console.log(
  `  draft items ${drafts.drafts} · pinned ${drafts.pinned} · discarded ${drafts.discarded} (click ${drafts.discarded_by.click}, voice ${drafts.discarded_by.voice}) · discard rate ${drafts.discard_rate === null ? 'n/a' : `${Math.round(drafts.discard_rate * 100)}%`}`,
);
for (const v of draftViews(doc.events))
  console.log(
    `  draft ${v.draft.draft_id} t=${v.draft.t}ms ${v.state}${v.source ? ` by ${v.source}` : ''} "${v.draft.title}" (${v.draft.category}) covers ${v.draft.annotation_ids.length} annotation(s)`,
  );
const pinnedItems = doc.change_items?.filter((i) => i.pinned).length;
if (pinnedItems !== undefined) console.log(`  pinned change items ${pinnedItems}`);
for (const e of doc.events) {
  if (e.type === 'voice_command')
    console.log(
      `  voice_command t=${e.t}ms ${e.command} "${e.phrase}"${e.target ? ` -> ${e.target.kind} ${e.target.id}` : ''}`,
    );
}
