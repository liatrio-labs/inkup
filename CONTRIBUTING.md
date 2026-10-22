# Contributing to InkUp

Thanks for helping. Bug reports, fixes, browser-support work and docs are all welcome. For a larger change, open an
issue first so we can agree on the approach before you build it.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes, not in an issue.

## Set up

You need Node 22.18 or later, pnpm 10 or later, Chrome 153 or later, Rust 1.98 or later for the host and desktop
(as declared in `host/Cargo.toml` and `apps/desktop/src-tauri/Cargo.toml`), and
[pre-commit](https://pre-commit.com) 4 or later.

```sh
pnpm install                                  # installs the git hooks, and copies the ONNX Runtime and VAD wasm files
pnpm dev                                      # the extension with hot reload, in a WXT-managed Chrome profile
cargo build --manifest-path host/Cargo.toml   # the inkup host
pnpm desktop:dev                              # the desktop app, with hot reload for its UI
```

The desktop app is built with [Tauri 2](https://v2.tauri.app/start/prerequisites/). macOS needs the Xcode command
line tools, and Windows needs WebView2, which Windows 11 already has. On Linux, install WebKitGTK and appindicator
first. On Debian or Ubuntu:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential file
```

### Running several hosts at once

Only one host runs per data dir (ADR 0025). The TUI, `inkup serve` and the desktop app all use your real one by
default (`~/Library/Application Support/dev.inkup.inkup` on macOS, `$XDG_DATA_HOME/inkup` on Linux,
`%APPDATA%\inkup\inkup\data` on Windows). To run a second host next to it, for a test or a second checkout, give it
its own data dir with `--data-dir` (or `INKUP_DATA_DIR`). Use port 0 so it takes any free port instead of 47823:

```sh
cargo run --manifest-path host/Cargo.toml -p inkup -- serve --data-dir /tmp/inkup-a --port 0
pnpm desktop:dev -- --data-dir /tmp/inkup-b --port 0
```

Two hosts on one data dir do not both run. The TUI and `serve` say which host is running and exit. The desktop
app becomes the running host's window, or brings the other app forward. `scripts/desktop-smoke.sh` runs these
cases with real binaries on temporary data dirs. It is macOS only, and it drives the app's window and menu through
accessibility, so the terminal needs Accessibility access.

The [README](README.md) lists every command and how to load the extension unpacked in Chrome, Firefox and Safari.

`pnpm install` runs `pre-commit install` for you when pre-commit is on your PATH, and says so when it is not.
Install pre-commit first, or run `pre-commit install` once after installing it. Before the first commit in each
worktree, run `pre-commit install-hooks` to prepare hook environments before they can affect its index.
Node and pnpm versions above are documented prerequisites; the root `package.json` has no `engines` constraints.

## Before you open a pull request

The hooks run most of what CI runs. On commit: Biome (format, lint, imports), markdownlint, rustfmt and clippy,
zizmor on the workflows, gitleaks, and file hygiene. On push: the type check and the unit tests, and `cargo test`
when the host changed. `pnpm lint:fix` applies Biome's fixes to the whole tree, and `pre-commit run --all-files`
runs every commit hook on every file.

The rest of CI you run yourself. None of it needs API keys or makes calls outside your machine.

```sh
pnpm schema && git diff --exit-code -- contract
node scripts/contract-compat.ts origin/main   # contract/ changes: breaking without a version bump fails (ADR 0007)
pnpm test:e2e:docker                          # Chrome e2e in Linux Docker; pnpm test:e2e:firefox:docker for Firefox
cd host && cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked
cd apps/desktop/src-tauri && cargo fmt --all --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
pnpm desktop:build                            # the desktop app, as CI builds it
```

On macOS, run the e2e in Docker. Chromium's tab and screen capture otherwise asks macOS for screen recording again and
again, and `network-host.spec.ts` needs local-network access; Linux has neither, and CI runs Linux. On other platforms,
the raw `pnpm test:e2e` and `pnpm test:e2e:firefox` run on the machine itself. Docker needs no setup beyond Docker
itself; [tests/e2e/README.md](tests/e2e/README.md#running-in-docker) has the details.

The host and desktop tests that listen beyond loopback (network mode on every interface, mDNS) skip unless
`INKUP_LAN_TESTS=1` is set. CI sets it. Locally each rebuilt test binary would set off a macOS "accept incoming network
connections?" prompt, so set it only when you change network mode and can answer the prompts.

- **Conventional Commits.** Messages look like `feat(host): pair by code` or `fix: keep the draft on reload`
  (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, ...). The `commit-msg` hook checks the format. The
  pull request title becomes the squash commit, and release-please reads it: `feat`, `fix`, `perf` and `revert` go
  in the next release's changelog (docs/releasing.md).
- **Silence a lint rule on the line, with a reason.** `// biome-ignore lint/<group>/<rule>: <why>`, not a rule
  turned off for the whole repo.
- **Tests exercise the real path.** A change to behaviour comes with a test that fails without it: a Vitest test
  for logic, a Playwright e2e for anything a reviewer does in the browser, a `cargo test` for the host.
- **Use the domain words.** `CONTEXT.md` defines Session, Stroke, Annotation, Candidate, Change Item and the rest,
  and the code uses those terms. Add a term there before using a new one.
- **Record decisions as ADRs.** A decision that constrains future code (architecture, a contract, trust, stored
  data, or a user-visible behaviour rule) gets an ADR in `docs/adr/`, or a dated History entry in the ADR it refines;
  a reversal is a new ADR that supersedes the old one. UI tweaks and implementation detail go in the pull request
  description. There is no decisions log. `docs/adr/README.md` has the rules and the template.
- **Keep the schemas in sync.** `session.json` and the host protocol come from the Zod schemas in
  `packages/core` and `packages/protocol`. Change those, run `pnpm schema`, then regenerate the host's Rust types
  with `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`.
- **Some things only a person can check.** A real side panel, permission prompts and on-device speech are covered
  by the ordered checklist in `docs/manual-checks.md`. Say in the pull request which parts you ran.

## Pull requests

- Use one isolated worktree and branch from `origin/main` for each change. Do not work in the shared root checkout
  or commit directly to `main`. Open a ready pull request against `main` with a Conventional Commit title.
- Keep one outcome per PR, targeting under 400 changed lines excluding generated files, locks and fixtures.
  Explain larger diffs and why they cannot be split in the template's exception field.
- Fill in the [PR template](.github/pull_request_template.md): outcome, public issue (or public-safe rationale),
  acceptance criteria, exact head SHA, proof commands/output and exit codes, risk/rollback, security triggers,
  follow-ups, visual evidence and owner-only items under Needs you, when there are any. State checks you could
  not run and why. For documentation-only work, run affected Markdown and file hygiene checks; product checks
  remain required when hooks or CI run them. Never disable or silently skip required checks.
- Behaviour changes need real evidence: load extension changes in at least one browser; exercise host changes
  through a real MCP client round trip. Record the relevant manual checks and platform limits.
- Any PR that changes what a user sees embeds before and after screenshots at 1440px and 390px, and a GIF or
  video for interactions, using `gh pr create/edit --attach`. Include dark mode where the app has one, and
  measured state (DOM values, focus, axe) where a screenshot can't prove the change. When attach is not
  available, link a CI artifact (for example the site-captures workflow artifact) or embed a committed image
  with `blob/<sha>/<path>?raw=true`. Never use raw.githubusercontent, release-asset or data: URIs.
- The builder's design check, on a pull request that changes what a user sees, is polish, then audit, then
  `impeccable@4.7.0 detect`, on the changed source and on the rendered page at 1440 and 390. Fix audit P0 and P1,
  and primary or `design-system-*` findings on the changed code, before opening the pull request. The cost rule is
  one batched look, one fix batch, one confirm look. The pull request body carries this Design check line:

  ```text
  Impeccable 4.7.0: audit NN/20 (P0..P3) · detect source N/M drift · rendered 1440/390 N/M · ignores and disables: none|list
  ```

- The InkUp Reviewer's eye pass blocks on audit P0/P1, a primary finding on changed lines, a missing state, an ignore
  without a reason, spacing off the DESIGN.md scale, `design-system-*` token drift in the changed code without an
  approved DESIGN.md update, and visible overflow at 1440 or 390. A clean detector run is not a pass. Spacing is
  on-scale when it is a spacing-scale step or a value a DESIGN.md component token defines. Only a new value in
  neither blocks.
- An inline `impeccable-disable` is allowed only with the repo owner's cited approval. The repo owner is the human
  maintainer. The comment cites that conversation and a CT timestamp. An agent relaying approval doesn't count.
- The InkUp Reviewer's single verdict covers code review, QA (tests at the right layer, and each acceptance
  criterion checked against real proof at this head) and security review, independently of the author, at the
  exact head SHA. Product acceptance by the maintainer applies to any PR that changes what a user sees or a
  user-visible behaviour rule. A pure documentation change with no boundary change records a skip reason in
  that verdict.
- Review comments identify the reviewer role, head SHA, verdict, findings and evidence. A new push invalidates
  previous verdicts: obtain the current InkUp Reviewer PASS, and the maintainer's product acceptance when the
  PR changes what a user sees or a user-visible behaviour rule, with evidence.
- Fix in the PR by default, dismiss with a reason, or file a follow-up. Each PR gets at most 2 follow-up
  issues. Urgent or critical findings (security, data loss, prod breakage) don't count toward that and are filed
  right away with a `priority` label. File one issue per bug class, never an issue for docs drift, and give every
  follow-up a one-line reason it couldn't go in the PR, in a public-safe issue that names the file and the PR.
  The Follow-ups section lists each issue with its reason, or "none". Resolve review conversations. Unresolved
  changes requested, security or acceptance blockers prevent merge.
- CI must pass: `ci-ok` aggregates the jobs selected by the change, including lint, core, Chrome/Firefox builds
  and e2e, host and desktop platform matrices, contract compatibility, site checks and an advisory design scan when
  a UI path changes. A job skipped by CI's path routing passes the aggregate (ADR 0007). This describes the workflow,
  not verified live protection.
- The InkUp Reviewer is the separate review agent that posts the verdict. The lead is the agent that owns the
  batch and queues merges. The repo owner is the human maintainer only. The lead runs `gh pr merge` from the
  maintainer's authenticated `gh` account. That account is only for queuing merges. The lead, like every
  agent, never changes rulesets, repo settings or secrets with it.
  After the InkUp Reviewer's PASS at the current head (plus the maintainer's product acceptance when the PR
  changes what a user sees or a user-visible behaviour rule), with findings reconciled and required checks
  green, the lead runs
  `gh pr merge <n> --squash --auto --match-head-commit <sha>` from the maintainer's authenticated `gh` account.
  Never before the PASS. Never use `--admin`, never bypass or edit a ruleset to land a PR, and never merge
  with a failing or missing required check. Workers don't merge PRs, change repository settings or rulesets,
  or skip or disable tests. Only the repo owner, the human maintainer, changes rulesets or repo settings,
  handles secrets, or makes outward-facing or hard-to-reverse changes. A PR proposes these under Needs you
  and never applies them.
  Release PRs from release-please auto-merge on their own (ADR 0027). Independent review comments supplement
  native GitHub protection: they cannot satisfy a required native approval, bypass protections or authorize
  self-approval. CODEOWNERS alone does not prove owner eligibility or server enforcement.
- This repository and its commits, PRs, issues and comments are public. Never include internal hosts or addresses,
  tokens, customer or colleague names, private evidence or internal task links. Share sensitive security findings
  privately through [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
