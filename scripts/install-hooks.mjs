// Runs from the root `prepare` script, so `pnpm install` after a clone wires the pre-commit hooks
// (commit, push and commit-msg, per default_install_hook_types in .pre-commit-config.yaml).
// Never fails the install. CI (any CI that sets CI, as GitHub Actions, GitLab and CircleCI do) skips with one plain
// log line: the lint job runs the hooks there itself. A tarball without .git skips silently. A developer without
// pre-commit gets a loud banner, colored only on a terminal.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ci = (process.env.CI ?? '').trim().toLowerCase();
if (ci !== '' && ci !== 'false' && ci !== '0') {
  console.log('[hooks] CI detected; not installing git hooks.');
  process.exit(0);
}
if (!existsSync('.git')) process.exit(0);

const found = spawnSync('pre-commit', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
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

const run = spawnSync('pre-commit', ['install'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (run.status !== 0)
  warn([
    'WARNING: pre-commit install failed. The git hooks are NOT set up.',
    '',
    'Fix the error above, then run: pre-commit install',
  ]);

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
