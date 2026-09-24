// The generated event fixtures (scripts/gen-event-fixtures.ts): current, one or more for every timeline event type,
// and complete, so the Host's contract test sees every field a Client can send. "Complete": every field of a type's
// schema, down through objects, arrays, records and each option of a union, holds a non-null value in at least one of
// that type's fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeItemSchema } from '@inkup/core/process/change-item';
import { EVENT_TYPES, TimelineEventSchema } from '@inkup/core/timeline';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { eventFixtures, FIXTURES, render, SAMPLES } from '../scripts/gen-event-fixtures.ts';

type Def = { type: string; [key: string]: unknown };
const def = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Every path the schema defines: `a.b`, `a[]` for array items, `a.*` for record values, `a|n` for union option n. */
function schemaPaths(schema: z.ZodType, at: string, out: Set<string>) {
  const d = def(schema);
  switch (d.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'pipe':
      return schemaPaths((d.innerType ?? d.in) as z.ZodType, at, out);
    case 'object':
      for (const [key, value] of Object.entries(d.shape as Record<string, z.ZodType>)) {
        out.add(`${at}.${key}`);
        schemaPaths(value, `${at}.${key}`, out);
      }
      return;
    case 'array':
      return schemaPaths(d.element as z.ZodType, `${at}[]`, out);
    case 'record':
      out.add(`${at}.*`);
      return schemaPaths(d.valueType as z.ZodType, `${at}.*`, out);
    case 'union':
      (d.options as z.ZodType[]).forEach((option, i) => {
        out.add(`${at}|${i}`);
        schemaPaths(option, `${at}|${i}`, out);
      });
      return;
  }
}

/** The paths `value` fills with something other than null, walked along the schema. */
function filledPaths(schema: z.ZodType, value: unknown, at: string, out: Set<string>) {
  if (value === null || value === undefined) return;
  const d = def(schema);
  switch (d.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'pipe':
      return filledPaths((d.innerType ?? d.in) as z.ZodType, value, at, out);
    case 'object':
      for (const [key, sub] of Object.entries(d.shape as Record<string, z.ZodType>)) {
        const v = (value as Record<string, unknown>)[key];
        if (v === null || v === undefined) continue;
        out.add(`${at}.${key}`);
        filledPaths(sub, v, `${at}.${key}`, out);
      }
      return;
    case 'array':
      for (const v of value as unknown[]) filledPaths(d.element as z.ZodType, v, `${at}[]`, out);
      return;
    case 'record':
      for (const v of Object.values(value as Record<string, unknown>)) {
        out.add(`${at}.*`);
        filledPaths(d.valueType as z.ZodType, v, `${at}.*`, out);
      }
      return;
    case 'union':
      (d.options as z.ZodType[]).forEach((option, i) => {
        if (!option.safeParse(value).success) return;
        out.add(`${at}|${i}`);
        filledPaths(option, value, `${at}|${i}`, out);
      });
      return;
  }
}

const optionOf = (type: string) => TimelineEventSchema.options.find((o) => o.shape.type.value === type)!;

describe('event fixtures', () => {
  const files = eventFixtures();

  it('are current (run `pnpm -C packages/protocol fixtures:events` to regenerate)', () => {
    for (const [file, message] of files) expect(readFileSync(join(FIXTURES, file), 'utf8'), file).toBe(render(message));
  });

  it('cover every timeline event type', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) expect(files.has(`event.${type}.json`), type).toBe(true);
  });

  it.each([...EVENT_TYPES])('%s: every field of the schema is filled in one of its fixtures', (type) => {
    const schema = optionOf(type) as unknown as z.ZodType;
    const wanted = new Set<string>();
    schemaPaths(schema, '', wanted);
    const filled = new Set<string>();
    for (const { event } of SAMPLES[type]) {
      expect(TimelineEventSchema.parse(event)).toEqual(event);
      filledPaths(schema, event, '', filled);
    }
    expect([...wanted].filter((p) => !filled.has(p))).toEqual([]);
  });

  it('the items push fills every field of a Change Item', () => {
    const item = (files.get('items.json') as { items: unknown[] }).items[0];
    expect(ChangeItemSchema.parse(item)).toEqual(item);
    const wanted = new Set<string>();
    schemaPaths(ChangeItemSchema, '', wanted);
    const filled = new Set<string>();
    filledPaths(ChangeItemSchema, item, '', filled);
    expect([...wanted].filter((p) => !filled.has(p))).toEqual([]);
  });
});
