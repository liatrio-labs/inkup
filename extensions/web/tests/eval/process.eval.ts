// `pnpm eval` (docs/PLAN.md Slice 2 proof): runs every fixture in fixtures/sessions through the real Anthropic
// adapter (the same core code the service worker runs) and checks category, Location roles and the chosen
// selectors against fixtures/sessions/expected.json. Prints a pass-rate table per timestamp mode.
//
// Needs ANTHROPIC_API_KEY in .env (or the environment). Without it every case is skipped and the run exits 0.
// EVAL_MODEL overrides the model (default claude-sonnet-5). Fixtures carry no screenshot bytes, so the
// low-confidence second pass does not run here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionDocumentSchema } from '@inkup/core/session-document';
import { afterAll, describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '@/adapters/llm';
import { DEFAULT_PROCESS_MODEL } from '@/settings';
import { fixtureFile, SCENARIOS, SESSIONS_DIR } from '../../../../scripts/gen-session-fixtures.ts';
import { type Expected, grade } from './grade';

const KEY = process.env.ANTHROPIC_API_KEY?.trim();
const MODEL = process.env.EVAL_MODEL?.trim() || DEFAULT_PROCESS_MODEL;
const MODES = ['word', 'approximate'] as const;
const TARGET = { word: 0.9, approximate: 0.8 };
const expected = JSON.parse(readFileSync(join(SESSIONS_DIR, 'expected.json'), 'utf8')) as Record<string, Expected>;

if (!KEY) console.log('\npnpm eval: ANTHROPIC_API_KEY is not set (add it to .env). Skipping the live Process eval.\n');

const results: { name: string; mode: (typeof MODES)[number]; pass: boolean; detail: string }[] = [];

describe.skipIf(!KEY)(`live Process eval (${MODEL})`, () => {
  const adapter = createAnthropicAdapter({ apiKey: KEY ?? '' });

  it.concurrent.each(SCENARIOS.flatMap((s) => MODES.map((mode) => ({ name: s.name, mode }))))(
    '$name ($mode)',
    async ({ name, mode }) => {
      const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile(name, mode), 'utf8')));
      const r = await adapter.process({ doc, model: MODEL });
      const problems = grade(r.items, expected[name]!);
      const summary = r.items
        .map((i) => `${i.category}[${i.locations.map((l) => `${l.role}=${l.selector}`).join(' ')}] c=${i.confidence}`)
        .join(' | ');
      results.push({
        name,
        mode,
        pass: problems.length === 0,
        detail: problems.length ? `${problems.join('; ')} :: ${summary}` : summary,
      });
      expect(problems, summary).toEqual([]);
    },
  );

  afterAll(() => {
    if (results.length === 0) return;
    const rows = MODES.map((mode) => {
      const rs = results.filter((r) => r.mode === mode);
      const passed = rs.filter((r) => r.pass).length;
      const rate = rs.length ? passed / rs.length : 0;
      return `| ${mode.padEnd(11)} | ${String(passed).padStart(6)} | ${String(rs.length).padStart(5)} | ${(rate * 100).toFixed(0).padStart(4)}% | ${(TARGET[mode] * 100).toFixed(0)}% ${rate >= TARGET[mode] ? 'met' : 'MISSED'} |`;
    });
    console.log(
      [
        '',
        `Process eval, ${MODEL}`,
        '| mode        | passed | cases | rate  | target      |',
        '|-------------|--------|-------|-------|-------------|',
        ...rows,
        '',
        ...results
          .sort((a, b) => a.name.localeCompare(b.name) || a.mode.localeCompare(b.mode))
          .map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name} (${r.mode}): ${r.detail}`),
        '',
      ].join('\n'),
    );
  });
});
