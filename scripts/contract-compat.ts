// `node scripts/contract-compat.ts <base-ref>`: compares each contract/ schema with its version at <base-ref> and
// fails on a breaking change that does not bump the schema's version (ADR 0007). The extension and the host ship on
// their own, so either side may meet an older or a newer peer: a change is additive only when both an old reader of
// new data and a new reader of old data still agree. That leaves new optional properties, new definitions and a new
// message type in a union; annotations are ignored. Everything else is breaking, new enum values too: Zod and serde
// both refuse a value they do not know.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Schema = Record<string, unknown>;
export type Change = { breaking: boolean; path: string; message: string };

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '..', 'contract');

/** Each contract schema, with where it keeps its version. */
export const SCHEMAS: Record<string, (schema: Schema) => unknown> = {
  'protocol.schema.json': (s) => at(s, 'definitions', 'HelloMessage', 'properties', 'v', 'enum'),
  'session.schema.json': (s) => at(s, 'properties', 'schema_version', 'const'),
};

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples']);
const DEFINITIONS = new Set(['definitions', '$defs']);
const UNIONS = new Set(['oneOf', 'anyOf']);

function at(node: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((n, k) => (isSchema(n) ? n[k] : undefined), node);
}
const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));
const refOf = (v: unknown) =>
  isSchema(v) && Object.keys(v).length === 1 && typeof v.$ref === 'string' ? v.$ref : null;

/** Every change from `base` to `head`, breaking or not. */
export function diff(base: Schema, head: Schema): Change[] {
  const changes: Change[] = [];
  const baseDefs = new Set([...DEFINITIONS].flatMap((k) => Object.keys((base[k] as Schema | undefined) ?? {})));
  const note = (breaking: boolean, path: string, message: string) => changes.push({ breaking, path, message });

  function walk(a: Schema, b: Schema, path: string) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (ANNOTATIONS.has(key) || key === 'required') continue;
      const [x, y, here] = [a[key], b[key], `${path}/${key}`];
      if (key === 'properties' || DEFINITIONS.has(key)) members(key, a, b, here);
      else if (UNIONS.has(key) && Array.isArray(x) && Array.isArray(y)) union(x, y, here);
      else if (isSchema(x) && isSchema(y)) walk(x, y, here);
      else if (key === 'enum' && Array.isArray(x) && Array.isArray(y)) {
        const added = y.filter((v) => !x.some((w) => same(v, w)));
        const removed = x.filter((v) => !y.some((w) => same(v, w)));
        if (added.length) note(true, here, `new values ${show(added)}: an older peer refuses them`);
        if (removed.length) note(true, here, `values removed ${show(removed)}`);
      } else if (!same(x, y)) note(true, here, `${show(x)} became ${show(y)}`);
    }
  }

  // Properties or definitions, by name. A definition is a whole message or type; a property has `required` beside it.
  function members(key: string, a: Schema, b: Schema, path: string) {
    const [x, y] = [(a[key] as Schema | undefined) ?? {}, (b[key] as Schema | undefined) ?? {}];
    const isProperty = key === 'properties';
    const req = (s: Schema, name: string) => Array.isArray(s.required) && s.required.includes(name);
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const here = `${path}/${name}`;
      if (!(name in y)) note(true, here, isProperty ? 'property removed' : 'definition removed');
      else if (!(name in x)) {
        if (isProperty && req(b, name)) note(true, here, 'new required property: an older writer leaves it out');
        else note(false, here, isProperty ? 'new optional property' : 'new definition');
      } else {
        if (isProperty && req(a, name) !== req(b, name))
          note(true, here, req(b, name) ? 'optional became required' : 'required became optional');
        walk(x[name] as Schema, y[name] as Schema, here);
      }
    }
  }

  // A union of $refs is a set of messages or types: a new one is additive when it names a new definition (a new
  // message type, which the older peer refuses on its own and keeps the connection). Any other union is compared
  // branch by branch.
  function union(x: unknown[], y: unknown[], path: string) {
    const [xs, ys] = [x.map(refOf), y.map(refOf)];
    if (xs.every(Boolean) && ys.every(Boolean)) {
      for (const ref of xs) if (!ys.includes(ref)) note(true, path, `${ref} removed from the union`);
      for (const ref of ys) {
        if (xs.includes(ref)) continue;
        const isNew = !baseDefs.has(String(ref).split('/').pop() ?? '');
        note(!isNew, path, isNew ? `new message type ${ref}` : `${ref} added to the union`);
      }
    } else if (x.length !== y.length) note(true, path, `${x.length} branches became ${y.length}`);
    else for (const [i, branch] of x.entries()) walk(branch as Schema, y[i] as Schema, `${path}/${i}`);
  }

  walk(base, head, '');
  return changes;
}

/** The report for one schema, and whether it passes: no breaking change, or a bumped version. */
export function check(file: string, base: Schema, head: Schema): { ok: boolean; lines: string[] } {
  const version = SCHEMAS[file];
  if (!version) throw new Error(`${file} is not a contract schema`);
  const [from, to] = [version(base), version(head)];
  if (from === undefined || to === undefined) throw new Error(`${file}: no version found`);
  const changes = diff(base, head);
  const breaking = changes.filter((c) => c.breaking).length;
  const bumped = !same(from, to);
  const lines = changes.map((c) => `  ${c.breaking ? 'BREAKING' : 'additive'} ${c.path}: ${c.message}`);
  if (bumped) lines.push(`  version ${show(from)} -> ${show(to)}`);
  if (breaking && !bumped) lines.push(`  ${breaking} breaking change(s) without a version bump`);
  return { ok: !breaking || bumped, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.argv[2];
  if (!ref) {
    console.error('usage: node scripts/contract-compat.ts <base-ref>');
    process.exit(2);
  }
  let ok = true;
  for (const file of Object.keys(SCHEMAS)) {
    let base: Schema;
    try {
      base = JSON.parse(execFileSync('git', ['show', `${ref}:contract/${file}`], { encoding: 'utf8', stdio: 'pipe' }));
    } catch {
      console.log(`contract/${file}: not at ${ref}, nothing to compare`);
      continue;
    }
    const result = check(file, base, JSON.parse(readFileSync(join(CONTRACT, file), 'utf8')));
    console.log(`contract/${file}: ${result.ok ? 'compatible' : 'INCOMPATIBLE'}`);
    for (const line of result.lines) console.log(line);
    ok &&= result.ok;
  }
  process.exit(ok ? 0 : 1);
}
