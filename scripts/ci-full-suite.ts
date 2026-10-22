// Push to main and the nightly schedule run every area, and the full Vitest suite. A pull request keeps the path
// routing in scripts/ci-changes.ts and narrows Vitest with `vitest --changed origin/main`.
import { pathToFileURL } from 'node:url';
import { render, type Sides } from './ci-changes.ts';

export const FULL_SUITE_EVENTS = new Set(['push', 'schedule']);

/** Every `changes` output on, including contract-compat (the nightly passes it HEAD~1 when it has no base). */
export function fullSuiteSides(): Sides {
  return { extension: true, host: true, contract: true, desktop: true, site: true, x64_macos: true };
}

export function areasForEvent(event: string): { mode: 'full'; sides: Sides } | { mode: 'diff' } {
  if (FULL_SUITE_EVENTS.has(event)) return { mode: 'full', sides: fullSuiteSides() };
  return { mode: 'diff' };
}

/** Arguments after `vitest`. Pull requests run the tests that import files changed since origin/main. */
export function vitestArgs(event: string): string[] {
  if (event === 'pull_request') return ['run', '--changed', 'origin/main', '--passWithNoTests'];
  return ['run'];
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const [command, event = ''] = process.argv.slice(2);
  if (command === 'areas') {
    const plan = areasForEvent(event);
    process.stdout.write(plan.mode === 'full' ? `full\n${render(plan.sides)}` : 'diff\n');
  } else if (command === 'vitest') {
    process.stdout.write(`${vitestArgs(event).join('\n')}\n`);
  } else {
    process.stderr.write('usage: node scripts/ci-full-suite.ts <areas|vitest> <event>\n');
    process.exit(2);
  }
}
