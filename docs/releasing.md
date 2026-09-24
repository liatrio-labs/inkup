# Releasing

Chrome only installs extensions for regular users from the Chrome Web Store. A GitHub Release zip can be loaded unpacked
for development or testing, but it is not a one-click install. So a release produces both:

| Output | Where | Who can install it |
| --- | --- | --- |
| `inkup-<version>-chrome.zip` | GitHub Release for the tag | Anyone with repo access, via `chrome://extensions` → Developer mode → Load unpacked (unzip first) |
| Store submission | Chrome Web Store, unlisted | Anyone with the listing link, one click, auto-updating |

## Branch rules

- `main` is protected: changes land through a pull request, and the `core`, `extension-chrome`, `extension-chrome-e2e`
  and `extension-firefox` checks from `.github/workflows/ci.yml` and the `cargo (ubuntu-latest)`, `cargo (macos-latest)`
  and `cargo (windows-latest)` checks from `.github/workflows/host.yml` must pass on an up-to-date branch. Force pushes
  and deletion are blocked; review conversations must be resolved.
- Release tags `v*` cannot be deleted or moved.
- Admins can bypass in an emergency; nobody needs an approving review because this is a one-person repo. Raise the
  approval count if collaborators join.

## Cutting a release

1. On a branch, bump the version: `pnpm -C extensions/web version 0.2.0 --no-git-tag-version`.
   `extensions/web/package.json` "version" is the manifest version Chrome sees and must increase every store upload.
2. Open a PR, let CI pass, merge to `main`.
3. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. `.github/workflows/release.yml` then:
   - refuses tags that are not on `main` or do not equal `v` + the extensions/web/package.json version,
   - runs typecheck, unit tests and `pnpm zip`,
   - creates the GitHub Release with the zip and generated notes,
   - uploads the zip to the Chrome Web Store and submits it for review, if store credentials are configured (otherwise
     it logs a notice and skips).

## One-time Chrome Web Store setup

The store API cannot create a new item, so the first upload is manual.

1. Register a Chrome Web Store developer account (one-time fee) at <https://chrome.google.com/webstore/devconsole>.
2. Download the zip from the first GitHub Release and upload it as a new item. Fill in the listing, the privacy
   practices (microphone, tab capture, `<all_urls>`: see `docs/adr/0003-all-sites-host-permission.md` and PRD P0-15),
   and set **Visibility: Unlisted**. Submit.
3. Note the **extension ID** (item page) and **publisher ID** (the dev console URL `.../devconsole/<publisher-id>`).
4. Create a Google Cloud service account for the Chrome Web Store API and download its JSON key:
   <https://developer.chrome.com/docs/webstore/service-accounts>. Add the service account's email to the publisher in
   the dev console.
5. In GitHub → Settings → Environments → `chrome-web-store` (already created, restricted to `v*` tags), add these
   environment secrets:

   | Secret | Value |
   | --- | --- |
   | `CHROME_EXTENSION_ID` | from step 3 |
   | `CHROME_PUBLISHER_ID` | from step 3 |
   | `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | `client_email` from the JSON key |
   | `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | `private_key` from the JSON key |

   Back each one up to 1Password as you create it (secrets-backup). Optional repository variable
   `CHROME_SKIP_SUBMIT_REVIEW=true` uploads without submitting.

From then on every tag uploads and submits automatically. The human gate is pushing the tag, and Google's store review
before the new version goes live. Required reviewers on the environment would add an approval click, but GitHub only
offers them on private repos with a paid plan; if the plan changes, add yourself under the environment's protection
rules.

## Checking a release locally

```sh
pnpm zip                                    # extensions/web/.output/*-chrome.zip
cd extensions/web && pnpm exec wxt submit --dry-run --chrome-zip .output/*-chrome.zip
```
