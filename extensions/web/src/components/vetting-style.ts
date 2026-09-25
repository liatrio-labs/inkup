// How a Change Item's vetting verdict (packages/core/src/process/vet.ts) reads and looks on its card, next to the
// category and pinned badges. Same pill as those; the hue says whether to look closer.
import type { VetVerdict } from '@inkup/core/process/change-item';

export const VETTING_LABEL: Record<VetVerdict, string> = {
  confirmed: 'Checked',
  corrected: 'Corrected',
  unverified: 'Unverified',
};

export const VETTING_STYLE: Record<VetVerdict, string> = {
  confirmed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  corrected: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-200',
  unverified: 'bg-muted text-rose-800 dark:text-rose-300',
};
