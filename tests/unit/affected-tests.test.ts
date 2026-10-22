// Selection for pull-request CI: which specs, crates and Vitest arguments a diff runs, and the full suite on main
// and the nightly. The workflow calls these scripts; a wrong plan fails here before it skips a suite.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readHostGraph, selectCrates, sharedCrates } from '../../scripts/affected-crates.ts';
import { formatE2ePlan, mappedSpecBasenames, planE2e, selectE2e } from '../../scripts/affected-e2e.ts';
import { classify } from '../../scripts/ci-changes.ts';
import { areasForEvent, fullSuiteSides, vitestArgs } from '../../scripts/ci-full-suite.ts';
import { checkTitle } from '../../scripts/pr-title.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const chrome = new Set([
  'tests/e2e/text-comment.spec.ts',
  'tests/e2e/host.spec.ts',
  'tests/e2e/toolbar-session.spec.ts',
]);
const firefox = new Set(['tests/e2e-firefox/text-comment.spec.ts', 'tests/e2e-firefox/toolbar.spec.ts']);

describe('affected e2e', () => {
  it('runs nothing for docs, CI and a leaf the browser does not drive', () => {
    const docs = ['docs/adr/0007-central-contract.md', 'README.md', 'LICENSE'];
    expect(selectE2e(docs, 'chrome', chrome)).toEqual({ mode: 'none', specs: [] });
    expect(selectE2e(['.github/workflows/ci.yml', 'scripts/affected-e2e.ts'], 'chrome', chrome)).toEqual({
      mode: 'none',
      specs: [],
    });
    expect(selectE2e(['host/crates/tui/src/lib.rs'], 'chrome', chrome)).toEqual({ mode: 'none', specs: [] });
    expect(classify(docs)).toEqual({
      extension: false,
      host: false,
      contract: false,
      desktop: false,
      site: false,
      x64_macos: false,
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
});

describe('affected crates', () => {
  const graph = readHostGraph(root);

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

  it('tests nothing when the diff has no host code', () => {
    expect(selectCrates(['docs/adr/0007-central-contract.md', 'README.md', 'host/README.md'], graph).mode).toBe('none');
    expect(selectCrates(['apps/desktop/rust-toolchain.toml', 'packages/ui/src/index.ts'], graph).mode).toBe('none');
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

  it('narrows vitest on a pull request and runs the suite otherwise', () => {
    expect(vitestArgs('pull_request')).toEqual(['run', '--changed', 'origin/main', '--passWithNoTests']);
    expect(vitestArgs('push')).toEqual(['run']);
    expect(vitestArgs('schedule')).toEqual(['run']);
    const out = execFileSync(process.execPath, ['scripts/ci-full-suite.ts', 'vitest', 'pull_request'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toBe('run\n--changed\norigin/main\n--passWithNoTests\n');
    const areas = execFileSync(process.execPath, ['scripts/ci-full-suite.ts', 'areas', 'schedule'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(areas).toBe('full\nextension=true\nhost=true\ncontract=true\ndesktop=true\nsite=true\nx64_macos=true\n');
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
      'needs: [changes, contract-compat, lint, core, extension-chrome, extension-chrome-e2e, extension-firefox, cargo, desktop, site, x64-macos]',
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
    expect(title).toContain('runner.arch');
    expect(title).not.toContain('ci-ok');
  });
});
