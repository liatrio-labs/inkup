// Which host crates `cargo test -p` runs on a pull request. A crate and its reverse dependencies (who depends
// on it, including dev-dependencies, transitively) are tested. Cargo.lock, the host toolchain, the workspace
// manifest, anything under contract/, or a shared crate falls back to `cargo test --workspace`. A shared crate
// is one that two or more workspace crates depend on: a change there reaches the rest of the host.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Crate = { name: string; dir: string; deps: string[] };

export type CargoPlan = { mode: 'workspace' | 'packages' | 'none'; packages: string[] };

const FALLBACK_FILES = new Set([
  'host/Cargo.lock',
  'host/Cargo.toml',
  'host/rust-toolchain.toml',
  'host/rust-toolchain',
]);

function depsIn(toml: string, known: ReadonlySet<string>): string[] {
  const deps = new Set<string>();
  const add = (name: string | undefined) => {
    if (name && known.has(name)) deps.add(name);
  };
  for (const match of toml.matchAll(/^([A-Za-z0-9_-]+)\.workspace = true/gm)) add(match[1]);
  for (const match of toml.matchAll(/^([A-Za-z0-9_-]+) = \{[^}\n]*path = "[^"]+"/gm)) add(match[1]);
  return [...deps].sort();
}

/** Crates under host/crates, with path dependencies on each other. */
export function readHostGraph(root: string): Crate[] {
  const cratesDir = join(root, 'host/crates');
  const found: { name: string; dir: string; toml: string }[] = [];
  for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const toml = readFileSync(join(cratesDir, entry.name, 'Cargo.toml'), 'utf8');
    const name = toml.match(/^name = "([^"]+)"/m)?.[1];
    if (!name) throw new Error(`host/crates/${entry.name}/Cargo.toml has no package name`);
    found.push({ name, dir: `host/crates/${entry.name}`, toml });
  }
  const known = new Set(found.map((crate) => crate.name));
  return found
    .map((crate) => ({ name: crate.name, dir: crate.dir, deps: depsIn(crate.toml, known) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Crates two or more workspace members depend on. */
export function sharedCrates(crates: readonly Crate[]): string[] {
  const counts = new Map<string, number>();
  for (const crate of crates) {
    for (const dep of crate.deps) counts.set(dep, (counts.get(dep) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort();
}

function withReverse(selected: ReadonlySet<string>, crates: readonly Crate[]): string[] {
  const all = new Set(selected);
  let grew = true;
  while (grew) {
    grew = false;
    for (const crate of crates) {
      if (all.has(crate.name)) continue;
      if (crate.deps.some((dep) => all.has(dep))) {
        all.add(crate.name);
        grew = true;
      }
    }
  }
  return [...all].sort();
}

export function selectCrates(files: string[], crates: readonly Crate[]): CargoPlan {
  const shared = new Set(sharedCrates(crates));
  const byDir = [...crates].sort((a, b) => b.dir.length - a.dir.length);
  let fallback = false;
  const selected = new Set<string>();
  for (const file of files) {
    if (!file || file.endsWith('.md') || file.startsWith('docs/') || file === 'LICENSE') continue;
    if (FALLBACK_FILES.has(file) || file.startsWith('host/.cargo/') || file.startsWith('contract/')) {
      fallback = true;
      continue;
    }
    const crate = byDir.find((candidate) => file === candidate.dir || file.startsWith(`${candidate.dir}/`));
    if (crate) {
      if (shared.has(crate.name)) fallback = true;
      else selected.add(crate.name);
      continue;
    }
    if (file.startsWith('host/')) fallback = true;
  }
  if (fallback) return { mode: 'workspace', packages: [] };
  if (selected.size === 0) return { mode: 'none', packages: [] };
  return { mode: 'packages', packages: withReverse(selected, crates) };
}

export function formatCargoPlan(plan: CargoPlan): string {
  if (plan.mode !== 'packages') return `${plan.mode}\n`;
  return `packages\n${plan.packages.join('\n')}\n`;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const files = readFileSync(0, 'utf8').split('\n');
  process.stdout.write(formatCargoPlan(selectCrates(files, readHostGraph(ROOT))));
}
