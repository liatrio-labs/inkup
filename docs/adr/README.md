# Architecture decision records

Each ADR records one decision that still governs the code: the rule, why it holds, and the alternatives we turned
down. The H1 of each file states the decision; the body says where it lives in the code.

## Index

| ADR | Topic | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-media-ownership-across-extension-contexts.md) | Media ownership across extension contexts | accepted; superseded in part by 0004 | 2026-09-22 |
| [0002](0002-screen-picker-over-tab-capture.md) | The screen picker over `chrome.tabCapture` | accepted | 2026-09-22 |
| [0003](0003-all-sites-host-permission.md) | `<all_urls>` host permission, and the permissions added since | accepted | 2026-09-22 |
| [0004](0004-rust-host-with-extension-clients.md) | A Rust Host with browser extensions as Clients | accepted | 2026-09-23 |
| [0005](0005-loopback-trust-and-pairing.md) | Loopback trust and pairing | accepted; superseded in part by 0006 | 2026-09-23 |
| [0006](0006-network-mode.md) | Network mode | accepted | 2026-09-23 |
| [0007](0007-central-contract.md) | One versioned contract in `contract/` | accepted | 2026-09-24 |
| [0008](0008-independent-releases-and-host-updates.md) | Independent releases and Host self-update | accepted | 2026-09-24 |
| 0009 | Reserved | | |
| [0010](0010-starting-owning-and-stopping-a-session.md) | Starting, owning and stopping a Session | accepted | 2026-09-22 |
| [0011](0011-the-page-overlay.md) | The page overlay | accepted | 2026-09-23 |
| [0012](0012-annotations-candidates-and-selection-modes.md) | Annotations, Candidates, Object Select and Select Text | accepted | 2026-09-22 |
| [0013](0013-screenshots-and-evidence.md) | Screenshots and evidence | accepted | 2026-09-22 |
| [0014](0014-speech-transcription-and-timing.md) | Speech: transcription tiers, the VAD, Voice Commands and timing | accepted | 2026-09-22 |
| [0015](0015-the-process-pipeline.md) | The Process pipeline | accepted | 2026-09-22 |
| [0016](0016-model-providers-cost-and-auto-run.md) | Model providers, cost and auto-run | accepted | 2026-09-22 |
| [0017](0017-live-draft-items.md) | Live Draft Items | accepted | 2026-09-22 |
| [0018](0018-the-session-log.md) | The Session log, its versions, and edits as ops | accepted | 2026-09-22 |
| [0019](0019-the-review-page-export-and-restore.md) | The review page, export and restore | accepted | 2026-09-22 |
| [0020](0020-streaming-sessions-to-the-host.md) | Streaming Sessions to the Host | accepted | 2026-09-23 |
| [0021](0021-agents-mcp-change-items-and-resolutions.md) | Agents: MCP, Change Items and Resolutions | accepted | 2026-09-23 |
| [0022](0022-page-api-and-source-mapping.md) | The page API and source mapping | accepted | 2026-09-23 |
| [0023](0023-viewport-sizes-through-a-frame-host.md) | Viewport sizes through a frame host | accepted | 2026-09-23 |
| [0024](0024-repository-tooling-dependencies-and-ci.md) | Repository tooling, dependencies and CI | accepted | 2026-09-22 |

The date is when the decision was first made. ADRs 0010 to 0024 were distilled on 2026-09-24 from the decisions log
that the repo kept until then; their History sections carry its dates.

## When to write one

Write an ADR for a decision that constrains future code:

- architecture: which process, context or crate owns what;
- contracts: the wire protocol, the Session schema, anything another component or an agent reads;
- trust: permissions, authentication, what leaves the machine;
- data: what is stored, where, and what is never rewritten;
- a user-visible behaviour rule that code in several places must keep (for example "closing the panel is Stop").

Do not write one for a UI tweak, a bug fix, a test fix or implementation detail. Those go in the pull request's
description, where git history keeps them. There is no decisions log: do not start one.

## How to change one

- **Refine it in place.** A change that keeps the decision (a new threshold, a renamed file, a case the rule now
  covers) edits the ADR's body to say what is true now, and adds a dated line to its `## History` section: what we
  thought, what we think now, and why. The status stays `accepted`.
- **Supersede it.** A real reversal is a new ADR with `supersedes: NNNN` in its frontmatter. The old one gets
  `status: superseded` and `superseded-by: MMMM`, and keeps its text. A reversal of one part says so:
  `supersedes: the loopback-only parts of 0005`, and the old one's status says `superseded in part by`.
- Keep file paths and identifiers current. When code moves, fix the ADR that names it in the same change.

Start from [template.md](template.md), take the next free number, and add the row above.
