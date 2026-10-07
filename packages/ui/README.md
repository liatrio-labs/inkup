# @inkup/ui (packages/ui)

The shared UI of the extension and the desktop app (ADR 0028): the shadcn/ui primitives, the `cn` helper, the
DESIGN.md theme and `mountInShadow`. Like `@inkup/core` it ships TypeScript source with no build step; each app's Vite
compiles it. `pnpm -C packages/ui test` runs its tests.

- `src/components/`: the shadcn/ui primitives (alert, alert-dialog, badge, button, card, dialog, input, label,
  skeleton, sonner, switch, table, tabs, textarea, tooltip). Import them from `@inkup/ui`.
- `src/lib/utils.ts`: `cn`, clsx and tailwind-merge.
- `src/styles/theme.css`: DESIGN.md's palette and radii on shadcn's CSS variables, light and dark. Dark follows
  `prefers-color-scheme`; `data-theme="light" | "dark"` on the root, or on a shadow host, wins over it.
- `src/styles/fonts.css`: Schibsted Grotesk and Fragment Mono, bundled from Fontsource, for the extension's pages and
  the desktop app only. Never import it into anything that reaches a reviewed page.
- `src/styles/shadow.css` and `src/mount-in-shadow.ts`: `mountInShadow(shadowRoot)` adopts Tailwind and the theme
  into a shadow root, scoped to `:host`, with the system font stack and nothing added to the host document.

## Using it in an app

The app's stylesheet imports Tailwind, then the theme, and scans the package's source as well as its own:

```css
@import "tailwindcss" source("./");
@import "tw-animate-css";
@import "@inkup/ui/theme.css";
@import "@inkup/ui/fonts.css";
@source "<relative path to>/packages/ui/src";
```

## Adding a primitive

`packages/ui/components.json` is the workspace's only one, so the shadcn CLI writes here:

```sh
cd packages/ui
pnpm dlx shadcn@latest add <name>
```

Then export it from `src/index.ts`. The current CLI imports `cn` from the `cn` npm package and adds that dependency;
point the import at `@inkup/ui/lib/utils` and drop the dependency, so there is one `cn`.
