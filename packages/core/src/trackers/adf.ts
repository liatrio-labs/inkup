// The issue a Change Item becomes, as Atlassian Document Format (ADR 0028), for Jira Cloud's REST v3, which takes no
// Markdown. It holds what buildIssue (./issue.ts) writes, in the same order: Intent (with the category), Where, What was
// said, Screenshots, the Agent prompt, Ambiguity, and a footer naming the Session and the item. The agent prompt is in an
// expand node, so it is collapsed until opened. Pure, like buildIssue.
//
// ADF text nodes may not be empty, and Jira refuses a description over 32,767 characters, so a long agent prompt is cut
// to fit, with a note.
import {
  type IssueItem,
  type IssueLocation,
  type IssueSession,
  rewriteCitations,
  type ScreenshotUrls,
} from './issue.ts';

export interface AdfMark {
  type: 'strong' | 'em' | 'code' | 'link';
  attrs?: { href: string };
}
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}
export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/** Jira's limit on a description is 32,767 characters; the document built is kept under this, measured as JSON. */
export const MAX_ADF_CHARS = 30_000;
export const ADF_TRUNCATED_NOTE =
  'The agent prompt was cut short to fit the issue. Copy the whole prompt from the InkUp review page.';

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

/** A text node; none for empty text, which ADF does not allow. */
const text = (value: string, marks?: AdfMark[]): AdfNode[] =>
  value ? [{ type: 'text', text: value, ...(marks?.length ? { marks } : {}) }] : [];
const strong = (value: string) => text(value, [{ type: 'strong' }]);
const paragraph = (...parts: AdfNode[][]): AdfNode => {
  const content = parts.flat();
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};
const heading = (value: string): AdfNode => ({
  type: 'heading',
  attrs: { level: 2 },
  content: text(value),
});
const bullets = (items: AdfNode[][][]): AdfNode => ({
  type: 'bulletList',
  content: items.map((parts) => ({ type: 'listItem', content: [paragraph(...parts)] })),
});
const isWebUrl = (value: string) => /^https?:\/\/\S+$/.test(value);

/** One line of Where: the role, the element, its selector, and where it is. */
function whereItem(l: IssueLocation): AdfNode[][] {
  const url = l.url?.trim() ?? '';
  const app = l.surface?.app?.trim() ?? '';
  const selector = l.selector?.trim() ?? '';
  const parts: AdfNode[][] = [strong(`${ROLE[l.role] ?? l.role}:`), text(` ${l.element.trim()}`)];
  if (selector) parts.push(text(' ('), text(selector, [{ type: 'code' }]), text(')'));
  if (url) parts.push(text(', on '), text(url, isWebUrl(url) ? [{ type: 'link', attrs: { href: url } }] : undefined));
  else if (app) parts.push(text(`, in ${app}`));
  return parts;
}

/** The words of an ADF node and its children, as one string (for tests and for sizing). */
export function adfText(node: AdfNode | AdfDoc): string {
  if ('text' in node && typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(adfText).join('');
}

/** `value` cut to `max` characters without splitting a surrogate pair. */
export function cutChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = Math.max(0, max);
  const code = value.charCodeAt(end - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

/**
 * The issue's description as ADF. `screenshotUrls` maps each uploaded image's id to the URL to link (a Jira attachment's
 * content URL); an image that is not in it is left out.
 */
export function buildIssueAdf(item: IssueItem, session: IssueSession, screenshotUrls: ScreenshotUrls): AdfDoc {
  const urls = screenshotUrls instanceof Map ? new Map(screenshotUrls) : new Map(Object.entries(screenshotUrls));
  const images = [...item.evidence.screenshots, ...(item.evidence.crops ?? [])].filter(
    (id, i, all) => urls.has(id) && all.indexOf(id) === i,
  );
  const crops = new Set(item.evidence.crops ?? []);
  const prompt = rewriteCitations(item.agent_prompt.trim(), urls);

  const head: AdfNode[] = [
    heading('Intent'),
    paragraph(text(item.intent.trim())),
    paragraph(strong('Category:'), text(` ${item.category}`)),
    heading('Where'),
    ...(item.locations.length ? [bullets(item.locations.map(whereItem))] : []),
  ];
  const said = item.transcript
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (said.length)
    head.push(heading('What was said'), { type: 'blockquote', content: said.map((line) => paragraph(text(line))) });
  if (images.length)
    head.push(
      heading('Screenshots'),
      bullets(
        images.map((id) => [
          text(`${crops.has(id) ? 'Element close-up' : 'Screenshot'} ${id}`, [
            { type: 'link', attrs: { href: urls.get(id)! } },
          ]),
        ]),
      ),
    );

  const tail: AdfNode[] = [];
  if (item.ambiguity?.trim()) tail.push(heading('Ambiguity'), paragraph(text(item.ambiguity.trim())));
  tail.push({ type: 'rule' }, paragraph(text(`Sent from InkUp · ${session.name.trim()} · ${item.id}`)));

  const promptBlock = (body: string, truncated: boolean): AdfNode[] => [
    heading('Agent prompt'),
    {
      type: 'expand',
      attrs: { title: 'Prompt for a coding agent' },
      content: [
        { type: 'codeBlock', attrs: { language: 'text' }, ...(body ? { content: text(body) } : {}) },
        ...(truncated ? [paragraph(text(ADF_TRUNCATED_NOTE, [{ type: 'em' }]))] : []),
      ],
    },
  ];
  const assemble = (body: string, truncated: boolean): AdfDoc => ({
    type: 'doc',
    version: 1,
    content: [...head, ...promptBlock(body, truncated), ...tail],
  });
  const size = (doc: AdfDoc) => JSON.stringify(doc).length;

  let doc = assemble(prompt, false);
  if (size(doc) > MAX_ADF_CHARS) {
    // What the prompt may take: the limit less everything else. JSON escapes (newlines, quotes) make the prompt longer
    // on the wire than in characters, so cut again by whatever is still over.
    let room = prompt.length - (size(doc) - MAX_ADF_CHARS) - (size(assemble('', true)) - size(assemble('', false)));
    for (let i = 0; i < 8; i++) {
      doc = assemble(`${cutChars(prompt, Math.max(0, room)).trimEnd()}\n…`, true);
      const over = size(doc) - MAX_ADF_CHARS;
      if (over <= 0 || room <= 0) break;
      room -= over + 16;
    }
  }
  return doc;
}
