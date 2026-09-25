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

**Never released.** The site is not a release-please component, and `apps/site` is in the root component's
`exclude-paths`, so site commits never bump the host's version or changelog.

## Considered options

- A separate repository: the versions and, later, the screenshots would have to be copied across by hand or by a bot.
- Next.js or a plain Vite app: the site is static pages; Astro ships no JavaScript by default and builds them directly.
- Hosting other than Pages: Pages is free for the public repo and deploys from the workflow with no secrets.

## Consequences

- A release deploy runs from the release's tag. The `github-pages` environment must allow `inkup-v*` tags as well as
  main, or that deploy is refused.
- Astro's type check (`astro check`) needs TypeScript 6, so `apps/site` pins its own TypeScript below the workspace's.

## History

- 2026-09-25: first version, with a one-page site.

## Sources

- <https://docs.astro.build/en/guides/deploy/github/>
- <https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages>
