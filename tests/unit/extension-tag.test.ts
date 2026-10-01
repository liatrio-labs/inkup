// The tag checks release.yml and firefox-release.yml run before they build (scripts/extension-tag.ts, ADR 0027), and
// the `prerelease` output their store jobs skip on.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExtensionTag } from '../../scripts/extension-tag.ts';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/extension-tag.ts');
const PACKAGE = resolve(import.meta.dirname, '../../extensions/web/package.json');

describe('parseExtensionTag', () => {
  it.each([
    ['inkup-extension-v0.3.0', 'chrome', '0.3.0', false],
    ['inkup-extension-v0.3.0', 'firefox', '0.3.0', false],
    ['inkup-chrome-v0.3.0', 'chrome', '0.3.0', false],
    ['inkup-firefox-v1.10.2', 'firefox', '1.10.2', false],
    ['inkup-extension-v0.3.0-rc.1', 'chrome', '0.3.0-rc.1', true],
    ['inkup-extension-v0.3.0-rc.12', 'firefox', '0.3.0-rc.12', true],
    ['inkup-firefox-v0.3.0-rc.2', 'firefox', '0.3.0-rc.2', true],
  ] as const)('%s for %s at %s: pre-release %s', (tag, store, version, prerelease) => {
    expect(parseExtensionTag(tag, store, version)).toEqual({ version, prerelease });
  });

  it.each([
    ['another version', 'inkup-extension-v0.3.1', 'chrome', '0.3.0'],
    ['a candidate of a final version', 'inkup-extension-v0.3.0-rc.1', 'chrome', '0.3.0'],
    ['the final of a candidate', 'inkup-extension-v0.3.0', 'chrome', '0.3.0-rc.1'],
    ['the other store', 'inkup-firefox-v0.3.0', 'chrome', '0.3.0'],
    ['the host', 'inkup-v0.3.0', 'firefox', '0.3.0'],
    ['a ref', 'refs/tags/inkup-extension-v0.3.0', 'chrome', '0.3.0'],
  ] as const)('refuses %s', (_, tag, store, version) => {
    expect(() => parseExtensionTag(tag, store, version)).toThrow(/is not inkup-extension-v/);
  });

  it.each(['0.3', '0.3.0-', '0.3.0-rc_1', '0.3.0+build', ''])('refuses package.json version %j', (version) => {
    expect(() => parseExtensionTag(`inkup-extension-v${version}`, 'chrome', version)).toThrow(/not a release version/);
  });
});

describe('the command line', () => {
  const { version } = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { version: string };
  const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('prints the outputs for the package.json version', () => {
    const run = cli(`inkup-extension-v${version}`, 'firefox');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`version=${version}\nprerelease=${version.includes('-')}\n`);
  });

  it('fails on a tag for another version', () => {
    const run = cli('inkup-extension-v999.0.0', 'chrome');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/::error::tag "inkup-extension-v999.0.0" is not/);
  });

  it('fails on an unknown store', () => {
    expect(cli(`inkup-extension-v${version}`, 'safari').status).toBe(2);
  });
});
