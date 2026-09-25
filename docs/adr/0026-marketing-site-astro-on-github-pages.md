---
status: accepted
date: 2026-09-25
---

# The marketing site is a static Astro build in `apps/site`, deployed to GitHub Pages at inkup.liatr.io from main only

InkUp had no public page. The site lives in the monorepo so it can show the released versions and, later, the
product's own screenshots, but it must not slow down or version the product.

**Static Astro in `apps/site`.** `@inkup/site` is an Astro project with static output and no server. It reads the
released versions from `.release-please-manifest.json` at build time (`apps/site/src/releases.ts`), so a page never
names a release by hand. `site` and `base` come from `SITE_URL` and `SITE_BASE` (`apps/site/astro.config.ts`), and
default to `https://inkup.liatr.io` and `/`.

**GitHub Pages at inkup.liatr.io.** `.github/workflows/site.yml` deploys the build with the Pages actions. It takes
`SITE_URL` and `SITE_BASE` from `actions/configure-pages`, so the build follows the Pages address: under `/inkup` on
`liatrio-labs.github.io` until the custom domain is live, under `/` after. A `SITE_BASE` repository variable overrides
the path. DNS is a CNAME from `inkup.liatr.io` to `liatrio-labs.github.io`, kept in `liatrio/liatrio-external-dns`.

**CI builds the site only when its inputs change.** `scripts/ci-changes.ts` has a `site` route (ADR 0007): `apps/site/`,
`site.yml`, the workspace's install files and the release-please manifest run the `site` job (`astro check` and the
build), and a site-only change runs nothing else.

**Deploys only from main.** The deploy runs on a push to main that touches `apps/site/`, `site.yml` or the manifest, on
a published `inkup-v*` host release (so the download links point at a release that exists), and by hand. Pull
requests never deploy.

**Cookieless analytics, with conversions as named events.** The layout (`apps/site/src/layouts/Base.astro`) loads
Umami only when the build has `PUBLIC_UMAMI_WEBSITE_ID`, from `PUBLIC_UMAMI_SRC` (default Umami Cloud,
`https://cloud.umami.is/script.js`), so a self-hosted Umami is a variable change. Umami sets no cookies, honours Do Not
Track and counts only on `inkup.liatr.io`, so the site has no consent banner. `site.yml` takes both from the
`UMAMI_WEBSITE_ID` and `UMAMI_SRC` repository variables; CI builds without them. Conversions are `data-umami-event`
attributes on the calls to action, and their names are a contract that dashboards and goals rely on: `install-chrome`,
`download-chrome-zip`, `download-firefox-zip`, `install-firefox`, `download-dmg`, `copy-brew-cli`, `copy-brew-cask`,
`copy-mcp-install`, `github` and `liatrio`, with `data-umami-event-location` (such as `hero`, `nav`, `install`,
`closing` or
`oss`) saying where. Until the Chrome Web Store listing is live, `install-chrome` jumps to the manual install steps. A
rename is a new event, not an edit.

**Product media is recorded from the real extension.** The site's screenshots and clips
(`apps/site/src/assets/captures`, listed in its `manifest.json`) come from `tests/e2e/site-captures.spec.ts`, which
drives the built extension on a fictional page (`fixtures/site/demo-store.html`) with scripted speech and the local
Anthropic stub, never a paid API. `.github/workflows/site-captures.yml` runs it on Linux: on a pull request that
changes its inputs it uploads the set as an artifact, and by hand or on an `inkup-extension-v*` release it opens a
pull request with the refreshed files. Nobody edits the captures by hand.

**Never released.** The site is not a release-please component, and `apps/site` is in the root component's
`exclude-paths`, so site commits never bump the host's version or changelog.

## Considered options

- A separate repository: the versions and, later, the screenshots would have to be copied across by hand or by a bot.
- Next.js or a plain Vite app: the site is static pages; Astro ships no JavaScript by default and builds them directly.
- Hosting other than Pages: Pages is free for the public repo and deploys from the workflow with no secrets.
- Google Analytics or another cookie-based tool: it needs a consent banner, and sends more than page views and a few
  events.

## Consequences

- A release deploy runs from the release's tag. The `github-pages` environment must allow `inkup-v*` tags as well as
  main, or that deploy is refused.
- Astro's type check (`astro check`) needs TypeScript 6, so `apps/site` pins its own TypeScript below the workspace's.

## History

- 2026-09-25: first version, with a one-page site and Umami Cloud analytics (free Hobby tier; self-hosted later).
- 2026-09-25: we planned hand-made placeholders for the product media; now it is recorded from the real extension
  by `site-captures.yml`, so it cannot drift from the product.

## Sources

- <https://docs.astro.build/en/guides/deploy/github/>
- <https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages>
