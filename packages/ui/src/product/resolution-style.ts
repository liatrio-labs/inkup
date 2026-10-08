// How a Change Item's Resolution reads and looks: the review page's cards and the Session list's counts share these.

import { TONE } from './tone';

export const RESOLUTION_LABEL = {
  in_progress: 'In work',
  resolved: 'Done',
  wont_fix: "Won't fix",
  needs_info: 'Needs info',
} as const;

export type ResolutionStatus = keyof typeof RESOLUTION_LABEL;

/** A card's box: border, fill and text. */
export const RESOLUTION_STYLE = {
  in_progress: TONE.inWorkCard,
  resolved: TONE.doneCard,
  wont_fix: TONE.wontFixCard,
  needs_info: TONE.needsInfoCard,
} as const satisfies Record<ResolutionStatus, string>;

/** Inline text in the same hue as the card, for a count on a muted line. */
export const RESOLUTION_TEXT = {
  in_progress: TONE.inWorkText,
  resolved: TONE.doneText,
  wont_fix: TONE.wontFixText,
  needs_info: TONE.needsInfoText,
} as const satisfies Record<ResolutionStatus, string>;
