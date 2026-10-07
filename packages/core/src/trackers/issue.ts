// The issue a Change Item becomes (ADR 0028): its title, and a Markdown body with the parts in a fixed order: Intent
// (with the category), Where, What was said, Screenshots, the Agent prompt (collapsed), Ambiguity, and a footer naming
// the Session and the item. Pure, so every tracker and every Client builds the same issue.
//
// A Location's place is its url, or the app it was in (`surface.app`, from native capture) when it has no url.
// The agent prompt cites screenshots as `screenshots/<id>.png`; each citation of an uploaded image becomes its URL.
// GitHub refuses a body of 65,536 characters or more, so a body that would reach it gets a shorter agent prompt, with
// a note saying so; every other part stays whole.
import { screenshotCitation } from '../process/change-item.ts';
import type { IssueDraft } from './adapter.ts';

/** GitHub's limit on an issue body, in characters. The body built is always shorter. */
export const MAX_BODY_CHARS = 65_536;
/** GitHub's limit on an issue title. */
export const MAX_TITLE_CHARS = 256;

/** A Location as the issue reads it. `url` may be absent (a native app), with `surface.app` naming the app. */
export interface IssueLocation {
  role: 'subject' | 'reference' | 'destination';
  element: string;
  selector?: string | null;
  url?: string | null;
  surface?: { app?: string | null } | null;
}

/** The Change Item fields the issue uses. */
export interface IssueItem {
  id: string;
  title: string;
  category: string;
  intent: string;
  locations: readonly IssueLocation[];
  transcript: string;
  ambiguity?: string | null;
  agent_prompt: string;
  evidence: { screenshots: readonly string[]; crops?: readonly string[] };
}

export interface IssueSession {
  /** The Session's name as the review page shows it (sessionName). */
  name: string;
}

/** Screenshot (or crop) id → the URL of the uploaded image. */
export type ScreenshotUrls = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;
export const TRUNCATED_NOTE =
  '_The agent prompt was cut short to fit the issue. Copy the whole prompt from the InkUp review page._';

const urlMap = (urls: ScreenshotUrls): Map<string, string> =>
  urls instanceof Map ? new Map(urls) : new Map(Object.entries(urls as Record<string, string>));

/** One line of Where: the role, the element, its selector, and where it is. */
function whereLine(l: IssueLocation): string {
  const place = l.url?.trim() ? `on ${l.url.trim()}` : l.surface?.app?.trim() ? `in ${l.surface.app.trim()}` : '';
  const selector = l.selector?.trim() ? ` (\`${l.selector.trim().replaceAll('`', "'")}\`)` : '';
  return `- **${ROLE[l.role] ?? l.role}:** ${l.element.trim()}${selector}${place ? `, ${place}` : ''}`;
}

/** The text as a Markdown quote, every line quoted. */
const quote = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Every `screenshots/<id>.png` citation of an uploaded image replaced by its URL. */
export function rewriteCitations(prompt: string, urls: ScreenshotUrls): string {
  let out = prompt;
  // Longer ids first, so one id that starts another never takes its citation.
  for (const [id, url] of [...urlMap(urls)].sort((a, b) => b[0].length - a[0].length))
    out = out.replaceAll(screenshotCitation(id), url);
  return out;
}

/** The first `max` characters, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

/** The issue for a Change Item: its title, and the body in the order above. */
export function buildIssue(item: IssueItem, session: IssueSession, screenshotUrls: ScreenshotUrls): IssueDraft {
  const urls = urlMap(screenshotUrls);
  const images = [...item.evidence.screenshots, ...(item.evidence.crops ?? [])].filter(
    (id, i, all) => urls.has(id) && all.indexOf(id) === i,
  );
  const crops = new Set(item.evidence.crops ?? []);

  const head = [
    '## Intent',
    '',
    item.intent.trim(),
    '',
    `**Category:** ${item.category}`,
    '',
    '## Where',
    '',
    ...item.locations.map(whereLine),
  ];
  if (item.transcript.trim()) head.push('', '## What was said', '', quote(item.transcript));
  if (images.length)
    head.push(
      '',
      '## Screenshots',
      '',
      ...images.map((id) => `![${crops.has(id) ? 'Element close-up' : 'Screenshot'} ${id}](${urls.get(id)})`),
    );

  const tail: string[] = [];
  if (item.ambiguity?.trim()) tail.push('', '## Ambiguity', '', item.ambiguity.trim());
  tail.push('', '---', '', `Sent from InkUp · ${session.name.trim()} · ${item.id}`);

  const prompt = rewriteCitations(item.agent_prompt.trim(), urls);
  const promptBlock = (text: string, truncated: boolean) => {
    const f = fence(text);
    return [
      '',
      '## Agent prompt',
      '',
      '<details>',
      '<summary>Prompt for a coding agent</summary>',
      '',
      `${f}text`,
      text,
      f,
      '',
      ...(truncated ? [TRUNCATED_NOTE, ''] : []),
      '</details>',
    ];
  };

  const assemble = (text: string, truncated: boolean) => [...head, ...promptBlock(text, truncated), ...tail].join('\n');
  let body = assemble(prompt, false);
  if (body.length >= MAX_BODY_CHARS) {
    // What the prompt may take: the limit less everything else and the note. A cut can change the fence's length,
    // so take off whatever is still over.
    let room = MAX_BODY_CHARS - 1 - assemble('', true).length - 2;
    for (let i = 0; i < 4; i++) {
      body = assemble(`${cut(prompt, Math.max(0, room)).trimEnd()}\n…`, true);
      if (body.length < MAX_BODY_CHARS || room <= 0) break;
      room -= body.length - MAX_BODY_CHARS + 1;
    }
    // Everything else alone is over the limit (a transcript of a whole Session): cut the end too, keeping the footer.
    if (body.length >= MAX_BODY_CHARS) {
      const footer = tail.at(-1)!;
      body = `${cut(body, MAX_BODY_CHARS - footer.length - 3)}\n\n${footer}`;
    }
  }
  return { title: cut(item.title.trim(), MAX_TITLE_CHARS), body };
}
