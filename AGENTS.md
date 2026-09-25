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
