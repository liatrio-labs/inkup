// `node scripts/extension-tag.ts <tag> <chrome|firefox>`: checks the tag release.yml (chrome) or firefox-release.yml
// (firefox) runs on against extensions/web/package.json "version", and prints, as GITHUB_OUTPUT lines, that version and
// whether it is a pre-release (ADR 0027). The tag is inkup-extension-v<version>, which releases both stores, or
// inkup-<store>-v<version>, which releases that store alone. A pre-release (a release candidate, `0.8.0-rc.1`) goes
// to the GitHub Release only: the workflows skip the store upload when `prerelease=true`.
import { readFileSync } from 'node:fs';

export type Store = 'chrome' | 'firefox';

export interface ExtensionTag {
  version: string;
  /** A `-` in the version, the rule dist, desktop-tag.ts and release-please use. */
  prerelease: boolean;
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

export function parseExtensionTag(tag: string, store: Store, version: string): ExtensionTag {
  if (!VERSION.test(version))
    throw new Error(`extensions/web/package.json version is not a release version: ${JSON.stringify(version)}`);
  if (tag !== `inkup-extension-v${version}` && tag !== `inkup-${store}-v${version}`)
    throw new Error(
      `tag ${JSON.stringify(tag)} is not inkup-extension-v${version} or inkup-${store}-v${version} (extensions/web/package.json version ${version})`,
    );
  return { version, prerelease: version.includes('-') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tag, store] = process.argv.slice(2);
  if (tag === undefined || (store !== 'chrome' && store !== 'firefox')) {
    console.error('usage: node scripts/extension-tag.ts <tag> <chrome|firefox>');
    process.exit(2);
  }
  try {
    const pkg = new URL('../extensions/web/package.json', import.meta.url);
    const { version } = JSON.parse(readFileSync(pkg, 'utf8')) as { version: string };
    const parsed = parseExtensionTag(tag, store, version);
    process.stdout.write(`version=${parsed.version}\nprerelease=${parsed.prerelease}\n`);
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    process.exit(1);
  }
}
