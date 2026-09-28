// The inkup CLI's Homebrew formula and its bottles (scripts/formula.ts, ADR 0008), as homebrew-formula.yml builds them
// from a host release's archives.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveName,
  BOTTLES,
  bottleName,
  buildRelease,
  parseSums,
  renderFormula,
  TARGETS,
  type Target,
} from '../../scripts/formula.ts';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/formula.ts');
const shas = (c: string) => Object.fromEntries(TARGETS.map((t) => [t, c.repeat(64)])) as Record<Target, string>;
const RELEASE = { version: '0.5.0', archives: shas('a'), bottles: shas('b') };
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const DOWNLOAD = 'https://github.com/liatrio-labs/inkup/releases/download/inkup-v0.5.0';

describe('renderFormula', () => {
  it('renders the whole formula for a release', () => {
    expect(renderFormula(RELEASE)).toBe(`class Inkup < Formula
  desc "Host for spoken and drawn web page reviews: server, store, TUI and MCP setup"
  homepage "https://github.com/liatrio-labs/inkup"
  version "0.5.0"
  license "MIT"

  # The repo also releases the browser extensions, on inkup-chrome-v* and inkup-firefox-v* tags.
  livecheck do
    url :stable
    regex(/^inkup-v(\\d+(?:\\.\\d+)+)$/i)
    strategy :github_releases
  end

  # Built from the release's own archives (scripts/formula.ts), so installing never compiles and needs no Xcode.
  bottle do
    root_url "${DOWNLOAD}"
    sha256 cellar: :any_skip_relocation, arm64_big_sur: "${B}"
    sha256 cellar: :any_skip_relocation, big_sur:       "${B}"
    sha256 cellar: :any_skip_relocation, arm64_linux:   "${B}"
    sha256 cellar: :any_skip_relocation, x86_64_linux:  "${B}"
  end

  on_macos do
    on_arm do
      url "${DOWNLOAD}/inkup-aarch64-apple-darwin.tar.xz"
      sha256 "${A}"
    end
    on_intel do
      url "${DOWNLOAD}/inkup-x86_64-apple-darwin.tar.xz"
      sha256 "${A}"
    end
  end

  on_linux do
    on_arm do
      url "${DOWNLOAD}/inkup-aarch64-unknown-linux-gnu.tar.xz"
      sha256 "${A}"
    end
    on_intel do
      url "${DOWNLOAD}/inkup-x86_64-unknown-linux-gnu.tar.xz"
      sha256 "${A}"
    end
  end

  def install
    bin.install "inkup"
  end

  test do
    assert_equal "inkup #{version}", shell_output("#{bin}/inkup --version").strip
  end
end
`);
  });

  it("keeps to brew style's line length, which exempts URLs and bottle checksums", () => {
    for (const line of renderFormula(RELEASE).split('\n')) {
      if (/^\s*(url "|sha256 cellar:)/.test(line)) continue;
      expect(line.length).toBeLessThanOrEqual(118);
    }
  });

  it('gives each bottle the url Homebrew downloads it from', () => {
    // Bottle#root_url: `<root_url>/<Bottle::Filename#url_encode>`, i.e. `<name>-<version>.<tag>.bottle.tar.gz`.
    const formula = renderFormula(RELEASE);
    const root = formula.match(/root_url "(.+)"/)?.[1];
    expect(root).toBe(DOWNLOAD);
    const tags = [...formula.matchAll(/sha256 cellar: :any_skip_relocation, (\w+):/g)].map((m) => m[1]);
    expect(tags).toEqual(['arm64_big_sur', 'big_sur', 'arm64_linux', 'x86_64_linux']);
    for (const target of TARGETS) {
      expect(`${root}/${bottleName('0.5.0', target)}`).toBe(`${DOWNLOAD}/inkup-0.5.0.${BOTTLES[target]}.bottle.tar.gz`);
    }
  });

  it('takes another root url, for installing from local bottles', () => {
    const formula = renderFormula({ ...RELEASE, rootUrl: 'file:///tmp/bottles' });
    expect(formula).toContain('root_url "file:///tmp/bottles"');
    expect(formula).toContain(`url "${DOWNLOAD}/inkup-aarch64-apple-darwin.tar.xz"`);
  });

  it.each([
    ['version', { version: '0.5' }],
    ['version', { version: '0.5.0"; system "x' }],
    ['root url', { rootUrl: 'http://example.com' }],
    ['root url', { rootUrl: 'https://example.com/#{system("x")}' }],
    ['root url', { rootUrl: 'https://example.com/"' }],
    ['sha256', { archives: { ...shas('a'), 'x86_64-apple-darwin': 'A'.repeat(64) } }],
    ['sha256', { bottles: { ...shas('b'), 'aarch64-unknown-linux-gnu': undefined } }],
  ])('refuses a bad %s', (what, change) => {
    expect(() => renderFormula({ ...RELEASE, ...change } as never)).toThrow(`not a ${what}`);
  });
});

describe('parseSums', () => {
  it("reads dist's sha256.sum", () => {
    const sums = parseSums(`${A} *inkup-aarch64-apple-darwin.tar.xz\n${B}  source.tar.gz\n\n`);
    expect(Object.fromEntries(sums)).toEqual({ 'inkup-aarch64-apple-darwin.tar.xz': A, 'source.tar.gz': B });
  });
});

describe('buildRelease', () => {
  let dir: string;
  const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  // A release's archives as dist lays them out: `inkup-<target>/` holding the binary and the docs.
  function archives(): string {
    const out = join(dir, 'archives');
    mkdirSync(out);
    const sums: string[] = [];
    for (const target of TARGETS) {
      const stage = join(dir, 'stage', `inkup-${target}`);
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, 'inkup'), `#!/bin/sh\necho ${target}\n`);
      chmodSync(join(stage, 'inkup'), 0o755);
      for (const doc of ['README.md', 'CHANGELOG.md', 'LICENSE']) writeFileSync(join(stage, doc), doc);
      execFileSync('tar', ['-cJf', join(out, archiveName(target)), '-C', join(dir, 'stage'), `inkup-${target}`]);
      sums.push(`${sha256(join(out, archiveName(target)))} *${archiveName(target)}`);
    }
    writeFileSync(join(out, 'sha256.sum'), `${sums.join('\n')}\n`);
    return out;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inkup-formula-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds a bottle per target holding only the keg, and renders their checksums', () => {
    const bottles = join(dir, 'bottles');
    const formula = buildRelease('0.5.0', archives(), bottles);
    expect(readdirSync(bottles).sort()).toEqual(TARGETS.map((t) => bottleName('0.5.0', t)).sort());
    for (const target of TARGETS) {
      const bottle = join(bottles, bottleName('0.5.0', target));
      const entries = execFileSync('tar', ['-tzf', bottle], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((entry) => entry.replace(/\/$/, ''))
        .sort();
      expect(entries).toEqual([
        'inkup',
        'inkup/0.5.0',
        'inkup/0.5.0/CHANGELOG.md',
        'inkup/0.5.0/LICENSE',
        'inkup/0.5.0/README.md',
        'inkup/0.5.0/bin',
        'inkup/0.5.0/bin/inkup',
      ]);
      const binary = execFileSync('tar', ['-xzOf', bottle, 'inkup/0.5.0/bin/inkup'], { encoding: 'utf8' });
      expect(binary).toContain(`echo ${target}`);
      expect(formula).toContain(`${BOTTLES[target]}:`);
      expect(formula).toMatch(new RegExp(`${BOTTLES[target]}:\\s+"${sha256(bottle)}"`));
    }
  });

  it('keeps the executable bit on the binary', () => {
    const bottles = join(dir, 'bottles');
    buildRelease('0.5.0', archives(), bottles);
    const listing = execFileSync('tar', ['-tvzf', join(bottles, bottleName('0.5.0', 'x86_64-unknown-linux-gnu'))], {
      encoding: 'utf8',
    });
    expect(listing).toMatch(/^-rwx.*inkup\/0\.5\.0\/bin\/inkup$/m);
  });

  it('refuses an archive that does not match sha256.sum', () => {
    const out = archives();
    writeFileSync(join(out, archiveName('x86_64-apple-darwin')), 'tampered');
    expect(() => buildRelease('0.5.0', out, join(dir, 'bottles'))).toThrow(
      'inkup-x86_64-apple-darwin.tar.xz does not match sha256.sum',
    );
  });

  it('prints the formula from the command line', () => {
    const out = archives();
    const run = spawnSync('node', [SCRIPT, '0.5.0', out, join(dir, 'bottles'), 'file:///tmp/b'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^class Inkup < Formula\n/);
    expect(run.stdout).toContain('root_url "file:///tmp/b"');
  });
});
