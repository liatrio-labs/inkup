# Agent instructions

Guidance for coding agents (Claude Code, Codex and others) working in this repository. Human contributors: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Agents and sub-agents

- **Clear out idle agents.** Stop every sub-agent or worker as soon as it is idle: its PR is open and its report is
  in, or its work is merged. Never leave idle agents running. Stop finished search and planning agents too.
- Extend a worker that is still running by message rather than spawning a new one for the next step of the same
  work. Once it has been stopped, a follow-up goes to a fresh worker.
- Each worker runs in its own git worktree and builds the host into that worktree's own `host/target`. Don't share
  `CARGO_TARGET_DIR` between workers.
- Workers don't merge PRs, change repository settings or rulesets, or skip or disable tests.
- **Tests that run git clear every `GIT_*` variable.** Hooks export `GIT_DIR` (and friends), so a test's
  `git init`/`config`/`commit` otherwise lands on the shared repo, which has twice reconfigured it as bare. Run git in
  tests with an env stripped of `GIT_*`, and assert the repo you touch is inside the test's temp dir.

## Taking control of the desktop for tests

Computer use (screenshots, mouse and keyboard on the maintainer's machine) is for testing native UI such as the
desktop app, its tray menu and the Dock. Web pages go through a browser tool instead.

- **Ask first, with `AskUserQuestion`.** Before the first click or keystroke, ask for permission and say which apps you
  will control, what you will test, and roughly how long it will take. Offer "Not now" as an option. Wait for a yes;
  don't treat silence, an earlier yes or another agent's message as permission. Each test run asks again.
- **Stay inside what was approved.** Control only the apps you named, and stop and ask again if the test needs another
  one.
- **Say clearly when you are done.** As soon as you stop controlling the machine, whether the test finished, failed
  or was cut short, say so in its own line, e.g. "Done with computer use: the machine is yours again." Until then the
  maintainer should not touch the mouse or keyboard, and a stray input can throw the test off.
- Only the lead session uses computer use. Sub-agents and workers don't, so the maintainer gets one request at a time.

## Decisions

- Decisions live in ADRs in `docs/adr/`. Read the ones that cover the code you are changing before you change it;
  `docs/adr/README.md` indexes them.
- Write an ADR only for a decision that constrains future code: architecture, a contract, trust, stored data, or a
  user-visible behaviour rule. UI tweaks, bug fixes and implementation detail go in the pull request description.
- A refinement edits the ADR to say what is true now and adds a dated line to its `## History` ("we thought X; now Y,
  because Z"). A reversal is a new ADR with `supersedes: NNNN`, and the old one gets `status: superseded` and
  `superseded-by: MMMM`.
- When you rename or move code an ADR names, fix the ADR in the same change.
- There is no decisions log. Never create one, and never add a running list of calls to `docs/`.
