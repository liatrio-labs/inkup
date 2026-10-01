// Whether the commits since the last release ship (scripts/release-worthy.ts, ADR 0027): release-please.yml skips the
// release pull request when they do not. The file lists below are the real ones from main's site pull requests that
// released inkup 0.3.0 to 0.5.0, with their apps/site files trimmed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Commit, commitsSinceRelease, releasedTypes, releaseWorthy } from '../../scripts/release-worthy.ts';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/release-worthy.ts');
const CONFIG = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../release-please-config.json'), 'utf8'));
const TYPES = releasedTypes(CONFIG);

const commit = (message: string, ...files: string[]): Commit => ({ sha: '0123456789abcdef', message, files });

describe('releasedTypes', () => {
  it('is the types release-please-config.json shows in a changelog', () => {
    expect([...TYPES].sort()).toEqual(['feat', 'fix', 'perf', 'revert']);
  });
});

describe('releaseWorthy', () => {
  it.each([
    [
      'the site skeleton (#48)',
      commit(
        'feat(site): add the marketing site skeleton, its CI route and Pages deploy (#48)',
        '.github/workflows/ci.yml',
        '.github/workflows/site.yml',
        '.gitignore',
        'apps/site/package.json',
        'biome.json',
        'docs/adr/0026-marketing-site-astro-on-github-pages.md',
        'pnpm-lock.yaml',
        'release-please-config.json',
        'scripts/ci-changes.ts',
        'tests/unit/ci-changes.test.ts',
      ),
    ],
    [
      'the site captures (#49)',
      commit(
        'feat(site): record the product captures from the real extension (#49)',
        '.github/workflows/site-captures.yml',
        'apps/site/src/assets/captures/toolbar-recording.png',
        'fixtures/site/demo-store.html',
        'package.json',
        'scripts/fixture-server.ts',
        'tests/e2e/site-captures.spec.ts',
      ),
    ],
    [
      'the site brand (#50)',
      commit(
        'feat(site): brand the landing page as "The Inspected Page" (#50)',
        '.gitignore',
        '.impeccable/design.json',
        'DESIGN.md',
        'PRODUCT.md',
        'README.md',
        'apps/site/src/pages/index.astro',
        'pnpm-lock.yaml',
      ),
    ],
    [
      'a root docs fix',
      commit('fix: correct the install steps', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md'),
    ],
    ['a lockfile-only refresh', commit('fix(deps): refresh the lockfile', 'pnpm-lock.yaml', 'package.json')],
    ['docs about the host', commit('docs(host): explain the update check', 'host/README.md', 'docs/releasing.md')],
    ['a host refactor', commit('refactor(host): split the server', 'host/crates/server/src/lib.rs')],
    ['a CI change to the release', commit('ci(release): run on tags', '.github/workflows/release.yml')],
    ['a test-only fix', commit('fix(e2e): wait for the panel', 'tests/e2e/panel.spec.ts')],
    ['an extension-ish path outside extensions/web', commit('feat: a new browser', 'extensions/safari/README.md')],
    ['a commit with no conventional header', commit('Update README', 'host/README.md')],
  ])('%s does not ship', (_, c) => {
    expect(releaseWorthy([c], TYPES)).toEqual({ release: false, reasons: [] });
  });

  it.each([
    ['a host feature', commit('feat(host): add a flag', 'host/crates/inkup/src/main.rs')],
    ['a desktop fix', commit('fix(desktop): pairing', 'apps/desktop/src-tauri/src/startup.rs')],
    ['a contract change', commit('feat(contract): add a message', 'contract/protocol.schema.json')],
    ['a shared package fix', commit('fix(core): rounding', 'packages/core/src/geometry.ts')],
    ['an extension fix', commit('fix(extension): toolbar', 'extensions/web/src/toolbar.ts')],
    ['an extension dependency', commit('fix(deps): bump wxt', 'extensions/web/package.json', 'pnpm-lock.yaml')],
    ['a perf change', commit('perf(host): faster store', 'host/crates/store/src/lib.rs')],
    ['a revert', commit('revert: "feat(host): add a flag"', 'host/crates/inkup/src/main.rs')],
    ['a breaking `!` of a hidden type', commit('refactor(host)!: drop v1 routes', 'host/crates/server/src/ws.rs')],
    [
      'a BREAKING CHANGE footer',
      commit('chore(contract): rename\n\nBREAKING CHANGE: hello is now greet', 'contract/protocol.schema.json'),
    ],
    ['a Release-As footer, anywhere', commit('chore: release 0.7.0\n\nRelease-As: 0.7.0', 'README.md')],
  ])('%s ships', (_, c) => {
    const verdict = releaseWorthy([c], TYPES);
    expect(verdict.release).toBe(true);
    expect(verdict.reasons).toHaveLength(1);
  });

  it('ships when any one commit since the release does, and names only that one', () => {
    const verdict = releaseWorthy(
      [
        commit('feat(site): new hero', 'apps/site/src/pages/index.astro', 'pnpm-lock.yaml'),
        { ...commit('fix(host): crash', 'host/crates/inkup/src/main.rs', 'host/Cargo.lock'), sha: 'feedface00' },
        commit('docs: readme', 'README.md'),
      ],
      TYPES,
    );
    expect(verdict).toEqual({
      release: true,
      reasons: ['feedfac fix(host): crash: host/crates/inkup/src/main.rs and 1 more'],
    });
  });
});

// The git side, against a real repo in a temp dir.
let dir: string;
let work: string;
let env: NodeJS.ProcessEnv;

/** The child environment, without the caller's GIT_* variables (a git hook exports GIT_DIR at the real repo). */
function isolatedEnv(): NodeJS.ProcessEnv {
  const outer = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return {
    ...outer,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: dir,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
  };
}

/** Runs git in the temp repo, after checking that the repo it would write to is inside the temp dir. */
function git(...args: string[]): string {
  const root = realpathSync(dir);
  const found = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: work, env, encoding: 'utf8' });
  const gitDir = found.status === 0 ? found.stdout.trim() : null;
  if (gitDir ? !gitDir.startsWith(`${root}/`) : args[0] !== 'init')
    throw new Error(`refusing \`git ${args.join(' ')}\`: its git dir ${gitDir} is outside ${root}`);
  const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: work,
    env,
    encoding: 'utf8',
  });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
}

/** Commits `files` (each written with new contents) with `message`, and returns its sha. */
function commitFiles(message: string, ...files: string[]): string {
  for (const file of files) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), `${message}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', message);
  return git('rev-parse', 'HEAD');
}

const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, env, encoding: 'utf8' });

describe('commitsSinceRelease and the command line', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inkup-release-worthy-'));
    work = join(dir, 'work');
    mkdirSync(work);
    env = isolatedEnv();
    git('init', '-q');
    const root = realpathSync(dir);
    if (!git('rev-parse', '--absolute-git-dir').startsWith(`${root}/`)) throw new Error('git init missed the temp dir');
    commitFiles('feat(host): before the release', 'host/src/main.rs');
    commitFiles('chore(release): inkup 0.6.0', '.release-please-manifest.json', 'host/CHANGELOG.md');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the commits after the last release pull request, with their files', () => {
    const site = commitFiles('feat(site): hero\n\nA longer body.', 'apps/site/index.astro', 'pnpm-lock.yaml');
    const docs = commitFiles('docs: readme', 'README.md');
    expect(commitsSinceRelease('HEAD', { cwd: work, env })).toEqual([
      { sha: site, message: 'feat(site): hero\n\nA longer body.', files: ['apps/site/index.astro', 'pnpm-lock.yaml'] },
      { sha: docs, message: 'docs: readme', files: ['README.md'] },
    ]);
  });

  it('prints release=false for site and docs commits', () => {
    commitFiles('feat(site): hero', 'apps/site/index.astro', 'README.md', 'pnpm-lock.yaml');
    commitFiles('docs: readme', 'README.md', 'PRODUCT.md');
    const run = cli();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('release=false\n');
    expect(run.stderr).toContain('Nothing since the last release ships');
  });

  it('prints release=true once a shipped change lands, and names it', () => {
    commitFiles('feat(site): hero', 'apps/site/index.astro');
    commitFiles('fix(extension): toolbar', 'extensions/web/src/toolbar.ts');
    const run = cli();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('release=true\n');
    expect(run.stderr).toMatch(/ships: [0-9a-f]{7} fix\(extension\): toolbar: extensions\/web\/src\/toolbar.ts/);
  });

  it('looks only after the last release, and up to the revision asked for', () => {
    commitFiles('fix(host): crash', 'host/src/main.rs');
    const fixed = git('rev-parse', 'HEAD');
    commitFiles('chore(release): inkup 0.6.1', '.release-please-manifest.json');
    commitFiles('docs: readme', 'README.md');
    expect(cli().stdout).toBe('release=false\n');
    expect(cli(fixed).stdout).toBe('release=true\n');
  });

  it('fails on a revision the repo does not have', () => {
    const run = cli('no-such-rev');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('::error::');
  });
});
