// The latest released versions, read from release-please's manifest at build time: a release of either component
// rebuilds the site (.github/workflows/site.yml), so the links follow it.
import manifest from '../../../.release-please-manifest.json';

const REPO = 'https://github.com/liatrio-labs/inkup';
const host = manifest['.'];
const extension = manifest['extensions/web'];

// The Chrome Web Store listing, once Google approves it. Until it is set, the site's install buttons lead to the manual
// install steps (load the release zip unpacked); set it and every button becomes a one-click store link.
export const chromeStore: string | null = null;

const extensionRelease = `${REPO}/releases/tag/inkup-extension-v${extension}`;

export const links = {
  repo: REPO,
  chrome: chromeStore ?? '#install',
  extensionRelease,
  chromeZip: `${REPO}/releases/download/inkup-extension-v${extension}/inkup-${extension}-chrome.zip`,
  firefoxZip: `${REPO}/releases/download/inkup-extension-v${extension}/inkup-${extension}-firefox.zip`,
  host: `${REPO}/releases/tag/inkup-v${host}`,
  dmg: `${REPO}/releases/download/inkup-v${host}/InkUp_${host}_universal.dmg`,
  adrs: `${REPO}/tree/main/docs/adr`,
  contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
  license: `${REPO}/blob/main/LICENSE`,
  liatrio: 'https://www.liatrio.com',
};

export const commands = {
  cli: 'brew install liatrio-labs/tap/inkup',
  cask: 'brew install --cask liatrio-labs/tap/inkup',
  mcp: 'inkup mcp install',
};

export const versions = { host, extension };

/** The primary button's words: a store listing installs in one click; a zip needs the steps. */
export const installLabel = chromeStore ? 'Add to Chrome' : 'Install for Chrome';
