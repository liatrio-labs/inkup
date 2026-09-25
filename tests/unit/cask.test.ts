// The desktop app's Homebrew cask (scripts/cask.ts, ADR 0025), as desktop-macos.yml pushes it to the tap.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dmgName, renderCask } from '../../scripts/cask.ts';

const SHA = 'a'.repeat(64);

describe('cask', () => {
  it('renders the whole cask for a version and a sha256', () => {
    expect(renderCask('0.2.0', SHA)).toBe(`cask "inkup" do
  version "0.2.0"
  sha256 "${SHA}"

  url "https://github.com/liatrio-labs/inkup/releases/download/inkup-v#{version}/InkUp_#{version}_universal.dmg"
  name "InkUp"
  desc "Turn spoken and drawn web page reviews into change items for coding agents"
  homepage "https://github.com/liatrio-labs/inkup"

  # The repo also releases the browser extensions, on inkup-chrome-v* and inkup-firefox-v* tags.
  livecheck do
    url :url
    regex(/^inkup-v(\\d+(?:\\.\\d+)+)$/i)
    strategy :github_releases
  end

  # tauri.conf.json sets no minimumSystemVersion, so the app takes Tauri's default, 10.13. That is older than any macOS
  # Homebrew supports, and Homebrew refuses a floor it has dropped, so the cask names none.
  depends_on :macos

  app "InkUp.app"

  # The host's data dir, ~/Library/Application Support/dev.inkup.inkup, is left out: the inkup CLI uses it too.
  zap trash: [
    "~/Library/Application Support/dev.inkup.desktop",
    "~/Library/Caches/dev.inkup.desktop",
    "~/Library/HTTPStorages/dev.inkup.desktop",
    "~/Library/Preferences/dev.inkup.desktop.plist",
    "~/Library/Saved Application State/dev.inkup.desktop.savedState",
    "~/Library/WebKit/dev.inkup.desktop",
  ]
end
`);
  });

  it('points at the release asset the workflow uploads', () => {
    const url = renderCask('0.2.0', SHA)
      .match(/url "(.+)"/)?.[1]
      ?.replaceAll('#{version}', '0.2.0');
    expect(url).toBe(`https://github.com/liatrio-labs/inkup/releases/download/inkup-v0.2.0/${dmgName('0.2.0')}`);
  });

  it('livecheck takes host tags only', () => {
    const regex = /^inkup-v(\d+(?:\.\d+)+)$/i;
    expect(renderCask('0.2.0', SHA)).toContain(`regex(${regex})`);
    expect('inkup-v0.2.0'.match(regex)?.[1]).toBe('0.2.0');
    for (const tag of ['inkup-chrome-v0.2.0', 'inkup-firefox-v0.2.0', 'inkup-v0.2.0-rc.1']) {
      expect(regex.test(tag)).toBe(false);
    }
  });

  it.each([
    ['0.2', SHA],
    ['v0.2.0', SHA],
    ['0.2.0"; system "x', SHA],
    ['0.2.0', 'A'.repeat(64)],
    ['0.2.0', 'a'.repeat(63)],
  ])('refuses version %j with sha256 %j', (version, sha) => {
    expect(() => renderCask(version, sha)).toThrow(/not a/);
  });

  it('prints the cask from the command line', () => {
    const out = execFileSync('node', ['scripts/cask.ts', '0.2.0', SHA], { encoding: 'utf8' });
    expect(out).toBe(renderCask('0.2.0', SHA));
  });
});
