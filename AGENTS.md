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
