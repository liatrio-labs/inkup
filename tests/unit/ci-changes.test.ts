// CI's path routing (scripts/ci-changes.ts, ADR 0007): which jobs a change runs.
import { describe, expect, it } from 'vitest';
import { classify, render } from '../../scripts/ci-changes.ts';

const none = { extension: false, host: false, contract: false, desktop: false };
const all = { extension: true, host: true, contract: true, desktop: true };

describe('ci-changes', () => {
  it.each<[string, string[], typeof none]>([
    ['docs only', ['docs/adr/0007-central-contract.md', 'README.md', 'host/README.md', 'LICENSE'], none],
    // The desktop app builds the host crates from source.
    ['host only', ['host/crates/server/src/ws.rs', 'host/Cargo.lock'], { ...none, host: true, desktop: true }],
    ['extension only', ['extensions/web/src/entrypoints/background.ts'], { ...none, extension: true }],
    [
      'desktop only',
      ['apps/desktop/ui/src/App.tsx', 'apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/src-tauri/Cargo.lock'],
      { ...none, desktop: true },
    ],
    ['desktop docs', ['apps/desktop/README.md'], none],
    // A core change that moves the wire regenerates contract/ too, or the drift check fails. The desktop UI imports
    // @inkup/protocol, which builds on core.
    ['core, no wire change', ['packages/core/src/timeline.ts'], { ...none, extension: true, desktop: true }],
    ['protocol, host control', ['packages/protocol/src/host-control.ts'], { ...none, extension: true, desktop: true }],
    [
      'core, wire change',
      ['packages/core/src/timeline.ts', 'contract/session.schema.json', 'contract/protocol.schema.json'],
      all,
    ],
    ['contract fixture', ['contract/fixtures/ack.json'], all],
    ['root config', ['biome.json', 'tsconfig.json'], { ...none, extension: true }],
    ['the lockfile', ['pnpm-lock.yaml'], { ...none, extension: true, desktop: true }],
    ['repo scripts and e2e', ['scripts/gen-schema.ts', 'tests/e2e/host.spec.ts'], { ...none, extension: true }],
    ['the CI workflow', ['.github/workflows/ci.yml'], { ...none, extension: true, host: true, desktop: true }],
    ['an unknown path', ['tools/new-thing.sh'], { ...none, extension: true, host: true, desktop: true }],
    ['no files', [''], none],
  ])('%s', (_, files, sides) => {
    expect(classify(files)).toEqual(sides);
  });

  it('renders $GITHUB_OUTPUT lines', () => {
    expect(render({ extension: true, host: false, contract: false, desktop: true })).toBe(
      'extension=true\nhost=false\ncontract=false\ndesktop=true\n',
    );
  });
});
