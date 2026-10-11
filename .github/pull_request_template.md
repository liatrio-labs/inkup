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

## Risk and rollback

Risk / affected boundary:
Rollback:

## Scope

Changed lines: <!-- Target under 400, excluding locks, generated files and fixtures. -->
Small-diff exception: <!-- None, or why this outcome cannot be split. -->

## Security triggers

Mark every boundary changed by this diff. One trigger requires independent Security review at this head.
Code review confirms the trigger decision; ambiguous boundary changes go to Security.

- [ ] Auth, identity, authorization, sessions or token validation
- [ ] Secrets, credentials, environment binding, storage, logging or redaction
- [ ] Data access, schemas/migrations, exports, retention or personal data
- [ ] Dependency manifests/locks, versions, new packages or supply-chain tooling
- [ ] CI, Actions permissions, release/versioning, signing, artifacts or deployment
- [ ] Infrastructure, hosting, network, IAM, storage or operational trust boundaries
- [ ] Extension permissions/capabilities, content scripts, capture/media access or native messaging
- [ ] MCP listeners/transports, tool/resource endpoints, pairing, origins, file/system access or command execution

Security skip reason: <!-- Required if no trigger; documentation of a boundary does not itself change it. -->

## Review gates

- [ ] Independent code review and QA approval with evidence at this head; product acceptance when applicable
- [ ] Security approval at this head when triggered
- [ ] Valid findings fixed or tracked; dismissals explained; review threads resolved
- [ ] Required CI green; no unresolved changes requested, security or acceptance blockers

<!-- Every push invalidates previous verdicts. Authors/reviewers never merge or enable auto-merge.
Review comments cannot bypass native GitHub protection or authorize self-approval.
Maintainers verify active gates before merge. -->
