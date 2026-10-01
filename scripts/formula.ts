// `node scripts/formula.ts <version> <archives-dir> <bottles-dir> [root-url]`: builds Homebrew bottles for the inkup
// CLI from a host release's dist archives and prints its formula (ADR 0027). homebrew-formula.yml uploads the bottles to
// the release and pushes the formula to liatrio-labs/homebrew-tap as Formula/inkup.rb on stable host releases.
//
// A formula without a `bottle do` block is a source build to Homebrew, which then demands a current Xcode or Command
// Line Tools before running `install`, even though `install` only copies a prebuilt binary. With bottles it pours.
//
// <archives-dir> holds the release's `inkup-<target>.tar.xz` archives and its `sha256.sum`, which each archive is
// checked against. The bottles are written to <bottles-dir> under the names Homebrew downloads them by. root-url
// defaults to the release's download URL; the workflow's verify job points it at a local directory instead.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
// No quote, backslash, whitespace or `#` (Ruby interpolation) can reach the formula's string.
const ROOT_URL = /^(?:https|file):\/\/[^"\\\s#]+$/;

/**
 * dist's targets that Homebrew runs on, and each one's bottle tag. A bottle tagged for a macOS version pours on that
 * version and every later one (Homebrew's find_older_compatible_tag), so the macOS tags name the oldest macOS Homebrew
 * still recognises, Big Sur (11): the arm64 binary's minimum is 11.0 and the Intel one's 10.12. Linux has no older
 * versions: a bottle is x86_64_linux or arm64_linux. Listed in the order brew style wants (arm64 before Intel, macOS
 * before Linux).
 */
export const BOTTLES = {
  'aarch64-apple-darwin': 'arm64_big_sur',
  'x86_64-apple-darwin': 'big_sur',
  'aarch64-unknown-linux-gnu': 'arm64_linux',
  'x86_64-unknown-linux-gnu': 'x86_64_linux',
} as const;

export type Target = keyof typeof BOTTLES;
export const TARGETS = Object.keys(BOTTLES) as Target[];

/** The release's download URL, where the archives are and the bottles go. */
export const releaseUrl = (version: string) =>
  `https://github.com/liatrio-labs/inkup/releases/download/inkup-v${version}`;

/** dist's archive for a target. */
export const archiveName = (target: Target) => `inkup-${target}.tar.xz`;

/**
 * The bottle's file name at root_url. Homebrew fetches `<root_url>/<name>-<version>.<tag>.bottle.tar.gz` from any
 * root_url but GitHub Packages (Bottle::Filename#url_encode, one `-`), not the `<name>--<version>…` of its to_s.
 */
export const bottleName = (version: string, target: Target) => `inkup-${version}.${BOTTLES[target]}.bottle.tar.gz`;

export interface Formula {
  version: string;
  /** Each target's dist archive sha256, for the source `url`s. */
  archives: Record<Target, string>;
  /** Each target's bottle sha256. */
  bottles: Record<Target, string>;
  rootUrl?: string;
}

export function renderFormula({ version, archives, bottles, rootUrl = releaseUrl(version) }: Formula): string {
  if (!VERSION.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
  if (!ROOT_URL.test(rootUrl)) throw new Error(`not a root url: ${JSON.stringify(rootUrl)}`);
  for (const target of TARGETS) {
    for (const sha of [archives[target], bottles[target]]) {
      if (!SHA256.test(sha ?? '')) throw new Error(`not a sha256 for ${target}: ${JSON.stringify(sha)}`);
    }
  }
  const source = (target: Target) => `      url "${releaseUrl(version)}/${archiveName(target)}"
      sha256 "${archives[target]}"`;
  const width = Math.max(...Object.values(BOTTLES).map((tag) => tag.length)) + 1;
  const bottle = TARGETS.map(
    (target) => `    sha256 cellar: :any_skip_relocation, ${`${BOTTLES[target]}:`.padEnd(width)} "${bottles[target]}"`,
  ).join('\n');
  return `class Inkup < Formula
  desc "Host for spoken and drawn web page reviews: server, store, TUI and MCP setup"
  homepage "https://github.com/liatrio-labs/inkup"
  version "${version}"
  license "MIT"

  # The repo also releases the browser extensions, on inkup-chrome-v* and inkup-firefox-v* tags.
  livecheck do
    url :stable
    regex(/^inkup-v(\\d+(?:\\.\\d+)+)$/i)
    strategy :github_releases
  end

  # Built from the release's own archives (scripts/formula.ts), so installing never compiles and needs no Xcode.
  bottle do
    root_url "${rootUrl}"
${bottle}
  end

  on_macos do
    on_arm do
${source('aarch64-apple-darwin')}
    end
    on_intel do
${source('x86_64-apple-darwin')}
    end
  end

  on_linux do
    on_arm do
${source('aarch64-unknown-linux-gnu')}
    end
    on_intel do
${source('x86_64-unknown-linux-gnu')}
    end
  end

  def install
    bin.install "inkup"
  end

  test do
    assert_equal "inkup #{version}", shell_output("#{bin}/inkup --version").strip
  end
end
`;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `sha256.sum` (`<sha256> *<file>` lines, as dist writes it) as a map from file name to sha256. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^([0-9a-f]{64}) [ *](\S+)$/);
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/**
 * Builds a bottle from a dist archive: the keg Homebrew's `install` would leave, `inkup/<version>/bin/inkup` plus the
 * README, CHANGELOG and LICENSE Homebrew copies into every keg, and nothing else at the top (Homebrew rejects a
 * bottle with more than `inkup/<version>`). No INSTALL_RECEIPT.json: pouring writes one.
 */
export function buildBottle(version: string, archive: string, target: Target, out: string): void {
  const work = mkdtempSync(join(tmpdir(), 'inkup-bottle-'));
  try {
    execFileSync('tar', ['-xJf', archive, '-C', work]);
    const from = join(work, `inkup-${target}`);
    const keg = join(work, 'bottle', 'inkup', version);
    mkdirSync(join(keg, 'bin'), { recursive: true });
    copyFileSync(join(from, 'inkup'), join(keg, 'bin', 'inkup'));
    for (const doc of ['README.md', 'CHANGELOG.md', 'LICENSE']) copyFileSync(join(from, doc), join(keg, doc));
    // COPYFILE_DISABLE: macOS tar would add `._` AppleDouble entries beside `inkup`.
    execFileSync('tar', ['-czf', out, '-C', join(work, 'bottle'), 'inkup'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Checks each archive against sha256.sum, builds its bottle into `bottlesDir`, and renders the formula. */
export function buildRelease(version: string, archivesDir: string, bottlesDir: string, rootUrl?: string): string {
  if (!VERSION.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
  const sums = parseSums(readFileSync(join(archivesDir, 'sha256.sum'), 'utf8'));
  mkdirSync(bottlesDir, { recursive: true });
  const archives = {} as Record<Target, string>;
  const bottles = {} as Record<Target, string>;
  for (const target of TARGETS) {
    const archive = join(archivesDir, archiveName(target));
    archives[target] = sha256(archive);
    if (sums.get(archiveName(target)) !== archives[target]) {
      throw new Error(`${archiveName(target)} does not match sha256.sum`);
    }
    const bottle = join(bottlesDir, bottleName(version, target));
    buildBottle(version, archive, target, bottle);
    bottles[target] = sha256(bottle);
  }
  return renderFormula({ version, archives, bottles, rootUrl });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, archivesDir, bottlesDir, rootUrl] = process.argv.slice(2);
  if (!version || !archivesDir || !bottlesDir) {
    console.error('usage: node scripts/formula.ts <version> <archives-dir> <bottles-dir> [root-url]');
    process.exit(2);
  }
  try {
    process.stdout.write(buildRelease(version, archivesDir, bottlesDir, rootUrl));
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    process.exit(1);
  }
}
