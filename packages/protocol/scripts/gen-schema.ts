// `pnpm schema`: writes protocol.schema.json from the Zod schemas in src/index.ts. host/crates/protocol generates
// its Rust types from that file. test/schema-sync.test.ts fails when the committed file is stale.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangeItemSchema } from '@inkup/core/process/change-item';
import { TimelineEventSchema } from '@inkup/core/timeline';
import { z } from 'zod';
import { DEFINITIONS, PROTOCOL_VERSION } from '../src/index.ts';

export const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'protocol.schema.json');

// typify, the Rust generator, reads draft-07 `definitions` and enforces `enum` but not `const`: a literal becomes a
// one-value enum (an integer one for `v`), so the Rust side rejects a wrong `type` or `v` as Zod does.
function constToEnum(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(constToEnum);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'const') out.enum = [value];
    else out[key] = constToEnum(value);
  }
  if ('const' in node && Number.isInteger((node as { const: unknown }).const) && out.type === 'number')
    out.type = 'integer';
  return out;
}

export function protocolJsonSchema(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(DEFINITIONS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-07',
    io: 'input',
    uri: (id) => `#/definitions/${id}`,
    // On the wire the Host sees only WireTimelineEvent and WireChangeItem: it stores events and items of any
    // schema version (src/index.ts).
    override: (ctx) => {
      const wire =
        ctx.zodSchema === TimelineEventSchema
          ? 'WireTimelineEvent'
          : ctx.zodSchema === ChangeItemSchema
            ? 'WireChangeItem'
            : null;
      if (!wire) return;
      for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
      ctx.jsonSchema.$ref = `#/definitions/${wire}`;
    },
  });
  const definitions: Record<string, unknown> = {};
  for (const id of Object.keys(DEFINITIONS)) {
    const { $schema: _, $id: __, ...schema } = schemas[id] as Record<string, unknown>;
    definitions[id] = constToEnum(schema);
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://inkup.dev/schema/protocol.schema.json',
    title: 'inkup host protocol',
    description: `Wire protocol version ${PROTOCOL_VERSION}. Generated from packages/protocol/src/index.ts by \`pnpm schema\`; do not edit.`,
    definitions,
  };
}

export const renderSchema = () => `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(SCHEMA_FILE, renderSchema());
  console.log(`wrote ${SCHEMA_FILE}`);
}
