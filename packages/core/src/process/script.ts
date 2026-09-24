// Prompt builder for Process (PRD §7). Turns a SessionDocument into a compact, time-ordered script plus the
// system prompt that explains it. Pure and deterministic, so the prompt is snapshot-tested.
//
// Screenshots appear as short aliases (s1, s2, … in capture order). The model answers in aliases; the adapter
// checks them against the ScriptContext and restores the stored ids before saving.

import { draftLocationSummary, draftViews } from '../drafts.ts';
import { applyTranscriptEdits } from '../review-edits.ts';
import type { SessionDocument } from '../session-document.ts';
import { describeSource } from '../source-path.ts';
import {
  type Candidate,
  type EventOf,
  isObjectSelectPick,
  type TimelineEvent,
  type TimestampQuality,
} from '../timeline.ts';
import { sizeLabel, viewportAt } from '../viewport.ts';
import { stripCommandPhrase } from '../voice-command-effects.ts';
import { type ChangeItem, LOW_CONFIDENCE, screenshotCitation } from './change-item.ts';
import { COMPARISON_CUES, DEMONSTRATIVES, MOTION_CUES, NOUNS, nounsForCandidate, nounsInText } from './locale/en.ts';
import { PAIRING_WINDOW_MS, pairSegment, sessionTimestampQuality } from './pairing.ts';
import { latestStyleEdits, styleChangeLines, TOKEN_RULE } from './style-changes.ts';
import { detectReplacement, textCommentSpeech } from './text-comments.ts';

export interface ScriptContext {
  quality: TimestampQuality;
  /** alias (s1) → stored screenshot id. */
  aliases: Record<string, string>;
  /** Annotation index → its Candidate selectors. */
  annotations: Record<number, { selectors: string[]; screenshot: string | null; url: string }>;
  start_url: string;
}

export interface ProcessPrompt {
  system: string;
  script: string;
  context: ScriptContext;
}

/** [mm:ss.s] */
export function stamp(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

const quote = (s: string, max = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return JSON.stringify(t.length > max ? `${t.slice(0, max - 1)}…` : t);
};

/** Marks a page the overlay could not run on (session_start or navigation `overlay: 'none'`). */
export const NO_DRAWING = '(no drawing: URL and screenshots only)';

/** Path for same-origin URLs, the full URL otherwise. */
export function displayUrl(url: string, startUrl: string): string {
  try {
    const u = new URL(url);
    const s = new URL(startUrl);
    // URL.origin is "null" for chrome:// and chrome-extension:// URLs, so compare scheme and host.
    return `${u.protocol}//${u.host}` === `${s.protocol}//${s.host}` ? `${u.pathname}${u.search}${u.hash}` : u.href;
  } catch {
    return url;
  }
}

function candidateLine(c: Candidate, i: number, prefix = ''): string {
  const label = c.name || c.text;
  const nouns = nounsForCandidate(c);
  const parts = [
    `${prefix}c${i} ${c.selector}`,
    `<${c.tag}${c.role ? ` role=${c.role}` : ''}${c.classes.length ? ` class="${c.classes.join(' ')}"` : ''}>${label ? ` ${quote(label, 60)}` : ''}`,
    c.relation === 'pick' ? 'PICK' : c.relation,
    `covers ${Math.round(c.coverage * 100)}%`,
  ];
  if (nouns.length) parts.push(`nouns: ${nouns.join(', ')}`);
  const source = c.source ? describeSource(c.source) : null;
  if (source) parts.push(`source: ${source}`);
  return `    ${parts.join(' · ')}`;
}

type Ev<T extends TimelineEvent['type']> = EventOf<T>;

/** Builds the script and its context. The system prompt is independent of the Session (cacheable). */
export function buildProcessPrompt(
  doc: SessionDocument,
  opts: {
    /** Only these events get lines (a Process window, ./windows.ts); the whole timeline is still walked. */
    include?: (e: TimelineEvent) => boolean;
    /** Only these pinned drafts are listed as fixed (the window that owns them). */
    pinnedDraft?: (d: Ev<'draft_item'>) => boolean;
  } = {},
): ProcessPrompt {
  // Process runs on the transcript as edited on the review page (PRD P0-11).
  const events = applyTranscriptEdits(doc.events);
  const startUrl = doc.session.start_url;
  const quality = scriptQuality(events, doc.session.transcription?.timestamp_quality);
  const segments = events.filter((e) => e.type === 'transcript_segment').length;
  const annotations = events.filter((e) => e.type === 'annotation').length;
  const end = events.find((e): e is Ev<'session_end'> => e.type === 'session_end');
  const start = events.find((e): e is Ev<'session_start'> => e.type === 'session_start');
  const { lines, context } = renderEvents(events, startUrl, quality, opts.include);
  const script = [
    ...scriptHeader(quality),
    `SESSION: starts at ${startUrl}${start?.overlay === 'none' ? ` ${NO_DRAWING}` : ''}${end ? ` · length ${stamp(end.duration_ms)}` : ''} · ${annotations} Annotations · ${segments} speech segments`,
    '',
    ...lines,
    ...draftSections(events, opts.pinnedDraft, opts.include),
  ];
  return { system: buildSystemPrompt(), script: script.join('\n'), context };
}

/** The Session's timestamp quality from its segments; with no speech, what the transcription reported. */
export function scriptQuality(
  events: readonly TimelineEvent[],
  fallback: TimestampQuality | undefined,
): TimestampQuality {
  const segments = events.filter((e): e is Ev<'transcript_segment'> => e.type === 'transcript_segment');
  return segments.length ? sessionTimestampQuality(segments) : (fallback ?? 'word');
}

export const scriptHeader = (quality: TimestampQuality) => [
  `TIMESTAMP QUALITY: ${quality === 'word' ? 'word-level' : 'approximate'}`,
  `PAIRING WINDOW: ${PAIRING_WINDOW_MS[quality] / 1000}s`,
];

/**
 * Pinned Draft Items are fixed items the model may not rewrite; discarded ones are negative examples (PRD P0-10,
 * P0-11). mergePinnedDrafts (./pins.ts) enforces the pins in code whatever the model answers.
 */
function draftSections(
  events: readonly TimelineEvent[],
  pinnedHere: (d: Ev<'draft_item'>) => boolean = () => true,
  shown: (e: TimelineEvent) => boolean = () => true,
): string[] {
  const views = draftViews(events);
  const line = (v: (typeof views)[number]) => {
    const where = draftLocationSummary(v.draft, true);
    return `${v.draft.draft_id} ${quote(v.draft.title)} (${v.draft.category}) · intent: ${quote(v.draft.intent, 200)}${where ? ` · ${where}` : ''}`;
  };
  const pinned = views.filter((v) => v.state === 'pinned' && pinnedHere(v.draft));
  const rejected = views.filter((v) => v.state === 'discarded' && shown(v.draft));
  const out: string[] = [];
  if (pinned.length) {
    out.push(
      '',
      'PINNED DRAFT ITEMS (fixed: the reviewer confirmed these. Output each as exactly one item with "pinned": true, this title and category, and these Locations. Do not rewrite, merge or split them, and do not output another item for the same Annotations):',
    );
    for (const v of pinned) out.push(`- ${line(v)}`);
  }
  if (rejected.length) {
    out.push(
      '',
      'REJECTED DRAFT ITEMS (negative examples: the reviewer discarded these readings. Do not produce them again):',
    );
    for (const v of rejected) out.push(`- the reviewer rejected: ${line(v)}`);
  }
  return out;
}

/**
 * The time-ordered lines of the script and their context. Every event is walked, so aliases, scrolls and
 * discards are right, but only events `include` accepts get lines: a live Draft Item pass renders just the
 * events since the previous pass.
 */
export function renderEvents(
  events: readonly TimelineEvent[],
  startUrl: string,
  quality: TimestampQuality,
  include: (e: TimelineEvent) => boolean = () => true,
): { lines: string[]; context: ScriptContext; rendered: { annotations: number; speech: number } } {
  const annotations = events.filter((e): e is Ev<'annotation'> => e.type === 'annotation');
  const strokes = new Map(events.filter((e): e is Ev<'stroke'> => e.type === 'stroke').map((s) => [s.stroke_id, s]));

  const aliases: Record<string, string> = {};
  const aliasOf = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'screenshot' && !aliasOf.has(e.screenshot_id)) {
      const alias = `s${aliasOf.size + 1}`;
      aliasOf.set(e.screenshot_id, alias);
      aliases[alias] = e.screenshot_id;
    }
  }
  const context: ScriptContext = { quality, aliases, annotations: {}, start_url: startUrl };

  // Voice Commands: their phrases leave the speech; `scratch that` takes an Annotation back.
  const commandPhrases = new Map<string, string[]>();
  const scratched = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'voice_command') continue;
    if (e.segment_id) commandPhrases.set(e.segment_id, [...(commandPhrases.get(e.segment_id) ?? []), e.phrase]);
    if (e.target?.kind === 'annotation') scratched.set(e.target.id, e.t);
  }
  const indexOf = new Map(annotations.map((a) => [a.annotation_id, a.index]));
  const styleEdits = latestStyleEdits(events);
  const live = annotations.filter((a) => !scratched.has(a.annotation_id));
  const region = (b: { x: number; y: number; width: number; height: number }) =>
    `region only: x=${Math.round(b.x)} y=${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)} (no element resolved)`;

  const textComments = events.filter((e): e is Ev<'text_comment'> => e.type === 'text_comment');

  const lines: string[] = [];
  const rendered = { annotations: 0, speech: 0 };
  let lastScrollY: number | null = null;
  for (const e of events) {
    const at = `[${stamp(e.t)}]`;
    const shown = include(e);
    const push = (...ls: string[]) => shown && lines.push(...ls);
    switch (e.type) {
      case 'annotation': {
        const shapes = [
          ...new Set(e.stroke_ids.map((id) => strokes.get(id)?.shape).filter((s): s is NonNullable<typeof s> => !!s)),
        ];
        const shot = e.screenshot_id ? (aliasOf.get(e.screenshot_id) ?? null) : null;
        if (lastScrollY !== null && Math.abs(e.scroll.y - lastScrollY) >= 1)
          push(`${at} SCROLL to y=${Math.round(e.scroll.y)}`);
        lastScrollY = e.scroll.y;
        const pageApi = e.source === 'page_api';
        const selected = isObjectSelectPick(e) && !pageApi;
        const head = [
          `${at} ANNOTATION #${e.index} ${pageApi ? 'PAGE API' : selected ? 'OBJECT SELECT' : shapes.length ? shapes.join('+') : 'mark'}`,
          ...(pageApi ? ['made by a script on the page'] : [`${stamp(e.t)}–${stamp(e.t_end)}`]),
          ...(selected || pageApi
            ? []
            : [`${e.stroke_ids.length} ${e.stroke_ids.length === 1 ? 'Stroke' : 'Strokes'}`]),
          `at ${displayUrl(e.url, startUrl)}`,
          `screenshot ${shot ?? 'none'}`,
          ...(selected || pageApi
            ? []
            : [
                e.close_reason === 'cleared'
                  ? 'closed by Clear all (no screenshot)'
                  : `closed by ${e.close_reason.replaceAll('_', ' ')}`,
              ]),
        ];
        const resized = viewportAt(events, e.t);
        if (resized) head.push(`viewport ${sizeLabel(resized)} (resized for the review)`);
        const scratchedAt = scratched.get(e.annotation_id);
        if (scratchedAt !== undefined) {
          push(`${head.join(' · ')} · DISCARDED by the reviewer ("scratch that" at ${stamp(scratchedAt)})`);
          break;
        }
        context.annotations[e.index] = {
          selectors: [
            ...e.candidates,
            ...(e.connector?.tail.candidates ?? []),
            ...(e.connector?.head.candidates ?? []),
          ].map((c) => c.selector),
          screenshot: shot,
          url: e.url,
        };
        if (shown) rendered.annotations++;
        push(head.join(' · '));
        if (pageApi && e.page_api) push(`    says: ${quote(e.page_api.comment, 400)}`);
        if (e.connector) {
          const { tail, head: tip } = e.connector;
          push(
            `    CONNECTOR arrow from (${Math.round(tail.point.x)}, ${Math.round(tail.point.y)}) to (${Math.round(tip.point.x)}, ${Math.round(tip.point.y)}): tail = subject, head = destination`,
          );
          for (const [name, end] of [
            ['tail', tail],
            ['head', tip],
          ] as const) {
            if (end.resolution === 'region') push(`    ${name} ${region(end.bbox)}`);
            else
              end.candidates.forEach((c, i) => {
                push(candidateLine(c, i, `${name} `));
              });
          }
          push('    whole drawing:');
        }
        if (e.resolution === 'region') push(`    ${region(e.bbox)}`);
        else
          e.candidates.forEach((c, i) => {
            push(candidateLine(c, i));
          });
        if (e.comment) push(`    COMMENT ${quote(e.comment, 2000)}`);
        const edit = styleEdits.get(e.annotation_id);
        if (edit) push(`    STYLE CHANGES at ${stamp(edit.t)} (exact): ${styleChangeLines(edit).join('; ')}`);
        break;
      }
      case 'transcript_segment': {
        const text = (commandPhrases.get(e.segment_id) ?? []).reduce(stripCommandPhrase, e.text);
        if (!text) break;
        const parts = [`${at} SPEECH ${quote(text, 400)}`, `${stamp(e.t)}–${stamp(e.t_end)}`];
        const pairs = pairSegment({ ...e, text }, live, quality);
        const words = pairs.filter((p) => p.anchor.word !== null);
        if (words.length) {
          parts.push(
            `demonstratives: ${words.map((p) => `"${p.anchor.word}"${quality === 'word' ? `@${stamp(p.anchor.t)}` : ''} near ${p.annotations.length ? p.annotations.map((i) => `#${i}`).join(', ') : 'none'}`).join('; ')}`,
          );
        } else {
          const near = pairs[0]?.annotations ?? [];
          parts.push(`near ${near.length ? near.map((i) => `#${i}`).join(', ') : 'none'}`);
        }
        const nouns = nounsInText(text);
        if (nouns.length) parts.push(`nouns: ${nouns.join(', ')}`);
        const during = textComments.filter((c) => e.t <= c.t_end && e.t_end >= c.t);
        if (during.length) parts.push(`during ${during.map((c) => `TEXT COMMENT t${c.index}`).join(', ')}`);
        if (shown) rendered.speech++;
        push(parts.join(' · '));
        break;
      }
      case 'scroll_settle':
        lastScrollY = e.scroll.y;
        push(`${at} SCROLL to y=${Math.round(e.scroll.y)} at ${displayUrl(e.url, startUrl)}`);
        break;
      case 'navigation':
        lastScrollY = null;
        push(
          `${at} NAVIGATION to ${displayUrl(e.url, startUrl)}${e.title ? ` ${quote(e.title)}` : ''}${e.overlay === 'none' ? ` ${NO_DRAWING}` : ''}`,
        );
        break;
      case 'click':
        push(
          `${at} CLICK ${e.selector} <${e.tag}>${e.name ? ` ${quote(e.name, 60)}` : ''} at ${displayUrl(e.url, startUrl)}`,
        );
        break;
      case 'tab_switch':
        push(`${at} TAB SWITCH ${e.away ? `away to ${quote(e.to_title)}` : 'back'}`);
        break;
      case 'text_comment': {
        const shot = e.screenshot_id ? (aliasOf.get(e.screenshot_id) ?? null) : null;
        const c = e.element;
        const label = c.name || c.text;
        const head = `${at} TEXT COMMENT t${e.index} on ${c.selector} <${c.tag}${c.role ? ` role=${c.role}` : ''}>${label ? ` ${quote(label, 60)}` : ''} · at ${displayUrl(e.url, startUrl)} · screenshot ${shot ?? 'none'}`;
        const replacement = detectReplacement(e.comment, e.selected_text);
        if (replacement) {
          push(
            `${head} · ${quote(replacement.before, 120)} → ${quote(replacement.after, 120)} · HANDLED: already a Change Item, output no item for it`,
          );
          break;
        }
        const speech = textCommentSpeech(e, events);
        push(
          head,
          `    selected ${quote(e.anchor.exact, 200)}${e.anchor.prefix ? ` after ${quote(`…${e.anchor.prefix}`, 60)}` : ''}${e.anchor.suffix ? ` before ${quote(`${e.anchor.suffix}…`, 60)}` : ''}`,
          `    comment ${quote(e.comment, 400)}`,
          ...(speech ? [`    said while selected ${quote(speech, 400)}`] : []),
        );
        break;
      }
      case 'screenshot':
        if (e.trigger !== 'annotation' && e.trigger !== 'text_comment')
          push(`${at} SCREENSHOT ${aliasOf.get(e.screenshot_id)} (${e.trigger}) at ${displayUrl(e.url, startUrl)}`);
        break;
      case 'voice_command': {
        const t = e.target;
        const effect =
          t?.kind === 'annotation'
            ? ` → discarded Annotation #${indexOf.get(t.id) ?? '?'}`
            : t?.kind === 'draft_item'
              ? ` → ${e.command === 'pin_that' ? 'pinned' : 'discarded'} draft ${t.id}`
              : '';
        push(`${at} VOICE COMMAND ${e.command.replaceAll('_', ' ')}${effect}`);
        break;
      }
      case 'draft_item': {
        const where = draftLocationSummary(e);
        push(`${at} DRAFT ${e.draft_id} ${quote(e.title)} (${e.category})${where ? ` · ${where}` : ''}`);
        break;
      }
      case 'draft_action':
        push(`${at} DRAFT ${e.draft_id} → ${e.action === 'pin' ? 'PINNED' : 'DISCARDED'} by user`);
        break;
      case 'viewport_change':
        push(`${at} VIEWPORT ${e.mechanism === 'none' ? "back to the tab's own size" : `resized to ${sizeLabel(e)}`}`);
        break;
      case 'session_pause':
        push(`${at} PAUSE`);
        break;
      case 'session_resume':
        push(`${at} RESUME`);
        break;
      case 'mic_muted':
        push(`${at} MIC MUTED: nothing the reviewer said until MIC ON was recorded`);
        break;
      case 'mic_unmuted':
        push(`${at} MIC ON`);
        break;
      case 'session_start':
        if (!e.voice)
          push(`${at} NO VOICE: the Session started without a microphone; the reviewer typed their comments`);
        break;
      case 'voice_on':
        push(`${at} VOICE ON: the microphone was turned on; speech is recorded from here`);
        break;
      default:
        break;
    }
  }
  return { lines, context, rendered };
}

/** The system prompt (English locale). Stable across Sessions, so it can be prompt-cached. */
export function buildSystemPrompt(): string {
  const demonstratives = DEMONSTRATIVES.map((d) => `- "${d.word}": usually ${d.usual_role}; ${d.note}`).join('\n');
  const nouns = NOUNS.map(
    (n) =>
      `- ${n.noun}: said as ${n.words.map((w) => `"${w}"`).join(', ')}; matches tags ${n.tags.join(', ') || '(none)'}, roles ${n.roles.join(', ') || '(none)'}${n.looks.length ? `, or class/id names starting ${n.looks.map((w) => `"${w}"`).join(', ')}` : ''}`,
  ).join('\n');
  return `You turn a recorded, spoken and drawn-on review of a web page into Change Items: implementer-facing requests that say what should change, where, and the evidence for it.

## Input
A time-ordered script. Times are [mm:ss.s] from the start of the Session.
- TIMESTAMP QUALITY and PAIRING WINDOW say how precise speech times are: word-level timings pair within 2s; approximate timings (whole segments stamped on arrival, often late) pair within 4s.
- ANNOTATION #n: a group of Strokes the reviewer drew, with its shapes (circle, underline, arrow, scribble, freeform), page, screenshot id, what closed it, and its Candidates: c0 is the geometric PICK (the smallest element enclosing most of the drawing); the others are its ancestors (enclosing it), siblings the Strokes cover, and descendants enclosed by the drawing. "nouns:" lists what each Candidate can be called. "region only" means nothing on the page could be resolved (canvas, iframe).
- "source:" on a Candidate is where the page's framework says it is rendered (file:line and the components, nearest first). Name that file in the agent_prompt when it helps the agent find the code.
- ANNOTATION #n PAGE API: not drawn by the reviewer but made by a script on the page through the page API (__inkup.annotate), with what it says (and, as STYLE CHANGES under it, any style or text change it asks for). It is a request like the reviewer's: make an item from it (its Location is the PICK), unless the reviewer's speech rejects it.
- OBJECT SELECT: an Annotation made by picking one element instead of drawing. Its only Candidate, c0, is exactly the element the reviewer chose: use it as the subject, whatever noun is spoken. It spans the time from the pick until the reviewer finished commenting: SPEECH in that span is about it.
- COMMENT (under an OBJECT SELECT): what the reviewer typed about that element. It is their own words, as good as speech: an item from it quotes it in its transcript.
- MIC MUTED … MIC ON: the reviewer turned the microphone off for that span. No speech exists there: an Annotation made then has only its drawing or typed comment, and silence there says nothing.
- NO VOICE (until VOICE ON, if any): the Session had no microphone. Each Annotation's typed COMMENT is what the reviewer wants there; the absence of speech says nothing.
- STYLE CHANGES (under an Annotation): exact changes for that element, as property: before → after (and text: before → after). An item for them is category style (copy when only the text changes); its agent_prompt states every change exactly as given. ${TOKEN_RULE}
- CONNECTOR: the Annotation contains an arrow. The "tail" Candidates are what it starts at (the subject), the "head" Candidates are where it points (the destination), each with its own PICK. The "whole drawing" Candidates follow.
- DISCARDED: the reviewer took that Annotation back by saying "scratch that". Produce no item from it, nor from speech that only refers to it.
- SPEECH: a transcript segment. "demonstratives" lists the pointing words with the Annotations inside the pairing window ("near"); nouns spoken are listed too. These are hints computed by rules: use them, but read the words.
- SCROLL, NAVIGATION, CLICK, TAB SWITCH, SCREENSHOT: what the page did.
- VIEWPORT: the reviewer resized the page's viewport (e.g. to a phone width) or gave it back to the tab. An Annotation drawn at a resized viewport says "viewport W×H"; an item from it is about the page at that size: say so in its intent and agent_prompt (e.g. "at 375 px wide").
- NO DRAWING: a page marked ${NO_DRAWING} belongs to Chrome or to another extension; the reviewer could not draw there and no elements were read. Items about it have Locations with "selector": null, element "page", its URL and the screenshot taken there (if any).
- TEXT COMMENT tN: the reviewer selected text in an element and typed a comment on it: the element's selector, the selected text with the words just before and after it, the comment, and what they said while the text was selected. A SPEECH line marked "during TEXT COMMENT tN" was said then. One marked HANDLED already states its new text and is a Change Item: output no item for it, nor for speech that only repeats it.
- VOICE COMMAND: control phrases, already removed from SPEECH. Never content.
- DRAFT dN: a Draft Item, a quick reading shown to the reviewer during the Session. "→ PINNED" means the reviewer confirmed it, "→ DISCARDED" that they rejected it. Drafts with neither are only hints.
- PINNED DRAFT ITEMS (after the timeline): fixed items. Output each one as exactly one item with "pinned": true, its exact title and category, and its Locations; do not rewrite, merge or split it, and output no other item for the same Annotations.
- REJECTED DRAFT ITEMS (after the timeline): readings the reviewer discarded. Do not produce them again; if the same Annotations mean something else, say that instead.
- ANNOTATIONS TO ACCOUNT FOR (first line): every Annotation listed must be used in some item's Locations, or listed in "dropped_annotations" with a one-sentence reason. Never leave one out silently.
- WINDOW k of n (long Sessions only): the Session is processed in parts. Produce items for what starts inside your part; the lines before and after it are context that another part covers.

## Pairing speech with Annotations
Pair each demonstrative with the Annotation inside the pairing window, nearest in time first. Speech often starts before the drawing ends or trails it by a second or two, and approximate timestamps arrive late: prefer the Annotation just before the speech when two are equally close. One Annotation can serve several demonstratives only if the reviewer clearly means the same thing.

Demonstratives (English):
${demonstratives}
A place word after a motion cue (${MOTION_CUES.join(', ')}) is a destination. A demonstrative after a comparison cue (${COMPARISON_CUES.join(', ')}) is a reference.

## Choosing the element (Candidates)
If the paired speech names a noun, choose the Candidate whose "nouns:" include it: prefer the PICK, then descendants, siblings and ancestors, nearest to the PICK. A link styled as a button counts as a button. Copy that Candidate's selector exactly into the Location. If no noun is spoken, or none matches, use the PICK and lower confidence by about 0.1. Region-only Annotations get "selector": null and an element description of the region.

Nouns (English):
${nouns}

## Change Items
- One item per requested change. "this" at one Annotation and "should go here" at another is ONE layout item: subject = the first, destination = the second. "make this the same height as that" is ONE item: subject = this, reference = that. An arrow drawn from one mark to another is a move: subject at its tail, destination at its head, even with no speech (then category layout, and say in the intent that the arrow was the whole request).
- Location roles: subject (what changes; every item has one), reference (what it should match or relate to), destination (where it goes). Each Location gives the selector, a short element description (e.g. button 'Get started'), the page path, the screenshot id and the Annotation number.
- Categories: layout (position, size, spacing, order, alignment), style (color, font, border, visual weight), copy (wording of existing text), content (adding or removing content, images, sections), behavior (what happens on interaction or navigation), bug (something broken), question (the reviewer asks rather than requests).
- Each TEXT COMMENT that is not HANDLED is one item about that text: category copy unless the comment clearly asks for something else, the subject Location is its selector with "annotation": null and its screenshot, and the agent_prompt quotes the selected text with the words around it so the implementer can find it. The reviewer pointed at exact text, so confidence is high unless the comment itself is unclear.
- Speech with no Annotation nearby can still be an item; its Location is the page (selector null, element "page").
- Do not invent changes the reviewer did not ask for. Ignore filler and self-corrections: when the reviewer restates something, keep the last version.
- id: item_0001, item_0002, … in time order. transcript: the reviewer's own words for this item, verbatim, joined with " ... ". pinned: true only for the PINNED DRAFT ITEMS, false otherwise.
- evidence.screenshots: the ids of the screenshots of every Annotation the item uses, exactly as written in the script (s1, s2, …). evidence.video: {start, end} in seconds of Session time covering the item's speech and Annotations.

## Confidence and ambiguity
confidence is how sure you are that the item says what the reviewer meant and points at the right elements. Below ${LOW_CONFIDENCE}, "ambiguity" is required: one sentence naming what is unclear (e.g. which of two elements "this" means). At ${LOW_CONFIDENCE} or above, omit "ambiguity". Lower confidence when the pairing is far apart, the noun does not match any Candidate, speech is garbled, or two readings are plausible.

## agent_prompt
A self-contained instruction for a coding agent working in the exported review folder, which holds the screenshots. Name the page path, each element by its selector and visible name, and exactly what to change, in the imperative. Cite every evidence screenshot as ${screenshotCitation('<id>')} (e.g. ${screenshotCitation('s1')}), saying what each shows. Do not say "the reviewer said"; state the change.

Answer with JSON only: {"items": [...], "dropped_annotations": [{"annotation": n, "reason": "..."}]}. Leave "dropped_annotations" empty when every Annotation is used.`;
}

/** Message sent after output failed validation (one repair retry). */
export function buildRepairMessage(issues: readonly string[]): string {
  return `Your answer did not pass validation:\n${issues.map((i) => `- ${i}`).join('\n')}\nReturn the complete corrected JSON ({"items": [...]}), fixing only what is listed.`;
}

/** Second pass for one low-confidence item: the script plus the item; screenshots are attached before it. */
export function buildSecondPassMessage(script: string, item: ChangeItem, attached: readonly string[]): string {
  return `The script of the review:\n\n${script}\n\nThis Change Item came out with confidence ${item.confidence} ("${item.ambiguity ?? ''}"). ${
    attached.length
      ? `The screenshots ${attached.join(', ')} are attached above, in that order; they show the page with the reviewer's Strokes in red.`
      : 'No screenshots are available.'
  } Re-examine the item against them. Keep its id. Return {"items": [the revised item]} with exactly one item.\n\n${JSON.stringify(item, null, 2)}`;
}

/** Problems an item has against this Session (unknown screenshots or Annotations). Feeds the repair retry. */
export function checkAgainstSession(items: readonly ChangeItem[], ctx: ScriptContext): string[] {
  const issues: string[] = [];
  const known = (id: string | null) => id === null || id in ctx.aliases;
  items.forEach((item, i) => {
    item.locations.forEach((l, j) => {
      if (!known(l.screenshot))
        issues.push(`items.${i}.locations.${j}.screenshot: "${l.screenshot}" is not a screenshot id in the script`);
      if (l.annotation !== null && !(l.annotation in ctx.annotations))
        issues.push(`items.${i}.locations.${j}.annotation: there is no Annotation #${l.annotation}`);
    });
    item.evidence.screenshots.forEach((s, j) => {
      if (!known(s)) issues.push(`items.${i}.evidence.screenshots.${j}: "${s}" is not a screenshot id in the script`);
    });
  });
  return issues;
}

const mapShots = (item: ChangeItem, map: (id: string) => string): ChangeItem => ({
  ...item,
  locations: item.locations.map((l) => ({ ...l, screenshot: l.screenshot === null ? null : map(l.screenshot) })),
  evidence: { ...item.evidence, screenshots: item.evidence.screenshots.map(map) },
  agent_prompt: item.agent_prompt.replace(/screenshots\/([\w-]+)\.png/g, (_m, id: string) =>
    screenshotCitation(map(id)),
  ),
});

/** Aliases (s1) → stored screenshot ids, everywhere in the item including agent_prompt citations. */
export function restoreScreenshotIds(item: ChangeItem, ctx: ScriptContext): ChangeItem {
  return mapShots(item, (id) => ctx.aliases[id] ?? id);
}

/** Stored ids → aliases, for sending an item back to the model. */
export function aliasScreenshotIds(item: ChangeItem, ctx: ScriptContext): ChangeItem {
  const back = Object.fromEntries(Object.entries(ctx.aliases).map(([a, id]) => [id, a]));
  return mapShots(item, (id) => back[id] ?? id);
}
