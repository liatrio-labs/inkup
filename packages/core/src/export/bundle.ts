// The export folder (PRD P0-13): what goes into the zip, and the checks that make it a working handoff. Pure: the
// review page resolves each blob id to bytes and streams the zip with client-zip.
//
//   review.md · session.json · screenshots/<id>.png (and <id>.crop.png, element crops) · audio.webm · recording.webm
//   (only with video)
import { localStamp } from '../clock.ts';
import { screenshotCitation } from '../process/change-item.ts';
import { sessionName } from '../review-edits.ts';
import { type SessionDocument, screenshotPath } from '../session-document.ts';
import { renderReviewMarkdown } from './review-md.ts';

export type ExportFile = { path: string; text: string; mime: string } | { path: string; blob_id: string };

export interface ExportPlan {
  files: ExportFile[];
  /** Why the folder would not work; export is refused while any remain. */
  issues: string[];
}

/**
 * Every screenshot the Session refers to: screenshot events, Annotations and their element crops, and each Change
 * Item's Locations, Evidence and prompt. A crop's id is `<screenshot_id>.crop`, so it lands at screenshots/<id>.crop.png.
 */
export function referencedScreenshots(doc: SessionDocument): string[] {
  const ids = new Set<string>();
  for (const e of doc.events) {
    if (e.type === 'screenshot') ids.add(e.screenshot_id);
    if (e.type === 'annotation' && e.screenshot_id) ids.add(e.screenshot_id);
    if (e.type === 'annotation' && e.crop) ids.add(e.crop.blob_id);
  }
  for (const item of doc.change_items ?? []) {
    for (const l of item.locations) if (l.screenshot) ids.add(l.screenshot);
    for (const id of item.evidence.screenshots) ids.add(id);
    for (const id of item.evidence.crops ?? []) ids.add(id);
    for (const id of promptCitations(item.agent_prompt)) ids.add(id);
  }
  return [...ids];
}

/** Screenshot ids an agent_prompt cites as screenshots/<id>.png. */
export function promptCitations(prompt: string): string[] {
  return [...prompt.matchAll(/screenshots\/([\w.-]+?)\.png/g)].map((m) => m[1]!);
}

export function planExport(doc: SessionDocument): ExportPlan {
  const issues: string[] = [];
  const blobs = new Map(doc.blobs.map((b) => [b.id, b]));
  const files: ExportFile[] = [];
  const shots = referencedScreenshots(doc);
  for (const id of shots) {
    const kind = blobs.get(id)?.kind;
    if (kind === 'screenshot' || kind === 'screenshot_crop') files.push({ path: screenshotPath(id), blob_id: id });
    else issues.push(`screenshot ${id} is referenced but its image is missing`);
  }
  const audio = doc.media.audio !== null && blobs.has(doc.media.audio.blob_id);
  const video = doc.media.video !== null && blobs.has(doc.media.video.blob_id);
  if (audio) files.push({ path: doc.media.audio!.path, blob_id: doc.media.audio!.blob_id });
  if (video) files.push({ path: doc.media.video!.path, blob_id: doc.media.video!.blob_id });

  const paths = new Set(files.map((f) => f.path));
  (doc.change_items ?? []).forEach((item, i) => {
    for (const id of promptCitations(item.agent_prompt)) {
      if (!paths.has(screenshotCitation(id)))
        issues.push(`Change Item ${i + 1} (${item.id}) cites ${screenshotCitation(id)}, which is not in the export`);
    }
  });

  files.unshift(
    { path: 'review.md', text: renderReviewMarkdown(doc, { include: { video, audio } }), mime: 'text/markdown' },
    { path: 'session.json', text: `${JSON.stringify(doc, null, 2)}\n`, mime: 'application/json' },
  );
  return { files, issues };
}

/** review-2026-09-22-1405-pricing-fixture.zip: the Session's local start time and its name. */
export function exportFileName(doc: SessionDocument): string {
  const slug = sessionName(doc.session, doc.events)
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `review-${localStamp(doc.session.started_at)}-${slug || doc.session.id.slice(0, 8)}.zip`;
}
