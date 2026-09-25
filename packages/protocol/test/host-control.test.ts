// The control API's fixtures (contract/fixtures/host-control): host/crates/protocol/tests/control.rs decodes the same
// files. Each parses as its schema and round-trips; the schema file matches the Zod schemas.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_FILE, renderControlSchema } from '../scripts/gen-schema.ts';
import { Activated, CONTROL_API, ControlState, HostFile } from '../src/host-control.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'contract',
  'fixtures',
  'host-control',
);
const load = (file: string): unknown => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));

describe('contract/host-control.schema.json', () => {
  it('matches the Zod schemas (run `pnpm schema` to regenerate)', () => {
    expect(readFileSync(CONTROL_SCHEMA_FILE, 'utf8')).toBe(renderControlSchema());
  });
});

describe('fixtures/host-control/', () => {
  it.each([
    ['host-file.json', HostFile],
    ['control-state.json', ControlState],
    ['activated.json', Activated],
  ] as const)('%s parses and round-trips', (file, schema) => {
    const raw = load(file);
    expect(schema.parse(raw)).toEqual(raw);
  });

  it('refuses a state of another control API version, but reads its host.json to say so', () => {
    const state = load('control-state.json') as Record<string, unknown>;
    expect(ControlState.safeParse({ ...state, control_api: CONTROL_API + 1 }).success).toBe(false);
    const file = load('host-file.json') as Record<string, unknown>;
    expect(HostFile.parse({ ...file, control_api: CONTROL_API + 1 }).control_api).toBe(CONTROL_API + 1);
  });

  it('refuses a null where the Host always sends a value', () => {
    const state = load('control-state.json') as { state: { sessions: Record<string, unknown>[] } };
    const session = { ...state.state.sessions[0], live: null };
    expect(ControlState.safeParse({ ...state, state: { ...state.state, sessions: [session] } }).success).toBe(false);
  });
});
