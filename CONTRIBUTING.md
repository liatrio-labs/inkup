# Contributing to InkUp

Thanks for helping. Bug reports, fixes, browser-support work and docs are all welcome. For a larger change, open an
issue first so we can agree on the approach before you build it.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes, not in an issue.

## Set up

You need Node 22.18 or later, pnpm 10 or later, Chrome 153 or later, for the host a Rust toolchain (the version
is in `host/Cargo.toml`, `rust-version`), and [pre-commit](https://pre-commit.com) 4 or later.

```sh
pnpm install                                  # installs the git hooks, and copies the ONNX Runtime and VAD wasm files
pnpm dev                                      # the extension with hot reload, in a WXT-managed Chrome profile
cargo build --manifest-path host/Cargo.toml   # the inkup host
```

The [README](README.md) lists every command and how to load the extension unpacked in Chrome, Firefox and Safari.

`pnpm install` runs `pre-commit install` for you when pre-commit is on your PATH, and says so when it is not.
Install pre-commit first, or run `pre-commit install` once after installing it.

## Before you open a pull request

The hooks run most of what CI runs. On commit: Biome (format, lint, imports), markdownlint, rustfmt and clippy,
zizmor on the workflows, gitleaks, and file hygiene. On push: the type check and the unit tests, and `cargo test`
when the host changed. `pnpm lint:fix` applies Biome's fixes to the whole tree, and `pre-commit run --all-files`
runs every commit hook on every file.

The rest of CI you run yourself. None of it needs API keys or makes calls outside your machine.

```sh
pnpm schema && git diff --exit-code -- contract
node scripts/contract-compat.ts origin/main   # contract/ changes: breaking without a version bump fails (ADR 0007)
pnpm test:e2e                                 # Chrome; pnpm test:e2e:firefox for Firefox
cd host && cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked
```

- **Conventional Commits.** Messages look like `feat(host): pair by code` or `fix: keep the draft on reload`
  (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, ...). The `commit-msg` hook checks the format.
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

- Keep one change per pull request, with a description of what changed and why and how you verified it.
- CI must pass: `CI` (lint, core, the Chrome and Firefox builds and e2e) and `Host` (cargo on Linux, macOS and Windows).
- A maintainer from `@liatrio-labs/liatrio-labs-maintainers` reviews and merges.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
