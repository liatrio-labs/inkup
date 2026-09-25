// The breaking-change guard (scripts/contract-compat.ts, ADR 0007), over small schema pairs shaped like the two
// contract files, and over the real ones.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, diff } from '../../scripts/contract-compat.ts';

type Schema = Record<string, unknown>;
const clone = (s: Schema): Schema => structuredClone(s);

// A protocol schema in miniature: versioned messages in a union of $refs, and an enum they share.
const PROTOCOL: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  description: 'Wire protocol version 1.',
  definitions: {
    Envelope: { oneOf: [{ $ref: '#/definitions/HelloMessage' }, { $ref: '#/definitions/AckMessage' }] },
    HelloMessage: {
      type: 'object',
      properties: {
        v: { type: 'integer', enum: [1] },
        type: { type: 'string', enum: ['hello'] },
        client_kind: { $ref: '#/definitions/ClientKind' },
        client_name: { type: 'string', maxLength: 100 },
        token: { type: 'string' },
      },
      required: ['v', 'type', 'client_kind', 'client_name'],
    },
    AckMessage: {
      type: 'object',
      properties: {
        v: { type: 'integer', enum: [1] },
        type: { type: 'string', enum: ['ack'] },
        re: { type: 'string' },
      },
      required: ['v', 'type', 're'],
    },
    ClientKind: { type: 'string', enum: ['chrome', 'firefox'] },
  },
};
const SESSION: Schema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 19 },
    events: { type: 'array', items: { oneOf: [{ type: 'object', properties: { t: { type: 'integer' } } }] } },
  },
  required: ['schema_version', 'events'],
};

const defs = (s: Schema) => s.definitions as Record<string, Schema>;
const props = (s: Schema, def: string) => defs(s)[def]?.properties as Record<string, Schema>;
const bumpProtocol = (s: Schema) => {
  for (const def of ['HelloMessage', 'AckMessage']) props(s, def).v = { type: 'integer', enum: [2] };
  return s;
};
const breaking = (base: Schema, head: Schema) => diff(base, head).filter((c) => c.breaking);

describe('contract-compat: additive', () => {
  it('passes an unchanged schema, and one whose annotations changed', () => {
    const head = clone(PROTOCOL);
    head.description = 'Wire protocol version 1, reworded.';
    (props(head, 'HelloMessage').token as Schema).description = 'from `paired`';
    expect(diff(PROTOCOL, head)).toEqual([]);
    expect(check('protocol.schema.json', PROTOCOL, head).ok).toBe(true);
  });

  it('passes a new optional property', () => {
    const head = clone(PROTOCOL);
    props(head, 'HelloMessage').pairing_code = { type: 'string' };
    expect(diff(PROTOCOL, head)).toEqual([
      { breaking: false, path: '/definitions/HelloMessage/properties/pairing_code', message: 'new optional property' },
    ]);
    expect(check('protocol.schema.json', PROTOCOL, head).ok).toBe(true);
  });

  it('passes a new message type in the union', () => {
    const head = clone(PROTOCOL);
    defs(head).ForgetMessage = { type: 'object', properties: { type: { type: 'string', enum: ['forget'] } } };
    (defs(head).Envelope as { oneOf: unknown[] }).oneOf.push({ $ref: '#/definitions/ForgetMessage' });
    expect(breaking(PROTOCOL, head)).toEqual([]);
    expect(diff(PROTOCOL, head).map((c) => c.message)).toEqual([
      'new message type #/definitions/ForgetMessage',
      'new definition',
    ]);
    expect(check('protocol.schema.json', PROTOCOL, head).ok).toBe(true);
  });
});

describe('contract-compat: breaking', () => {
  const cases: [string, (s: Schema) => void, RegExp][] = [
    ['a removed property', (s) => delete props(s, 'HelloMessage').token, /token: property removed/],
    [
      'a renamed property',
      (s) => {
        const p = props(s, 'AckMessage');
        p.reply_to = p.re as Schema;
        delete p.re;
        (defs(s).AckMessage as Schema).required = ['v', 'type', 'reply_to'];
      },
      /re: property removed/,
    ],
    ['a removed message', (s) => delete defs(s).AckMessage, /AckMessage: definition removed/],
    [
      'a message dropped from the union',
      (s) => (defs(s).Envelope as { oneOf: unknown[] }).oneOf.pop(),
      /AckMessage removed from the union/,
    ],
    ['a type change', (s) => (props(s, 'HelloMessage').token = { type: 'integer' }), /"string" became "integer"/],
    [
      'optional to required',
      (s) => (defs(s).HelloMessage as { required: string[] }).required.push('token'),
      /token: optional became required/,
    ],
    [
      'a new required property',
      (s) => {
        props(s, 'AckMessage').ok = { type: 'boolean' };
        (defs(s).AckMessage as { required: string[] }).required.push('ok');
      },
      /ok: new required property/,
    ],
    ['a narrowed enum', (s) => ((defs(s).ClientKind as Schema).enum = ['chrome']), /values removed \["firefox"\]/],
    [
      'a new enum value',
      (s) => ((defs(s).ClientKind as Schema).enum = ['chrome', 'firefox', 'safari']),
      /new values \["safari"\]/,
    ],
    [
      'a changed limit',
      (s) => ((props(s, 'HelloMessage').client_name as Schema).maxLength = 200),
      /maxLength: 100 became 200/,
    ],
  ];

  it.each(cases)('fails %s without a version bump', (_, change, message) => {
    const head = clone(PROTOCOL);
    change(head);
    const result = check('protocol.schema.json', PROTOCOL, head);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(message);
    expect(result.lines.at(-1)).toMatch(/breaking change\(s\) without a version bump/);
  });

  it.each(cases)('passes %s with PROTOCOL_VERSION bumped', (_, change) => {
    const head = bumpProtocol(clone(PROTOCOL));
    change(head);
    const result = check('protocol.schema.json', PROTOCOL, head);
    expect(result.ok).toBe(true);
    expect(result.lines).toContain('  version [1] -> [2]');
  });

  it('fails a new branch in an inline union (a new Session event type) unless schema_version is bumped', () => {
    const head = clone(SESSION);
    const items = (head.properties as Record<string, Schema>).events?.items as { oneOf: unknown[] };
    items.oneOf.push({ type: 'object', properties: { x: { type: 'number' } } });
    expect(check('session.schema.json', SESSION, head).ok).toBe(false);
    (head.properties as Record<string, Schema>).schema_version = { type: 'number', const: 20 };
    const bumped = check('session.schema.json', SESSION, head);
    expect(bumped.ok).toBe(true);
    expect(bumped.lines).toContain('  version 19 -> 20');
  });
});

describe('contract-compat: the real contract', () => {
  const load = (file: string): Schema =>
    JSON.parse(readFileSync(join(__dirname, '../../contract', file), 'utf8')) as Schema;

  it.each(['protocol.schema.json', 'session.schema.json', 'host-control.schema.json'])(
    '%s has a version, and matches itself',
    (file) => {
      const schema = load(file);
      expect(check(file, schema, schema)).toEqual({ ok: true, lines: [] });
    },
  );

  it('needs a control_api bump for a breaking change to the control API', () => {
    const base = load('host-control.schema.json');
    const head = clone(base);
    delete props(head, 'HostState').sessions;
    expect(check('host-control.schema.json', base, head).ok).toBe(false);
    const version = props(head, 'ControlState').control_api as { enum: number[] };
    version.enum = [(version.enum[0] ?? 0) + 1];
    expect(check('host-control.schema.json', base, head).ok).toBe(true);
  });

  it('catches a removed field in the real protocol schema', () => {
    const base = load('protocol.schema.json');
    const head = clone(base);
    delete props(head, 'WelcomeMessage').capabilities;
    expect(check('protocol.schema.json', base, head).lines[0]).toBe(
      '  BREAKING /definitions/WelcomeMessage/properties/capabilities: property removed',
    );
  });
});
