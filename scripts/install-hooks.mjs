// Runs from the root `prepare` script, so `pnpm install` after a clone wires the pre-commit hooks
// (commit, push and commit-msg, per default_install_hook_types in .pre-commit-config.yaml).
// Never fails the install. CI (any CI that sets CI, as GitHub Actions, GitLab and CircleCI do) skips with one plain
// log line: the lint job runs the hooks there itself. A tarball without .git skips silently. A developer without
// pre-commit gets a loud banner, colored only on a terminal.
//
// Worktrees share one hooks directory (in the git common dir), and `pnpm install` in several of them at once raced
// `pre-commit install`: one run moved another's fresh hook aside as `<hook>.legacy`, and every commit then ran the
// hooks in migration mode. So it skips when every hook is already pre-commit's, installs under a lock in the common
// dir, and deletes any `.legacy` file that is itself a pre-commit hook.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 120_000;
const shell = process.platform === 'win32';

const ci = (process.env.CI ?? '').trim().toLowerCase();
if (ci !== '' && ci !== 'false' && ci !== '0') {
  console.log('[hooks] CI detected; not installing git hooks.');
  process.exit(0);
}
if (!existsSync('.git')) process.exit(0);

const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', shell });
if (common.status !== 0) process.exit(0);
const commonDir = resolve(common.stdout.trim());
const hookTypes = readHookTypes();

if (healthy()) process.exit(0);

const found = spawnSync('pre-commit', ['--version'], { stdio: 'ignore', shell });
if (found.status !== 0) {
  warn([
    'WARNING: pre-commit is not installed. The git hooks are NOT set up.',
    '',
    'Commits will skip formatting, linting, secret scanning and the',
    'commit-message check, and CI will reject what the hooks would catch.',
    '',
    'Install it, then wire the hooks:',
    '  brew install pre-commit     (or: pipx install pre-commit)',
    '  pre-commit install',
  ]);
  process.exit(0);
}

const lock = join(commonDir, 'inkup-install-hooks.lock');
if (!acquire(lock)) {
  warn([
    'WARNING: another install held the git hooks lock for too long.',
    '',
    `If no install is running, delete ${lock}`,
    'and run: pre-commit install',
  ]);
  process.exit(0);
}
try {
  // Another worktree may have installed while this one waited for the lock.
  if (!healthy({ heal: true })) {
    const run = spawnSync('pre-commit', ['install'], { stdio: 'inherit', shell });
    if (run.status !== 0)
      warn([
        'WARNING: pre-commit install failed. The git hooks are NOT set up.',
        '',
        'Fix the error above, then run: pre-commit install',
      ]);
    healthy({ heal: true });
  }
} finally {
  rmSync(lock, { recursive: true, force: true });
}

/** The hook types `pre-commit install` writes: default_install_hook_types, else pre-commit's own default. */
function readHookTypes() {
  let config = '';
  try {
    config = readFileSync('.pre-commit-config.yaml', 'utf8');
  } catch {}
  const types = config
    .match(/^default_install_hook_types:\s*\[([^\]]*)\]/m)?.[1]
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return types?.length ? types : ['pre-commit'];
}

/** A hook pre-commit generated: its template carries an `# ID: <32 hex>` marker line. */
function isPreCommitHook(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return text.includes('pre-commit') && /^# ID: [0-9a-f]{32}$/m.test(text);
  } catch {
    return false;
  }
}

/**
 * True when every hook type is pre-commit's and no `<hook>.legacy` is a copy of one (that copy is what puts
 * pre-commit in migration mode). With `heal`, deletes those copies first; only under the lock.
 */
function healthy({ heal = false } = {}) {
  let ok = true;
  for (const type of hookTypes) {
    const hook = join(commonDir, 'hooks', type);
    if (isPreCommitHook(`${hook}.legacy`)) {
      if (heal) {
        rmSync(`${hook}.legacy`, { force: true });
        console.log(`[hooks] removed ${type}.legacy, a copy of the pre-commit hook itself.`);
      } else ok = false;
    }
    if (!isPreCommitHook(hook)) ok = false;
  }
  return ok;
}

/** An atomic mkdir lock. One older than LOCK_STALE_MS belongs to a crashed install and is taken over. */
function acquire(dir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      mkdirSync(dir);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
    }
    try {
      if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) rmSync(dir, { recursive: true, force: true });
    } catch {}
    Atomics.wait(pause, 0, 0, 100);
  }
  return false;
}

// A boxed banner in bold yellow (plain when NO_COLOR is set or stderr is not a terminal), so it stands out in the
// install log.
function warn(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const color = process.stderr.isTTY && !process.env.NO_COLOR;
  const paint = (s) => (color ? `\x1b[1;33m${s}\x1b[0m` : s);
  const bar = '!'.repeat(width + 6);
  const body = lines.map((l) => `!! ${l.padEnd(width)} !!`);
  console.warn(`\n${[bar, ...body, bar].map(paint).join('\n')}\n`);
}
