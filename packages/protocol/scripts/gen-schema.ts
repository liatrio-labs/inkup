// `pnpm schema`: writes contract/protocol.schema.json from the Zod schemas in src/index.ts, and
// contract/host-control.schema.json from src/host-control.ts. host/crates/protocol generates its Rust types from those
// files. test/schema-sync.test.ts fails when a committed file is stale.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangeItemSchema } from '@inkup/core/process/change-item';
import { TimelineEventSchema } from '@inkup/core/timeline';
import { z } from 'zod';
import { CONTROL_API, CONTROL_DEFINITIONS } from '../src/host-control.ts';
import { DEFINITIONS, PROTOCOL_VERSION } from '../src/index.ts';

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contract');
export const SCHEMA_FILE = join(CONTRACT, 'protocol.schema.json');
export const CONTROL_SCHEMA_FILE = join(CONTRACT, 'host-control.schema.json');

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

/** draft-07 `definitions`, one per entry, with cross-references as `#/definitions/<id>`. */
function definitionsOf(entries: Record<string, z.ZodType>): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(entries)) registry.add(schema, { id });
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
  for (const id of Object.keys(entries)) {
    const { $schema: _, $id: __, ...schema } = schemas[id] as Record<string, unknown>;
    definitions[id] = constToEnum(schema);
  }
  return definitions;
}

export function protocolJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://inkup.dev/schema/protocol.schema.json',
    title: 'inkup host protocol',
    description: `Wire protocol version ${PROTOCOL_VERSION}. Generated from packages/protocol/src/index.ts by \`pnpm schema\`; do not edit.`,
    definitions: definitionsOf(DEFINITIONS),
  };
}

export function controlJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://inkup.dev/schema/host-control.schema.json',
    title: 'inkup host control API',
    description: `Control API version ${CONTROL_API} (host.json and /api/host/*). Generated from packages/protocol/src/host-control.ts by \`pnpm schema\`; do not edit.`,
    definitions: definitionsOf(CONTROL_DEFINITIONS),
  };
}

const render = (schema: Record<string, unknown>) => `${JSON.stringify(schema, null, 2)}\n`;
export const renderSchema = () => render(protocolJsonSchema());
export const renderControlSchema = () => render(controlJsonSchema());

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(SCHEMA_FILE, renderSchema());
  writeFileSync(CONTROL_SCHEMA_FILE, renderControlSchema());
  console.log(`wrote ${SCHEMA_FILE} and ${CONTROL_SCHEMA_FILE}`);
}
