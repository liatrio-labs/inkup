// The shared fixture corpus (contract/fixtures): host/crates/protocol/tests/fixtures.rs decodes the same files, so the two sides
// agree on the wire. A fixture named `<type>.<case>.json` must parse as that message type (health.json as the
// /health document); every file under invalid/ must be refused.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Envelope, Health } from '../src/index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contract', 'fixtures');
const jsonFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
const load = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const typeOf = (file: string) => file.split('.')[0];

describe('fixtures/', () => {
  const files = jsonFiles(FIXTURES);

  it('covers every message type and /health', () => {
    const types = new Set(files.map(typeOf));
    for (const t of [...Envelope.options.map((o) => o.shape.type.value), 'health']) expect(types).toContain(t);
  });

  it.each(files)('%s parses and round-trips', (file) => {
    const raw = load(join(FIXTURES, file));
    const parsed = typeOf(file) === 'health' ? Health.parse(raw) : Envelope.parse(raw);
    if (typeOf(file) !== 'health') expect((parsed as Envelope).type).toBe(typeOf(file));
    expect(parsed).toEqual(raw);
  });

  it('includes a session_start event shaped like the real timeline', () => {
    const msg = Envelope.parse(load(join(FIXTURES, 'event.session_start.json')));
    expect(msg.type).toBe('event');
    if (msg.type !== 'event') return;
    expect(msg.event).toMatchObject({
      type: 'session_start',
      t: 0,
      tab_id: expect.any(Number),
      t0: expect.any(Number),
      overlay: 'page',
    });
  });
});

describe('fixtures/invalid/', () => {
  it.each(jsonFiles(join(FIXTURES, 'invalid')))('%s is refused', (file) => {
    const raw = load(join(FIXTURES, 'invalid', file));
    expect(Envelope.safeParse(raw).success).toBe(false);
  });
});

describe('EventMessage (sender side)', () => {
  it('checks the event against the timeline schema, not just the fields the Host indexes', () => {
    const msg = load(join(FIXTURES, 'event.session_start.json')) as { event: Record<string, unknown> };
    expect(Envelope.safeParse({ ...msg, event: { ...msg.event, tab_id: 'not a number' } }).success).toBe(false);
    expect(Envelope.safeParse({ ...msg, event: { id: 'e1', type: 'not_an_event', t: 0 } }).success).toBe(false);
  });
});
