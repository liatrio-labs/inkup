// How a Change Item's vetting verdict (packages/core/src/process/vet.ts) reads and looks on its card, next to the
// category and pinned badges. Same pill as those; the hue says whether to look closer.
import type { VetVerdict } from '@inkup/core/process/change-item';
import { TONE } from './tone';

export const VETTING_LABEL: Record<VetVerdict, string> = {
  confirmed: 'Checked',
  corrected: 'Corrected',
  unverified: 'Unverified',
};

export const VETTING_STYLE: Record<VetVerdict, string> = {
  confirmed: TONE.vetCheckedBadge,
  corrected: TONE.vetCorrectedBadge,
  unverified: TONE.vetUnverifiedBadge,
};
