// The ADF converter: the description validates against Atlassian's published JSON schema (vendored in
// fixtures/adf-schema.json, from @atlaskit/adf-schema 57.7.2), holds the sections of buildIssue's Markdown in the same
// order, keeps the agent prompt in an expand node, and ends with the footer.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import {
  ADF_TRUNCATED_NOTE,
  type AdfDoc,
  type AdfNode,
  adfText,
  buildIssue,
  buildIssueAdf,
  type IssueItem,
  MAX_ADF_CHARS,
} from '../../src/trackers';

const schema = JSON.parse(readFileSync(new URL('./fixtures/adf-schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
function expectValid(doc: AdfDoc) {
  const ok = validate(doc);
  expect(ok ? [] : validate.errors).toEqual([]);
}

const SESSION = { name: 'Pricing page review' };
const item = (over: Partial<IssueItem> = {}): IssueItem => ({
  id: 'item_0001',
  title: 'Make the Get started button larger',
  category: 'style',
  intent: 'The primary call to action is too small to notice.',
  locations: [
    { role: 'subject', element: "button 'Get started'", selector: 'button.cta', url: 'https://example.com/pricing' },
    { role: 'reference', element: 'Nav bar', surface: { app: 'Figma' } },
  ],
  transcript: 'this button is way too small\n\nand the rest too',
  ambiguity: 'How much larger is not said.',
  agent_prompt: 'Enlarge it. See screenshots/s1.png and screenshots/s2.png.',
  evidence: { screenshots: ['s1', 's2'], crops: ['s1.crop'] },
  ...over,
});
const urls = new Map([
  ['s1', 'https://acme.atlassian.net/rest/api/3/attachment/content/1'],
  ['s2', 'https://acme.atlassian.net/rest/api/3/attachment/content/2'],
  ['s1.crop', 'https://acme.atlassian.net/rest/api/3/attachment/content/3'],
]);

const walk = (node: AdfNode, visit: (n: AdfNode) => void) => {
  visit(node);
  for (const c of node.content ?? []) walk(c, visit);
};
const headings = (doc: AdfDoc) => doc.content.filter((n) => n.type === 'heading').map((n) => adfText(n));

describe('buildIssueAdf', () => {
  it('the schema check rejects a document that is not ADF', () => {
    expect(validate({ type: 'doc', version: 1, content: [{ type: 'expand', content: [{ type: 'bogus' }] }] })).toBe(
      false,
    );
    expect(
      validate({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] }),
    ).toBe(false);
  });

  it('validates against the ADF JSON schema, with and without images', () => {
    expectValid(buildIssueAdf(item(), SESSION, urls));
    expectValid(buildIssueAdf(item(), SESSION, new Map()));
    expectValid(
      buildIssueAdf(
        item({
          locations: [],
          transcript: '',
          ambiguity: null,
          agent_prompt: '',
          intent: '',
          evidence: { screenshots: [] },
        }),
        SESSION,
        new Map(),
      ),
    );
  });

  it('holds the same sections, in the same order, as the Markdown body', () => {
    const markdown = buildIssue(item(), SESSION, urls).body;
    const fromMarkdown = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings(buildIssueAdf(item(), SESSION, urls))).toEqual(fromMarkdown);
    expect(fromMarkdown).toEqual(['Intent', 'Where', 'What was said', 'Screenshots', 'Agent prompt', 'Ambiguity']);

    const bare = item({ transcript: '', ambiguity: null, evidence: { screenshots: [] } });
    expect(headings(buildIssueAdf(bare, SESSION, new Map()))).toEqual(
      [...buildIssue(bare, SESSION, new Map()).body.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    );
  });

  it('puts the agent prompt in an expand node, with each citation rewritten to the attachment', () => {
    const doc = buildIssueAdf(item(), SESSION, urls);
    const expands = doc.content.filter((n) => n.type === 'expand');
    expect(expands).toHaveLength(1);
    const code = expands[0]!.content![0]!;
    expect(code.type).toBe('codeBlock');
    expect(adfText(code)).toBe(
      'Enlarge it. See https://acme.atlassian.net/rest/api/3/attachment/content/1 and https://acme.atlassian.net/rest/api/3/attachment/content/2.',
    );
    // Nothing else holds the prompt.
    const outside = doc.content.filter((n) => n.type !== 'expand');
    expect(outside.map(adfText).join('\n')).not.toContain('Enlarge it');
  });

  it('links every uploaded image, where each Location is, and what was said', () => {
    const doc = buildIssueAdf(item(), SESSION, urls);
    const links: string[] = [];
    walk({ type: 'doc', content: doc.content }, (n) => {
      for (const m of n.marks ?? []) if (m.type === 'link') links.push(m.attrs!.href);
    });
    expect(links).toEqual(['https://example.com/pricing', ...urls.values()]);
    const where = adfText(doc.content[doc.content.findIndex((n) => adfText(n) === 'Where') + 1]!);
    expect(where).toBe(
      "Subject: button 'Get started' (button.cta), on https://example.com/pricingReference: Nav bar, in Figma",
    );
    const quote = doc.content.find((n) => n.type === 'blockquote')!;
    expect(quote.content!.map(adfText)).toEqual(['this button is way too small', 'and the rest too']);
  });

  it('ends with a rule and the footer paragraph', () => {
    const doc = buildIssueAdf(item(), SESSION, urls);
    const last = doc.content.at(-1)!;
    expect(last.type).toBe('paragraph');
    expect(adfText(last)).toBe('Sent from InkUp · Pricing page review · item_0001');
    expect(doc.content.at(-2)!.type).toBe('rule');
  });

  it('cuts a very long agent prompt to fit Jira, with a note, and keeps the footer', () => {
    const long = item({ agent_prompt: `${'Line "quoted"\n'.repeat(5000)}screenshots/s1.png` });
    const doc = buildIssueAdf(long, SESSION, urls);
    expect(JSON.stringify(doc).length).toBeLessThanOrEqual(MAX_ADF_CHARS);
    expect(JSON.stringify(doc)).toContain(ADF_TRUNCATED_NOTE);
    expectValid(doc);
    expect(adfText(doc.content.at(-1)!)).toBe('Sent from InkUp · Pricing page review · item_0001');
  });
});
