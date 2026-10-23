// Push to main and the nightly schedule run every area, and the full Vitest suite. A pull request keeps the path
// routing in scripts/ci-changes.ts. Vitest uses `--changed` only when every non-doc file is a TypeScript module
// under a package's source or test tree. Anything else (a workflow, a script, a fixture read from disk) runs the
// suite. DESIGN.md is not a doc here: packages/ui/tests/theme.test.ts reads it from disk. packages/core,
// packages/protocol and packages/ui always run in full: their boundary tests scan src/ instead of importing it,
// and the suites are small.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { render, type Sides } from './ci-changes.ts';

export const FULL_SUITE_EVENTS = new Set(['push', 'schedule']);

/** Every `changes` output on, including contract-compat (the nightly passes it HEAD~1 when it has no base). */
export function fullSuiteSides(): Sides {
  return {
    extension: true,
    host: true,
    contract: true,
    desktop: true,
    site: true,
    x64_macos: true,
    ui: true,
    workflows: true,
  };
}

export function areasForEvent(event: string): { mode: 'full'; sides: Sides } | { mode: 'diff' } {
  if (FULL_SUITE_EVENTS.has(event)) return { mode: 'full', sides: fullSuiteSides() };
  return { mode: 'diff' };
}

export type VitestScope = 'all' | 'core';

// DESIGN.md is the theme source theme.test.ts reads. Other markdown, docs/ and LICENSE do not select tests.
const DOCS = /(?:^|\/)(?!DESIGN\.md$)[^/]+\.md$|^docs\/|^LICENSE$/;
// apps/desktop keeps its tests beside the UI, under ui/src, not a tests/ directory.
const PACKAGE_MODULE = /^(?:packages|extensions|apps)\/[^/]+\/(?:src|tests|test|ui\/src)\/.+\.tsx?$/;

/**
 * Arguments after `vitest`. `core` is packages/core, packages/protocol and packages/ui, always the full suite.
 * `all` is the workspace or the desktop UI: `--changed` only for an all-module diff.
 */
export function vitestArgs(event: string, files: readonly string[] = [], scope: VitestScope = 'all'): string[] {
  if (event !== 'pull_request' || scope === 'core') return ['run'];
  const code = files.filter((file) => file && !DOCS.test(file));
  if (code.length > 0 && code.every((file) => PACKAGE_MODULE.test(file))) {
    return ['run', '--changed', 'origin/main', '--passWithNoTests'];
  }
  return ['run'];
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const [command, event = '', scopeArg = 'all'] = process.argv.slice(2);
  if (command === 'areas') {
    const plan = areasForEvent(event);
    process.stdout.write(plan.mode === 'full' ? `full\n${render(plan.sides)}` : 'diff\n');
  } else if (command === 'vitest') {
    const scope = scopeArg === 'core' ? 'core' : 'all';
    const files = readFileSync(0, 'utf8').split('\n');
    process.stdout.write(`${vitestArgs(event, files, scope).join('\n')}\n`);
  } else {
    process.stderr.write('usage: node scripts/ci-full-suite.ts <areas|vitest> <event>\n');
    process.exit(2);
  }
}
