// `node scripts/cask.ts <version> <sha256>`: prints the Homebrew cask for the desktop app's DMG (ADR 0025), which
// desktop-macos.yml pushes to liatrio-labs/homebrew-tap as Casks/inkup.rb on stable host releases. The token is `inkup`,
// the same as cargo-dist's CLI formula: `brew install --cask liatrio-labs/tap/inkup` installs InkUp.app and
// `brew install liatrio-labs/tap/inkup` the CLI.

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The DMG's file name, as Tauri names it and the release carries it. */
export const dmgName = (version: string) => `InkUp_${version}_universal.dmg`;

export function renderCask(version: string, sha256: string): string {
  if (!VERSION.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
  if (!SHA256.test(sha256)) throw new Error(`not a sha256: ${JSON.stringify(sha256)}`);
  return `cask "inkup" do
  version "${version}"
  sha256 "${sha256}"

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

  # tauri.conf.json sets no minimumSystemVersion, so the app takes Tauri's default, 10.13. That is older than any
  # macOS Homebrew supports, and Homebrew refuses a floor it has dropped, so the cask names none.
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
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, sha256] = process.argv.slice(2);
  if (!version || !sha256) {
    console.error('usage: node scripts/cask.ts <version> <sha256>');
    process.exit(2);
  }
  process.stdout.write(renderCask(version, sha256));
}
