---
status: accepted
date: 2026-10-07
---

# A Client sends a Change Item to the reviewer's issue tracker as one issue, with the reviewer's own token; the link is a `tracker_link` event and the issue's status is only read

Reviewers plan work in GitHub Issues, Linear or Jira, not in InkUp. Copying an item's title, words, screenshots and agent
prompt into a tracker by hand is the step between a review and the team picking it up (PRD P1-4). InkUp has no server
of its own, the Host is a local server that may not be running, and the extension is the whole product without it
(ADR 0004). Screenshots have to reach the tracker, and an item must not become two issues by accident.

**Adapters run in the Client, with the reviewer's personal token.** `packages/core/src/trackers/` defines
`TrackerAdapter` (`test`, `listDestinations`, `uploadImages`, `createIssue`, `getStatus`) and the GitHub adapter
(`github.ts`). Each adapter is given its `fetch` and the tracker's API base, so the extension's pages call it with the
page's `fetch`, the desktop app can call it with `tauri-plugin-http`'s, and tests point it at a stub
(`tests/support/github-stub.ts`). Errors are `TrackerError`, whose message says in plain words what went wrong and what
to do next ("This token can't write to acme/web. Give it Contents: read and write."). The token is a GitHub
fine-grained personal access token (Issues and Contents read and write, Metadata read), kept like a model key
(ADR 0016): `storage.local` only (`githubToken` in `extensions/web/src/settings.ts`), shown back masked, never logged,
exported, synced or sent to the Host. The first saved token shows a one-time notice of what goes to GitHub.

**One issue per Change Item, built by one pure function.** `buildIssue` (`trackers/issue.ts`) makes the title and a
Markdown body in a fixed order: Intent with the category, Where (each Location's element and its url, or the app it was
in when it has no url), What was said as a quote, Screenshots, the agent prompt in a collapsed `<details>` with each
`screenshots/<id>.png` citation rewritten to the uploaded image's URL, Ambiguity when there is one, and the footer
`Sent from InkUp · <Session name> · <item id>`. A body that would reach GitHub's 65,536-character limit gets a shorter
agent prompt with a note saying so; every other part stays whole. `pushItem` (`trackers/index.ts`) uploads the images,
then creates the issue.

**GitHub images live on an `inkup-assets` branch of the target repo.** GitHub has no API to attach an image to an issue.
The adapter commits the item's screenshots and element crops through the Git Data API at
`inkup/<session_id>/<screenshot_id>.png`: one blob per image, one tree on the branch tip, one commit, then the ref. A
repo without the branch gets it as an orphan, so it shares no history with the code. A ref update refused as not a
fast-forward is tried again on the new tip. The body embeds
`https://github.com/<owner>/<repo>/blob/inkup-assets/<path>?raw=true`, which renders for anyone who can read the repo;
the notice says so.

**A successful send is a `tracker_link` event.** It carries `item_id`, `run_id`, `tracker`, `destination`, `key`, `url`
and `created_at`, and is appended after the Session like a review edit (ADR 0018), by `appendTrackerLink`
(`extensions/web/src/db/review.ts`). It is not an `item_edit` op, so Undo and Redo never take it back: the issue exists
whatever the review page does. Folding the review edits (`applyItemEdits` with `trackerLinksFor`, `review-edits.ts`) puts
each link on the item it names as the optional `tracker_links[]`, so `session.json`, the zip and the Host's `items`
message carry it. The event bumped `SCHEMA_VERSION` 20 → 21 with a no-op upgrade step; `tracker` is the enum `github`,
`linear`, `jira` from the start, so adding the other two trackers is not another schema break (ADR 0007). The wire is
unchanged: the Host stores events and items verbatim. An item that already has a link offers "Send again" only from a
menu, behind a confirm.

**Status is read, never written.** When the review page opens, each link's status is read with `getStatus` and shown as
a badge: open, closed (completed), closed (not planned), or "status unavailable" when the read fails, which blocks
nothing. A status is never stored, logged or exported, and InkUp never updates or closes an issue; tracker state is not
a Resolution (ADR 0021).

**A registry lists the trackers.** `TRACKERS` (`trackers/registry.ts`) describes each tracker as data: its label,
its fields (a secret field is a token), its destination's label, its help and one-time notice, and how to build its
adapter and credentials from the saved values, and an optional `prepare` that checks a field before it is saved
(Jira's site must be Atlassian Cloud). A Client's settings and send controls are drawn from it, so a new tracker is
one entry there.

**The desktop app sends the items its host holds.** Its Items view (`apps/desktop/ui/src/send-to-tracker.tsx`) has
Send on each row and a bulk Send, with the same rules as the review page. Its Trackers view (`trackers.tsx`) has the
same fields, Test and notice. The adapters run in the webview on `tauri-plugin-http`'s fetch, which
`capabilities/default.json` limits to the trackers' hosts, so no CORS rule applies and nothing else can be reached.
Tokens are in the OS keychain (`src-tauri/src/keychain.rs`, service `dev.inkup.desktop`, account
`tracker:<tracker>:<field>`), read at the moment of use and never kept in web storage. The rest of a tracker's
settings (its destination) is in localStorage. The host's control API serves the item in full and its screenshots,
and records the link (ADR 0025). The host keeps such links in its own `tracker_links` table, apart from the item's
body, because the Client's next push replaces the body. Every read of the item (the control API, the window's state,
MCP's `get_item` and `read_items`) gives the body's links and the recorded ones, one per issue url. An issue made
whose link the host then failed to record is kept in the window, so Retry records the link and makes no second
issue.

**The API base is overridable only in a development build.** `devOverrides.githubBaseUrl` points the extension at the
stub for e2e tests, like `anthropicBaseUrl`; `githubApiBase` ignores it in a release build (`__INKUP_RELEASE_BUILD__`),
so nothing stored can send a token anywhere but `https://api.github.com`.

## Considered options

- An InkUp server, a GitHub App or OAuth: InkUp runs no server, and an App needs one to hold its key. A personal token
  works today in every Client.
- Sending through the Host: the Host may not be running or paired, and it would then hold tokens it has no other use
  for.
- Images as data URIs or gists: GitHub strips data URIs from issue bodies, and gists cannot hold binary files through
  the API. A branch in the target repo keeps the images where the issue's readers already have access.
- Storing the link in the Change Item rows: items are derived output (ADR 0018), and a re-run would lose the link; an
  event keeps the log the single source of truth.
- Storing the last status read: it goes stale at once, and the tracker is the source of truth for it.

## Consequences

- Sending an item writes to the reviewer's repo: issues, and screenshots on `inkup-assets`. A repo with no commits yet
  cannot take screenshots; the error says to push a first commit.
- Process again replaces a run's items, so links on the old run's items are no longer shown (they stay in the log).
- A merge keeps the link of the item merged into; the other item's link is only in the log.
- Linear and Jira (spec 01 Units 2 and 3) add adapters to the same interface, and the desktop app (Unit 4) runs the same
  adapters with its own `fetch` and the OS keychain.

## History

- 2026-10-07: GitHub, end to end in the extension (spec 01, Unit 1).
- 2026-10-07: Linear, bulk send and the per-send destination picker (spec 01, Unit 2). We thought each Client's UI
  would name its trackers; now the trackers are data in `packages/core/src/trackers/registry.ts`, and the options
  page, the send control and the bulk bar read it, so a new tracker adds an entry and no UI code. Linear uploads
  images through `fileUpload`'s signed URL and records the team's id as the link's `destination`. A status can carry
  the tracker's own state name, which the badge shows. A 403 or 429 with `retry-after` pauses a bulk send and retries
  the same item.
- 2026-10-07: Jira Cloud (spec 01, Unit 3). We expected every tracker to take its images before the issue exists; Jira
  takes an attachment only on an existing issue, so its adapter sends the whole item itself (`sendItem`: create, attach,
  update the description) and writes the body as Atlassian Document Format (`adf.ts`), not Markdown. It signs in with
  the account's email and an API token (Basic auth) on a `https://<site>.atlassian.net` site, which the settings check
  unless a development build points at a stub.
- 2026-10-07: the desktop app sends too (spec 01, Unit 4). We planned for it to run the same adapters with its own
  fetch and the OS keychain. That is now built: it reads the same registry and sends through `pushItem` (so Jira's
  `sendItem` too), and the host records the desktop app's links in a `tracker_links` table. Links made on the desktop
  don't reach the extension's review page, which doesn't read items back from the host. We thought only the
  extension's settings would check a field before saving it; now the registry has an optional `prepare`, so the
  desktop's Trackers view refuses a Jira site that isn't Atlassian Cloud too.

## Sources

- docs/PRD.md P1-4.
- GitHub REST API: Git Database (blobs, trees, commits, references) and Issues.
- Jira Cloud REST API v3 (issues, attachments, projects) and Atlassian Document Format.
