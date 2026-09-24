// CI's path routing (scripts/ci-changes.ts, ADR 0007): which jobs a change runs.
import { describe, expect, it } from 'vitest';
import { classify, render } from '../../scripts/ci-changes.ts';

const none = { extension: false, host: false, contract: false };

describe('ci-changes', () => {
  it.each<[string, string[], typeof none]>([
    ['docs only', ['docs/adr/0007-central-contract.md', 'README.md', 'host/README.md', 'LICENSE'], none],
    ['host only', ['host/crates/server/src/ws.rs', 'host/Cargo.lock'], { ...none, host: true }],
    ['extension only', ['extensions/web/src/entrypoints/background.ts'], { ...none, extension: true }],
    // A core change that moves the wire regenerates contract/ too, or the drift check fails.
    ['core, no wire change', ['packages/core/src/timeline.ts'], { ...none, extension: true }],
    [
      'core, wire change',
      ['packages/core/src/timeline.ts', 'contract/session.schema.json', 'contract/protocol.schema.json'],
      { extension: true, host: true, contract: true },
    ],
    ['contract fixture', ['contract/fixtures/ack.json'], { extension: true, host: true, contract: true }],
    ['root config', ['pnpm-lock.yaml', 'biome.json'], { ...none, extension: true }],
    ['repo scripts and e2e', ['scripts/gen-schema.ts', 'tests/e2e/host.spec.ts'], { ...none, extension: true }],
    ['the CI workflow', ['.github/workflows/ci.yml'], { ...none, extension: true, host: true }],
    ['an unknown path', ['tools/new-thing.sh'], { ...none, extension: true, host: true }],
    ['no files', [''], none],
  ])('%s', (_, files, sides) => {
    expect(classify(files)).toEqual(sides);
  });

  it('renders $GITHUB_OUTPUT lines', () => {
    expect(render({ extension: true, host: false, contract: false })).toBe(
      'extension=true\nhost=false\ncontract=false\n',
    );
  });
});
