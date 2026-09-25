// The page reviews itself. Each section carries one Change Item a reviewer "said" about it, located on the element the
// red pen circles there. The Items dock collects them as you scroll, and the agents section resolves them. The quotes
// and timestamps are illustrative; the fields match what a real Change Item carries (ADR 0021).

export type ReviewItem = {
  id: string;
  /** The section the item is made in; the dock marks it when that section is inspected. */
  section: string;
  /** The element the Stroke landed on, as the inspector names it. */
  selector: string;
  /** What the reviewer said, verbatim. */
  quote: string;
  /** Where in the recording it was said. */
  at: string;
  /** The Change Item's title: what should change. */
  title: string;
  /** Which agent claimed it, and what it said when it resolved it. */
  agent: 'Claude Code' | 'Cursor' | 'Codex';
  resolution: string;
};

export const items: ReviewItem[] = [
  {
    id: 'item-cta',
    section: 'top',
    selector: 'a.cta',
    quote: 'Make this the first thing people see.',
    at: '00:04',
    title: 'Make the install button the primary action',
    agent: 'Claude Code',
    resolution: 'Made a.cta the primary button and moved it into the first viewport.',
  },
  {
    id: 'item-demo',
    section: 'demo',
    selector: 'figure.demo',
    quote: 'Show it working here, not a screenshot.',
    at: '00:11',
    title: 'Show a real review in the demo slot',
    agent: 'Cursor',
    resolution: 'Swapped the static screenshot for the recorded review clip.',
  },
  {
    id: 'item-steps',
    section: 'how',
    selector: 'ol.steps',
    quote: 'This should read as three steps.',
    at: '00:19',
    title: 'Lay out the flow as three steps',
    agent: 'Codex',
    resolution: 'Rebuilt the section as an ordered list of three steps.',
  },
  {
    id: 'item-privacy',
    section: 'privacy',
    selector: 'p.promise',
    quote: 'Say plainly that nothing leaves the laptop.',
    at: '00:27',
    title: 'State that the free tier sends nothing',
    agent: 'Claude Code',
    resolution: 'Added the free-tier promise above the key options.',
  },
  {
    id: 'item-install',
    section: 'install',
    selector: 'pre.brew',
    quote: 'Put the brew command right here.',
    at: '00:33',
    title: 'Add a copyable brew command',
    agent: 'Cursor',
    resolution: 'Added the brew command with a copy button.',
  },
];

export const itemFor = (section: string) => items.find((item) => item.section === section);
