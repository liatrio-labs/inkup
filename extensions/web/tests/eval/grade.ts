// Grading for `pnpm eval`: a fixture passes when one Change Item has the expected category and, for every
// expected role, a Location with that role at one of the accepted selectors.
import type { ChangeItem } from '@inkup/core/process/change-item';

export type Role = 'subject' | 'reference' | 'destination';
export interface Expected {
  description: string;
  category: string;
  /** Role → accepted selectors, the intended one first. */
  locations: Partial<Record<Role, string[]>>;
}

/** Problems of the closest item, or [] when some item matches. */
export function grade(items: readonly ChangeItem[], exp: Expected): string[] {
  if (items.length === 0) return ['no items'];
  const problems = items.map((item) => {
    const p: string[] = [];
    if (item.category !== exp.category) p.push(`category ${item.category}, expected ${exp.category}`);
    for (const [role, selectors] of Object.entries(exp.locations) as [Role, string[]][]) {
      const locs = item.locations.filter((l) => l.role === role);
      if (locs.length === 0) p.push(`no ${role} Location`);
      else if (!locs.some((l) => l.selector !== null && selectors.includes(l.selector)))
        p.push(`${role} at ${locs.map((l) => l.selector).join(', ')}, expected ${selectors.join(' or ')}`);
    }
    return p;
  });
  return problems.reduce((a, b) => (b.length < a.length ? b : a));
}
