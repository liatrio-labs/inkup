# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- The product is:
  - a browser extension: WXT, Manifest V3, Chrome, Firefox and Safari from one codebase;
  - a Rust host: the `inkup` CLI and TUI, a SQLite store and an MCP server;
  - a macOS desktop app: Tauri with React and shadcn.
- The marketing site is Astro, static, in `apps/site`, on GitHub Pages at `inkup.liatr.io`. Daniel chose this stack.

## Users

The primary users are builders who review their own UI and hand the fixes to AI coding agents:

- product people, designers, founders and developers;
- reviewing a site they own or work on;
- handing the fixes to Claude Code, Cursor or Codex.

They want to talk, point at the page and move on, without writing tickets by hand.

The secondary users are the implementers who consume the output, whether a person or a coding agent. They need every
item to be clear about *what* should change and *where*.

The site's audience is the same public, open-source group, not a client-only audience.

## Product Purpose

InkUp lets you review a web page out loud:

- You talk and draw on the page.
- InkUp turns the Session into a list of located Change Items.
- Each item names its element, carries a screenshot and a transcript excerpt, and says what should change.

Spoken feedback from the person with the most product context is fast to give but slow to turn into written, located
change requests. InkUp removes that gap.

Success over the next few months:

- people install the extension and run real Sessions;
- people pair the host and hand Change Items to coding agents over MCP;
- the GitHub project grows a community of stars, issues and contributors;
- InkUp raises Liatrio's profile in AI-assisted delivery.

## Positioning

- **Speech and drawing resolve to page elements.** When you say "this" or "here" while you draw a Stroke, InkUp resolves
  it to a concrete element.
- **The output is actionable Change Items, not a transcript or a recording.** A person can act on them, or a coding
  agent can claim and resolve them over MCP.
- **It is local first and free to start.**
  - Transcription runs on the device, and the free tier sends nothing anywhere.
  - There is no backend and no sign-in. You bring your own keys for paid transcription or processing.

## Operating Context

- The user reviews in their own browser, on their own site or a staging URL.
- They press a shortcut (Alt+Shift+R) or click the toolbar icon, then talk, draw and press Stop.
- Process sends the Session to Claude and returns Change Items. The model watches the recording, and every item is
  checked before it is shown.
- The Change Items then leave in one of two ways:
  - exported as a zip with `session.json`, screenshots and an agent prompt;
  - handed over MCP to an agent that calls `start_item` and `resolve_item`, while the reviewer sees the item move to In
    work and then Done.

## Capabilities and Constraints

**Capabilities:**

- A floating toolbar that never appears in screenshots.
- Stroke drawing, Object Select and Select Text.
- Viewport presets for phone, tablet and desktop.
- Voice Commands: "scratch that", "next", "pin that", "snap", "pause", "resume".
- Live Draft Items while you talk (needs an Anthropic key).
- Source mapping, plus the page API `window.__inkup`.
- Network mode for pairing across a LAN.

**Host:**

- `inkup` (TUI) and `inkup serve`.
- `inkup mcp install` for Claude Code, Cursor and Codex.

**Install:**

- **Extension:** Chrome Web Store (unlisted listing), Firefox AMO, and the zip from GitHub Releases.
- **CLI:** `brew install liatrio-labs/tap/inkup`, or the shell and PowerShell installers. It runs on macOS, Linux and
  Windows.
- **Desktop app:** `brew install --cask liatrio-labs/tap/inkup`, or the DMG. It is macOS only.

**Terminology:** use the capitalized terms in `CONTEXT.md` (Session, Stroke, Annotation, Change Item, Draft Item, Voice
 Command, Resolution) and avoid its listed synonyms. For example, a Change Item is never a "ticket", "task" or "note".

**Versions:** the extension and host are versioned separately. See `.release-please-manifest.json`.

**Undecided:** whether the Firefox AMO listing and the Safari build are public. Link them only once they are confirmed.

## Brand Commitments

- **Name:** InkUp, one word, with a capital I and a capital U.
- **Mark:** `extensions/web/assets/icon.svg`, with `icon-small.svg` for 16–32 px.
  - An ink-navy `#1F2A44` rounded tile.
  - A hand-drawn red-pen `#E5484D` open circle that overshoots where the pen started.
  - A white up-chevron: the "Up".
  - The mark is kept. The brand expands around it.
- **Ownership:** InkUp has its own identity, credited as "InkUp by Liatrio".
  - The credit uses Liatrio's official logo, unaltered, from liatrio.com/brand: the main logo on light grounds and the
    reverse-colour logo on dark ones.
  - It keeps clear space equal to the height of the logo's 'L'.
  - Otherwise InkUp uses no Liatrio colours or fonts.
- **Voice:** plain, declarative and specific. Short sentences in the active voice. No hype.
- **License:** MIT, © Liatrio, Inc. Open source at `github.com/liatrio-labs/inkup`.

## Evidence on Hand

- **None yet:** testimonials, customer logos, usage numbers and benchmarks. Never fabricate them.
- **Proof comes from the product itself:**
  - real captures of the extension recorded by a scripted Playwright pipeline against the fixture site
    (`fixtures/site`);
  - the public repo, its README and its ADRs.
- **Until real captures exist:** illustrative frames must be labelled synthetic.

**The marketing site** uses cookieless Umami analytics with no consent banner. It counts pageviews and conversions:
 install and download clicks, brew-command copies, and GitHub clicks.

## Product Principles

1. **Talk and point; the product does the writing.** Capturing feedback should feel faster than typing it.
2. **Every item is located and actionable.** An item without an element, a screenshot and an intent is not done.
3. **Local and private by default.** Nothing leaves the machine unless the user adds a key or pairs a host.
4. **Built for agent hand-off.** The output is shaped so a coding agent can claim it, do it and resolve it.
5. **Truthful and specific.** Claim only what ships, and in the product's own terms.

## Accessibility & Inclusion

- WCAG 2.2 AA for the site and the apps.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.
- Voice-first capture must always have a pointer and keyboard path. Object Select, Select Text and the toolbar controls
  already provide one.
