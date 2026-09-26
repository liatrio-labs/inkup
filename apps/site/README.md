# @inkup/site

The InkUp marketing site at <https://inkup.liatr.io>: static Astro, deployed to GitHub Pages by
`.github/workflows/site.yml` from main. ADR 0026 has the decisions.

## Develop

```sh
pnpm --filter @inkup/site dev      # http://localhost:4321
pnpm --filter @inkup/site check    # astro check
pnpm --filter @inkup/site build    # writes apps/site/dist
pnpm --filter @inkup/site preview  # serves the build
pnpm --filter @inkup/site icons    # re-renders the favicons from extensions/web/assets (needs rsvg-convert)
```

The versions and release links come from `.release-please-manifest.json` at build time (`src/releases.ts`).

## Environment

All are read at build time; none is needed locally.

| Variable | Default | What it does |
| --- | --- | --- |
| `SITE_URL` | `https://inkup.liatr.io` | The origin for canonical URLs, the sitemap and `robots.txt` |
| `SITE_BASE` | `/` | The path the site is served under, e.g. `/inkup` on `liatrio-labs.github.io` |
| `PUBLIC_UMAMI_WEBSITE_ID` | unset | Umami's website ID. Unset, the page loads no analytics script |
| `PUBLIC_UMAMI_SRC` | `https://cloud.umami.is/script.js` | Umami's script, for a self-hosted Umami |

The deploy sets `SITE_URL` and `SITE_BASE` from Pages, and the Umami pair from the `UMAMI_WEBSITE_ID` and `UMAMI_SRC`
repository variables.

## Analytics events

Umami is cookieless, honours Do Not Track and counts only on `inkup.liatr.io`. Conversions are `data-umami-event`
attributes on links and buttons. The names are a contract: dashboards and goals use them, so don't rename one.

| Event | When |
| --- | --- |
| `install-chrome` | Add to Chrome |
| `install-firefox` | Add to Firefox |
| `download-dmg` | The macOS app download |
| `copy-brew-cli` | Copy the Homebrew command for the `inkup` CLI |
| `copy-brew-cask` | Copy the Homebrew command for the desktop app |
| `github` | A link to the GitHub repository |

Add `data-umami-event-location` with `hero`, `install` or `footer` to say where the click came from:

```html
<a href="…" data-umami-event="install-chrome" data-umami-event-location="hero">Add to Chrome</a>
```
