// The extension pages' status colours, in one place, each a light shade with its dark (prefers-color-scheme)
// pair. Text in every pair keeps WCAG AA contrast (4.5:1) on its own fill and on the page (tests/e2e/dark-mode.spec.ts).
// Neutral surfaces use the theme tokens (bg-background, bg-muted, text-muted-foreground) instead.

export const TONE = {
  /** A callout that asks for attention: a limit, a missing piece, a caveat. */
  note: 'bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100',
  /** The same callout's border, when it has one. */
  noteBorder: 'border-amber-300 dark:border-amber-800',
  /** A warning on a plain line. */
  warnText: 'text-amber-700 dark:text-amber-400',
  /** A strong warning on a plain line, e.g. the model's own doubts about an item. */
  warnStrongText: 'text-amber-950 dark:text-amber-200',
  /** Something worked: a test passed, the mic is on. */
  okText: 'text-green-700 dark:text-green-400',
  /** A connected dot. Not text. */
  okDot: 'bg-green-600 dark:bg-green-500',
  /** The panel's status pill while recording. */
  recordingBadge: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  /** The panel's status pill while paused. */
  pausedBadge: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  /** A low-confidence Change Item's card and its "check me" chip. */
  unsureCard: 'border-amber-400 bg-amber-50/40 dark:border-amber-700 dark:bg-amber-950/30',
  unsureChip: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  /** The frame of a screenshot, so it does not float on a dark page. */
  shotFrame: 'dark:border-white/20',
  /** A Change Item's Resolution: its card, and a count in the same hue on a plain line. */
  inWorkCard: 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100',
  inWorkText: 'text-sky-700 dark:text-sky-400',
  doneCard:
    'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-100',
  doneText: 'text-emerald-700 dark:text-emerald-400',
  needsInfoCard:
    'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100',
  needsInfoText: 'text-amber-700 dark:text-amber-400',
  /** A Change Item's vetting verdict pill (ADR 0009): checked, corrected, or left unverified. */
  vetCheckedBadge: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  vetCorrectedBadge: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-200',
  vetUnverifiedBadge: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
} as const;
