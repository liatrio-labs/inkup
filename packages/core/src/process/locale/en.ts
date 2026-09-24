// English demonstrative and noun tables (PRD P0-4, P0-7: English-only in v1, one module per locale; P1-6 adds
// more). The prompt builder uses them twice: deterministic hints in the script (which demonstratives a segment
// contains, which nouns a Candidate can answer to) and the tables themselves in the system prompt.
import type { Candidate } from '../../timeline.ts';

export interface Demonstrative {
  word: string;
  /** Role this word usually gives its Location. */
  usual_role: 'subject' | 'reference' | 'destination';
  note: string;
}

export const DEMONSTRATIVES: readonly Demonstrative[] = [
  { word: 'this', usual_role: 'subject', note: 'the thing being changed' },
  { word: 'these', usual_role: 'subject', note: 'several things being changed' },
  { word: 'it', usual_role: 'subject', note: 'refers back to the last subject when no new mark is near' },
  {
    word: 'that',
    usual_role: 'reference',
    note: 'in a comparison ("same … as that", "like that") it is the reference; alone it can be a subject',
  },
  { word: 'those', usual_role: 'reference', note: 'as "that", plural' },
  {
    word: 'here',
    usual_role: 'destination',
    note: 'after a motion verb ("should go here", "move it here") it is the destination',
  },
  { word: 'there', usual_role: 'destination', note: 'as "here"' },
];

/** Words that make the next demonstrative a reference. */
export const COMPARISON_CUES = [
  'same',
  'as',
  'like',
  'match',
  'matches',
  'similar',
  'than',
  'align',
  'aligned',
] as const;
/** Words that make the next place word a destination. */
export const MOTION_CUES = [
  'go',
  'goes',
  'move',
  'moved',
  'put',
  'place',
  'drag',
  'swap',
  'into',
  'above',
  'below',
  'next',
] as const;

export interface NounEntry {
  /** Canonical noun, as shown to the model. */
  noun: string;
  /** Spoken forms that mean this noun (singular; plurals with a trailing "s" match too). */
  words: readonly string[];
  tags: readonly string[];
  roles: readonly string[];
  /** Class, id or test-id fragments that make an element look like this noun ("a link styled as a button counts as a button"). */
  looks: readonly string[];
}

export const NOUNS: readonly NounEntry[] = [
  {
    noun: 'button',
    words: ['button', 'cta', 'call to action'],
    tags: ['button'],
    roles: ['button'],
    looks: ['btn', 'button', 'cta'],
  },
  { noun: 'link', words: ['link', 'hyperlink'], tags: ['a'], roles: ['link'], looks: [] },
  {
    noun: 'card',
    words: ['card', 'tile', 'panel', 'box'],
    tags: ['article'],
    roles: ['article'],
    looks: ['card', 'tile', 'panel'],
  },
  {
    noun: 'header',
    words: ['header', 'top bar', 'masthead'],
    tags: ['header'],
    roles: ['banner'],
    looks: ['header', 'masthead', 'topbar'],
  },
  { noun: 'footer', words: ['footer'], tags: ['footer'], roles: ['contentinfo'], looks: ['footer'] },
  {
    noun: 'nav',
    words: ['nav', 'navigation', 'menu', 'navbar'],
    tags: ['nav'],
    roles: ['navigation', 'menu', 'menubar'],
    looks: ['nav', 'menu'],
  },
  {
    noun: 'section',
    words: ['section', 'area', 'block', 'hero', 'banner'],
    tags: ['section'],
    roles: ['region'],
    looks: ['section'],
  },
  {
    noun: 'image',
    words: ['image', 'picture', 'photo', 'icon', 'logo', 'illustration'],
    tags: ['img', 'picture', 'svg', 'figure'],
    roles: ['img', 'image', 'figure'],
    looks: ['img', 'image', 'logo', 'icon', 'photo'],
  },
  {
    noun: 'heading',
    words: ['heading', 'headline', 'title'],
    tags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    roles: ['heading'],
    looks: ['title', 'heading', 'headline'],
  },
  {
    noun: 'text',
    words: ['text', 'paragraph', 'copy', 'sentence', 'label', 'description'],
    tags: ['p', 'span', 'label'],
    roles: ['paragraph'],
    looks: ['lede', 'text', 'copy', 'desc'],
  },
  { noun: 'price', words: ['price', 'pricing'], tags: [], roles: [], looks: ['price'] },
  { noun: 'list', words: ['list', 'items'], tags: ['ul', 'ol'], roles: ['list'], looks: ['list'] },
  {
    noun: 'field',
    words: ['field', 'input', 'textbox', 'dropdown', 'checkbox'],
    tags: ['input', 'textarea', 'select'],
    roles: ['textbox', 'combobox', 'checkbox', 'searchbox'],
    looks: ['input', 'field'],
  },
  { noun: 'form', words: ['form'], tags: ['form'], roles: ['form'], looks: ['form'] },
  { noun: 'table', words: ['table', 'grid'], tags: ['table'], roles: ['table', 'grid'], looks: ['table'] },
];

const tokens = (text: string) => text.toLowerCase().match(/[a-z']+/g) ?? [];

/** Canonical nouns a Candidate can answer to, by tag, role and appearance hints in its selector or id. */
export function nounsForCandidate(
  c: Pick<Candidate, 'tag' | 'role' | 'selector' | 'id' | 'testid'> & { classes?: readonly string[] },
): string[] {
  // Only the element's own names count: in the selector "div.hero-card p" the "card" belongs to the parent.
  const own =
    c.selector
      .trim()
      .split(/\s*[\s>+~]\s*/)
      .at(-1) ?? '';
  const names = [own, c.id ?? '', c.testid ?? '', ...(c.classes ?? [])].join(' ').toLowerCase();
  // A fragment counts at the start of a name part: "btn-primary", "hero-card", "navbar", not "discard".
  const looksLike = (frag: string) => new RegExp(`(^|[^a-z])${frag}`).test(names);
  return NOUNS.filter(
    (n) => n.tags.includes(c.tag) || (c.role !== null && n.roles.includes(c.role)) || n.looks.some(looksLike),
  ).map((n) => n.noun);
}

/** Canonical nouns spoken in `text` (whole words, simple plurals, multi-word forms). */
export function nounsInText(text: string): string[] {
  const t = ` ${tokens(text).join(' ')} `;
  return NOUNS.filter((n) => n.words.some((w) => t.includes(` ${w} `) || t.includes(` ${w}s `))).map((n) => n.noun);
}

export interface SpokenDemonstrative {
  word: string;
  /** Index of the word in the tokenized text. */
  index: number;
}

export function demonstrativesInText(text: string): SpokenDemonstrative[] {
  const words = new Set(DEMONSTRATIVES.map((d) => d.word));
  return tokens(text).flatMap((w, index) => (words.has(w) ? [{ word: w, index }] : []));
}

export const isDemonstrative = (word: string) =>
  DEMONSTRATIVES.some((d) => d.word === word.toLowerCase().replace(/[^a-z']/g, ''));
