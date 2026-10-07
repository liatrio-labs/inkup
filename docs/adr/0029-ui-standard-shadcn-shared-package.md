---
status: accepted
date: 2026-10-07
---

# Both apps build their UI with React, Tailwind and shadcn/ui from the shared `@inkup/ui` package, including the in-page capture surfaces

The extension and the desktop app each held their own copy of the shadcn/ui primitives, with stock neutrals and the
system font, while the extension's in-page surfaces (the toolbar, the comment box, the Object Select highlight) were
hand-built DOM with CSS in strings. The desktop app is about to grow its own toolbar and Review view (the
native-capture plan, Phase 1), and DESIGN.md is product-wide. Three copies of the same controls would drift apart in
looks and in behaviour.

**One UI package, `@inkup/ui` (`packages/ui`).** It holds the shadcn/ui primitives both apps use
(`packages/ui/src/components/`), the `cn` helper (`src/lib/utils.ts`), the theme (`src/styles/theme.css`), the
product fonts (`src/styles/fonts.css`) and `mountInShadow` (`src/mount-in-shadow.ts`). Like `@inkup/core` it ships its
TypeScript source with no build step; each app's Vite compiles it. The extension (pages and content script) and the
desktop app import from it, and neither keeps a `components/ui` directory of its own. `packages/core` and
`packages/protocol` never import it (`packages/core/tests/core-boundary.test.ts`).

**React + Tailwind + shadcn/ui for every surface, including capture surfaces.** The extension's pages, its in-page
surfaces (the toolbar, the viewport control, the comment box, the draw note, the Object Select highlight) and the
desktop app's window are React components styled with Tailwind on the package theme. No surface hand-rolls DOM chrome
(`document.createElement` trees with CSS strings); the drawing canvas, which is not chrome, stays as ADR 0011 has it.

**The shadcn CLI adds a primitive, in `packages/ui` only.** `packages/ui/components.json` is the workspace's only
`components.json`, so `pnpm dlx shadcn@latest add <name>` run from `packages/ui` writes to
`packages/ui/src/components/`; then `src/index.ts` exports it. A component built from primitives for one surface
lives in the package too, beside them, so the other app can import it.

**The theme is DESIGN.md's, on shadcn's variables.** `theme.css` maps DESIGN.md's palette (ink, paper, pen, muted,
hairline, done, working and their dark values) and `rounded` scale onto `--background`, `--foreground`, `--primary`,
`--destructive`, `--border`, `--radius` and the rest, for light and dark. Every text pair is at least 4.5:1
(`packages/ui/tests/theme.test.ts`), which is why `--destructive` is `pen-ink` in light: it is error text as well as a
fill, and `pen` is a mark colour at 3.9:1. Dark follows `prefers-color-scheme`, and `data-theme="light" | "dark"` on
the root (or a shadow host) wins over it, so the toolbar's page-driven theme (ADR 0011) holds whatever the system
scheme is.

**In-page surfaces add nothing to the page.** `mountInShadow(shadowRoot)` adopts the compiled Tailwind and theme into
the shadow root (`adoptedStyleSheets`, with `:root` rewritten to `:host`), or a `<style>` inside it where a browser
refuses a constructed sheet. The host document gains no `<style>`, `<link>` or `@font-face`, and in-page type is the
system stack (`ui-sans-serif, system-ui`). Schibsted Grotesk and Fragment Mono load only in the extension's pages and
the desktop app, bundled from Fontsource (`fonts.css`), never from a network.

## Considered options

- Keep a copy of the primitives in each app: the copies had already diverged, and the desktop's Phase 1 views would
  have meant a third copy of the toolbar.
- Keep the in-page surfaces as vanilla DOM and share only the primitives: two ways to build chrome, and the toolbar
  could not be imported by the desktop app.
- A web-component library for the in-page surfaces: a second component model beside React, with none of shadcn's
  primitives.
- A build step for the package (a `dist/`): the apps already compile TypeScript and Tailwind; a build would only add
  a stale-output failure mode, and `@inkup/core` set the precedent of source exports.

## Consequences

- The content script carries React for its surfaces, so the extension grows; the zip budget (under 200 KB over the
  pre-migration build) is checked when a surface moves.
- Each app's Tailwind scans `packages/ui/src` as well as its own source (`@source` in its `tailwind.css`), still scoped
  to source so the AMO sources zip rebuilds the same CSS. The Firefox sources zip includes `packages/ui`.
- A change to `packages/ui` runs both the extension and the desktop checks in CI (`scripts/ci-changes.ts` already
  routes `packages/` to both).
- Until spec 02 moves the review page's last imports, the extension resolves `@/components/ui/*` to the package
  through a path alias (`extensions/web/tsconfig.json`, `wxt.config.ts`) and `src/lib/utils.ts` re-exports `cn`.

## History

- 2026-10-07: first written, with the package, the theme, `mountInShadow` and both apps' primitives moved into it
  (spec 01, Unit 1). ADR 0025's "shadcn/ui only" rule was refined to "shadcn/ui and `@inkup/ui` components" the same
  day.

## Sources

- DESIGN.md and `.impeccable/design.json`: the palette, radii and type this theme carries.
- shadcn/ui theming and monorepo setup: <https://ui.shadcn.com/docs/theming>, <https://ui.shadcn.com/docs/monorepo>
- Tailwind CSS v4 custom variants: <https://tailwindcss.com/docs/dark-mode>
- Constructable stylesheets: <https://developer.mozilla.org/en-US/docs/Web/API/Document/adoptedStyleSheets>
