// "Copy all prompts" (PRD P0-12): one numbered prompt for the whole list, for a coding agent run inside the
// exported folder.
import type { ChangeItem } from '../process/change-item.ts';

export function allPrompts(items: readonly Pick<ChangeItem, 'title' | 'agent_prompt'>[]): string {
  if (items.length === 0) return '';
  const head =
    items.length === 1
      ? 'Make this change from a recorded review of the site. Screenshots are cited by path relative to the review folder.'
      : `Make these ${items.length} changes from a recorded review of the site, in order. Screenshots are cited by path relative to the review folder.`;
  return [head, ...items.map((item, i) => `${i + 1}. ${item.title}\n${item.agent_prompt.trim()}`)].join('\n\n');
}
