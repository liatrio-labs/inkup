// The latest released versions, read from release-please's manifest at build time: a release of either component
// rebuilds the site (.github/workflows/site.yml), so the links follow it.
import manifest from '../../../.release-please-manifest.json';

const REPO = 'https://github.com/liatrio-labs/inkup';

export const links = {
  repo: REPO,
  // No Chrome Web Store listing link is published yet; until then the button opens the extension's latest release.
  chrome: `${REPO}/releases/tag/inkup-extension-v${manifest['extensions/web']}`,
  host: `${REPO}/releases/tag/inkup-v${manifest['.']}`,
};

export const versions = { host: manifest['.'], extension: manifest['extensions/web'] };
