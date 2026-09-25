# Chrome e2e: waiting and flakes

`pnpm test:e2e` runs these specs against the built extension in Playwright's Chromium, with fake media. CI splits
them into three shards with one worker each. The patterns below come from flakes that passed locally and failed on
CI runners, which are slower.

## Wait on the thing the assertion is about

- **Wait on the document, not the target.** A CDP target (`/json/list`, `Target.createTarget`) lists its URL as
  soon as the navigation starts. Until the navigation commits, the tab still holds its initial `about:blank`, and
  that page's `readyState` is already `"complete"`. Poll `location.href` inside the page until it is the URL you
  expect, then read `document.readyState` (single-overlay.spec.ts).
- **Measure a box once it has been placed.** A box that is visible and focused should also be where it belongs.
  The comment box is placed synchronously in `open()` for this reason. Before that fix it moved on the next
  animation frame, and on a busy renderer a test could read its old position.
- **Register a worker's event listeners synchronously.** If the service worker adds a listener after an `await`,
  it misses the event that woke it, and the icon click does nothing. `chrome.action.onClicked` is added in the
  worker's first turn (platform/chrome).
- **Poll state; don't sleep.** Use `expect.poll` or `expect(locator)` on the state that proves the step happened:
  a storage value, a host endpoint, an attribute. A fixed `waitForTimeout` only moves the race.

## Running in Docker

`pnpm test:e2e:docker` and `pnpm test:e2e:firefox:docker` (scripts/e2e-docker.sh) run the suites in Linux, as CI
does. Use them on macOS: there, Chromium's tab and screen capture asks macOS for screen recording on every run, and
`network-host.spec.ts` needs local-network access. The container runs `pnpm install`, the build, `pnpm host:build`
and then `pnpm test:e2e` (or the Firefox job's sound server, display and `pnpm test:e2e:firefox`), with two workers
unless you pass `--workers`. Extra arguments go to Playwright:

```sh
pnpm test:e2e:docker tests/e2e/<spec>.ts:<line> --repeat-each=20 --workers=4
```

The image (`docker/e2e.Dockerfile`) is the Playwright image at the lockfile's version, with CI's Node, pnpm and Rust
added. The first run builds it and fills the caches; later runs reuse them. The worktree is mounted read-write, so
`test-results/` and `playwright-report/` land in it as usual, and `.git` read-only. Linux builds go to named
volumes, never into the Mac's `node_modules`, `extensions/web/.output` or `host/target`:

- `inkup-e2e-<worktree>-<hash>-*`: this worktree's `node_modules` (one per package), `.output`, `.wxt` and host build.
- `inkup-e2e-cargo-home` and `inkup-e2e-pnpm-store`: the cargo registry and pnpm store, shared by all worktrees.

To start over, remove them: `docker volume ls -q --filter name=inkup-e2e- | xargs docker volume rm`.

## Reproducing

```sh
pnpm test:e2e:docker tests/e2e/<spec>.ts:<line> --repeat-each=20 --workers=2   # also try --workers=4
```

On Linux, or in CI, run Playwright itself, and `E2E_CHROME_LOG_DIR=<dir>` writes one Chromium log per test. CI turns
it on and uploads `chrome-logs/` with the report when a shard fails. The fixture also adds a `renderer crashed`
annotation to a test when one of its pages crashes.

## Known: the extension's renderer crashes during Stop (unresolved)

Rarely, in a full CI shard, Stop or Cancel never finishes. The side panel stays on "Finishing…", the review tab never
opens, and the test times out waiting for it. This was seen in host.spec.ts, host-sync.spec.ts, source-map.spec.ts,
privacy.spec.ts and cancel-mute.spec.ts (b) and (c). The traces show a crash, not a slow step:

- Every extension page stops painting within about 100 ms of the Stop click.
- In cancel-mute (b), `page.evaluate` on an extension page fails with `Target crashed`.
- In cancel-mute (c), the toolbar shows "A listener indicated an asynchronous response … the message channel
  closed before a response was received". The service worker went away while it handled Cancel.

The extension's pages and its service worker share one renderer process, so a single crash takes all of them down.
The same tests ran 284 times in isolation on CI runners (runs 36137199093 and 36137917333) and 80 times locally, and
the crash never happened. The Chromium logs from the next failure should give its signature.
