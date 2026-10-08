// The extension pages' status colours, in one place, on the DESIGN.md theme tokens (theme.css), so each follows the
// scheme by itself and needs no `dark:` pair. The hues keep DESIGN.md's meanings:
// - `done` (green) and `working` (amber) are the two Resolution states, and the vetting verdicts that say the same
//   (checked, corrected). `done` also marks something that worked.
// - `pen` is the reviewer's hand: the recording pill, and whatever asks the reviewer to look (check me, unverified,
//   needs info). It is a mark, never a fill; as text it is `pen-ink`.
// - `muted` grounds the callouts, which are notes, not alarms.
// Pills and Resolution boxes follow DESIGN.md's status pill: a border in its own colour, no tinted fill. Every text
// colour here keeps WCAG AA (4.5:1) on its own fill and on the page, card and muted grounds, light and dark
// (tests/tone.test.ts here; tests/e2e/dark-mode.spec.ts in a browser).

export const TONE = {
  /** A callout that asks for attention: a limit, a missing piece, a caveat. */
  note: 'bg-muted text-foreground',
  /** The same callout's border, when it has one. */
  noteBorder: 'border-guide',
  /** A warning on a plain line. */
  warnText: 'text-working',
  /** A strong warning on a plain line, e.g. the model's own doubts about an item: ink behind a working rule. */
  warnStrongText: 'border-l-2 border-working pl-2 text-foreground',
  /** Something worked: a test passed, the mic is on. */
  okText: 'text-done',
  /** A connected dot. Not text. */
  okDot: 'bg-done',
  /** A dot for anything else (offline, waiting). Not text. */
  restDot: 'bg-muted-foreground/50',
  /** The panel's status pill while recording: the reviewer's pen is down. */
  recordingBadge: 'border-pen text-pen-ink',
  /** The panel's status pill while paused: work on hold. */
  pausedBadge: 'border-working text-working',
  /** The panel's status pill at rest (DESIGN.md: muted, hairline border). */
  idleBadge: 'border-border text-muted-foreground',
  /** A low-confidence Change Item's card and its "check me" chip. */
  unsureCard: 'border-pen',
  unsureChip: 'border border-pen text-pen-ink',
  /** The frame of a screenshot, so it does not float on a dark page. */
  shotFrame: 'dark:border-guide',
  /** A Change Item's Resolution: its box, and a count in the same hue on a plain line. */
  inWorkCard: 'border-working bg-background text-foreground',
  inWorkText: 'text-working',
  doneCard: 'border-done bg-background text-foreground',
  doneText: 'text-done',
  needsInfoCard: 'border-pen bg-background text-foreground',
  needsInfoText: 'text-pen-ink',
  wontFixCard: 'border-border bg-muted text-muted-foreground',
  wontFixText: 'text-muted-foreground',
  /** A Change Item's vetting verdict pill (ADR 0009): checked, corrected, or left unverified. */
  vetCheckedBadge: 'border border-done text-done',
  vetCorrectedBadge: 'border border-working text-working',
  vetUnverifiedBadge: 'border border-pen text-pen-ink',
} as const;

export type Tone = keyof typeof TONE;
