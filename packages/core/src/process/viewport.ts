// Change Items seen at a resized viewport (plan E6) say so. The script tells the model which Annotations were drawn
// at which size; this makes it true whatever the model answers: an item whose Locations cite an Annotation drawn
// at a resized viewport gets that size in its agent_prompt, where a coding agent needs it to reproduce the issue.
import type { EventOf, TimelineEvent } from '../timeline.ts';
import { type Size, seenAtPhrase, viewportAt } from '../viewport.ts';
import type { ChangeItem } from './change-item.ts';

/** The resized viewports an item's Annotations were drawn at, in Annotation order, without repeats. */
export function itemViewports(item: Pick<ChangeItem, 'locations'>, events: readonly TimelineEvent[]): Size[] {
  const byIndex = new Map(
    events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation').map((a) => [a.index, a]),
  );
  const seen = new Map<string, Size>();
  for (const l of item.locations) {
    const a = l.annotation !== null ? byIndex.get(l.annotation) : undefined;
    const v = a ? viewportAt(events, a.t) : null;
    if (v) seen.set(`${v.width}x${v.height}`, { width: v.width, height: v.height });
  }
  return [...seen.values()];
}

/** Each item's agent_prompt names every resized viewport its Annotations were seen at ("at 375 px wide"). */
export function withViewportSizes(items: readonly ChangeItem[], events: readonly TimelineEvent[]): ChangeItem[] {
  return items.map((item) => {
    const missing = itemViewports(item, events).filter((s) => !item.agent_prompt.includes(`${s.width} px`));
    if (missing.length === 0) return item;
    const note = `The reviewer saw this with the page's viewport ${missing.map(seenAtPhrase).join(' and ')}; check it at that size.`;
    return { ...item, agent_prompt: `${item.agent_prompt.trimEnd()}\n\n${note}` };
  });
}
