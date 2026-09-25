// review.md (PRD P0-13): numbered Change Items with their Locations, intent, embedded screenshots and a video
// timestamp link, then the full transcript as an appendix. A pure template-string renderer over session.json.
import { formatElapsed } from '../clock.ts';
import { type MediaClock, mutedSpans, pauseGaps, sessionToMedia } from '../media-time.ts';
import { type ChangeItem, isLowConfidence } from '../process/change-item.ts';
import { displayUrl } from '../process/script.ts';
import { styleChangeLines } from '../process/style-changes.ts';
import { applyTranscriptEdits, sessionName } from '../review-edits.ts';
import { type SessionDocument, screenshotPath } from '../session-document.ts';
import { describeSource } from '../source-path.ts';
import { sizeWithScale, viewportAt } from '../viewport.ts';

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

/** Inline code that survives backticks in the text. */
const code = (s: string) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const seconds = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1);

interface MediaLink {
  path: string;
  clock: MediaClock;
  label: string;
}

/** The recording an item's time range links into: the video, else the audio, else none. */
function mediaLink(doc: SessionDocument, include: { video: boolean; audio: boolean }): MediaLink | null {
  const gaps = pauseGaps(doc.events);
  const v = doc.media.video;
  if (v && include.video) return { path: v.path, clock: { start_offset_ms: v.start_offset_ms, gaps }, label: 'video' };
  const a = doc.media.audio;
  if (a && include.audio) return { path: a.path, clock: { start_offset_ms: a.start_offset_ms, gaps }, label: 'audio' };
  return null;
}

function evidenceTime(item: ChangeItem, link: MediaLink | null): string | null {
  const v = item.evidence.video;
  if (!v) return null;
  const range = `${formatElapsed(v.start * 1000)}–${formatElapsed(v.end * 1000)}`;
  if (!link) return `Session time ${range} (no recording in this folder)`;
  const from = sessionToMedia(v.start * 1000, link.clock);
  const to = Math.max(from, sessionToMedia(v.end * 1000, link.clock));
  return `[${link.label} at ${formatElapsed(from)}–${formatElapsed(to)}](${link.path}#t=${seconds(from)},${seconds(to)}) (Session time ${range})`;
}

function renderItem(item: ChangeItem, n: number, doc: SessionDocument, link: MediaLink | null): string {
  const startUrl = doc.session.start_url;
  const lines: string[] = [`## ${n}. ${oneLine(item.title)}`, ''];
  lines.push(
    `**Category:** ${item.category}${item.pinned ? ' · pinned' : ''}${item.source === 'page_api' ? ' · from the page API' : ''}${isLowConfidence(item) ? ' · **check me**' : ''}`,
    '',
  );
  if (isLowConfidence(item) && item.ambiguity) lines.push(`> ${oneLine(item.ambiguity)}`, '');
  lines.push(item.intent.trim(), '', '**Locations**', '');
  for (const l of item.locations) {
    const drawn =
      l.annotation !== null ? doc.events.find((e) => e.type === 'annotation' && e.index === l.annotation) : undefined;
    const size = drawn ? viewportAt(doc.events, drawn.t) : null;
    const where = [
      l.selector ? code(l.selector) : null,
      `on ${displayUrl(l.url, startUrl)}`,
      size ? `at ${size.width} px wide (${size.width}×${size.height})` : null,
      l.annotation !== null ? `(Annotation #${l.annotation})` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const source = l.source ? describeSource(l.source) : null;
    lines.push(`- ${ROLE[l.role]}: ${oneLine(l.element)} ${where}${source ? ` · source ${code(source)}` : ''}`);
  }
  if (item.style_changes?.length) {
    lines.push('', '**Style changes** (exact; apply as given)', '');
    for (const c of item.style_changes)
      for (const l of styleChangeLines(c))
        lines.push(`- ${code(c.selector)} (Annotation #${c.annotation}): ${code(l)}`);
  }
  lines.push('', '**Evidence**', '');
  const time = evidenceTime(item, link);
  if (time) lines.push(`- ${time}`);
  for (const id of item.evidence.screenshots)
    lines.push(`- ${screenshotPath(id)}`, '', `  ![Screenshot ${id}](${screenshotPath(id)})`, '');
  for (const id of item.evidence.crops ?? [])
    lines.push(
      `- ${screenshotPath(id)} (cropped to the element)`,
      '',
      `  ![Close-up ${id}](${screenshotPath(id)})`,
      '',
    );
  if (item.transcript.trim()) lines.push(`**Reviewer said:** “${oneLine(item.transcript)}”`, '');
  lines.push('**Agent prompt**', '', '```text', item.agent_prompt.trim(), '```', '');
  return lines.join('\n');
}

/** The viewport sizes the reviewer resized the page to (plan E6), in order; null when the page kept the tab's size. */
function viewportLine(doc: SessionDocument): string | null {
  const changes = doc.events.filter((e) => e.type === 'viewport_change');
  if (changes.length === 0) return null;
  const parts = changes.map(
    (e) => `${e.mechanism === 'none' ? "the tab's own size" : sizeWithScale(e)} from ${formatElapsed(e.t)}`,
  );
  return `Viewport: resized for the review: ${parts.join(', ')}. Locations drawn at a resized viewport say its width.`;
}

/** The spans the reviewer muted the microphone (E10): the audio is silent there and nothing was transcribed. */
function mutedLine(doc: SessionDocument): string | null {
  const spans = mutedSpans(doc.events);
  if (spans.length === 0) return null;
  const parts = spans.map(
    (g) => `${formatElapsed(g.start)}–${Number.isFinite(g.end) ? formatElapsed(g.end) : 'the end'}`,
  );
  return `Mic muted: ${parts.join(', ')}. Nothing said then was recorded or transcribed.`;
}

export interface ReviewMarkdownOptions {
  /** Which recordings the export folder holds (a link points only at a file that is there). */
  include: { video: boolean; audio: boolean };
}

export function renderReviewMarkdown(doc: SessionDocument, opts: ReviewMarkdownOptions): string {
  const s = doc.session;
  const items = doc.change_items ?? [];
  const link = mediaLink(doc, opts.include);
  const video =
    doc.media.video && opts.include.video
      ? `Video: [${doc.media.video.path}](${doc.media.video.path}). Pauses are cut from the recording, so its times run behind Session time after a pause.`
      : `Video: none${s.video_off_reason === 'picker_cancelled' ? ' (the screen picker was cancelled)' : s.media_deleted_at ? ' (deleted after an earlier export)' : ''}.`;
  const out: string[] = [
    `# Review: ${oneLine(sessionName(s, doc.events))}`,
    '',
    `Recorded ${s.started_at.slice(0, 16).replace('T', ' ')} UTC · ${s.duration_ms !== null ? formatElapsed(s.duration_ms) : 'unfinished'} · starts at ${s.start_url}`,
    '',
    video,
    '',
    `${items.length} ${items.length === 1 ? 'Change Item' : 'Change Items'}. Each cites its screenshots by path inside this folder; \`session.json\` has the full timeline.`,
    '',
  ];
  const viewports = viewportLine(doc);
  if (viewports) out.push(viewports, '');
  const muted = mutedLine(doc);
  if (muted) out.push(muted, '');
  if (items.length === 0) out.push('_Not processed: no Change Items yet._', '');
  items.forEach((item, i) => {
    out.push(renderItem(item, i + 1, doc, link));
  });

  out.push('## Transcript', '');
  const segments = applyTranscriptEdits(doc.events).filter((e) => e.type === 'transcript_segment' && e.text.trim());
  if (segments.length === 0) out.push('_No speech was transcribed._', '');
  for (const seg of segments)
    if (seg.type === 'transcript_segment') out.push(`- [${formatElapsed(seg.t)}] ${oneLine(seg.text)}`);
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
