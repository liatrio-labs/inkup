// Recorded style changes through Process (the `style_edit` event, from the page API, E5). They are exact, so they
// never go through the model's words: the script shows them under their Annotation (./script.ts), and after the model
// has answered they are passed through as each item's `style_changes`, with the agent_prompt made to state every one
// of them. An Annotation with changes that no item covers gets an item of its own, so a change is never lost.
import type { EventOf, TimelineEvent } from '../timeline.ts';
import { type ChangeItem, type StyleChange, screenshotCitation } from './change-item.ts';
import { displayUrl } from './script.ts';

type StyleEdit = EventOf<'style_edit'>;
type Annotation = EventOf<'annotation'>;

/** The latest `style_edit` of each Annotation (each carries the whole difference), leaving out ones that undo it all. */
export function latestStyleEdits(events: readonly TimelineEvent[]): Map<string, StyleEdit> {
  const latest = new Map<string, StyleEdit>();
  for (const e of events) if (e.type === 'style_edit') latest.set(e.annotation_id, e);
  for (const [id, e] of latest) if (Object.keys(e.changes).length === 0 && !e.text) latest.delete(id);
  return latest;
}

/** `padding: 14px 28px → 20px 32px`, one per change, then the text. */
export function styleChangeLines(change: Pick<StyleChange, 'changes' | 'text'>): string[] {
  const lines = Object.entries(change.changes).map(([prop, v]) => `${prop}: ${v.from} → ${v.to}`);
  if (change.text) lines.push(`text: ${JSON.stringify(change.text.from)} → ${JSON.stringify(change.text.to)}`);
  return lines;
}

export const TOKEN_RULE =
  "Where a new value matches one of the project's design tokens (a CSS custom property, theme or Tailwind value), use the token rather than the raw value; a value written as var(--name) names the token to use.";

/** The agent_prompt block that states the edits exactly. */
export function stylePromptBlock(changes: readonly StyleChange[]): string {
  const lines = changes.flatMap((c) =>
    styleChangeLines(c).map((l) => `- ${c.selector} (Annotation #${c.annotation}): ${l}`),
  );
  return `Apply these changes exactly:\n${lines.join('\n')}\n${TOKEN_RULE}`;
}

/** True when the prompt already names every edit exactly. */
const statesAll = (prompt: string, changes: readonly StyleChange[]) =>
  changes.every((c) => styleChangeLines(c).every((l) => prompt.includes(l)));

export interface StylePassThrough {
  items: ChangeItem[];
  /** Ids of the items made for edited picks no item covered. */
  added: string[];
}

/**
 * Sets each item's `style_changes` from the latest changes of the Annotations its Locations name, makes its
 * agent_prompt state them exactly, and adds an item for each Annotation with changes that no item covers. Scratched picks are
 * left out. `items` carry stored screenshot ids.
 */
export function attachStyleChanges(
  items: readonly ChangeItem[],
  events: readonly TimelineEvent[],
  startUrl: string,
): StylePassThrough {
  const edits = latestStyleEdits(events);
  const scratched = new Set(
    events.flatMap((e) => (e.type === 'voice_command' && e.target?.kind === 'annotation' ? [e.target.id] : [])),
  );
  const picks = new Map<number, { annotation: Annotation; change: StyleChange; edit: StyleEdit }>();
  for (const e of events) {
    if (e.type !== 'annotation' || scratched.has(e.annotation_id)) continue;
    const edit = edits.get(e.annotation_id);
    if (!edit) continue;
    picks.set(e.index, {
      annotation: e,
      edit,
      change: {
        annotation: e.index,
        selector: edit.selector,
        changes: edit.changes,
        ...(edit.text ? { text: edit.text } : {}),
      },
    });
  }
  const covered = new Set<number>();
  const out: ChangeItem[] = items.map((item) => {
    const { style_changes: _, ...rest } = item;
    const mine = [
      ...new Set(
        item.locations.flatMap((l) => (l.annotation !== null && picks.has(l.annotation) ? [l.annotation] : [])),
      ),
    ].map((n) => picks.get(n)!.change);
    if (mine.length === 0) return rest;
    for (const c of mine) covered.add(c.annotation);
    const agent_prompt = statesAll(item.agent_prompt, mine)
      ? item.agent_prompt
      : `${item.agent_prompt.trimEnd()}\n\n${stylePromptBlock(mine)}`;
    return { ...rest, style_changes: mine, agent_prompt };
  });

  const added: string[] = [];
  let next = Math.max(0, ...out.map((i) => Number(/^item_(\d+)$/.exec(i.id)?.[1] ?? 0))) + 1;
  for (const [n, { annotation: a, edit, change }] of [...picks].sort(([x], [y]) => x - y)) {
    if (covered.has(n)) continue;
    const pick = a.pick !== null ? a.candidates[a.pick] : undefined;
    const label = pick ? `${pick.role ?? pick.tag} '${(pick.name || pick.text).slice(0, 60)}'` : edit.selector;
    const page = displayUrl(a.url, startUrl);
    const onlyText = Object.keys(change.changes).length === 0;
    const shot = a.screenshot_id;
    const id = `item_${String(next++).padStart(4, '0')}`;
    added.push(id);
    out.push({
      id,
      title: `${onlyText ? 'Change the text of' : 'Restyle'} ${label}`.slice(0, 80),
      category: onlyText ? 'copy' : 'style',
      intent: `Change ${label}: ${styleChangeLines(change).join('; ')}.`,
      locations: [
        { role: 'subject', selector: edit.selector, element: label, url: page, screenshot: shot, annotation: n },
      ],
      evidence: { video: { start: a.t / 1000, end: Math.max(a.t, edit.t) / 1000 }, screenshots: shot ? [shot] : [] },
      transcript: '',
      confidence: 0.9,
      agent_prompt: `On ${page}, change ${label} (${edit.selector}).${shot ? ` ${screenshotCitation(shot)} shows it as it is.` : ''}\n\n${stylePromptBlock([change])}`,
      pinned: false,
      style_changes: [change],
    });
  }
  return { items: out, added };
}
