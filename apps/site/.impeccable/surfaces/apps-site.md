---
version: 1
slug: "apps-site"
primary_target: "apps/site"
related_targets: []
---

# Surface brief: marketing site (apps/site)

## Scope

- **Surface:** the InkUp marketing site at `inkup.liatr.io`, a single landing page for now.
- **Mode:** Persuade.

## Audience, job, action

- **Audience:** builders who review their own UI and hand fixes to AI coding agents.
- **What visitors should come away with:**
  - Talking and pointing produces located Change Items.
  - Those items are precise enough for a coding agent to act on.
  - InkUp is private and free to start.
- **Primary action:** Add to Chrome.
- **Secondary actions:**
  - Firefox, only once the listing is confirmed public;
  - `brew` for the CLI;
  - the macOS DMG;
  - GitHub.
- **Tracking:** every conversion is an Umami event.

## Proof and content

- Real product captures come from the capture pipeline (Slice 4).
- Until they exist, frames are labelled synthetic.
- The repo is MIT and public.
- There are no testimonials, logos or numbers.

## Constraints

- Keep the mark and its colours unchanged.
- Liatrio appears as "InkUp by Liatrio" in the footer lockup, with the official Liatrio logo following liatrio.com/brand
  rules.
- WCAG 2.2 AA.
- Respect reduced motion.
- Static Astro on GitHub Pages.

## Direction contract

THESIS: The site is a live page under the browser inspector. Speech and a red-pen Stroke resolve to inspected elements,
and each one becomes a located Change Item. It refuses the dark developer-tool landing page: glowing terminal, gradient
washes and a bento card grid.

OWN-WORLD:

- White page ground, with ink-navy `#1F2A44` for text and chrome.
- Red-pen `#E5484D` is used only for the reviewer's marks.
- The only other colour fields are the devtools box-model tints, laid as translucent overlays on real page elements:
  margin `#F9CC9D`, padding `#C3D08B`, content `#8CB6C0`.
- Selector tag chips: navy fill, white code text, with an arrow notch.
- Hairline measurement guides.
- DOM-tree indentation gives lists their structure.
- A precise grotesk carries the page; a code face appears only inside selector tags and Change Item fields.

STORY:

1. The visitor watches the site itself get reviewed.
2. They understand that talk plus point gives located items.
3. They see those items being claimed and resolved by an agent.
4. They add the extension.

FIRST VIEWPORT:

- The H1 sits inside an inspector box-model overlay with an `h1` tag.
- A red-pen loop draws around the Add to Chrome button, with a transcript line: "make this the first thing people see".
- The tag snaps into a Change Item card docked at the right edge, carrying the element, the quote and a timestamp.
- Add to Chrome sits in the hero and in the nav.

Signature interaction:

- As you scroll, the inspector moves through the page's own sections: overlay, Stroke, then a Change Item joins a docked
  Items panel.
- At the Agents section, the items go In work → Done.
- Reduced motion shows the final state.

FORM: Browser devtools element inspector. It was number 1 on my ordered list, the IMPECCABLE'S PICK card, and Daniel
chose it. Seed key 15ab832c.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and
every shipping raster carrying its provenance

## Unresolved

- Whether Firefox AMO and Safari are public.
- Whether a real demo video exists. It waits on Slice 4.
