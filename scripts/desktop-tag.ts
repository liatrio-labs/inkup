// `node scripts/desktop-tag.ts <tag> <remote>`: checks the host release tag desktop-macos.yml builds the desktop app's
// DMG for (ADR 0025) and prints, as GITHUB_OUTPUT lines, the tag, its version, whether it is a pre-release and the
// commit it points at on <remote>. The tag comes from a tag push or from a workflow_dispatch input, so it is checked
// here before anything uses it.
import { execFileSync } from 'node:child_process';

const TAG = /^inkup-v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export interface HostTag {
  tag: string;
  version: string;
  /** A `-` in the version, the rule dist (the release's pre-release flag) and release-please use. */
  prerelease: boolean;
}

export function parseHostTag(tag: string): HostTag {
  if (!TAG.test(tag)) throw new Error(`not a host release tag (inkup-v<version>): ${JSON.stringify(tag)}`);
  const version = tag.slice('inkup-v'.length);
  return { tag, version, prerelease: version.includes('-') };
}

/** The commit `tag` points at on `remote`, peeling an annotated tag. Throws when the remote has no such tag. */
export function remoteTagCommit(tag: string, remote: string): string {
  const ref = `refs/tags/${tag}`;
  const out = execFileSync('git', ['ls-remote', '--tags', remote, ref, `${ref}^{}`], { encoding: 'utf8' });
  const refs = new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, name] = line.split('\t');
        return [name, sha] as const;
      }),
  );
  const sha = refs.get(`${ref}^{}`) ?? refs.get(ref);
  if (!sha) throw new Error(`${remote} has no tag ${tag}`);
  return sha;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tag, remote] = process.argv.slice(2);
  if (tag === undefined || !remote) {
    console.error('usage: node scripts/desktop-tag.ts <tag> <remote>');
    process.exit(2);
  }
  try {
    const host = parseHostTag(tag);
    const sha = remoteTagCommit(host.tag, remote);
    process.stdout.write(`tag=${host.tag}\nversion=${host.version}\nprerelease=${host.prerelease}\nsha=${sha}\n`);
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    process.exit(1);
  }
}
