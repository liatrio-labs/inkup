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
| `install-chrome` | The primary install button: Add to Chrome, or Install for Chrome while the store listing is in review (it then jumps to the manual steps) |
| `download-chrome-zip` | The Chrome release zip, for the manual install |
| `download-firefox-zip` | The Firefox release zip, for a temporary add-on |
| `install-firefox` | Add to Firefox, once the add-on is listed |
| `download-dmg` | The macOS app download |
| `copy-brew-cli` | Copy the Homebrew command for the `inkup` CLI |
| `copy-brew-cask` | Copy the Homebrew command for the desktop app |
| `copy-mcp-install` | Copy `inkup mcp install` |
| `github` | A link to the GitHub repository |
| `liatrio` | The Liatrio logo in the footer |

Add `data-umami-event-location` to say where the click came from: `hero`, `nav`, `install`, `install-extension`,
`install-host`, `oss` or `closing`.

```html
<a href="…" data-umami-event="install-chrome" data-umami-event-location="hero">Add to Chrome</a>
```

## Product captures

The screenshots and the clip in `src/assets/captures/` are recorded from the real extension, never drawn by hand.
`tests/e2e/site-captures.spec.ts` loads the built extension in Playwright's Chromium, opens a fictional product page
(`fixtures/site/demo-store.html`, "Tallybook"), and records one review Session from the page's floating toolbar. The
mic plays `fixtures/audio/site-demo.wav`, `fixtures/transcripts/site-demo.json` stands in for speech recognition,
and a local stub (`tests/support/anthropic-stub.ts`) answers the Draft Item and Process calls, so no paid API is used.

| File | What it shows | Size |
| --- | --- | --- |
| `toolbar-recording.png` | the page with the toolbar recording and a caption | 1440×900 |
| `stroke.png` | a red-pen circle on the page's trial button | 1440×900 |
| `stroke-mobile.png` | the same on a phone-sized page | 390×844 |
| `drafts.png` | the side panel's Draft Items, one per spoken note | 420×900 |
| `review.png` | the review page's Change Items after Process | 1440×900 |
| `review-flow.mp4`, `.webm`, `.jpg` | Start, two Strokes with speech, Stop (about 11 s, muted), and its poster | 1440×900 |

`manifest.json` lists every file with its `name`, `file`, `width`, `height`, `kind` (`screenshot`, `video` or
`poster`), `capturedAt` and `extensionVersion` (from `.release-please-manifest.json`); its `source` is
`site-captures.spec.ts`.

### Refreshing

Run **Site captures** (`.github/workflows/site-captures.yml`) from the Actions tab. It records on Linux, uploads the
set as the `site-captures` artifact and opens or updates the pull request "chore(site): refresh product captures". It
also runs by itself when an `inkup-extension-v*` release is published, and, without the pull request, on a pull
request that changes the spec, the demo page or its speech.

To fetch a run's set by hand:

```sh
gh run download <run-id> -n site-captures -D apps/site/src/assets/captures
```

`pnpm site:captures` builds the extension and runs the spec into `src/assets/captures/` on Linux. Don't run it on a
Mac desktop: the fake microphone and tab capture raise macOS screen-recording prompts. Running it in Docker, with the
e2e-in-Docker setup, is a follow-up.

To change what is recorded, edit the spec, the demo page or the scripted notes. The notes' audio is regenerated on a
Mac with `ONLY=site-demo pnpm fixtures:audio`; keep `fixtures/transcripts/site-demo.json` in step with
`fixtures/audio/site-demo.timing.json`.
