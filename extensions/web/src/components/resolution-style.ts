// How a Change Item's Resolution reads and looks: the review page's cards and the Session list's counts share these.

export const RESOLUTION_LABEL = {
  in_progress: 'In work',
  resolved: 'Done',
  wont_fix: "Won't fix",
  needs_info: 'Needs info',
} as const;

/** A card's box: border, fill and text. */
export const RESOLUTION_STYLE = {
  in_progress: 'border-sky-300 bg-sky-50 text-sky-950',
  resolved: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  wont_fix: 'bg-muted',
  needs_info: 'border-amber-400 bg-amber-50 text-amber-950',
} as const;

/** Inline text in the same hue as the card, for a count on a muted line. */
export const RESOLUTION_TEXT = {
  in_progress: 'text-sky-700 dark:text-sky-400',
  resolved: 'text-emerald-700 dark:text-emerald-400',
  wont_fix: 'text-emerald-700 dark:text-emerald-400',
  needs_info: 'text-amber-700 dark:text-amber-400',
} as const;
