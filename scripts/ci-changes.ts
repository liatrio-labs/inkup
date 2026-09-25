// CI's `changes` job: which side of the contract a change touches, from the changed paths on stdin, one per line.
// contract/ is the API between the extension and the host (ADR 0007), so it runs both; host/ runs the host; the rest
// of the workspace is the extension side. A wire-affecting change in packages/ also changes contract/, or the drift
// check fails. The desktop app (apps/desktop, ADR 0025) builds the host crates and imports @inkup/protocol, so
// host/, packages/ and the workspace's install files run it too. Docs run lint alone, and a path no rule knows runs
// everything. Prints `extension=`, `host=`, `contract=` and `desktop=` lines for $GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';

export type Sides = { extension: boolean; host: boolean; contract: boolean; desktop: boolean };

const DOCS = /\.md$|^LICENSE$|^docs\//;
const EXTENSION = /^(extensions|packages|scripts|tests|fixtures)\/|^[^/]+$/;
// What the desktop app is built from besides apps/desktop and host/.
const DESKTOP_TOO = /^packages\/|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;

export function classify(files: string[]): Sides {
  const sides: Sides = { extension: false, host: false, contract: false, desktop: false };
  for (const file of files) {
    if (!file || DOCS.test(file)) continue;
    if (file.startsWith('contract/'))
      Object.assign(sides, { extension: true, host: true, contract: true, desktop: true });
    else if (file.startsWith('host/')) Object.assign(sides, { host: true, desktop: true });
    else if (file.startsWith('apps/desktop/')) sides.desktop = true;
    else if (EXTENSION.test(file)) {
      sides.extension = true;
      if (DESKTOP_TOO.test(file)) sides.desktop = true;
    } else Object.assign(sides, { extension: true, host: true, desktop: true });
  }
  return sides;
}

export const render = (sides: Sides) =>
  Object.entries(sides)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(render(classify(readFileSync(0, 'utf8').split('\n'))));
}
