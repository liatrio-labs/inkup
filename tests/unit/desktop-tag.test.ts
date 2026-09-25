// The tag checks desktop-macos.yml runs before it builds the desktop app's DMG (scripts/desktop-tag.ts, ADR 0025),
// against a real git remote: a bare repo with a lightweight and an annotated tag.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHostTag, remoteTagCommit } from '../../scripts/desktop-tag.ts';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/desktop-tag.ts');

describe('parseHostTag', () => {
  it.each([
    ['inkup-v0.2.0', '0.2.0', false],
    ['inkup-v1.10.3', '1.10.3', false],
    ['inkup-v0.2.0-rc.2', '0.2.0-rc.2', true],
    ['inkup-v0.3.0-beta', '0.3.0-beta', true],
  ])('%s is version %s, pre-release %s', (tag, version, prerelease) => {
    expect(parseHostTag(tag)).toEqual({ tag, version, prerelease });
  });

  it.each([
    '',
    'v0.2.0',
    '0.2.0',
    'inkup-v0.2',
    'inkup-v0.2.0-',
    'inkup-v0.2.0-rc_1',
    'inkup-extension-v0.2.0',
    'inkup-chrome-v0.2.0',
    'refs/tags/inkup-v0.2.0',
    'inkup-v0.2.0\n',
    'inkup-v0.2.0"; echo pwned',
    'inkup-v0.2.0-rc.1$(id)',
    ' inkup-v0.2.0',
  ])('refuses %j', (tag) => {
    expect(() => parseHostTag(tag)).toThrow(/not a host release tag/);
  });
});

let dir: string;
let remote: string;
let first: string;
let second: string;
let env: NodeJS.ProcessEnv;

/**
 * The child environment, built without the caller's GIT_* variables (the pattern of install-hooks.test.ts).
 * `pnpm test` runs from the pre-push hook, where GIT_DIR and the rest point at the real repo; passed on, they made
 * `git init --bare` here reinitialise it as a bare repo. No global or system config (signing, hooks), HOME in the temp
 * dir, and git never searches above the temp dir either.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const outer = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return {
    ...outer,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: dir,
    // No detached auto-maintenance after a commit: it writes objects/maintenance.lock while a snapshot reads the repo.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
  };
}

/** The git dir `cwd` resolves to, or null outside a repo. */
function gitDirOf(cwd: string): string | null {
  const found = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, env, encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

/**
 * Runs git in `cwd`, after checking that the repo it would write to is inside the temp dir, and that every path
 * argument is too. Only `init` may run where there is no repo yet.
 */
function git(cwd: string, ...args: string[]): string {
  const root = realpathSync(dir);
  const gitDir = gitDirOf(cwd);
  if (gitDir ? !gitDir.startsWith(`${root}/`) : args[0] !== 'init')
    throw new Error(`refusing \`git ${args.join(' ')}\` in ${cwd}: its git dir ${gitDir} is outside ${root}`);
  for (const arg of args)
    if (arg.startsWith('/') && !realpathSync(join(arg, '..')).startsWith(root))
      throw new Error(`refusing \`git ${args.join(' ')}\`: ${arg} is outside ${root}`);
  const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
}

/** A temp dir with a bare remote holding a lightweight tag on one commit and an annotated tag on the next. */
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'inkup-desktop-tag-'));
  env = isolatedEnv();
  remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  mkdirSync(remote);
  mkdirSync(work);
  git(remote, 'init', '-q', '--bare');
  git(work, 'init', '-q');
  const root = realpathSync(dir);
  for (const repo of [remote, work])
    if (!gitDirOf(repo)?.startsWith(`${root}/`)) throw new Error(`git init did not make a repo in ${repo}`);
  git(work, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'one');
  first = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', 'inkup-v0.2.0-rc.2');
  git(work, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'two');
  second = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', '-a', '-m', 'annotated', 'inkup-v0.2.0');
  git(work, 'push', '-q', '--no-verify', remote, 'HEAD:refs/heads/main', '--tags');
}

/** The script's command line, run with the isolated environment. */
const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });

/** Every file under `root`, with its contents: a before/after fingerprint of a repo. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(root.length)] = readFileSync(path, 'base64');
    }
  return files;
}

describe('remoteTagCommit', () => {
  beforeEach(setup);

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves a lightweight tag to its commit', () => {
    expect(remoteTagCommit('inkup-v0.2.0-rc.2', remote)).toBe(first);
  });

  it('peels an annotated tag to its commit', () => {
    expect(remoteTagCommit('inkup-v0.2.0', remote)).toBe(second);
  });

  it('refuses a tag the remote does not have', () => {
    expect(() => remoteTagCommit('inkup-v0.2.0-rc.3', remote)).toThrow(/has no tag inkup-v0.2.0-rc.3/);
  });

  it('prints the outputs from the command line', () => {
    const run = cli('inkup-v0.2.0-rc.2', remote);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`tag=inkup-v0.2.0-rc.2\nversion=0.2.0-rc.2\nprerelease=true\nsha=${first}\n`);
  });

  it.each([
    ['a malformed tag', 'main', /not a host release tag/],
    ['a missing tag', 'inkup-v9.9.9', /has no tag inkup-v9.9.9/],
  ])('fails on %s from the command line', (_, tag, message) => {
    const run = cli(tag, remote);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(message);
  });

  it('leaves the repo that GIT_DIR points at alone, as inside a git hook', () => {
    const decoyDir = mkdtempSync(join(tmpdir(), 'inkup-decoy-'));
    const decoy = join(decoyDir, 'repo');
    try {
      // The decoy, made with this suite's own guarded helpers.
      const [outerDir, outerEnv] = [dir, env];
      dir = decoyDir;
      env = isolatedEnv();
      mkdirSync(decoy);
      git(decoy, 'init', '-q');
      git(decoy, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'decoy');
      [dir, env] = [outerDir, outerEnv];
      const before = snapshot(join(decoy, '.git'));

      // What a pre-push hook exports, pointing at the decoy.
      const hookEnv = {
        GIT_DIR: join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(decoy, '.git', 'index'),
        GIT_COMMON_DIR: join(decoy, '.git'),
        GIT_OBJECT_DIRECTORY: join(decoy, '.git', 'objects'),
      };
      Object.assign(process.env, hookEnv);
      try {
        // The whole fixture, rebuilt with the hook's variables in the environment.
        rmSync(dir, { recursive: true, force: true });
        setup();
        expect(remoteTagCommit('inkup-v0.2.0', remote)).toBe(second);
        // The script itself, run with the hook's variables, only reads the remote.
        const direct = spawnSync(process.execPath, [SCRIPT, 'inkup-v0.2.0-rc.2', remote], {
          env: { ...env, ...hookEnv },
          encoding: 'utf8',
        });
        expect(direct.status).toBe(0);
        expect(direct.stdout).toContain(`sha=${first}`);
      } finally {
        for (const k of Object.keys(hookEnv)) delete process.env[k];
      }

      expect(snapshot(join(decoy, '.git'))).toEqual(before);
    } finally {
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });
});
