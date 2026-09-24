// `pnpm schema`: writes docs/schema/session.schema.json from the Zod schema in packages/core/src.
// tests/unit/schema-sync.test.ts fails when the committed file is stale.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionJsonSchema } from '../packages/core/src/session-document.ts';

export const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'schema', 'session.schema.json');
export const renderSchema = () => `${JSON.stringify(sessionJsonSchema(), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(dirname(SCHEMA_FILE), { recursive: true });
  writeFileSync(SCHEMA_FILE, renderSchema());
  console.log(`wrote ${SCHEMA_FILE}`);
}
