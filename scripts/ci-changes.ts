// CI's `changes` job: which side of the contract a change touches, from the changed paths on stdin, one per line.
// contract/ is the API between the extension and the host (ADR 0007), so it runs both; host/ runs the host; the rest
// of the workspace is the extension side. A wire-affecting change in packages/ also changes contract/, or the drift
// check fails. Docs run lint alone, and a path no rule knows runs both. Prints `extension=`, `host=` and `contract=`
// lines for $GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';

export type Sides = { extension: boolean; host: boolean; contract: boolean };

const DOCS = /\.md$|^LICENSE$|^docs\//;
const EXTENSION = /^(extensions|packages|scripts|tests|fixtures)\/|^[^/]+$/;

export function classify(files: string[]): Sides {
  const sides: Sides = { extension: false, host: false, contract: false };
  for (const file of files) {
    if (!file || DOCS.test(file)) continue;
    if (file.startsWith('contract/')) Object.assign(sides, { extension: true, host: true, contract: true });
    else if (file.startsWith('host/')) sides.host = true;
    else if (EXTENSION.test(file)) sides.extension = true;
    else Object.assign(sides, { extension: true, host: true });
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
