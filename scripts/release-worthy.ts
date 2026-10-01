// `node scripts/release-worthy.ts [<rev>]`: says whether the commits since the last release, up to <rev> (HEAD by
// default), hold a change that ships, and prints `release=true|false` as a GITHUB_OUTPUT line (ADR 0027).
// release-please.yml runs it before release-please and skips the release pull request when it prints false.
//
// release-please cannot say this itself. The host is its root package (`.`), which gets every commit, and its
// `exclude-paths` only match directories, so a commit touching a root file (README.md, pnpm-lock.yaml) always counted
// for the host: three `feat(site)` pull requests released inkup 0.3.0, 0.4.0 and 0.5.0. This lists what does ship
// instead. A commit ships when its type is one release-please-config.json shows in a changelog (feat, fix, perf,
// revert) or it is a breaking change, and it touches a path either component is built from. A `Release-As:` footer
// always ships, wherever it is. The last release is the last commit that changed .release-please-manifest.json, which
// only a merged release pull request does.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * What the host, the desktop app and the extension are built from. Root files are not: a dependency change that
 * matters edits a package.json or Cargo.toml in here as well as the lockfile, and a lockfile-only refresh ships with the
 * next release. apps/site, docs, CI, tests, fixtures and scripts build nothing that ships.
 */
export const SHIPPED_PATHS = ['host/', 'apps/desktop/', 'contract/', 'packages/', 'extensions/web/'] as const;

export interface Commit {
  sha: string;
  message: string;
  files: string[];
}

export interface Verdict {
  release: boolean;
  /** One line per commit that ships, with why. */
  reasons: string[];
}

const HEADER = /^(?<type>[a-z]+)(\([^)]*\))?(?<bang>!)?: /;
const BREAKING = /^BREAKING[ -]CHANGE: /m;
const RELEASE_AS = /^release-as: \S+/im;

/** The commit types release-please-config.json shows in a changelog: the ones release-please releases for. */
export function releasedTypes(config: { 'changelog-sections': { type: string; hidden?: boolean }[] }): Set<string> {
  return new Set(config['changelog-sections'].filter((s) => !s.hidden).map((s) => s.type));
}

export function releaseWorthy(commits: Commit[], types: Set<string>): Verdict {
  const reasons: string[] = [];
  for (const commit of commits) {
    const header = commit.message.split('\n', 1)[0] ?? '';
    const short = `${commit.sha.slice(0, 7)} ${header}`;
    if (RELEASE_AS.test(commit.message)) {
      reasons.push(`${short}: Release-As footer`);
      continue;
    }
    const { type = '', bang } = HEADER.exec(header)?.groups ?? {};
    if (!type) continue;
    const breaking = bang === '!' || BREAKING.test(commit.message);
    if (!breaking && !types.has(type)) continue;
    const shipped = commit.files.filter((f) => SHIPPED_PATHS.some((p) => f.startsWith(p)));
    if (shipped.length > 0)
      reasons.push(`${short}: ${shipped[0]}${shipped.length > 1 ? ` and ${shipped.length - 1} more` : ''}`);
  }
  return { release: reasons.length > 0, reasons };
}

/** The commits after the last release, up to `rev`, oldest first, from the git repo in `opts.cwd`. */
export function commitsSinceRelease(rev: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Commit[] {
  const git = (...args: string[]) => execFileSync('git', args, { ...opts, encoding: 'utf8', maxBuffer: 64 << 20 });
  const base = git('log', '-1', '--first-parent', '--format=%H', rev, '--', '.release-please-manifest.json').trim();
  const range = base ? `${base}..${rev}` : rev;
  // NUL before each commit and between its message and its files; files one per line.
  const out = git(
    'log',
    '--reverse',
    '--first-parent',
    '--no-renames',
    '--format=%x00%H%x00%B%x00',
    '--name-only',
    range,
  );
  const commits: Commit[] = [];
  const parts = out.split('\0');
  for (let i = 1; i + 3 <= parts.length; i += 3) {
    const [sha = '', message = '', files = ''] = parts.slice(i, i + 3);
    commits.push({ sha, message: message.trim(), files: files.split('\n').filter(Boolean) });
  }
  return commits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rev = process.argv[2] ?? 'HEAD';
  try {
    const config = JSON.parse(readFileSync(new URL('../release-please-config.json', import.meta.url), 'utf8'));
    const verdict = releaseWorthy(commitsSinceRelease(rev), releasedTypes(config));
    for (const reason of verdict.reasons) console.error(`ships: ${reason}`);
    if (!verdict.release) console.error('Nothing since the last release ships; no release pull request.');
    process.stdout.write(`release=${verdict.release}\n`);
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    process.exit(1);
  }
}
