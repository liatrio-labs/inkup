# Pull request

## Outcome and issue

Describe the contributor or user outcome and why it matters.
Public issue: <!-- Closes #number, or explain the public-safe rationale. No internal task links. -->

## Acceptance criteria

- [ ] <!-- Testable criterion and expected result. -->

## Proof at the current head

Head SHA: <!-- Full SHA; update after every push. -->

| Criterion / check | Command or real scenario | Output / result and exit code | Evidence |
| --- | --- | --- | --- |
| | | | |

<!-- Record browser load for extension changes; real MCP client round trip for host changes.
List checks not run, their reason and platform limits. Never disable required hooks or CI.
Keep private evidence, internal hosts/addresses, tokens and customer/colleague names out of public text. -->

## Visual evidence

<!-- When this PR changes what a user sees, embed before and after screenshots at 1440px and 390px, and a GIF
or video for interactions. Attach them with `gh pr create/edit --attach`. Include dark mode where the app has
one, and measured state (DOM values, focus, axe) where a screenshot can't prove the change. When attach is
not available, link a CI artifact (for example the site-captures workflow artifact) or embed a committed
image with `blob/<sha>/<path>?raw=true`. Never use raw.githubusercontent, release-asset or data: URIs.
Otherwise: none. -->

none

## Follow-ups

<!-- Each follow-up issue with the one-line reason it couldn't go in this PR, or "none". At most 2 per PR.
Urgent or critical findings (security, data loss, prod breakage) don't count toward that and are filed right
away with a `priority` label. One issue per bug class. Never an issue for docs drift. -->

none

## Needs you

<!-- Only when an owner-only item applies. Only the owner changes rulesets or repo settings, handles secrets,
or makes outward-facing or hard-to-reverse changes. List each one here, proposed and not applied in this PR.
Delete this section when nothing needs the owner; never write "none". -->

## Risk and rollback

Risk / affected boundary:
Rollback:

## Scope

Changed lines: <!-- Target under 400, excluding locks, generated files and fixtures. -->
Small-diff exception: <!-- None, or why this outcome cannot be split. -->

## Security triggers

Mark every boundary changed by this diff. The InkUp Reviewer's verdict covers security review of every trigger
marked here. A pure documentation change with no boundary change records a skip reason; documentation of a
boundary does not itself change it.

- [ ] Auth, identity, authorization, sessions or token validation
- [ ] Secrets, credentials, environment binding, storage, logging or redaction
- [ ] Data access, schemas/migrations, exports, retention or personal data
- [ ] Dependency manifests/locks, versions, new packages or supply-chain tooling
- [ ] CI, Actions permissions, release/versioning, signing, artifacts or deployment
- [ ] Infrastructure, hosting, network, IAM, storage or operational trust boundaries
- [ ] Extension permissions/capabilities, content scripts, capture/media access or native messaging
- [ ] MCP listeners/transports, tool/resource endpoints, pairing, origins, file/system access or command execution

Security skip reason: <!-- Required when no trigger is marked. The InkUp Reviewer's verdict covers security review. -->

## Review gates

- [ ] InkUp Reviewer PASS at this head, covering code review, QA (tests at the right layer) and security review
- [ ] Maintainer product acceptance when it applies
- [ ] Findings fixed in the PR, dismissed with a reason, or filed as follow-ups (at most 2; urgent or critical exempt)
- [ ] Review threads resolved
- [ ] Required CI green; no unresolved changes requested, security or acceptance blockers

<!-- Every push invalidates previous verdicts. The InkUp Reviewer is the separate review agent that posts the
verdict. That single verdict covers code review, QA (tests at the right layer) and security review. Product
acceptance stays with the maintainer when it applies. The lead is the agent that owns the batch and queues
merges. After the InkUp Reviewer's PASS at this head (plus the maintainer's product acceptance when it
applies), with findings reconciled and required checks green, the lead runs
`gh pr merge <n> --squash --auto --match-head-commit <sha>` from the maintainer's authenticated `gh` account.
Never before the PASS. Never use `--admin`, never bypass or edit a ruleset to land a PR, and
never merge with a failing or missing required check. Workers don't merge PRs, change repository settings or
rulesets, or skip or disable tests. A PR proposes owner-only items under Needs you and never applies them.
Release PRs from release-please auto-merge on their own (ADR 0027). Review comments cannot bypass native
GitHub protection or authorize self-approval. -->
