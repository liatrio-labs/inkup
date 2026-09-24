// Grounding (E4): what the Session recorded, copied onto each Change Item after Process, so an agent does not
// depend on the model to repeat it. A Location gets the `source` of the Candidate it names; the item's Evidence
// gets the element crops of the Annotations it uses; the agent_prompt gains one line for each. Idempotent: an item
// grounded twice is unchanged, so runs over pinned or edited items are safe.
// E5: an item whose Annotations all came from the page API is tagged `source: 'page_api'`.
import { describeSource } from '../source-path.ts';
import type { Candidate, EventOf, TimelineEvent } from '../timeline.ts';
import { type ChangeItem, screenshotCitation } from './change-item.ts';

type Annotation = EventOf<'annotation'>;

const candidatesOf = (a: Annotation): Candidate[] => [
  ...a.candidates,
  ...(a.connector?.tail.candidates ?? []),
  ...(a.connector?.head.candidates ?? []),
];

export const SOURCE_PROMPT_PREFIX = 'Source in the codebase:';
export const CROP_PROMPT_PREFIX = 'Close-up of the element:';

export function groundItems(items: readonly ChangeItem[], events: readonly TimelineEvent[]): ChangeItem[] {
  const byIndex = new Map(events.filter((e): e is Annotation => e.type === 'annotation').map((a) => [a.index, a]));
  return items.map((item) => groundItem(item, byIndex));
}

function groundItem(item: ChangeItem, byIndex: ReadonlyMap<number, Annotation>): ChangeItem {
  const locations = item.locations.map((l) => {
    const { source: _model, ...rest } = l;
    const a = l.annotation !== null ? byIndex.get(l.annotation) : undefined;
    const c = a && l.selector ? candidatesOf(a).find((x) => x.selector === l.selector) : undefined;
    return c?.source ? { ...rest, source: c.source } : rest;
  });
  const annotations = [...new Set(item.locations.flatMap((l) => (l.annotation !== null ? [l.annotation] : [])))];
  const crops = annotations.flatMap((n) => {
    const crop = byIndex.get(n)?.crop;
    return crop ? [crop.blob_id] : [];
  });
  const { crops: _modelCrops, ...evidence } = item.evidence;
  const { source: _modelSource, ...rest } = item;
  const fromPageApi = annotations.length > 0 && annotations.every((n) => byIndex.get(n)?.source === 'page_api');

  // Prompt lines are rebuilt from scratch each time, so grounding again replaces rather than repeats them.
  const lines = item.agent_prompt.split('\n');
  const kept = lines.filter((line) => !line.startsWith(SOURCE_PROMPT_PREFIX) && !line.startsWith(CROP_PROMPT_PREFIX));
  const base = kept.length === lines.length ? item.agent_prompt : kept.join('\n').trimEnd();
  const extra: string[] = [];
  for (const l of locations) {
    const described = 'source' in l && l.source ? describeSource(l.source) : null;
    if (described) extra.push(`${SOURCE_PROMPT_PREFIX} ${l.selector ?? l.element} is rendered at ${described}.`);
  }
  if (crops.length)
    extra.push(
      `${CROP_PROMPT_PREFIX} ${crops.map(screenshotCitation).join(', ')} (the screenshot cropped to the marked element).`,
    );
  return {
    ...rest,
    ...(fromPageApi ? { source: 'page_api' as const } : {}),
    locations,
    evidence: crops.length ? { ...evidence, crops } : evidence,
    agent_prompt: extra.length ? `${base.trimEnd()}\n${extra.join('\n')}` : base,
  };
}
