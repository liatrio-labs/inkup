// Selection for pull-request CI: which specs, crates and Vitest arguments a diff runs, and the full suite on main
// and the nightly. The workflow calls these scripts; a wrong plan fails here before it skips a suite.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cratesPlan, readHostGraph, selectCrates, sharedCrates } from '../../scripts/affected-crates.ts';
import {
  availableSpecs,
  e2eImportedFiles,
  formatE2ePlan,
  guardE2ePlan,
  mappedSpecBasenames,
  namedByRule,
  planE2e,
  selectE2e,
} from '../../scripts/affected-e2e.ts';
import { classify } from '../../scripts/ci-changes.ts';
import { areasForEvent, fullSuiteSides, vitestArgs } from '../../scripts/ci-full-suite.ts';
import { checkTitle } from '../../scripts/pr-title.ts';
import { FORCE_RERUN_TRIGGERS } from '../../scripts/vitest-rerun.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const chrome = new Set([
  'tests/e2e/text-comment.spec.ts',
  'tests/e2e/host.spec.ts',
  'tests/e2e/toolbar-session.spec.ts',
]);
const firefox = new Set(['tests/e2e-firefox/text-comment.spec.ts', 'tests/e2e-firefox/toolbar.spec.ts']);

describe('affected e2e', () => {
  it('narrows only docs and a rule that names no specs; everything else runs the suite', () => {
    const docs = ['docs/adr/0007-central-contract.md', 'README.md', 'LICENSE'];
    expect(selectE2e(docs, 'chrome', chrome)).toEqual({ mode: 'none', specs: [] });
    // The TUI rule is the named exception. A workflow, the selector itself, and root config are not.
    expect(selectE2e(['host/crates/tui/src/lib.rs'], 'chrome', chrome)).toEqual({ mode: 'none', specs: [] });
    expect(selectE2e(['DESIGN.md'], 'chrome', chrome)).toEqual({ mode: 'none', specs: [] });
    expect(selectE2e(['release-please-config.json'], 'chrome', chrome)).toEqual({ mode: 'none', specs: [] });
    expect(selectE2e(['release-please-config.json'], 'firefox', firefox)).toEqual({ mode: 'none', specs: [] });
    for (const file of [
      '.github/workflows/ci.yml',
      'scripts/affected-e2e.ts',
      'scripts/fixture-server.ts',
      'scripts/gen-long-session.ts',
      'tests/support/anthropic-stub.ts',
      'tsconfig.json',
      'biome.json',
    ]) {
      expect(selectE2e([file], 'chrome', chrome).mode, file).toBe('all');
      expect(selectE2e([file], 'firefox', firefox).mode, file).toBe('all');
    }
    expect(classify(docs)).toEqual({
      extension: false,
      host: false,
      contract: false,
      desktop: false,
      site: false,
      x64_macos: false,
      ui: false,
      workflows: false,
    });
  });

  it('runs one area for one package file, in each browser that has the spec', () => {
    const files = ['packages/ui/src/comment-box/comment-box.tsx'];
    expect(selectE2e(files, 'chrome', chrome)).toEqual({
      mode: 'specs',
      specs: ['tests/e2e/text-comment.spec.ts'],
    });
    expect(selectE2e(files, 'firefox', firefox)).toEqual({
      mode: 'specs',
      specs: ['tests/e2e-firefox/text-comment.spec.ts'],
    });
    expect(selectE2e(['extensions/web/src/content/text-comment.ts', 'README.md'], 'chrome', chrome).specs).toEqual([
      'tests/e2e/text-comment.spec.ts',
    ]);
  });

  it('runs the whole suite for a shared fixture, the harness, Playwright config, package.json or the lockfile', () => {
    for (const file of [
      'fixtures/site/pricing.html',
      'tests/e2e/fixtures.ts',
      'tests/e2e/helpers/draw.ts',
      'tests/e2e/raw-cdp.ts',
      'tests/e2e/harness.spec.ts',
      'tests/e2e-firefox/fixtures.ts',
      'tests/e2e-firefox/rdp.ts',
      'playwright.config.ts',
      'playwright.whisper.config.ts',
      'package.json',
      'extensions/web/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]) {
      expect(selectE2e([file, 'extensions/web/src/content/text-comment.ts'], 'chrome', chrome).mode, file).toBe('all');
    }
  });

  it('runs the whole suite for extension or contract code the map does not name', () => {
    expect(selectE2e(['packages/core/src/timeline.ts'], 'chrome', chrome).mode).toBe('all');
    expect(selectE2e(['contract/protocol.schema.json'], 'chrome', chrome).mode).toBe('all');
    expect(selectE2e(['extensions/web/src/messaging.ts'], 'firefox', firefox).mode).toBe('all');
  });

  it('runs the host specs for the host binary and a changed spec only in its browser', () => {
    expect(selectE2e(['host/crates/server/src/ws.rs'], 'chrome', chrome)).toEqual({
      mode: 'specs',
      specs: ['tests/e2e/host.spec.ts'],
    });
    expect(selectE2e(['tests/e2e/text-comment.spec.ts'], 'chrome', chrome).specs).toEqual([
      'tests/e2e/text-comment.spec.ts',
    ]);
    expect(selectE2e(['tests/e2e/text-comment.spec.ts'], 'firefox', firefox).mode).toBe('none');
    expect(selectE2e(['tests/e2e-firefox/toolbar.spec.ts'], 'firefox', firefox).specs).toEqual([
      'tests/e2e-firefox/toolbar.spec.ts',
    ]);
  });

  it('drops a spec the suite does not have and unions two areas', () => {
    const files = ['extensions/web/src/content/toolbar-position.ts', 'packages/ui/src/comment-box/index.ts'];
    expect(selectE2e(files, 'chrome', chrome).specs).toEqual([
      'tests/e2e/text-comment.spec.ts',
      'tests/e2e/toolbar-session.spec.ts',
    ]);
    expect(selectE2e(files, 'firefox', firefox).specs).toEqual([
      'tests/e2e-firefox/text-comment.spec.ts',
      'tests/e2e-firefox/toolbar.spec.ts',
    ]);
  });

  it('prints all, none, or specs for the workflow', () => {
    expect(formatE2ePlan({ mode: 'all', specs: [] })).toBe('all\n');
    expect(formatE2ePlan({ mode: 'none', specs: [] })).toBe('none\n');
    expect(formatE2ePlan({ mode: 'specs', specs: ['tests/e2e/text-comment.spec.ts'] })).toBe(
      'specs\ntests/e2e/text-comment.spec.ts\n',
    );
  });

  it('every mapped spec exists on disk, and the CLI reads stdin', () => {
    const real = planE2e(['packages/ui/src/comment-box/comment-box.tsx'], 'chrome', root);
    expect(real).toEqual({ mode: 'specs', specs: ['tests/e2e/text-comment.spec.ts'] });
    for (const basename of mappedSpecBasenames()) {
      const chromeHas = planE2e([`tests/e2e/${basename}`], 'chrome', root).mode !== 'none';
      const firefoxHas = planE2e([`tests/e2e-firefox/${basename}`], 'firefox', root).mode !== 'none';
      expect(chromeHas || firefoxHas, basename).toBe(true);
    }
    const out = execFileSync(process.execPath, ['scripts/affected-e2e.ts', 'chrome'], {
      cwd: root,
      encoding: 'utf8',
      input: 'fixtures/site/pricing.html\n',
    });
    expect(out).toBe('all\n');
  });

  it('covers every relative import of the suites, in both browsers, unless a rule names it', () => {
    const graph = e2eImportedFiles(root);
    for (const file of [
      'scripts/fixture-server.ts',
      'scripts/gen-long-session.ts',
      'scripts/gen-session-fixtures.ts',
      'tests/support/anthropic-stub.ts',
      'tests/support/script-model.ts',
      'tests/support/stt-stubs.ts',
      'tests/support/page-side-bundles.ts',
      'tests/support/github-stub.ts',
      'tests/support/jira-stub.ts',
      'tests/support/linear-stub.ts',
    ]) {
      expect(graph.has(file), file).toBe(true);
    }
    const chromeSpecs = planE2e([], 'chrome', root);
    expect(chromeSpecs.mode).toBe('none');
    for (const file of graph) {
      if (file.endsWith('.spec.ts') || namedByRule(file)) continue;
      expect(selectE2e([file], 'chrome', availableSpecs(root, 'chrome')).mode, file).toBe('all');
      expect(selectE2e([file], 'firefox', availableSpecs(root, 'firefox')).mode, file).toBe('all');
    }
  });

  it('refuses a zero-spec plan when the diff touches the e2e import graph', () => {
    expect(() =>
      guardE2ePlan(['scripts/fixture-server.ts'], { mode: 'none', specs: [] }, new Set(['scripts/fixture-server.ts'])),
    ).toThrow(/import graph/);
    expect(planE2e(['scripts/fixture-server.ts'], 'chrome', root).mode).toBe('all');
    expect(planE2e(['scripts/gen-long-session.ts'], 'firefox', root).mode).toBe('all');
  });
});

describe('affected crates', () => {
  const loaded = readHostGraph(root);
  if (!loaded) throw new Error('cargo metadata failed for host/');
  const graph = loaded;

  it('reads the host graph and the crates two members depend on', () => {
    expect(graph.map((crate) => [crate.name, crate.deps])).toEqual([
      ['inkup', ['inkup-protocol', 'inkup-server', 'inkup-store', 'inkup-tui', 'inkup-update-check']],
      ['inkup-protocol', []],
      ['inkup-server', ['inkup-protocol', 'inkup-store']],
      ['inkup-store', ['inkup-protocol']],
      ['inkup-tui', ['inkup-server', 'inkup-store']],
      ['inkup-update-check', ['inkup-store']],
    ]);
    expect(sharedCrates(graph)).toEqual(['inkup-protocol', 'inkup-server', 'inkup-store']);
  });

  it('tests a leaf crate and the crates that depend on it', () => {
    expect(selectCrates(['host/crates/tui/src/lib.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['inkup', 'inkup-tui'],
    });
    expect(selectCrates(['host/crates/update-check/src/lib.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['inkup', 'inkup-update-check'],
    });
    expect(selectCrates(['host/crates/inkup/src/main.rs'], graph)).toEqual({ mode: 'packages', packages: ['inkup'] });
    expect(selectCrates(['host/crates/tui/src/lib.rs', 'host/crates/update-check/src/lib.rs'], graph).packages).toEqual(
      ['inkup', 'inkup-tui', 'inkup-update-check'],
    );
  });

  it('tests the workspace when the lock, toolchain, manifest, contract or a shared crate changes', () => {
    for (const file of [
      'host/Cargo.lock',
      'host/Cargo.toml',
      'host/rust-toolchain.toml',
      'host/.cargo/config.toml',
      'contract/protocol.schema.json',
      'host/crates/protocol/src/lib.rs',
      'host/crates/store/src/lib.rs',
      'host/crates/server/src/ws.rs',
      'host/crates/tui/src/lib.rs',
    ]) {
      const plan = selectCrates([file], graph);
      const workspace = [
        'host/Cargo.lock',
        'host/Cargo.toml',
        'host/rust-toolchain.toml',
        'host/.cargo/config.toml',
        'contract/protocol.schema.json',
        'host/crates/protocol/src/lib.rs',
        'host/crates/store/src/lib.rs',
        'host/crates/server/src/ws.rs',
      ].includes(file);
      expect(plan.mode, file).toBe(workspace ? 'workspace' : 'packages');
    }
    expect(selectCrates(['host/crates/tui/src/lib.rs', 'host/Cargo.lock'], graph).mode).toBe('workspace');
  });

  it('tests nothing for docs and the workspace for every other non-crate path', () => {
    expect(selectCrates(['docs/adr/0007-central-contract.md', 'README.md', 'host/README.md'], graph).mode).toBe('none');
    for (const file of [
      '.github/workflows/ci.yml',
      'apps/desktop/rust-toolchain.toml',
      'packages/ui/src/index.ts',
      'tsconfig.json',
      'scripts/gen-schema.ts',
    ]) {
      expect(selectCrates([file], graph).mode, file).toBe('workspace');
    }
    expect(cratesPlan(['host/crates/tui/src/lib.rs'], null).mode).toBe('workspace');
  });

  it('keeps a reverse dependency declared as an inline workspace table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkup-crates-'));
    try {
      writeFileSync(
        join(dir, 'Cargo.toml'),
        `[workspace]\nresolver = "2"\nmembers = ["crates/leaf", "crates/app"]\n\n[workspace.dependencies]\nleaf = { path = "crates/leaf" }\n`,
      );
      mkdirSync(join(dir, 'crates/leaf/src'), { recursive: true });
      mkdirSync(join(dir, 'crates/app/src'), { recursive: true });
      writeFileSync(join(dir, 'crates/leaf/src/lib.rs'), '');
      writeFileSync(join(dir, 'crates/app/src/lib.rs'), '');
      writeFileSync(
        join(dir, 'crates/leaf/Cargo.toml'),
        '[package]\nname = "leaf"\nversion = "0.0.0"\nedition = "2021"\n',
      );
      writeFileSync(
        join(dir, 'crates/app/Cargo.toml'),
        '[package]\nname = "app"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nleaf = { workspace = true }\n',
      );
      // The reader looks for host/Cargo.toml. Point it at this workspace by laying the files under host/.
      const repo = mkdtempSync(join(tmpdir(), 'inkup-repo-'));
      mkdirSync(join(repo, 'host/crates'), { recursive: true });
      execFileSync('cp', ['-a', join(dir, 'Cargo.toml'), join(repo, 'host/Cargo.toml')]);
      execFileSync('cp', ['-a', join(dir, 'crates/leaf'), join(repo, 'host/crates/leaf')]);
      execFileSync('cp', ['-a', join(dir, 'crates/app'), join(repo, 'host/crates/app')]);
      // A machine whose only toolchain is the one host/rust-toolchain.toml names has no default to fall back on.
      execFileSync('cp', ['-a', join(root, 'host/rust-toolchain.toml'), join(repo, 'host/rust-toolchain.toml')]);
      const inline = readHostGraph(repo, false);
      expect(inline, 'cargo metadata').not.toBeNull();
      expect(selectCrates(['host/crates/leaf/src/lib.rs'], inline ?? []).packages).toEqual(['app', 'leaf']);
      rmSync(repo, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints the plan the cargo job reads', () => {
    const out = execFileSync(process.execPath, ['scripts/affected-crates.ts'], {
      cwd: root,
      encoding: 'utf8',
      input: 'host/crates/tui/src/lib.rs\n',
    });
    expect(out).toBe('packages\ninkup\ninkup-tui\n');
  });
});

describe('full suite and vitest', () => {
  it('treats push and the nightly as every area, and a pull request as a diff', () => {
    expect(areasForEvent('push')).toEqual({ mode: 'full', sides: fullSuiteSides() });
    expect(areasForEvent('schedule')).toEqual({ mode: 'full', sides: fullSuiteSides() });
    expect(fullSuiteSides().contract).toBe(true);
    expect(areasForEvent('pull_request')).toEqual({ mode: 'diff' });
    expect(areasForEvent('workflow_dispatch')).toEqual({ mode: 'diff' });
  });

  it('uses --changed only for an all-module diff, and always runs core in full', () => {
    const changed = ['run', '--changed', 'origin/main', '--passWithNoTests'];
    expect(vitestArgs('pull_request', ['.github/workflows/ci.yml'])).toEqual(['run']);
    expect(vitestArgs('pull_request', ['packages/core/src/annotation-shot.ts'], 'core')).toEqual(['run']);
    expect(vitestArgs('pull_request', ['packages/core/src/annotation-shot.ts'])).toEqual(changed);
    expect(vitestArgs('pull_request', ['extensions/web/src/content/text-comment.ts', 'README.md'])).toEqual(changed);
    expect(vitestArgs('pull_request', ['extensions/web/src/foo.ts', '.github/workflows/ci.yml'])).toEqual(['run']);
    expect(vitestArgs('push', ['extensions/web/src/foo.ts'])).toEqual(['run']);
    expect(vitestArgs('schedule')).toEqual(['run']);
    const full = execFileSync(process.execPath, ['scripts/ci-full-suite.ts', 'vitest', 'pull_request', 'all'], {
      cwd: root,
      encoding: 'utf8',
      input: '.github/workflows/ci.yml\n',
    });
    expect(full).toBe('run\n');
    const core = execFileSync(process.execPath, ['scripts/ci-full-suite.ts', 'vitest', 'pull_request', 'core'], {
      cwd: root,
      encoding: 'utf8',
      input: 'packages/core/src/annotation-shot.ts\n',
    });
    expect(core).toBe('run\n');
    expect(readFileSync(join(root, 'packages/core/tests/core-boundary.test.ts'), 'utf8')).toContain('readdirSync');
    const areas = execFileSync(process.execPath, ['scripts/ci-full-suite.ts', 'areas', 'schedule'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(areas).toBe(
      'full\nextension=true\nhost=true\ncontract=true\ndesktop=true\nsite=true\nx64_macos=true\nui=true\nworkflows=true\n',
    );
    expect(fullSuiteSides().workflows).toBe(true);
  });

  it('runs packages/ui in full from the core job, because product-boundary scans src/', () => {
    expect(vitestArgs('pull_request', ['packages/ui/src/highlight/index.ts'], 'core')).toEqual(['run']);
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const coreJob = ci.slice(ci.indexOf('\n  core:'), ci.indexOf('\n  # The Chrome'));
    expect(coreJob).toContain('pnpm -C packages/ui exec vitest');
    expect(coreJob).not.toContain('--changed');
    expect(readFileSync(join(root, 'packages/ui/tests/product-boundary.test.ts'), 'utf8')).toContain('readdirSync');
  });

  it('runs the full suite when DESIGN.md changes beside a UI module', () => {
    expect(vitestArgs('pull_request', ['DESIGN.md', 'packages/ui/src/highlight/index.ts'])).toEqual(['run']);
    expect(readFileSync(join(root, 'packages/ui/tests/theme.test.ts'), 'utf8')).toContain('DESIGN.md');
  });
});

describe('conventional pull request title', () => {
  it.each([
    'ci: narrow pull request tests',
    'feat(host): pair by code',
    'fix: keep the draft on reload',
    'feat!: bump the wire',
  ])('accepts %s', (title) => {
    expect(checkTitle(title)).toEqual({ ok: true });
  });

  it.each([
    ['Fix: nope', 'Conventional Commit'],
    ['feat: Done.', 'period'],
    ['feat: Keep the draft', 'sentence-case'],
    ['feat: Keep The Draft', 'start-case'],
    ['feat(Host): bad scope', 'Conventional Commit'],
    ['wip: later', 'unknown type'],
    [`ci: ${'a'.repeat(98)}`, '100 characters'],
  ])('rejects %s', (title, message) => {
    const result = checkTitle(title);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain(message);
  });
});

describe('workflow lint routing', () => {
  it('turns workflows on for a workflow-only diff and leaves it off otherwise', () => {
    const workflowOnly = classify(['.github/workflows/site-captures.yml']);
    expect(workflowOnly.workflows).toBe(true);
    expect(workflowOnly).toEqual({
      extension: false,
      host: false,
      contract: false,
      desktop: false,
      site: false,
      x64_macos: false,
      ui: false,
      workflows: true,
    });
    expect(classify(['.github/actionlint.yaml']).workflows).toBe(true);
    expect(classify(['.github/actionlint.yml']).workflows).toBe(true);
    expect(classify(['extensions/web/src/entrypoints/background.ts']).workflows).toBe(false);
    expect(classify(['README.md', 'docs/adr/0007-central-contract.md']).workflows).toBe(false);
    expect(classify(['.github/dependabot.yml']).workflows).toBe(false);
    expect(fullSuiteSides().workflows).toBe(true);
  });
});

describe('ci workflows', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const title = readFileSync(join(root, '.github/workflows/pr-title.yml'), 'utf8');

  function trigger(yaml: string): string {
    const start = yaml.indexOf('\non:');
    const end = yaml.indexOf('\npermissions:', start);
    return yaml.slice(start, end);
  }

  it('keeps ci-ok and does not filter a required workflow by path', () => {
    expect(trigger(ci)).not.toMatch(/paths(-ignore)?:/);
    expect(trigger(title)).not.toMatch(/paths(-ignore)?:/);
    expect(ci).not.toContain('paths-ignore:');
    expect(title).not.toContain('paths-ignore:');
    expect(ci).toContain('if: always()');
    expect(ci).toContain(
      'needs: [changes, contract-compat, lint, core, extension-chrome, extension-chrome-e2e, extension-firefox, cargo, desktop, site, x64-macos, design, actionlint]',
    );
    expect(ci).toContain('ui: $' + '{{ steps.diff.outputs.ui }}');
    expect(ci).toContain(
      "printf 'extension=true\\nhost=true\\ncontract=false\\ndesktop=true\\nsite=true\\nx64_macos=true\\nui=true\\nworkflows=true\\n'",
    );
    expect(ci).toContain('.result == "success" or .result == "skipped"');
  });

  it('narrows pull requests, runs the full suite on main and nightly, and checks the title apart from ci-ok', () => {
    expect(trigger(ci)).toContain('schedule:');
    expect(trigger(ci)).toContain("cron: '15 7 * * *'");
    expect(ci).toContain('scripts/ci-full-suite.ts areas');
    expect(ci).toContain('scripts/ci-full-suite.ts vitest');
    expect(ci).toContain('scripts/affected-e2e.ts chrome');
    expect(ci).toContain('scripts/affected-e2e.ts firefox');
    expect(ci).toContain('scripts/affected-crates.ts');
    expect(ci).toContain('cargo test --workspace --locked');
    expect(ci).toMatch(/cargo test "\$\{pkgs\[@\]\}" --locked/);
    expect(title).toContain('types: [opened, edited, synchronize, reopened]');
    expect(title).toContain('runs-on: ubuntu-24.04-arm');
    expect(title).toContain('timeout-minutes: 5');
    expect(title).toContain('contents: read');
    expect(title).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(title).toContain('test "$machine" = aarch64');
    expect(title).toContain('node-version: $' + '{{ env.NODE_VERSION }}');
    expect(title).not.toContain('actions/cache@');
    expect(title).not.toContain('ci-ok');
    expect(nodeVersion(title)).toBe(nodeVersion(ci));
  });

  it('runs an advisory design job on UI changes and skips it otherwise', () => {
    const start = ci.indexOf('\n  design:\n');
    const end = ci.indexOf('\n  actionlint:\n', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const design = ci.slice(start, end);
    expect(design).toContain('needs: changes');
    expect(design).toContain("if: needs.changes.outputs.ui == 'true'");
    expect(design).toContain('runs-on: ubuntu-24.04-arm');
    expect(design).toContain('timeout-minutes:');
    expect(design).toContain('contents: read');
    expect(design).toContain('uname -m');
    expect(design).toContain('test "$machine" = aarch64');
    expect(design.indexOf('test "$machine" = aarch64')).toBeLessThan(design.indexOf('actions/checkout@'));
    expect(design).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(design).toContain('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
    expect(design).toContain('pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413');
    expect(design).toContain('persist-credentials: false');
    expect(design).toContain('pnpm exec impeccable');
    expect(design).toContain('test "$detected" = "4.7.0"');
    expect(design).not.toContain('npx');
    expect(design).not.toContain('impeccable@latest');
    expect(design).toContain('detect --json --');
    expect(design).toContain('--diff-filter=ACMR');
    expect(design).toContain('DO_NOT_TRACK: "1"');
    expect(design).toContain('ui:build');
    expect(design).toContain('Twenty minutes');
    expect(design).toContain('mapfile');
    expect(design).not.toContain('xargs');
    expect(design).toContain('IMPECCABLE_MODE: advisory');
    expect(design).toContain('blocking');
    expect(design).toContain('--viewport');
    expect(design).toContain('1440x900');
    expect(design).toContain('390x844');
    expect(design).toContain('IMPECCABLE_BROWSER');
    expect(design).toContain('scripts/ci-design.ts summarize');
    expect(design).toContain('scripts/ci-design.ts disables');
    expect(design).toContain('scripts/ci-changes.ts --ui-files');
  });

  it('runs actionlint on workflow changes, on arm64, and lets a skip pass ci-ok', () => {
    const start = ci.indexOf('\n  actionlint:\n');
    const end = ci.indexOf('\n  # The one required check', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const job = ci.slice(start, end);
    expect(job).toContain('needs: changes');
    expect(job).toContain("if: needs.changes.outputs.workflows == 'true'");
    expect(job).toContain('runs-on: ubuntu-24.04-arm');
    expect(job).toContain('test "$machine" = aarch64');
    expect(job).toContain('linux_arm64');
    expect(job).toContain('sha256sum -c -');
    expect(job).toContain('325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6');
    expect(job).toContain('1.7.12');
    expect(job).toContain('command -v shellcheck');
    expect(job).toContain('actionlint -color');
    expect(ci).toContain('workflows: $' + '{{ steps.diff.outputs.workflows }}');
    expect(ci).toContain('.result == "success" or .result == "skipped"');
  });
});

function nodeVersion(yaml: string): string {
  const match = yaml.match(/^env:\n(?:^[ \t].*\n)*?^[ \t]+NODE_VERSION: "([^"]+)"/m);
  if (!match?.[1]) throw new Error('NODE_VERSION missing');
  return match[1];
}

function withoutGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

describe('vitest changed reruns disk fixtures', () => {
  it('lists the triggers on every Vitest config the jobs run', () => {
    expect(FORCE_RERUN_TRIGGERS).toEqual(
      expect.arrayContaining(['**/fixtures/**', '**/contract/**', '**/tests/support/**']),
    );
    for (const file of [
      'vitest.config.ts',
      'packages/core/vitest.config.ts',
      'packages/protocol/vitest.config.ts',
      'packages/ui/vitest.config.ts',
      'extensions/web/vitest.config.ts',
      'apps/desktop/vitest.config.ts',
    ]) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain('FORCE_RERUN_TRIGGERS');
    }
  });

  it('runs the project when only a fixture file changed', () => {
    // Inside the repo so `vitest` resolves. A nested git repo, removed when the test ends.
    const dir = mkdtempSync(join(root, 'vitest-rerun-'));
    const env = withoutGitEnv();
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
    try {
      writeFileSync(
        join(dir, 'vitest.config.ts'),
        `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { forceRerunTriggers: ${JSON.stringify(FORCE_RERUN_TRIGGERS)}, include: ['read.test.ts'] } });\n`,
      );
      mkdirSync(join(dir, 'fixtures'));
      writeFileSync(join(dir, 'fixtures/session.json'), '{"schema_version":"ok"}\n');
      writeFileSync(
        join(dir, 'read.test.ts'),
        "import { readFileSync } from 'node:fs';\nimport { expect, it } from 'vitest';\nit('reads the fixture', () => {\n  expect(readFileSync(new URL('./fixtures/session.json', import.meta.url), 'utf8')).toContain('ok');\n});\n",
      );
      git(['init']);
      git(['add', '.']);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'test: fixture']);
      writeFileSync(join(dir, 'fixtures/session.json'), '{"schema_version":"bad"}\n');
      let output = '';
      let status = 0;
      try {
        output = execFileSync(
          process.execPath,
          [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--changed', 'HEAD', '--passWithNoTests'],
          { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        status = failed.status ?? 1;
        output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`;
      }
      expect(output).not.toContain('No test files found');
      expect(output).toMatch(/reads the fixture|toContain\('ok'\)/);
      expect(status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
