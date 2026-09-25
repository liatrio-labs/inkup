// scripts/desktop-smoke.sh drives app windows and trays through System Events, which addresses a process by its
// name even when it was looked up by pid. Every build of the app is named inkup-desktop, so the smoke launches each
// app from its own copy, named for the run and the launch, and drives a process only by that name and its pid. The
// smoke itself needs a desktop session (lead-only); this checks the script keeps to that rule.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = readFileSync(resolve(import.meta.dirname, '../../scripts/desktop-smoke.sh'), 'utf8');

/** A shell function's definition from the script, by name. */
function shellFunction(name: string): string {
  const match = SCRIPT.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`no ${name}() in desktop-smoke.sh`);
  return match[0];
}

describe('desktop-smoke.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('launches every app from its own copy, never the shared binary', () => {
    const launches = SCRIPT.split('\n').filter((line) => /^\s*(start|run) "\$(\(instance |APP")/.test(line));
    expect(launches.length).toBeGreaterThanOrEqual(5);
    for (const line of launches) expect(line).toMatch(/^\s*(start|run) "\$\(instance [a-z0-9]+\)"/);
  });

  it('drives a process by its unique name, and only after checking its pid', () => {
    expect(SCRIPT).not.toMatch(/whose unix id/);
    const scripts = SCRIPT.match(/<<'OSA'[\s\S]*?\nOSA\n/g) ?? [];
    expect(scripts).toHaveLength(2);
    for (const osa of scripts) {
      expect(osa).toMatch(/application process \(item 2 of argv\)/);
      expect(osa).toMatch(/unix id (of p )?is not \(\(item 1 of argv\) as integer\)/);
    }
  });

  it('names each copy for the run and the launch', () => {
    const work = mkdtempSync(join(tmpdir(), 'inkup-smoke-test-'));
    dirs.push(work);
    const app = join(work, 'inkup-desktop');
    writeFileSync(app, '#!/bin/sh\n', { mode: 0o755 });
    const names = (label: string) => {
      const run = spawnSync(
        'bash',
        ['-c', `${shellFunction('instance')}\nWORK="$1" APP="$2"; instance "$3"`, 'smoke', work, app, label],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
      return run.stdout.trim();
    };
    const a = names('a');
    const b = names('b');
    expect(a).toMatch(/\/bin\/inkup-smoke-\d+-a$/);
    expect(b).toMatch(/\/bin\/inkup-smoke-\d+-b$/);
    expect(a.replace(/-a$/, '')).not.toBe(b.replace(/-b$/, '')); // each bash run has its own $$
    expect(readFileSync(a, 'utf8')).toBe('#!/bin/sh\n');
  });
});
