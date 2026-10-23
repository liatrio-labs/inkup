// CI's path routing (scripts/ci-changes.ts, ADR 0007): which jobs a change runs.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify, isUi, render } from '../../scripts/ci-changes.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const none = {
  extension: false,
  host: false,
  contract: false,
  desktop: false,
  site: false,
  x64_macos: false,
  ui: false,
  workflows: false,
};
const all = {
  extension: true,
  host: true,
  contract: true,
  desktop: true,
  site: false,
  x64_macos: false,
  ui: false,
  workflows: false,
};

describe('ci-changes', () => {
  it.each<[string, string[], typeof none]>([
    ['docs only', ['docs/adr/0007-central-contract.md', 'README.md', 'host/README.md', 'LICENSE'], none],
    // The desktop app builds the host crates from source.
    [
      'host only',
      ['host/crates/server/src/ws.rs', 'host/Cargo.lock'],
      { ...none, host: true, desktop: true, x64_macos: true },
    ],
    ['extension only', ['extensions/web/src/entrypoints/background.ts'], { ...none, extension: true }],
    [
      'desktop only',
      ['apps/desktop/ui/src/App.tsx', 'apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/src-tauri/Cargo.lock'],
      { ...none, desktop: true, ui: true },
    ],
    ['desktop docs', ['apps/desktop/README.md'], none],
    // The marketing site (ADR 0026) builds from apps/site alone, so nothing else runs for it.
    [
      'site only',
      ['apps/site/src/pages/index.astro', 'apps/site/astro.config.ts', '.github/workflows/site.yml'],
      { ...none, site: true, ui: true, workflows: true },
    ],
    ['site docs', ['apps/site/README.md'], none],
    // What only the site's captures read: site-captures.yml records them on the pull request itself.
    [
      'site capture inputs',
      [
        'fixtures/site/demo-store.html',
        'fixtures/site/vendor/fonts/manrope-latin.woff2',
        'fixtures/transcripts/site-demo.json',
        'fixtures/audio/site-demo.wav',
        '.github/workflows/site-captures.yml',
      ],
      { ...none, workflows: true },
    ],
    ['refreshed captures', ['apps/site/src/assets/captures/stroke.png'], { ...none, site: true }],
    // The capture spec is e2e code, and the other fixtures are the e2e suite's.
    ['the capture spec', ['tests/e2e/site-captures.spec.ts'], { ...none, extension: true }],
    ['another site fixture', ['fixtures/site/pricing.html'], { ...none, extension: true }],
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
    // A release pull request skips CI entirely (ci.yml); this is its manifest on any other pull request. The site
    // shows the versions in the manifest.
    [
      'release-please files',
      ['.release-please-manifest.json', 'release-please-config.json', 'host/CHANGELOG.md'],
      { ...none, site: true, extension: true },
    ],
    ['release-please config', ['release-please-config.json'], { ...none, extension: true }],
    ['DESIGN.md', ['DESIGN.md'], { ...none, extension: true, ui: true }],
    ['PRODUCT.md', ['PRODUCT.md'], { ...none, ui: true }],
    ['theme config', ['packages/ui/components.json'], { ...none, extension: true, desktop: true, ui: true }],
    ['theme css', ['packages/ui/src/styles/theme.css'], { ...none, extension: true, desktop: true, ui: true }],
    ['a component test', ['apps/desktop/ui/src/App.test.tsx'], { ...none, desktop: true }],
    ['a story', ['packages/ui/src/button.stories.tsx'], { ...none, extension: true, desktop: true }],
    ['a spec stylesheet', ['extensions/web/src/panel.spec.css'], { ...none, extension: true }],
    [
      'impeccable config',
      ['.impeccable/design.json'],
      { ...none, extension: true, host: true, desktop: true, site: true, x64_macos: true, ui: true },
    ],
    ['a site surface brief', ['apps/site/.impeccable/surfaces/apps-site.md'], { ...none, ui: true }],
    ['root config', ['biome.json', 'tsconfig.json'], { ...none, extension: true }],
    ['the lockfile', ['pnpm-lock.yaml'], { ...none, extension: true, desktop: true, site: true }],
    [
      'workspace files',
      ['package.json', 'pnpm-workspace.yaml'],
      { ...none, extension: true, desktop: true, site: true },
    ],
    [
      'extension, no site',
      ['extensions/web/src/entrypoints/background.ts', 'packages/core/src/timeline.ts'],
      {
        ...none,
        extension: true,
        desktop: true,
      },
    ],
    ['repo scripts and e2e', ['scripts/gen-schema.ts', 'tests/e2e/host.spec.ts'], { ...none, extension: true }],
    ['dist config only', ['dist-workspace.toml'], { ...none, extension: true, x64_macos: true }],
    [
      'the CI workflow',
      ['.github/workflows/ci.yml'],
      {
        ...none,
        extension: true,
        host: true,
        desktop: true,
        site: true,
        x64_macos: true,
        ui: true,
        workflows: true,
      },
    ],
    [
      'the host release workflow',
      ['.github/workflows/inkup-v-release.yml'],
      {
        ...none,
        extension: true,
        host: true,
        desktop: true,
        site: true,
        x64_macos: true,
        ui: true,
        workflows: true,
      },
    ],
    // site-captures.yml is the workflow that runs no other area. actionlint's config runs actionlint alone.
    ['one workflow', ['.github/workflows/site-captures.yml'], { ...none, workflows: true }],
    ['actionlint config', ['.github/actionlint.yaml', '.github/actionlint.yml'], { ...none, workflows: true }],
    [
      'an unknown path',
      ['tools/new-thing.sh'],
      { ...none, extension: true, host: true, desktop: true, site: true, x64_macos: true, ui: true },
    ],
    ['no files', [''], none],
  ])('%s', (_, files, sides) => {
    expect(classify(files)).toEqual(sides);
  });

  it('renders $GITHUB_OUTPUT lines', () => {
    expect(
      render({
        extension: true,
        host: false,
        contract: false,
        desktop: true,
        site: false,
        x64_macos: true,
        ui: false,
        workflows: false,
      }),
    ).toBe(
      'extension=true\nhost=false\ncontract=false\ndesktop=true\nsite=false\nx64_macos=true\nui=false\nworkflows=false\n',
    );
  });

  it('lists changed UI files and skips tests, stories and fixtures', () => {
    const out = execFileSync(process.execPath, ['scripts/ci-changes.ts', '--ui-files'], {
      cwd: root,
      encoding: 'utf8',
      input: [
        'README.md',
        'apps/desktop/ui/src/App.tsx',
        'apps/desktop/ui/src/App.test.tsx',
        'fixtures/site/demo-store.html',
        '',
      ].join('\n'),
    });
    expect(out).toBe('apps/desktop/ui/src/App.tsx\n');
  });
});

describe('isUi', () => {
  it.each<[string, boolean]>([
    ['apps/desktop/ui/src/App.tsx', true],
    ['apps/site/src/pages/index.astro', true],
    ['extensions/web/src/entrypoints/onboarding/index.html', true],
    ['page.htm', true],
    ['Widget.jsx', true],
    ['Widget.vue', true],
    ['Widget.svelte', true],
    ['theme.scss', true],
    ['theme.sass', true],
    ['theme.less', true],
    ['packages/ui/src/styles/theme.css', true],
    ['DESIGN.md', true],
    ['PRODUCT.md', true],
    ['.impeccable/design.json', true],
    ['apps/site/.impeccable/surfaces/apps-site.md', true],
    ['packages/ui/components.json', true],
    ['apps/desktop/ui/src/App.test.tsx', false],
    ['packages/ui/src/button.spec.tsx', false],
    ['packages/ui/src/button.stories.tsx', false],
    ['.impeccable/foo.test.json', false],
    ['fixtures/site/demo-store.html', false],
    ['fixtures/site/styles.css', false],
    ['packages/ui/src/fixtures/demo.css', false],
    ['README.md', false],
    ['docs/adr/0007-central-contract.md', false],
    ['extensions/web/src/entrypoints/background.ts', false],
    ['host/crates/server/src/ws.rs', false],
    ['.github/workflows/ci.yml', false],
  ])('%s', (file, ui) => {
    expect(isUi(file)).toBe(ui);
  });
});
