// Which host crates `cargo test -p` runs on a pull request. A non-shared crate and its reverse dependencies
// (who depends on it, dev and build dependencies included, transitively) are tested. The graph comes from
// `cargo metadata`, not from reading Cargo.toml: a line regex misses `name = { workspace = true }`. If metadata
// fails, the plan is the whole workspace. Only docs narrow to nothing. Any other path that is not inside one
// non-shared crate (a workflow, a script, the lockfile, the toolchain, a shared crate) runs `--workspace`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Crate = { name: string; dir: string; deps: string[] };

export type CargoPlan = { mode: 'workspace' | 'packages' | 'none'; packages: string[] };

type MetadataDependency = { name?: string };
type MetadataPackage = { name?: string; manifest_path?: string; dependencies?: MetadataDependency[] };
export type CargoMetadata = { packages?: MetadataPackage[] };

const FALLBACK_FILES = new Set([
  'host/Cargo.lock',
  'host/Cargo.toml',
  'host/rust-toolchain.toml',
  'host/rust-toolchain',
]);

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function isDoc(file: string): boolean {
  return file.endsWith('.md') || file.startsWith('docs/') || file === 'LICENSE';
}

/** Workspace members under host/crates, with dependencies that are other members. */
export function graphFromMetadata(root: string, metadata: CargoMetadata): Crate[] {
  const cratesDir = join(root, 'host/crates');
  const members = (metadata.packages ?? []).flatMap((pkg) => {
    const manifest = pkg.manifest_path;
    const name = pkg.name;
    if (!manifest || !name) return [];
    const rel = relative(cratesDir, manifest);
    if (rel.startsWith('..') || isAbsolute(rel)) return [];
    const deps = [
      ...new Set(
        (pkg.dependencies ?? [])
          .map((dep) => dep.name)
          .filter((dep): dep is string => typeof dep === 'string' && dep !== name),
      ),
    ].sort();
    return [{ name, dir: toPosix(relative(root, dirname(manifest))), deps }];
  });
  const names = new Set(members.map((crate) => crate.name));
  return members
    .map((crate) => ({ ...crate, deps: crate.deps.filter((dep) => names.has(dep)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `null` when cargo metadata fails. The caller then tests the whole workspace. */
export function readHostGraph(root: string, locked = true): Crate[] | null {
  // cwd is the host workspace so rustup reads host/rust-toolchain.toml. The manifest path is absolute so a
  // caller whose cwd is the repo root still works.
  const args = ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', join(root, 'host/Cargo.toml')];
  if (locked) args.push('--locked');
  try {
    const out = execFileSync('cargo', args, {
      cwd: join(root, 'host'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return graphFromMetadata(root, JSON.parse(out) as CargoMetadata);
  } catch {
    return null;
  }
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
    if (!file || isDoc(file)) continue;
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
    // Not a doc and not one leaf crate: a workflow, a script, another config, or an unknown host file.
    fallback = true;
  }
  if (fallback) return { mode: 'workspace', packages: [] };
  if (selected.size === 0) return { mode: 'none', packages: [] };
  return { mode: 'packages', packages: withReverse(selected, crates) };
}

/** `crates === null` means metadata failed, which tests the whole workspace. */
export function cratesPlan(files: string[], crates: readonly Crate[] | null): CargoPlan {
  if (!crates) return { mode: 'workspace', packages: [] };
  return selectCrates(files, crates);
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
  process.stdout.write(formatCargoPlan(cratesPlan(files, readHostGraph(ROOT))));
}
