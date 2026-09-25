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

## Reproducing

```sh
npx playwright test --project=chrome tests/e2e/<spec>.ts:<line> --repeat-each=20 --workers=2   # also try --workers=4
E2E_CHROME_LOG_DIR=/tmp/chrome-logs npx playwright test ...                                     # one Chromium log per test
```

Linux differs from macOS here. `mcr.microsoft.com/playwright:v1.63.0-noble` (with `unzip` added) runs the specs
that don't need the host binary. CI turns on `E2E_CHROME_LOG_DIR` and uploads `chrome-logs/` with the report when a
shard fails. The fixture also adds a `renderer crashed` annotation to a test when one of its pages crashes.

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
