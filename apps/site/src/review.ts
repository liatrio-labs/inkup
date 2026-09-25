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
  /** Which agent claimed it, and what it said when it resolved it (or, still in work, what it's doing). */
  agent: 'Claude Code' | 'Cursor' | 'Codex';
  resolution: string;
  /** Where the agents section leaves it. Only true things are Done: the demo item stays In work until the real
   * recording replaces the illustration. */
  ends: 'working' | 'done';
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
    ends: 'done',
  },
  {
    id: 'item-demo',
    section: 'demo',
    selector: 'figure.demo',
    quote: 'Show it working here, not a screenshot.',
    at: '00:11',
    title: 'Show a real review in the demo slot',
    agent: 'Cursor',
    resolution: 'Recording the clip from the real extension. The illustration stays until it lands.',
    ends: 'working',
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
    ends: 'done',
  },
  {
    id: 'item-privacy',
    section: 'privacy',
    selector: 'p.promise',
    quote: 'Say plainly where my data goes.',
    at: '00:27',
    title: 'Say where the data goes',
    agent: 'Claude Code',
    resolution: 'Added the promise that we never see it, and listed what goes to each provider.',
    ends: 'done',
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
    ends: 'done',
  },
];

export const itemFor = (section: string) => items.find((item) => item.section === section);
