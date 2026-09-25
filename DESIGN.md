---
name: InkUp
description: Review a web page out loud. The page ground is white, the ink is navy, and the reviewer's pen is red.
colors:
  ink: "#1f2a44"
  ink-2: "#3a4663"
  muted: "#566077"
  paper: "#ffffff"
  paper-2: "#f4f6fa"
  paper-3: "#e9edf4"
  hairline: "rgb(31 42 68 / 0.16)"
  guide: "rgb(31 42 68 / 0.24)"
  pen: "#e5484d"
  pen-ink: "#c8323a"
  on-ink: "#ffffff"
  box-margin: "rgb(249 204 157 / 0.45)"
  box-padding: "rgb(195 208 139 / 0.4)"
  box-content: "rgb(140 182 192 / 0.2)"
  tag-bg: "#1f2a44"
  tag-fg: "#ffffff"
  tag-dim: "#aab4c8"
  done: "#1f7a4d"
  working: "#9a5b00"
  mark-tile: "#1f2a44"
  mark-pen: "#e5484d"
  mark-chevron: "#ffffff"
  ink-dark: "#e7ebf3"
  ink-2-dark: "#c3cadb"
  muted-dark: "#9aa4ba"
  paper-dark: "#141b2d"
  paper-2-dark: "#1a2238"
  paper-3-dark: "#232d47"
  hairline-dark: "rgb(231 235 243 / 0.14)"
  guide-dark: "rgb(231 235 243 / 0.24)"
  pen-dark: "#ff6b70"
  pen-ink-dark: "#ff8a8e"
  on-ink-dark: "#141b2d"
  box-margin-dark: "rgb(249 204 157 / 0.2)"
  box-padding-dark: "rgb(195 208 139 / 0.2)"
  box-content-dark: "rgb(140 182 192 / 0.14)"
  tag-bg-dark: "#e7ebf3"
  tag-fg-dark: "#141b2d"
  tag-dim-dark: "#56607a"
  done-dark: "#5cc98f"
  working-dark: "#f0b35a"
  mark-ring-dark: "rgb(231 235 243 / 0.28)"
typography:
  display:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 1.8rem + 4vw, 5.4rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.04em"
    fontFeature: "'ss01'"
  headline:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 1.6rem + 1.9vw, 3.3rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.025em"
    fontFeature: "'ss01'"
  lede-large:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.3rem + 0.9vw, 2.1rem)"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "-0.012em"
    fontFeature: "'ss01'"
  subhead:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.2rem, 1.1rem + 0.45vw, 1.45rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.025em"
    fontFeature: "'ss01'"
  lede:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.2rem, 1.1rem + 0.45vw, 1.45rem)"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'ss01'"
  body:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1rem, 0.96rem + 0.2vw, 1.125rem)"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "'ss01'"
  small:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(0.83rem, 0.8rem + 0.15vw, 0.9rem)"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "'ss01'"
  label:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
  wordmark:
    fontFamily: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 750
    letterSpacing: "-0.035em"
  code:
    fontFamily: "'Fragment Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "0.9em"
    fontWeight: 400
  tag:
    fontFamily: "'Fragment Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  tag: "4px"
  s: "6px"
  m: "10px"
  l: "14px"
  pill: "999px"
  mark: "28px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.5rem"
  "6": "2rem"
  "7": "3rem"
  "8": "4.5rem"
  "9": "7rem"
  gutter: "clamp(1rem, 4vw, 2.5rem)"
  dock: "21rem"
  container: "80rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.m}"
    padding: "0 1.25rem"
    height: "2.9rem"
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.on-ink}"
  button-primary-hero:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.m}"
    padding: "0 1.6rem"
    height: "3.4rem"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.m}"
    padding: "0 1.25rem"
    height: "2.9rem"
  button-small:
    rounded: "{rounded.m}"
    padding: "0 0.9rem"
    height: "2.3rem"
  tag-chip:
    backgroundColor: "{colors.tag-bg}"
    textColor: "{colors.tag-fg}"
    typography: "{typography.tag}"
    rounded: "{rounded.tag}"
    padding: "0.28em 0.55em"
  change-item:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.small}"
    rounded: "{rounded.m}"
    padding: "{spacing.4}"
  change-item-compact:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.m}"
    padding: "0.75rem 1rem"
  status-pill:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.15em 0.55em"
  status-pill-working:
    textColor: "{colors.working}"
  status-pill-done:
    textColor: "{colors.done}"
  items-dock:
    backgroundColor: "{colors.paper}"
    width: "{spacing.dock}"
  count-badge:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.pill}"
    padding: "0.1em 0.5em"
  copy-command:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.m}"
    padding: "0.5rem 0.5rem 0.5rem 1rem"
  copy-command-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.s}"
    padding: "0 0.75rem"
    height: "2.25rem"
  capture-frame:
    backgroundColor: "{colors.paper-2}"
    rounded: "{rounded.l}"
  mark:
    backgroundColor: "{colors.mark-tile}"
    rounded: "{rounded.mark}"
    size: "128px"
---

# Design System: InkUp

This file is product-wide. The marketing site (`apps/site`) is the first surface built on it, and its tokens live in
`apps/site/src/styles/global.css`. The browser extension and the desktop app adopt it later (see Known gaps). The
frontmatter is normative; where prose and frontmatter disagree, the frontmatter wins.

## Overview

**Creative North Star: "The Inspected Page"**\
InkUp's world is a live page under the browser's element inspector, being reviewed by someone with a red pen. The
ground is white paper and the text and chrome are ink-navy. The only other colour fields are the devtools box-model
tints, laid as translucent overlays on real elements, and the only warm accent is the reviewer's red pen. Structure is
drawn the way the inspector draws it: hairlines, dashed measurement guides, selector tag chips and DOM-tree
indentation. Nothing is decorative that the inspector or the reviewer would not have put there.

The system is quiet and precise so the pen can be loud. One precise grotesk carries everything, and a code face
appears only where the inspector would show code. Surfaces are flat with hairline edges; the two shadows belong to
things that float over the page, like a Change Item or a capture.

The world refuses the dark developer-tool landing page: the glowing terminal, gradient washes and a bento card grid.
It also refuses invented proof. Everything the page shows is either the real product or labelled as an illustration.

**Key Characteristics:**

- White paper, ink-navy text, one red pen, three inspector tints.
- Reviewer marks (loops, quote rules, timestamps, selectors) are the only red on the page.
- Schibsted Grotesk for everything; Fragment Mono only for code, selectors and timestamps.
- Flat surfaces, hairline borders, dashed guides; shadows only on floating cards.
- One orchestrated motion: the page reviews itself. No scattered entrance effects.
- Light and dark follow `prefers-color-scheme`; both are first-class.

## Colors

A restrained ink-on-paper palette with one red accent reserved for the reviewer's hand, and the browser inspector's
own box-model tints as the only other colour.

### Primary

- **Ink Navy** (`ink`): all body text, headings, primary buttons, the count badge and the selector tag chip. It is
  also the mark's tile colour (`mark-tile`), so the brand and the page's ink are the same navy. In dark mode ink
  becomes a pale blue-white (`ink-dark`) and the ground becomes navy.
- **Ink Navy, secondary** (`ink-2`): ledes, supporting paragraphs, list items and the hover state of primary
  buttons.

### Secondary

- **Red Pen** (`pen`): the reviewer's marks. It strokes the pen loops, the quote rule on a Change Item, and the border
  flash when an item lands in the dock. At 3.9:1 on white it is a mark colour, never a text colour.
- **Red Pen, as text** (`pen-ink`): selectors and timestamps set in red: the selector on a Change Item, the timestamp
  beside the hero quote and the selector in the agents run list. It is darker than `pen` so it passes AA as text
  (5.3:1 on white).

### Tertiary

- **Box-model margin** (`box-margin`, the inspector's `#F9CC9D`), **padding** (`box-padding`, `#C3D08B`) and
  **content** (`box-content`, `#8CB6C0`): translucent overlays on inspected elements only. Content also tints text
  selection and the hover row of the capability tree. Dark mode drops their alpha so they sit on navy without glowing.

### Neutral

- **Paper** (`paper`): the page ground, Change Item cards, secondary buttons and the copy button.
- **Paper 2** (`paper-2`): recessed grounds: the copy-command well, the capture frame's letterbox and the footer.
- **Paper 3** (`paper-3`): reserved as the third ground step; not yet used by a shipped component.
- **Muted** (`muted`): metadata, notes, status pills at rest, the shell prompt and the footer text (6.3:1 on white).
- **Hairline** (`hairline`): every border, divider and rule.
- **Guide** (`guide`): the inspector's dashed measurement guides.
- **On ink** (`on-ink`): text on an ink fill.
- **Tag** (`tag-bg`, `tag-fg`, `tag-dim`): the selector chip's fill, its code text and the dimmed live size. In dark
  mode the chip inverts to a pale fill with navy text.

### Status

- **In work** (`working`, amber) and **Done** (`done`, green): the two resolution states of a Change Item, on its
  status pill and in the agents run list. Open uses `muted`. These colours mean status and nothing else; `done` also
  marks a successful copy.

### Named Rules

**The Red Pen Rule.** Red pen is the reviewer's hand. Use it only for reviewer marks: pen loops, selectors in
`pen-ink`, quote rules, timestamps, and the flash when an item lands. The keyboard focus ring is `ink`, and a hovered
link's underline takes the text colour. Never use red pen for a fill, a heading, a button, an icon, an error, focus or
decoration.

**The Inspector Tint Rule.** The box-model tints appear only as translucent overlays on real elements (or as the
inspector's own hover and selection tint). They are never section backgrounds, card fills or chart colours.

**The Status Colour Rule.** Amber and green mean In work and Done. Don't reuse them for emphasis, badges or success
decoration.

## Typography

**Display Font:** Schibsted Grotesk Variable (with Schibsted Grotesk, ui-sans-serif, system-ui)
**Body Font:** Schibsted Grotesk Variable, the same family
**Label/Mono Font:** Fragment Mono (with ui-monospace, SF Mono, Menlo)

**Character:** A tight, newsy grotesk set with stylistic set 01 and negative tracking on headings, paired with a
narrow, even mono that reads as the inspector's own code text.

Both faces are self-hosted through Fontsource. The type scale is fluid (`--step--1` to `--step-4`), each step a
`clamp()` so it grows with the viewport without breakpoints.

### Hierarchy

- **Display** (700, `--step-4`, line-height 0.98, tracking -0.04em): the hero H1 only, capped at 11ch.
- **Headline** (700, `--step-3`, 1.05, -0.025em): section H2s, capped at 18ch; the closing H2 at 14ch.
- **Lede large** (400, `--step-2`, 1.3, -0.012em): the hero lede at 36ch. The privacy promise uses this step at 600.
- **Subhead** (700, `--step-1`): step and install-row H3s. The capability tree's summaries use `--step-1` at 600.
- **Lede** (400, `--step-1`, 1.45): the paragraph under a section H2, at 58ch, in `ink-2`.
- **Body** (400, `--step-0`, 1.55): running text, with `text-wrap: pretty`; long paragraphs cap at 60 to 62ch.
- **Small** (400, `--step--1`): metadata, notes, nav links (550), Change Item bodies and the footer.
- **Label** (600, 0.72 to 0.8rem, 1.4): status pills, the Optional pill and the count badge, in sentence case.
- **Wordmark** (750, tracking -0.035em): "InkUp" beside the mark; 1.3rem in the nav, 1.15rem in the footer.
- **Code** (Fragment Mono, 400, 0.9em): inline code, `kbd`, shell commands, selectors and timestamps.
- **Tag** (Fragment Mono, 400, 0.78rem, 1.2): the selector chip.

### Type Rules

**The One Family Rule.** Schibsted Grotesk sets every word of interface and prose. Fragment Mono appears only for
code, selectors, shell commands, keys and timestamps. Never set a heading, a label or a button in mono.

**The Sentence Case Rule.** Headings, buttons, pills and labels are sentence case. No all-caps labels, no letterspaced
kickers or eyebrows above headings.

## Layout

The page is a single reading column inside an 80rem container with a fluid gutter (`clamp(1rem, 4vw, 2.5rem)`). At
72rem and wider a second column opens on the right for the Items dock (21rem), separated by a `--space-8` gap; below
that width the dock is hidden and each section shows its Change Item inline under its content (max 30rem).

Sections are generous and vertical: `--space-9` above, `--space-8` below. Content blocks inside a section step down
through `--space-8`, `--space-7` and `--space-6`. The spacing scale runs 0.25rem to 7rem in nine steps; use its steps,
not ad-hoc values.

Breakpoints are 40rem (phone: tighter inspector boxes, pen loop pulled inside the gutter, hero buttons stacked above
the quote), 48rem (nav links hide, install and run rows collapse) and 72rem (the dock appears). The sticky nav is
translucent paper with a background blur and gains its hairline only after the page scrolls. Anchors scroll with 5rem
padding so headings clear the nav.

Lists take their structure from the DOM tree: the capability list is an indented tree with a hairline on its left
edge and disclosure carets; fact lists use a short hairline dash as a marker. Rows (install, agents run) are divided by
hairlines, not boxed.

The inspector's measurement guides run across the page to the gutter and stop; beside the dock they stop just past
the page column. Pen strokes may overshoot their element but never widen the page (`overflow-x: clip`).

## Elevation & Depth

Flat by default. Depth comes from hairline borders and the paper steps, not shadows. Two shadows exist, both tinted
with ink (pure black in dark mode) and both reserved for things that float above the page: a Change Item card and a
capture frame. The sticky nav is lifted by blur and translucency, not a shadow.

### Shadow Vocabulary

- **Card** (`--shadow-card`): Change Item cards and the capture frame at rest.
- **Lift** (`--shadow-lift`): only the moment a Change Item lands in the dock; it settles back to Card.

### Elevation Rules

**The Floating Card Rule.** Only a Change Item and a capture cast a shadow. Rows, lists, sections, the dock and the
copy command are flat with hairlines.

## Shapes

Gently rounded, never soft. Three radii cover almost everything: small (6px) for the copy button, the skip link and
tree rows; medium (10px) for buttons, Change Items and the copy command; large (14px) for the capture frame. Pills
(999px) are for status, Optional and the count badge. The selector tag chip is squarer (4px), with a 5px arrow notch
pointing at its element, as the inspector draws it. The focus ring is 2px with a 3px offset and a 4px radius.

Two shapes are hand-drawn: the mark's tile (radius 28 on a 128 grid) and the pen loop, an open circle that overshoots
where the pen started. Everything else is straight lines: hairlines, dashed guides and the step numbers' 1.5px ink
circles.

## Components

### The mark

- **Drawing:** an ink-navy rounded tile (`mark-tile`, radius 28 on a 128 grid), a hand-drawn red-pen open loop
  (`mark-pen`) that overshoots where the pen started, and a white up-chevron (`mark-chevron`), the "Up" in InkUp. The
  masters are `extensions/web/assets/icon.svg` and `icon-small.svg`; the site's inline `Mark.astro` is the same
  drawing and must stay in step.
- **Sizes:** `icon-small.svg` (loop stroke 13, chevron 14) for 16 to 32 px, including the favicon and its 32 px PNG.
  `icon.svg` (loop 9, chevron 10) above that: the 180 px touch icon, the social card (56 px), and inline in the nav
  (30 px) and footer (26 px).
- **Dark-mode ring:** on a dark ground the navy tile sinks into the navy page (1.2:1), so the inline mark draws a
  2-unit inside ring in `mark-ring-dark`. The ring is transparent in light mode.
- **Usage:** keep the three colours, the proportions and the open loop exactly. Don't recolour, outline, add effects,
  or place the mark on a busy image. The mark is decorative beside the wordmark (`aria-hidden`); the link carries the
  name.

### The "InkUp by Liatrio" lockup

- **Order:** InkUp's mark and wordmark, then "by" in `muted`, then the official, unaltered Liatrio logo from
  liatrio.com/brand. The files are `apps/site/src/assets/liatrio/`.
- **Logo swap:** the main logo (`logo_Liatrio.svg`) goes on grounds lighter than 50% grey and the reverse logo
  (`logo_Liatrio_reverse-preferred.svg`) on darker grounds. The site swaps them with a `<picture>` source on
  `prefers-color-scheme: dark`.
- **Size and clear space:** the footer renders the logo 24px high. Clear space on every side equals the height of its
  "L" (about 0.63 of the logo's height, so 15px at 24px); the flex gap plus a 0.45rem margin gives that from "by".
- **Never** distort, recolour, re-draw or crop the Liatrio logo, and use no other Liatrio colours or fonts anywhere in
  InkUp. The logo's greens stay inside the logo.

### Inspector overlay and tag chip

- **Overlay:** wraps an element in the box-model rings: a margin ring (14px, 6px on phones), a padding ring (10px,
  6px on phones) and a content fill, in the three tints. Dashed `guide` hairlines extend the box's edges across the
  page and 3rem past it vertically. The wrapper's padding is pulled back out with a negative margin so wrapping never
  moves the layout.
- **Tag chip:** navy fill, white Fragment Mono text, the selector (`h1`, `a.cta`, `p.promise`) followed by the live
  size in `tag-dim` (`1024 × 96`), and a 5px notch pointing at the box. It sits above the box by default, below when
  there is no room.
- **Probe:** holding Alt on a fine pointer inspects any element on the page with the same chip and a content-tint box.

### Pen loop (Stroke)

- **Character:** the mark's open loop, stretched around whatever the reviewer circles: an open, overshooting ellipse.
- **Stroke:** `pen`, 3.5px, round caps and joins, non-scaling so the line stays a pen line at any size.
- **Placement:** overshoots its element (about 22% above, 26% below, 9% to the sides) and sits above content without
  taking pointer events. On phones it pulls in to stay inside the gutter.
- **Use:** one loop per reviewed element, on the element the Change Item names. Never as a decorative circle.

### Change Item

- **Character:** a located change request, laid out as the review page shows it.
- **Anatomy:** a title (650, 1rem) with a status pill; the selector in `pen-ink` mono and the timestamp in muted mono;
  the quote in `ink-2` behind a 1px `pen` rule; a resolution note once an agent resolves it. The compact variant (in
  the dock after the first item) drops the quote.
- **Card:** paper, hairline border, medium radius, Card shadow, 1rem padding.
- **Status pill:** Open (muted, hairline border), In work (`working`) and Done (`done`), each with a border in its
  own colour. Only true things are Done: an item whose work hasn't happened stays In work.

### Items dock (side pane)

- **Character:** the review's side panel, not a floating widget.
- **Layout:** a sticky 21rem pane on the right at 72rem and wider, with a hairline left edge on paper, a "Change
  Items" heading, an ink count badge and a muted note that says it is an example review. It scrolls on its own and
  contains its overscroll. Below 72rem it is hidden and items render inline in their sections.
- **Without JS** it lists every item; with JS each item waits until its section is reviewed.

### Copy command

- **Anatomy:** a `paper-2` well with a hairline border and medium radius; a muted, unselectable `$` prompt; the
  command in Fragment Mono, wrapping between words and never inside one; a paper Copy button (small radius, a 1.8px
  stroked copy icon, 600 small text).
- **States:** hover darkens the button's border to `ink-2`; on success the label reads "Copied" in `done` for 1.8s;
  if the clipboard fails it reads "Select and copy".
- Every copy is a conversion and names its analytics event.

### Capture frame

- **Frame:** large radius, hairline border, `paper-2` letterbox, Card shadow, clipped. The media fills its width.
- **Content order:** a real video capture wins over a still, and a still over the fallback. The fallback is a
  labelled illustration (see Capture framing).
- Videos are muted, inline and looped, load nothing until needed, play only while on screen and never under reduced
  motion.

### Buttons

- **Primary:** ink fill, `on-ink` text, 600 weight, medium radius, 2.9rem tall; hover lightens to `ink-2`, press
  nudges down 1px. The hero's install button is the large size (3.4rem, `--step-1`); the nav's is the small size
  (2.3rem, `--step--1`).
- **Secondary:** paper with a hairline border; hover darkens the border to `ink-2`.
- **Text link:** 600 small text, underlined 1px with a 0.2em offset; the underline turns `pen` on hover.
- Icons in buttons are inline 24-unit SVG strokes at 1.1em. The install button is the one primary action per view.

### Supporting patterns

- **Numbered steps:** a real sequence, numbered in 2rem circles with a 1.5px ink border.
- **Capability tree:** `details` rows with a CSS caret that rotates on open; rows tint with `box-content` on hover.
- **Keys:** `kbd` with a hairline border and a 2px bottom edge, small radius.
- **Optional pill:** a hairline pill in muted label type beside a heading, for the host and desktop app.

### Motion: the page reviews itself

There is one orchestrated sequence and no other entrance effects. Each reviewed section is inspected, circled and
turned into a Change Item as it scrolls into view (20% visible, 35% up from the bottom), and the agents section
resolves the items in turn.

- **Easing:** one curve, `cubic-bezier(0.16, 1, 0.3, 1)`, for everything.
- **Inspect:** the overlay fades in over 280ms; the tag chip follows 80ms later, rising 4px over 380ms.
- **Stroke:** the pen loop draws on over 900ms after a 150ms beat, its dash measured in screen pixels.
- **Transcript:** the hero's quote and timestamp fade up 6px after 900ms, once the loop is drawn.
- **Arrive:** the Change Item snaps into the dock from 18px right at 98% scale over 520ms, flashing a `pen` border
  and the Lift shadow that settle to Card over 900ms. Skipped sections arrive in page order.
- **Resolve:** at the agents section every item goes In work at 350ms + 520ms per item, and Done 750ms later, except
  the items whose work isn't true yet.
- **Interface motion:** buttons and borders 160ms; the nav hairline 200ms; the tree caret 180ms.
- **Reduced motion:** the end state, all at once: every section inspected, every loop whole, every item in the dock
  and resolved to its end state, no smooth scrolling, no video playback.
- **Without JS:** everything is visible from the first paint; the script only holds back what hasn't happened yet.

## Do's and Don'ts

### Do

- **Do** keep the ground white paper (dark: navy `paper-dark`) and the text ink-navy.
- **Do** use red pen only for reviewer marks: pen loops, selectors in `pen-ink`, quote rules and timestamps, plus the
  focus ring and link-hover underline.
- **Do** set selector and timestamp text in `pen-ink`, never in `pen`.
- **Do** tie every pen loop to the element its Change Item names.
- **Do** lay the box-model tints only as translucent overlays on real elements.
- **Do** mark Change Item status with `working` and `done` and nothing else.
- **Do** use Schibsted Grotesk for all prose and interface text, and Fragment Mono only for code, selectors, keys and
  timestamps.
- **Do** draw structure with hairlines, dashed guides and DOM-tree indentation.
- **Do** keep motion inside the one review sequence, and give reduced motion the finished state.
- **Do** show the Liatrio logo only in the "InkUp by Liatrio" lockup, unaltered, main or reverse by the ground.

### Don't

- **Don't** build the dark developer-tool landing page: no glowing terminal, gradient washes or bento card grid.
- **Don't** use red pen as a fill, a button colour, an error colour, a heading colour or decoration.
- **Don't** give sections, cards or charts a box-model tint as a background.
- **Don't** add shadows to rows, sections, the dock or the copy command.
- **Don't** add scroll-triggered fades, parallax or staggered reveals outside the review sequence.
- **Don't** set headings, labels or buttons in mono, or in all caps with letterspacing.
- **Don't** put kickers or eyebrows above headings.
- **Don't** use glyph characters as icons in the interface; draw icons as inline SVG strokes.
- **Don't** recolour, outline or re-proportion the mark, or remove its dark-mode ring.
- **Don't** use Liatrio's greens, greys or fonts outside the Liatrio logo.

## Voice and Copy

The voice comes from PRODUCT.md; the terms come from CONTEXT.md. Copy is part of the system because the page's
reviewer marks quote it.

- Write plain words in sentence case: short declarative sentences in the active voice, no hype.
- No slogan pairs ("Talk less. Ship more.") and no rule-of-three rhythms. Lists are lists because the product has
  that many things.
- Never write "free tier". InkUp has no paid plan, and nothing useful comes out without the user's own Anthropic key;
  say "free and open source" and "you use your own AI keys".
- Never write an unqualified "no server" or "no backend". The optional host is a local server on the user's machine;
  say whose ("Liatrio runs no servers for InkUp", "the optional host runs on your own machine").
- No invented proof: no testimonials, customer logos, usage numbers or benchmarks until they exist.
- Label illustrative content as illustrative, on its face: the synthetic frame says "Illustration", and the dock says
  it is an example review.
- Use the glossary terms, capitalised: Session, Change Item, Stroke, Voice Command (and Draft Item, Annotation,
  Resolution). A Change Item is never a ticket, task or note.
- Name the Chrome action "Add to Chrome" once the store listing is live, and say plainly when a listing is in review.

## Capture Framing

Screenshots and videos of the product come from the scripted Playwright capture pipeline, not hand-made mock-ups.

- **Real extension:** captures show the actual built extension running, never a redrawn or doctored UI.
- **Synthetic demo page:** captures are recorded against the fixture site (`fixtures/site`), a made-up page, and the
  caption or alt text says it is a demo page; never a real company's site presented as a customer.
- **In the capture frame:** every capture sits in the capture frame (large radius, hairline, `paper-2` letterbox, Card
  shadow). Videos are muted and looped, with a poster still.
- **Until a capture exists:** the slot shows the HTML illustration (`SyntheticFrame`), which carries a visible
  "Illustration" label and an `aria-label` that starts with "Illustration". The illustration draws the extension's
  current UI (system font, zinc neutrals, its red); it depicts the other surface and does not set this system's
  tokens.
- **Provenance:** every shipping raster (captures, the social card `public/og.png`) records where it came from.

## Known Gaps

These are follow-ups, not done here.

- **Two reds.** The mark's red pen is `#E5484D`; the extension's toolbar uses Tailwind's `#dc2626` for its pressed and
  primary buttons. The apps should move to `pen` and `pen-ink`.
- **Stock apps.** The extension and the desktop app still use stock shadcn neutrals and system fonts. Adopting this
  system means the ink and paper scales, Schibsted Grotesk and Fragment Mono, and the radius scale.
- **Paper 3** is defined in both schemes but not yet used.
