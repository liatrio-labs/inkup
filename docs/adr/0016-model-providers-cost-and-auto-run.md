---
status: accepted
date: 2026-09-22
---

# The reviewer brings their own key; each model role picks a provider, model and effort; Process asks before it spends, unless the estimate is under the reviewer's threshold

Every model call is paid for by the reviewer's own key, from their own browser. They need to know what a run will cost
before it runs, to choose models per job, and not to be asked about pennies.

**Keys stay local.** The Anthropic key (`anthropicKey`) and the Vercel AI Gateway key (`gatewayKey`) are saved to
`storage.local` from the options page, shown back only masked. A one-time notice (PRD P0-15) appears the first time each
key is saved, saying what is sent. Each key's Test button checks the models the roles on that provider use.

**Three roles, each `{provider, model, effort?}`.** `processingSettings` is `{process, draft, merge}`: Process, live
Draft Items (ADR 0017) and Combine (ADR 0015). Defaults: `claude-sonnet-5` for Process and `claude-haiku-4-5-20251001`
for Draft and Merge. Settings saved in an older shape are read through `normalizeProcessingSettings`; nothing is
migrated in storage. "Has a key" is per role: each feature needs a key for its own role's provider.

**The Gateway is a second provider, not a second adapter.** It serves the Anthropic Messages API (streaming,
structured output, images, `count_tokens`), so a Gateway role uses the same Anthropic adapter with the Gateway key and
base URL. Its model ids are `creator/model`; a model that cannot do structured output or effort there fails the call
like any API error.

**Effort is `output_config.effort`**: Default (send nothing), `low`, `medium`, `high`, `xhigh`, `max`, offered for
every model. Which levels a model accepts changes by model, and the API's 400 says so plainly. Effort is sent on the
estimate's `count_tokens` call too, since it shapes the prompt.

**Model lists are live and cached.** The options page asks each provider with a key for its model list (`modelLists` in
`storage.local`); without a key or when the call fails, the model field is a text input, and a saved id the list lacks
still shows.

**Cost.** The estimate counts input with `count_tokens` and estimates output as 600 + 700 per expected item
(`estimateOutputTokens`). Prices and output caps are dated tables in `packages/core/src/process/cost.ts` (`priceFor`,
`outputCapFor`); `anthropic/<id>` on the Gateway reads as the Anthropic id, and other Gateway models use the cached
list's prices. An unknown model shows no dollar amount. `contextWindowFor` reads the cached lists.

**Auto-run under a threshold.** `processingSettings.autoRunBelowUsd` (off when absent, empty, zero or not a number)
lets Process start without the confirm step when the estimate is strictly under it. It still asks when the price is
unknown, when any limit warning shows, and for **Process again** (the Session already has a `done` run), which replaces
the items and the reviewer's edits. An auto-run says what it spent ("processed without asking."). The decision is pure:
`shouldAutoRun` in `cost.ts`.

**Limit warnings are per call.** A long Session runs as several calls (ADR 0015), so the estimate carries
`chunk_tokens`, and `limitWarnings` flags the largest call at 80% or more of the model's context window or output cap,
one warning per limit.

## Considered options

- A separate adapter for the Gateway: it speaks the same API.
- Offering only the effort levels a model is known to accept: that table would go stale with every model; the API's
  error is clear.
- Auto-running Process again under the threshold: it throws away the reviewer's edits, which costs more than money.
- One warning per chunk: noise; the largest call is the one that fails first.

## Consequences

- Price tables are dated and must be refreshed by hand when prices change.
- The second pass and screenshots are not in the estimate, and the confirm step says so.

## History

- 2026-09-22 (Slice 2): one Anthropic key; Process and Draft models were free-text ids (`processModel`, `draftModel`).
  2026-09-23 (E12): `mergeModel` added for Combine.
- 2026-09-24 (#38): roles with a provider each, the Gateway, effort, and model dropdowns from live lists. The old keys
  are still read.
- 2026-09-24 (#43): auto-run under a threshold and per-call limit warnings.
